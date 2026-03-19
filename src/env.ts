import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Return values for the requested keys, resolved in priority order:
 *   1. .env file in the current working directory
 *   2. process.env (shell / container environment)
 *
 * Does NOT write anything into process.env — callers decide what to do
 * with the values.  Secrets in .env take precedence so a committed key
 * always wins over an accidental ambient variable.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const wanted = new Set(keys);

  // Start with process.env as the lowest-priority source
  const result: Record<string, string> = {};
  for (const key of wanted) {
    const val = process.env[key];
    if (val) result[key] = val;
  }

  // Override with values from .env (higher priority)
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    // No .env file — process.env values (if any) are used as-is
    return result;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
