import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
export declare function initDatabase(): void;
/** @internal - for tests only. Creates a fresh in-memory database. */
export declare function _initTestDatabase(): void;
/** @internal - for tests only. */
export declare function _closeDatabase(): void;
/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export declare function storeChatMetadata(chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean): void;
/**
 * Update chat name, guarded by a timestamp comparison.
 * The name is only written if nameUpdatedAt is >= the currently stored name_updated_at,
 * so that an older push from another client can never overwrite a newer rename.
 * New chats (INSERT path) always get the supplied values.
 */
export declare function updateChatName(chatJid: string, name: string, nameUpdatedAt?: number): void;
export interface ChatInfo {
    jid: string;
    name: string;
    last_message_time: string;
    channel: string;
    is_group: number;
    name_updated_at: number;
    cwd: string;
}
/**
 * Get all known chats, ordered by most recent activity.
 */
export declare function getAllChats(): ChatInfo[];
/**
 * Get the user-defined display order for web sessions.
 * Returns an array of chat JIDs (local@web-<id>) in the desired order.
 * An empty array means no custom order has been saved yet.
 */
export declare function getWebSessionOrder(): string[];
/**
 * Persist the user-defined display order for web sessions.
 * @param jids - Ordered array of chat JIDs (local@web-<id>)
 */
export declare function setWebSessionOrder(jids: string[]): void;
/**
 * Persist the current working directory for a web session.
 */
export declare function updateChatCwd(chatJid: string, cwd: string): void;
/**
 * Get full conversation history for a chat (both user and bot messages),
 * ordered chronologically. Used by the web channel history endpoint.
 */
export declare function getConversation(chatJid: string, limit?: number): NewMessage[];
/**
 * Delete a chat and all its messages from the database.
 * Used by the web channel when a session is deleted.
 */
export declare function deleteChat(chatJid: string): void;
/**
 * Delete only the messages of a chat, keeping the chat entry itself.
 * Used by the web channel /clear command.
 */
export declare function clearChatMessages(chatJid: string): void;
/**
 * Get timestamp of last group metadata sync.
 */
export declare function getLastGroupSync(): string | null;
/**
 * Record that group metadata was synced.
 */
export declare function setLastGroupSync(): void;
/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export declare function storeMessage(msg: NewMessage): void;
/**
 * Store a message directly.
 */
export declare function storeMessageDirect(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
}): void;
export declare function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string, limit?: number): {
    messages: NewMessage[];
    newTimestamp: string;
};
export declare function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string, limit?: number): NewMessage[];
/**
 * Delete a single message by its ID.
 * Used by the web channel when the user clicks the trash icon on a message.
 */
export declare function deleteMessage(id: string): void;
export declare function getLastBotMessageTimestamp(chatJid: string, botPrefix: string): string | undefined;
export declare function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
export declare function getTaskById(id: string): ScheduledTask | undefined;
export declare function getTasksForGroup(groupFolder: string): ScheduledTask[];
export declare function getAllTasks(): ScheduledTask[];
export declare function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'script' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>): void;
export declare function deleteTask(id: string): void;
export declare function getDueTasks(): ScheduledTask[];
export declare function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void;
export declare function logTaskRun(log: TaskRunLog): void;
export declare function getRouterState(key: string): string | undefined;
export declare function setRouterState(key: string, value: string): void;
export declare function getSession(groupFolder: string): string | undefined;
export declare function setSession(groupFolder: string, sessionId: string): void;
export declare function deleteSession(groupFolder: string): void;
export declare function getAllSessions(): Record<string, string>;
export declare function getRegisteredGroup(jid: string): (RegisteredGroup & {
    jid: string;
}) | undefined;
export declare function setRegisteredGroup(jid: string, group: RegisteredGroup): void;
export declare function getAllRegisteredGroups(): Record<string, RegisteredGroup>;
//# sourceMappingURL=db.d.ts.map