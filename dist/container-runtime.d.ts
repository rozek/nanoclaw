/** The container runtime binary name. */
export declare const CONTAINER_RUNTIME_BIN = "docker";
/** Hostname containers use to reach the host machine. */
export declare const CONTAINER_HOST_GATEWAY = "host.docker.internal";
/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export declare const PROXY_BIND_HOST: string;
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