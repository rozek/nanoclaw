import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { runContainerAgent, writeTasksSnapshot, } from './container-runner.js';
import { getAllTasks, getDueTasks, getTaskById, logTaskRun, updateTask, updateTaskAfterRun, } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
// Web-channel JID prefix and dedicated cron session JID.
// Scheduled task output for web sessions is always routed to the cron session
// so users see it in one dedicated place instead of the originating session.
const WEB_JID_PREFIX = 'local@web-';
const WEB_JID_LEGACY = 'local@web'; // Legacy JID used before per-session JIDs were introduced
const CRON_SESSION_JID = 'local@web-cron';
/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task) {
    if (task.schedule_type === 'once')
        return null;
    const now = Date.now();
    if (task.schedule_type === 'cron') {
        const interval = CronExpressionParser.parse(task.schedule_value, {
            tz: TIMEZONE,
        });
        return interval.next().toISOString();
    }
    if (task.schedule_type === 'interval') {
        const ms = parseInt(task.schedule_value, 10);
        if (!ms || ms <= 0) {
            // Guard against malformed interval that would cause an infinite loop
            logger.warn({ taskId: task.id, value: task.schedule_value }, 'Invalid interval value');
            return new Date(now + 60_000).toISOString();
        }
        // Anchor to the scheduled time, not now, to prevent drift.
        // Skip past any missed intervals so we always land in the future.
        let next = new Date(task.next_run).getTime() + ms;
        while (next <= now) {
            next += ms;
        }
        return new Date(next).toISOString();
    }
    return null;
}
async function runTask(task, deps) {
    const startTime = Date.now();
    let groupDir;
    try {
        groupDir = resolveGroupFolderPath(task.group_folder);
    }
    catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // Stop retry churn for malformed legacy rows.
        updateTask(task.id, { status: 'paused' });
        logger.error({ taskId: task.id, groupFolder: task.group_folder, error }, 'Task has invalid group folder');
        logTaskRun({
            task_id: task.id,
            run_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error,
        });
        return;
    }
    fs.mkdirSync(groupDir, { recursive: true });
    logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');
    const groups = deps.registeredGroups();
    let group = Object.values(groups).find((g) => g.folder === task.group_folder);
    if (!group) {
        // Fall back to the first isMain group so that legacy tasks created with
        // group_folder='main' still run after a web-channel migration.
        const fallback = Object.values(groups).find((g) => g.isMain === true);
        if (fallback) {
            logger.warn({
                taskId: task.id,
                groupFolder: task.group_folder,
                fallback: fallback.folder,
            }, 'Group not found for task, falling back to main group');
            group = fallback;
        }
        else {
            logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
            logTaskRun({
                task_id: task.id,
                run_at: new Date().toISOString(),
                duration_ms: Date.now() - startTime,
                status: 'error',
                result: null,
                error: `Group not found: ${task.group_folder}`,
            });
            return;
        }
    }
    // Update tasks snapshot for container to read (filtered by group)
    const isMain = group.isMain === true;
    const tasks = getAllTasks();
    writeTasksSnapshot(group.folder, isMain, tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
    })));
    let result = null;
    let error = null;
    // For web sessions, display output in the dedicated cron session instead of
    // the originating session, so all scheduled-task output is in one place.
    // Also handle legacy JID 'local@web' (without suffix) used before per-session JIDs.
    const displayJid = task.chat_jid === WEB_JID_LEGACY || task.chat_jid.startsWith(WEB_JID_PREFIX)
        ? CRON_SESSION_JID
        : task.chat_jid;
    // For group context mode, look up the session by chatJid first (per-session key),
    // then fall back to group_folder (backward compatibility).
    const sessions = deps.getSessions();
    const sessionId = task.context_mode === 'group'
        ? (sessions[task.chat_jid] ?? sessions[task.group_folder])
        : undefined;
    // Each task gets its own queue JID so it runs in parallel with user messages
    // and with other tasks, without blocking the user's message queue slot.
    const taskQueueJid = `task:${task.id}`;
    // Send a header to the cron session so the user knows which task is running.
    const promptPreview = task.prompt.split('\n')[0].slice(0, 80);
    const scheduleLabel = task.schedule_type === 'interval'
        ? `every ${Math.round(parseInt(task.schedule_value, 10) / 60000)} min`
        : task.schedule_value;
    const taskHeader = `---\n**Task #${task.id}** | ${scheduleLabel}\n> ${promptPreview}`;
    await deps.sendMessage(displayJid, taskHeader);
    // After the task produces a result, close the container promptly.
    // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
    // query loop to time out. A short delay handles any final MCP calls.
    const TASK_CLOSE_DELAY_MS = 10000;
    let closeTimer = null;
    const scheduleClose = () => {
        if (closeTimer)
            return; // already scheduled
        closeTimer = setTimeout(() => {
            logger.debug({ taskId: task.id }, 'Closing task container after result');
            deps.queue.closeStdin(taskQueueJid);
        }, TASK_CLOSE_DELAY_MS);
    };
    try {
        const output = await runContainerAgent(group, {
            prompt: task.prompt,
            sessionId,
            groupFolder: group.folder,
            chatJid: task.chat_jid,
            isMain,
            isScheduledTask: true,
            assistantName: ASSISTANT_NAME,
            script: task.script || undefined,
        }, (proc, containerName) => deps.onProcess(taskQueueJid, proc, containerName, group.folder), async (streamedOutput) => {
            if (streamedOutput.result) {
                result = streamedOutput.result;
                // Forward result to the display JID (cron session for web tasks)
                await deps.sendMessage(displayJid, streamedOutput.result);
                scheduleClose();
            }
            if (streamedOutput.status === 'success') {
                deps.queue.notifyIdle(taskQueueJid);
                scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
            }
            if (streamedOutput.status === 'error') {
                error = streamedOutput.error || 'Unknown error';
            }
        });
        if (closeTimer)
            clearTimeout(closeTimer);
        if (output.status === 'error') {
            error = output.error || 'Unknown error';
        }
        else if (output.result) {
            // Result was already forwarded to the user via the streaming callback above
            result = output.result;
        }
        logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
    }
    catch (err) {
        if (closeTimer)
            clearTimeout(closeTimer);
        error = err instanceof Error ? err.message : String(err);
        logger.error({ taskId: task.id, error }, 'Task failed');
    }
    const durationMs = Date.now() - startTime;
    logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: error ? 'error' : 'success',
        result,
        error,
    });
    const nextRun = computeNextRun(task);
    const resultSummary = error
        ? `Error: ${error}`
        : result
            ? result.slice(0, 200)
            : 'Completed';
    updateTaskAfterRun(task.id, nextRun, resultSummary);
}
let schedulerRunning = false;
export function startSchedulerLoop(deps) {
    if (schedulerRunning) {
        logger.debug('Scheduler loop already running, skipping duplicate start');
        return;
    }
    schedulerRunning = true;
    logger.info('Scheduler loop started');
    const loop = async () => {
        try {
            const dueTasks = getDueTasks();
            if (dueTasks.length > 0) {
                logger.info({ count: dueTasks.length }, 'Found due tasks');
            }
            for (const task of dueTasks) {
                // Re-check task status in case it was paused/cancelled
                const currentTask = getTaskById(task.id);
                if (!currentTask || currentTask.status !== 'active') {
                    continue;
                }
                // Use a task-specific queue JID so the task runs in parallel with
                // user messages and other tasks (not serialized on the group's slot).
                deps.queue.enqueueTask(`task:${currentTask.id}`, currentTask.id, () => runTask(currentTask, deps));
            }
        }
        catch (err) {
            logger.error({ err }, 'Error in scheduler loop');
        }
        setTimeout(loop, SCHEDULER_POLL_INTERVAL);
    };
    loop();
}
/** @internal - for tests only. */
export function _resetSchedulerLoopForTests() {
    schedulerRunning = false;
}
//# sourceMappingURL=task-scheduler.js.map