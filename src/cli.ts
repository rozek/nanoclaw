#!/usr/bin/env node
/**
 * cli.ts — NanoClaw CLI entry point
 *
 * Usage:
 *   node dist/cli.js [options]
 *   npx nanoclaw [options]    (requires "bin" field in package.json)
 *
 * Parses arguments, validates them (fail-fast), then starts NanoClaw.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

// ─── Help text ───────────────────────────────────────────────────────────────

const HELP = `
Usage: nanoclaw [options]

Options:
  --host <address>      Bind address for the web channel  (default: 0.0.0.0)
  --port <number>       Port for the web channel           (default: 3099)
  --workspace <path>    Workspace directory                (default: current directory)
  --key <api-key>       Anthropic API key
                          Not required with a Claude Pro/Max subscription —
                          NanoClaw uses Claude Code which is included in those plans.
  --token <token>       Access token for the web interface (default: no protection)
                          Clients must supply it via Authorization: Bearer <token>,
                          as a ?token=<value> query parameter, or a session cookie.
  --sandbox <type>      Container runtime: "docker" or "apple"
                          apple = macOS Sequoia 15+ Apple Container Runtime
                          Defaults to auto-detect (docker first, then apple).
  -h, --help            Show this help and exit

Environment variables (CLI flags take precedence):
  NANOCLAW_HOST           Bind address          (same as --host)
  NANOCLAW_PORT           Port                  (same as --port)
  NANOCLAW_KEY            Anthropic API key     (same as --key)
  NANOCLAW_TOKEN          Access token          (same as --token)
  NANOCLAW_WORKSPACE      Workspace directory   (same as --workspace)
  NANOCLAW_SANDBOX        Container runtime     (same as --sandbox)

Examples:
  nanoclaw
  nanoclaw --port 8080 --workspace ~/my-workspace
  nanoclaw --sandbox docker --host 127.0.0.1 --token s3cr3t
  NANOCLAW_PORT=8080 NANOCLAW_TOKEN=s3cr3t nanoclaw
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error('Run "nanoclaw --help" for usage.');
  process.exit(1);
}

function checkBinary(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectSandbox(): 'docker' | 'apple' | null {
  if (checkBinary('docker info')) return 'docker';
  if (checkBinary('container --version')) return 'apple';
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  // --- Parse arguments -------------------------------------------------------
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        workspace: { type: 'string' },
        key: { type: 'string' },
        token: { type: 'string' },
        sandbox: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err: any) {
    // parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION for unrecognised flags
    die(err?.message ?? String(err));
  }

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  // --- Merge: CLI flags override NANOCLAW_* env vars -------------------------
  // Each setting resolves in priority order: CLI flag > NANOCLAW_* env var > default
  const host = (values.host as string | undefined) ?? process.env.NANOCLAW_HOST;
  const portStr =
    (values.port as string | undefined) ?? process.env.NANOCLAW_PORT;
  const key = (values.key as string | undefined) ?? process.env.NANOCLAW_KEY;
  const token =
    (values.token as string | undefined) ?? process.env.NANOCLAW_TOKEN;
  const workspace =
    (values.workspace as string | undefined) ?? process.env.NANOCLAW_WORKSPACE;
  const sandboxRaw =
    (values.sandbox as string | undefined) ?? process.env.NANOCLAW_SANDBOX;

  // --- Validate --port -------------------------------------------------------
  if (portStr !== undefined) {
    const port = parseInt(portStr, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      die(
        `Invalid port value "${portStr}". Must be an integer between 1 and 65535.`,
      );
    }
  }

  // --- Validate --sandbox ----------------------------------------------------
  let sandboxType: 'docker' | 'apple';

  if (sandboxRaw) {
    if (sandboxRaw !== 'docker' && sandboxRaw !== 'apple') {
      die(
        `Invalid sandbox value "${sandboxRaw}". Must be "docker" or "apple".`,
      );
    }
    sandboxType = sandboxRaw as 'docker' | 'apple';
  } else {
    const detected = detectSandbox();
    if (!detected) {
      die(
        'No container sandbox found.\n' +
          '  • Install Docker Desktop (https://www.docker.com/products/docker-desktop)\n' +
          '  • Or use macOS Sequoia 15+ with the Apple Container Runtime.',
      );
    }
    sandboxType = detected;
    console.log(`Auto-detected sandbox: ${sandboxType}`);
  }

  // --- Validate --workspace --------------------------------------------------
  if (workspace !== undefined) {
    const ws = resolve(workspace);
    if (!existsSync(ws)) {
      die(`Workspace directory not found: ${ws}`);
    }
    process.chdir(ws);
    console.log(`Workspace: ${ws}`);
  }

  // --- Check "claude" binary -------------------------------------------------
  if (!checkBinary('claude --version')) {
    die(
      '"claude" command not found.\n' +
        '  Install Claude Code via: npm install -g @anthropic-ai/claude-code\n' +
        '  or visit https://claude.ai/code',
    );
  }

  // --- Check sandbox availability --------------------------------------------
  if (sandboxType === 'docker') {
    if (!checkBinary('docker info')) {
      die(
        'Docker is not running.\n' +
          '  Please start Docker Desktop or the Docker Engine daemon.',
      );
    }
  } else {
    // apple
    if (!checkBinary('container --version')) {
      die(
        'Apple Container Runtime not available.\n' +
          '  Requires macOS Sequoia 15 or later.',
      );
    }
  }

  // --- Apply settings to process.env so downstream modules pick them up ------
  // web.ts reads NANOCLAW_HOST / NANOCLAW_PORT / NANOCLAW_TOKEN;
  // credential-proxy reads ANTHROPIC_API_KEY.
  if (host) process.env.NANOCLAW_HOST = host;
  if (portStr) process.env.NANOCLAW_PORT = portStr;
  if (key) process.env.ANTHROPIC_API_KEY = key;
  if (token) process.env.NANOCLAW_TOKEN = token;
  process.env.NANOCLAW_SANDBOX = sandboxType;
  process.env.CONTAINER_RUNTIME = sandboxType; // backward compat for container-runtime.ts

  // --- Start NanoClaw --------------------------------------------------------
  const tokenHint = token ? ' — token protection enabled' : '';
  console.log(
    `Starting NanoClaw (sandbox: ${sandboxType}, port: ${process.env.NANOCLAW_PORT ?? 3099}${tokenHint})…`,
  );
  const { main } = await import('./index.js');
  await main();
}

cli().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
