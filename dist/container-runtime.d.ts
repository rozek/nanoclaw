/** The container runtime binary name. */
export declare const CONTAINER_RUNTIME_BIN = "docker";
/** CLI args needed for the container to resolve the host gateway. */
export declare function hostGatewayArgs(): string[];
/** Returns CLI args for a readonly bind mount. */
export declare function readonlyMountArgs(hostPath: string, containerPath: string): string[];
/** Returns the shell command to stop a container by name. */
export declare function stopContainer(name: string): string;
/** Ensure the container runtime is running, starting it if needed. */
export declare function ensureContainerRuntimeRunning(): void;
/** Kill orphaned NanoClaw containers from previous runs. */
export declare function cleanupOrphans(): void;
//# sourceMappingURL=container-runtime.d.ts.map