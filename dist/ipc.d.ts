import { AvailableGroup } from './container-runner.js';
import { RegisteredGroup } from './types.js';
export interface IpcDeps {
    sendMessage: (jid: string, text: string) => Promise<void>;
    registeredGroups: () => Record<string, RegisteredGroup>;
    registerGroup: (jid: string, group: RegisteredGroup) => void;
    syncGroups: (force: boolean) => Promise<void>;
    getAvailableGroups: () => AvailableGroup[];
    writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[], registeredJids: Set<string>) => void;
    onTasksChanged: () => void;
}
export declare function startIpcWatcher(deps: IpcDeps): void;
export declare function processTaskIpc(data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
}, sourceGroup: string, // Verified identity from IPC directory
isMain: boolean, // Verified from directory path
deps: IpcDeps): Promise<void>;
//# sourceMappingURL=ipc.d.ts.map