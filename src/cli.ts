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

import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
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
  if (checkBinary('docker info --format "{{.ID}}"')) return 'docker';
  if (checkBinary('container --version')) return 'apple';
  return null;
}

// ─── Container image ─────────────────────────────────────────────────────────

function containerImageExists(sandboxType: 'docker' | 'apple'): boolean {
  return checkBinary(
    `${sandboxType === 'apple' ? 'container' : 'docker'} image inspect nanoclaw-agent:latest`,
  );
}

function buildContainerImage(sandboxType: 'docker' | 'apple'): void {
  // build.sh lives inside the npm package, not in the user's workspace
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const buildScript = resolve(pkgDir, 'container', 'build.sh');
  if (!existsSync(buildScript)) {
    console.warn('container/build.sh not found — skipping container build.');
    return;
  }
  console.log(
    'Building container image nanoclaw-agent:latest (this may take a few minutes)…',
  );
  const r = spawnSync('bash', [buildScript], {
    stdio: 'inherit',
    cwd: resolve(pkgDir, 'container'),
    env: {
      ...process.env,
      CONTAINER_RUNTIME: sandboxType === 'apple' ? 'container' : 'docker',
    },
  });
  if (r.status !== 0) {
    console.warn(`Container build exited with code ${r.status}.`);
  }
}

// ─── .env persistence ────────────────────────────────────────────────────────

/**
 * Write (or update) ANTHROPIC_API_KEY in the workspace .env file so that
 * the credential proxy can pick it up on this and future runs.
 * Preserves all other lines already present in the file.
 */
function writeApiKeyToEnv(apiKey: string): void {
  const envFile = resolve(process.cwd(), '.env');
  let lines: string[] = [];
  if (existsSync(envFile)) {
    try {
      lines = readFileSync(envFile, 'utf-8').split('\n');
    } catch {
      /* ignore read errors — file will be overwritten */
    }
  }

  const keyLine = `ANTHROPIC_API_KEY=${apiKey}`;
  const idx = lines.findIndex((l) =>
    l.trimStart().startsWith('ANTHROPIC_API_KEY='),
  );
  if (idx >= 0) {
    if (lines[idx] === keyLine) return; // already up to date
    lines[idx] = keyLine;
  } else {
    lines.push(keyLine);
  }

  try {
    writeFileSync(envFile, lines.join('\n'), 'utf-8');
    console.log('.env updated with ANTHROPIC_API_KEY.');
  } catch (err) {
    console.warn(`Could not write .env file: ${err}`);
  }
}

// ─── First-time setup ────────────────────────────────────────────────────────

function runFirstTimeSetup(sandboxType: 'docker' | 'apple'): void {
  // setup/ scripts are run via tsx (they use .ts imports and are not compiled by tsc)
  const distDir = dirname(fileURLToPath(import.meta.url)); // dist/
  const setupIndex = resolve(distDir, '../setup/index.ts');

  // tsx may live at different depths depending on whether we're running from a
  // local install or from the npx cache (where the package is nested inside
  // another node_modules tree).
  const tsxCandidates = [
    resolve(distDir, '../node_modules/.bin/tsx'), // local / direct install
    resolve(distDir, '../../.bin/tsx'), // npx cache (scoped pkg)
    resolve(distDir, '../../../.bin/tsx'), // npx cache (nested)
  ];
  const tsxBin = tsxCandidates.find((p) => existsSync(p));
  const runner = tsxBin ?? 'tsx';

  if (!existsSync(setupIndex)) {
    console.warn('Setup scripts not found — skipping first-time setup.');
    return;
  }

  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│  NanoClaw — First-Time Setup                │');
  console.log('└─────────────────────────────────────────────┘\n');

  const step = (name: string, extraArgs: string[] = []): void => {
    const bar = '─'.repeat(Math.max(0, 38 - name.length));
    console.log(`\n── ${name} ${bar}`);
    const r = spawnSync(runner, [setupIndex, '--step', name, ...extraArgs], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    if (r.status !== 0) {
      console.warn(`Setup step "${name}" exited with code ${r.status}.`);
    }
  };

  step('environment');
  step('container', ['--runtime', sandboxType]);
  step('mounts', ['--empty']);
  step('verify');

  console.log('\nSetup complete. Starting NanoClaw…\n');
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
    if (!checkBinary('docker info --format "{{.ID}}"')) {
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

  // --- First-run detection ---------------------------------------------------
  if (!existsSync(resolve(process.cwd(), 'store', 'messages.db'))) {
    runFirstTimeSetup(sandboxType);
  }

  // --- Ensure container image exists ----------------------------------------
  if (!containerImageExists(sandboxType)) {
    buildContainerImage(sandboxType);
  }

  // --- Persist API key to .env so credential-proxy can read it ---------------
  // credential-proxy reads only from the .env file (not process.env) to keep
  // secrets out of child-process environments.  Writing it here means the user
  // only has to supply --key (or NANOCLAW_KEY) once; subsequent runs reuse it.
  if (key) writeApiKeyToEnv(key);

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
