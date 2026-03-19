import type { NewMessage } from './types.js';
/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export declare function extractSessionCommand(content: string, triggerPattern: RegExp): string | null;
/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export declare function isSessionCommandAllowed(isMainGroup: boolean, isFromMe: boolean): boolean;
/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
    status: 'success' | 'error';
    result?: string | object | null;
}
/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
    sendMessage: (text: string) => Promise<void>;
    setTyping: (typing: boolean) => Promise<void>;
    runAgent: (prompt: string, onOutput: (result: AgentResult) => Promise<void>) => Promise<'success' | 'error'>;
    closeStdin: () => void;
    advanceCursor: (timestamp: string) => void;
    formatMessages: (msgs: NewMessage[], timezone: string) => string;
    /** Whether the denied sender would normally be allowed to interact (for denial messages). */
    canSenderInteract: (msg: NewMessage) => boolean;
}
/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export declare function handleSessionCommand(opts: {
    missedMessages: NewMessage[];
    isMainGroup: boolean;
    groupName: string;
    triggerPattern: RegExp;
    timezone: string;
    deps: SessionCommandDeps;
}): Promise<{
    handled: false;
} | {
    handled: true;
    success: boolean;
}>;
//# sourceMappingURL=session-commands.d.ts.map