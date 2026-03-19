/**
 * Return values for the requested keys, resolved in priority order:
 *   1. .env file in the current working directory
 *   2. process.env (shell / container environment)
 *
 * Does NOT write anything into process.env — callers decide what to do
 * with the values.  Secrets in .env take precedence so a committed key
 * always wins over an accidental ambient variable.
 */
export declare function readEnvFile(keys: string[]): Record<string, string>;
//# sourceMappingURL=env.d.ts.map