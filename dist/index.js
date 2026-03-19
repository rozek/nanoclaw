import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, CREDENTIAL_PROXY_PORT, DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, POLL_INTERVAL, STORE_DIR, TIMEZONE, TRIGGER_PATTERN, } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import { getChannelFactory, getRegisteredChannelNames, } from './channels/registry.js';
import { runContainerAgent, writeGroupsSnapshot, writeTasksSnapshot, } from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning, PROXY_BIND_HOST, } from './container-runtime.js';
import { getAllChats, getAllRegisteredGroups, getAllSessions, getAllTasks, getMessagesSince, getNewMessages, getRouterState, initDatabase, setRegisteredGroup, setRouterState, setSession, storeChatMetadata, storeMessage, } from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { restoreRemoteControl, startRemoteControl, stopRemoteControl, } from './remote-control.js';
import { isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage, } from './sender-allowlist.js';
import { extractSessionCommand, handleSessionCommand, isSessionCommandAllowed, } from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { logger } from './logger.js';
// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';
let lastTimestamp = '';
let sessions = {};
let registeredGroups = {};
let lastAgentTimestamp = {};
let messageLoopRunning = false;
const channels = [];
const queue = new GroupQueue();
function loadState() {
    lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
        lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    }
    catch {
        logger.warn('Corrupted last_agent_timestamp in DB, resetting');
        lastAgentTimestamp = {};
    }
    sessions = getAllSessions();
    registeredGroups = getAllRegisteredGroups();
    logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}
function saveState() {
    setRouterState('last_timestamp', lastTimestamp);
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}
function registerGroup(jid, group) {
    let groupDir;
    try {
        groupDir = resolveGroupFolderPath(group.folder);
    }
    catch (err) {
        logger.warn({ jid, folder: group.folder, err }, 'Rejecting group registration with invalid folder');
        return;
    }
    registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    // Create group folder
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}
/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups() {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(registeredGroups));
    return chats
        .filter((c) => c.jid !== '__group_sync__' && c.is_group)
        .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
    }));
}
/** @internal - exported for testing */
export function _setRegisteredGroups(groups) {
    registeredGroups = groups;
}
/**
 * Classify an Anthropic SDK error string and return a user-facing message
 * plus whether the error is permanent (no retry) or transient (retry).
 * Returns null if the error is not a recognized API error.
 */
function formatApiError(error) {
    if (/401|unauthorized|invalid.*key|expired.*key|authentication/i.test(error)) {
        return {
            message: '⚠️ Anthropic-Anmeldung fehlgeschlagen (401). Bitte prüfe die API-Konfiguration.',
            permanent: true,
        };
    }
    if (/429|rate.?limit/i.test(error)) {
        return {
            message: '⚠️ Anthropic-Anfragelimit erreicht (429). Ich versuche es in Kürze erneut.',
            permanent: false,
        };
    }
    if (/529|503|overload|unavailable/i.test(error)) {
        return {
            message: '⚠️ Anthropic ist gerade überlastet. Ich versuche es in Kürze erneut.',
            permanent: false,
        };
    }
    if (/\b500\b|internal.server.error/i.test(error)) {
        return {
            message: '⚠️ Anthropic-Serverfehler (500). Ich versuche es in Kürze erneut.',
            permanent: false,
        };
    }
    return null;
}
/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid) {
    const group = registeredGroups[chatJid];
    if (!group)
        return true;
    const channel = findChannel(channels, chatJid);
    if (!channel) {
        logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
        return true;
    }
    const isMainGroup = group.isMain === true;
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (missedMessages.length === 0)
        return true;
    // --- Session command interception (before trigger check) ---
    const cmdResult = await handleSessionCommand({
        missedMessages,
        isMainGroup,
        groupName: group.name,
        triggerPattern: TRIGGER_PATTERN,
        timezone: TIMEZONE,
        deps: {
            sendMessage: (text) => channel.sendMessage(chatJid, text),
            setTyping: (typing) => channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
            runAgent: (prompt, onOutput) => runAgent(group, prompt, chatJid, onOutput),
            closeStdin: () => queue.closeStdin(chatJid),
            advanceCursor: (ts) => {
                lastAgentTimestamp[chatJid] = ts;
                saveState();
            },
            formatMessages,
            canSenderInteract: (msg) => {
                const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
                const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
                return (isMainGroup ||
                    !reqTrigger ||
                    (hasTrigger &&
                        (msg.is_from_me ||
                            isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist()))));
            },
        },
    });
    if (cmdResult.handled)
        return cmdResult.success;
    // --- End session command interception ---
    // For non-main groups, check if trigger is required and present
    if (!isMainGroup && group.requiresTrigger !== false) {
        const allowlistCfg = loadSenderAllowlist();
        const hasTrigger = missedMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()) &&
            (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)));
        if (!hasTrigger)
            return true;
    }
    const prompt = formatMessages(missedMessages, TIMEZONE);
    // Advance cursor so the piping path in startMessageLoop won't re-fetch
    // these messages. Save the old cursor so we can roll back on error.
    const previousCursor = lastAgentTimestamp[chatJid] || '';
    lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');
    // Track idle timer for closing stdin when agent is idle
    let idleTimer = null;
    const resetIdleTimer = () => {
        if (idleTimer)
            clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
            queue.closeStdin(chatJid);
        }, IDLE_TIMEOUT);
    };
    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;
    // Status callback: broadcasts live tool-use events to the channel (best-effort)
    const statusCallback = (tool, inputSnippet) => {
        try {
            channel.setStatus?.(chatJid, tool, inputSnippet);
        }
        catch {
            /* non-critical */
        }
    };
    const output = await runAgent(group, prompt, chatJid, async (result) => {
        // Streaming output callback — called for each agent result
        if (result.result) {
            const raw = typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
            const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
            if (text) {
                await channel.sendMessage(chatJid, text);
                outputSentToUser = true;
            }
            // Only reset idle timer on actual results, not session-update markers (result: null)
            resetIdleTimer();
        }
        if (result.status === 'success') {
            queue.notifyIdle(chatJid);
        }
        if (result.status === 'error') {
            hadError = true;
            if (result.error && !outputSentToUser) {
                const apiError = formatApiError(result.error);
                if (apiError) {
                    logger.info({ group: group.name, permanent: apiError.permanent }, 'Anthropic API error detected, notifying user');
                    try {
                        await channel.sendMessage(chatJid, apiError.message);
                        // For permanent errors (e.g. 401), mark as "output sent" to prevent
                        // cursor rollback and infinite retry. For transient errors (429/529/500),
                        // leave outputSentToUser=false so the cursor rolls back and retries.
                        if (apiError.permanent) {
                            outputSentToUser = true;
                        }
                    }
                    catch {
                        /* ignore send failure */
                    }
                }
            }
        }
    }, statusCallback);
    // Clear status display when the agent is done
    try {
        channel.setStatus?.(chatJid, null);
    }
    catch {
        /* non-critical */
    }
    await channel.setTyping?.(chatJid, false);
    if (idleTimer)
        clearTimeout(idleTimer);
    if (output === 'error' || hadError) {
        // If we already sent output to the user, don't roll back the cursor —
        // the user got their response and re-processing would send duplicates.
        if (outputSentToUser) {
            logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
            return true;
        }
        // Roll back cursor so retries can re-process these messages
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
        return false;
    }
    return true;
}
async function runAgent(group, prompt, chatJid, onOutput, onStatus) {
    const isMain = group.isMain === true;
    // Use chatJid as session key so each web session gets its own Claude conversation
    // context. Fall back to group.folder for backward compatibility with stored sessions.
    const sessionId = sessions[chatJid] ?? sessions[group.folder];
    // Update tasks snapshot for container to read (filtered by group)
    const tasks = getAllTasks();
    writeTasksSnapshot(group.folder, isMain, tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
    })));
    // Update available groups snapshot (main group only can see all groups)
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));
    // Wrap onOutput to track session ID from streamed results
    const wrappedOnOutput = onOutput
        ? async (output) => {
            if (output.newSessionId) {
                sessions[chatJid] = output.newSessionId;
                setSession(chatJid, output.newSessionId);
            }
            await onOutput(output);
        }
        : undefined;
    try {
        const output = await runContainerAgent(group, {
            prompt,
            sessionId,
            groupFolder: group.folder,
            chatJid,
            isMain,
            assistantName: ASSISTANT_NAME,
        }, (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder), wrappedOnOutput, onStatus);
        if (output.newSessionId) {
            sessions[chatJid] = output.newSessionId;
            setSession(chatJid, output.newSessionId);
        }
        if (output.status === 'error') {
            logger.error({ group: group.name, error: output.error }, 'Container agent error');
            return 'error';
        }
        return 'success';
    }
    catch (err) {
        logger.error({ group: group.name, err }, 'Agent error');
        return 'error';
    }
}
async function startMessageLoop() {
    if (messageLoopRunning) {
        logger.debug('Message loop already running, skipping duplicate start');
        return;
    }
    messageLoopRunning = true;
    logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);
    while (true) {
        try {
            const jids = Object.keys(registeredGroups);
            const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);
            if (messages.length > 0) {
                logger.info({ count: messages.length }, 'New messages');
                // Advance the "seen" cursor for all messages immediately
                lastTimestamp = newTimestamp;
                saveState();
                // Deduplicate by group
                const messagesByGroup = new Map();
                for (const msg of messages) {
                    const existing = messagesByGroup.get(msg.chat_jid);
                    if (existing) {
                        existing.push(msg);
                    }
                    else {
                        messagesByGroup.set(msg.chat_jid, [msg]);
                    }
                }
                for (const [chatJid, groupMessages] of messagesByGroup) {
                    const group = registeredGroups[chatJid];
                    if (!group)
                        continue;
                    const channel = findChannel(channels, chatJid);
                    if (!channel) {
                        logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
                        continue;
                    }
                    const isMainGroup = group.isMain === true;
                    // --- Session command interception (message loop) ---
                    // Scan ALL messages in the batch for a session command.
                    const loopCmdMsg = groupMessages.find((m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null);
                    if (loopCmdMsg) {
                        // Only close active container if the sender is authorized — otherwise an
                        // untrusted user could kill in-flight work by sending /compact (DoS).
                        // closeStdin no-ops internally when no container is active.
                        if (isSessionCommandAllowed(isMainGroup, loopCmdMsg.is_from_me === true)) {
                            queue.closeStdin(chatJid);
                        }
                        // Enqueue so processGroupMessages handles auth + cursor advancement.
                        // Don't pipe via IPC — slash commands need a fresh container with
                        // string prompt (not MessageStream) for SDK recognition.
                        queue.enqueueMessageCheck(chatJid);
                        continue;
                    }
                    // --- End session command interception ---
                    const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
                    // For non-main groups, only act on trigger messages.
                    // Non-trigger messages accumulate in DB and get pulled as
                    // context when a trigger eventually arrives.
                    if (needsTrigger) {
                        const allowlistCfg = loadSenderAllowlist();
                        const hasTrigger = groupMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()) &&
                            (m.is_from_me ||
                                isTriggerAllowed(chatJid, m.sender, allowlistCfg)));
                        if (!hasTrigger)
                            continue;
                    }
                    // Pull all messages since lastAgentTimestamp so non-trigger
                    // context that accumulated between triggers is included.
                    const allPending = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
                    const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
                    const formatted = formatMessages(messagesToSend, TIMEZONE);
                    if (queue.sendMessage(chatJid, formatted)) {
                        logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
                        lastAgentTimestamp[chatJid] =
                            messagesToSend[messagesToSend.length - 1].timestamp;
                        saveState();
                        // Show typing indicator while the container processes the piped message
                        channel
                            .setTyping?.(chatJid, true)
                            ?.catch((err) => logger.warn({ chatJid, err }, 'Failed to set typing indicator'));
                    }
                    else {
                        // No active container — enqueue for a new one
                        queue.enqueueMessageCheck(chatJid);
                    }
                }
            }
        }
        catch (err) {
            logger.error({ err }, 'Error in message loop');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
}
/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages() {
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
        const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
        const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
        if (pending.length > 0) {
            logger.info({ group: group.name, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
            queue.enqueueMessageCheck(chatJid);
        }
    }
}
function ensureContainerSystemRunning() {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
}
const MAIN_CLAUDE_MD = `# NanoClaw

Personal Claude assistant. You help with tasks, answer questions, and can schedule activities.

## What You Can Do

- answer questions and have conversations
- search the web and fetch content from URLs
- read and write files in your workspace
- run bash commands in your sandbox
- schedule tasks to run later or on a recurring basis
- send messages back to the chat

## Memory

The \`conversations/\` folder contains searchable history of past conversations. Use this to recall
context from previous sessions.

When you learn something important, create files for structured data (e.g. \`preferences.md\`) and
keep an index in your memory for the files you create.
`;
const GLOBAL_CLAUDE_MD = `# Shared Memory

This directory is mounted read-only in all groups. Use it for information that should be
accessible across all sessions.
`;
/** Export for use by cli.ts entry point. */
function initWorkspace() {
    const dirs = [
        STORE_DIR,
        GROUPS_DIR,
        path.join(GROUPS_DIR, 'main'),
        path.join(GROUPS_DIR, 'global'),
        path.join(DATA_DIR, 'ipc'),
        path.join(DATA_DIR, 'sessions'),
        path.join(GROUPS_DIR, 'main', 'Tools'),
        path.join(GROUPS_DIR, 'main', 'Skills'),
        path.join(GROUPS_DIR, 'main', 'MCP-Servers'),
        path.join(GROUPS_DIR, 'main', 'conversations'),
    ];
    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const mainClaudeMd = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
    if (!fs.existsSync(mainClaudeMd)) {
        fs.writeFileSync(mainClaudeMd, MAIN_CLAUDE_MD, 'utf-8');
    }
    const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (!fs.existsSync(globalClaudeMd)) {
        fs.writeFileSync(globalClaudeMd, GLOBAL_CLAUDE_MD, 'utf-8');
    }
}
export async function main() {
    initWorkspace();
    ensureContainerSystemRunning();
    initDatabase();
    logger.info('Database initialized');
    loadState();
    restoreRemoteControl();
    // Start credential proxy (containers route API calls through this)
    const proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
    // Graceful shutdown handlers
    const shutdown = async (signal) => {
        logger.info({ signal }, 'Shutdown signal received');
        proxyServer.close();
        await queue.shutdown(10000);
        for (const ch of channels)
            await ch.disconnect();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    // Handle /remote-control and /remote-control-end commands
    async function handleRemoteControl(command, chatJid, msg) {
        const group = registeredGroups[chatJid];
        if (!group?.isMain) {
            logger.warn({ chatJid, sender: msg.sender }, 'Remote control rejected: not main group');
            return;
        }
        const channel = findChannel(channels, chatJid);
        if (!channel)
            return;
        if (command === '/remote-control') {
            const result = await startRemoteControl(msg.sender, chatJid, process.cwd());
            if (result.ok) {
                await channel.sendMessage(chatJid, result.url);
            }
            else {
                await channel.sendMessage(chatJid, `Remote Control failed: ${result.error}`);
            }
        }
        else {
            const result = stopRemoteControl();
            if (result.ok) {
                await channel.sendMessage(chatJid, 'Remote Control session ended.');
            }
            else {
                await channel.sendMessage(chatJid, result.error);
            }
        }
    }
    // Channel callbacks (shared by all channels)
    const channelOpts = {
        registerGroup,
        onMessage: (chatJid, msg) => {
            // Remote control commands — intercept before storage
            const trimmed = msg.content.trim();
            if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
                handleRemoteControl(trimmed, chatJid, msg).catch((err) => logger.error({ err, chatJid }, 'Remote control command error'));
                return;
            }
            // Sender allowlist drop mode: discard messages from denied senders before storing
            if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
                const cfg = loadSenderAllowlist();
                if (shouldDropMessage(chatJid, cfg) &&
                    !isSenderAllowed(chatJid, msg.sender, cfg)) {
                    if (cfg.logDenied) {
                        logger.debug({ chatJid, sender: msg.sender }, 'sender-allowlist: dropping message (drop mode)');
                    }
                    return;
                }
            }
            storeMessage(msg);
        },
        onChatMetadata: (chatJid, timestamp, name, channel, isGroup) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
        registeredGroups: () => registeredGroups,
        onCancelRequest: (jid) => {
            logger.info({ jid }, 'Cancel request received, killing container');
            queue.cancelContainer(jid);
        },
    };
    // Create and connect all registered channels.
    // Each channel self-registers via the barrel import above.
    // Factories return null when credentials are missing, so unconfigured channels are skipped.
    for (const channelName of getRegisteredChannelNames()) {
        const factory = getChannelFactory(channelName);
        const channel = factory(channelOpts);
        if (!channel) {
            logger.warn({ channel: channelName }, 'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.');
            continue;
        }
        channels.push(channel);
        await channel.connect();
    }
    if (channels.length === 0) {
        logger.fatal('No channels connected');
        process.exit(1);
    }
    // Start subsystems (independently of connection handler)
    startSchedulerLoop({
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
        queue,
        onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
        sendMessage: async (jid, rawText) => {
            const channel = findChannel(channels, jid);
            if (!channel) {
                logger.warn({ jid }, 'No channel owns JID, cannot send message');
                return;
            }
            const text = formatOutbound(rawText);
            if (text)
                await channel.sendMessage(jid, text);
        },
    });
    startIpcWatcher({
        sendMessage: (jid, text) => {
            const channel = findChannel(channels, jid);
            if (!channel)
                throw new Error(`No channel for JID: ${jid}`);
            return channel.sendMessage(jid, text);
        },
        registeredGroups: () => registeredGroups,
        registerGroup,
        syncGroups: async (force) => {
            await Promise.all(channels
                .filter((ch) => ch.syncGroups)
                .map((ch) => ch.syncGroups(force)));
        },
        getAvailableGroups,
        writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
        onTasksChanged: () => {
            const tasks = getAllTasks();
            const taskRows = tasks.map((t) => ({
                id: t.id,
                groupFolder: t.group_folder,
                prompt: t.prompt,
                schedule_type: t.schedule_type,
                schedule_value: t.schedule_value,
                status: t.status,
                next_run: t.next_run,
            }));
            for (const group of Object.values(registeredGroups)) {
                writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
            }
        },
    });
    queue.setProcessMessagesFn(processGroupMessages);
    recoverPendingMessages();
    startMessageLoop().catch((err) => {
        logger.fatal({ err }, 'Message loop crashed unexpectedly');
        process.exit(1);
    });
}
// Guard: only run when executed directly, not when imported by tests
const isDirectRun = process.argv[1] &&
    new URL(import.meta.url).pathname ===
        new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) {
    main().catch((err) => {
        logger.error({ err }, 'Failed to start NanoClaw');
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map