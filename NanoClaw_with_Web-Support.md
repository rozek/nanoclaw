# NanoClaw with Web Support

This document describes the changes added in the [rozek/nanoclaw](https://github.com/rozek/nanoclaw) fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). It serves as installation guide, feature reference, and API documentation.

---

## Quick Start (npx)

No cloning, no `npm install` — just run:

```bash
npx @rozek/nanoclaw
```

Then open **http://localhost:3099** in your browser.

### Prerequisites

| Requirement | How to check | Notes |
|-------------|-------------|-------|
| **Node.js ≥ 20** | `node --version` | |
| **Claude Code** | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| **Container runtime** | `docker info` *or* `container --version` | Docker Desktop **or** macOS Sequoia 15+ Apple Container Runtime |

> **No API key required** if you have a Claude Pro or Max subscription — NanoClaw uses Claude Code, which is included in those plans.

---

## Web Channel Features

### UI & Design

- **Light and dark themes** — with your system theme as default
- **Full-viewport layout** — always fills the screen
- **Responsive** — desktop: fixed sidebar; mobile: sidebar as overlay with backdrop

### Rich Content Rendering

Bot responses are rendered with full Markdown support:

| Library | Purpose |
|---------|---------|
| [marked.js](https://marked.js.org) | GitHub Flavored Markdown |
| [KaTeX](https://katex.org) | Inline (`$...$`) and block (`$$...$$`) math formulas |
| [highlight.js](https://highlightjs.org) | Syntax highlighting (TypeScript, Java, and many more) |
| [Mermaid](https://mermaid.js.org) | Flowcharts, sequence diagrams, etc. |

### Multi-Session Chat

- Unlimited parallel chat sessions per browser
- Sessions are listed in the sidebar, freely sortable by dragging
- Each session has an editable name (pencil icon ✏; default: date+time)
- Sessions persist in `localStorage` and SQLite — survive browser reloads and server restarts
- Sessions from other devices appear automatically in the sidebar (polled every 5 s)
- Unread message indicators (blue dot) per session, persisted in `localStorage`
- Sessions can be deleted (removes all messages from DB and `localStorage`)

### Session Name Sync

Conflict-free name synchronisation across devices:

- Every rename carries a `nameUpdatedAt` UNIX timestamp
- Server-side guard: `UPDATE … WHERE excluded.name_updated_at >= chats.name_updated_at`
- On SSE connect, the client pushes its local name; if it is newer than the server's name, the server adopts it

### Message History

- Local `localStorage` cache (`hist:{sid}`) for instant display on load
- Full conversation history served from SQLite via `GET /history?sid=…`
- Both user messages and bot replies are persisted and synced across devices
- Individual messages can be deleted (trash icon; removes from DOM, cache, and DB)

### Real-Time Updates (Server-Sent Events)

All live updates arrive over a single SSE connection (`GET /events?sid=…`):

| Event | Payload | Purpose |
|-------|---------|---------|
| `message` | `{"text":"…","id":"…"}` | Append bot reply |
| `typing` | `"true"` / `"false"` | Show/hide typing indicator |
| `status` | `{"tool":"…","input":"…"}` or `null` | Display active tool (e.g. "searching…") |
| `cwd` | path string | Update working-directory display in header |

On connect, the server immediately sends the current `typing`, `status`, and `cwd` state so reconnects are seamless. Additionally, the client fetches `GET /pwd?sid=…` in the SSE `open` handler to reliably sync the CWD even if the `cwd` event arrives before the session is fully initialized.

### Working Folder (CWD)

- Current working folder shown in the header: `NanoClaw — IP:Port — <relative-path>`
- Set by the agent or user via `switching to folder: <relative-path>` (in any message or response)
- User shorthand commands available in the chat input:
  - `/cwd <path>` — change the working folder instantly (no agent invocation)
  - `/pwd` — display the current working folder
- Persisted in `chats.cwd` (SQLite) — survives server restarts
- Also cached in `localStorage` per session
- NanoClaw ships with built-in skills (`container/skills/cwd/` and `container/skills/pwd/`) that instruct the AI how to use these commands
- All CWD values (from agent output, `/cwd` command, or `POST /cwd`) are passed through `sanitizeCwd()` which resolves paths relative to the workspace root and rejects any attempt to escape it (absolute paths outside the workspace are silently clamped to `''`)

### File Upload

- Drag files into the browser window
- Files are written to the session's current working directory (or group root if no CWD)
- Maximum file size: 10 MB

### Cancel In-Progress Requests

- A **Cancel** button appears while the agent is processing
- Clicking it immediately kills the container process (SIGTERM) via `POST /cancel?sid=…`
- The button is disabled while the cancel request is in flight to prevent double-clicks

### Cron Jobs Tab

- A dedicated **Cron Jobs** tab (`local@web-cron`) shows output from all scheduled tasks
- The text input is disabled in this tab — it is reserved for task output only

### Access Control

Token-based authentication is optional but recommended when NanoClaw is reachable from the LAN:

```bash
npx @rozek/nanoclaw --token mySecretToken
```

Clients authenticate via:
1. `Authorization: Bearer mySecretToken` header
2. `?token=mySecretToken` URL query parameter (sets an HttpOnly session cookie)
3. The HttpOnly session cookie set after step 2

---

## Installation & Usage

### Simplest start

```bash
npx @rozek/nanoclaw
```

Auto-detects the container runtime (Docker first, then Apple Container). Binds to `127.0.0.1:3099` by default (localhost only).

### Common options

```bash
# Custom port
npx @rozek/nanoclaw --port 8080

# Custom workspace (directory NanoClaw works in)
npx @rozek/nanoclaw --workspace ~/my-workspace

# Token protection — recommended when accessible from the LAN
npx @rozek/nanoclaw --token mySecretToken

# Make accessible from the LAN (bind to all interfaces) — use with a token!
npx nanoclaw --host 0.0.0.0 --token mySecretToken

# Explicit container runtime
npx @rozek/nanoclaw --sandbox docker
npx @rozek/nanoclaw --sandbox apple

# With an Anthropic API key (for users without Pro/Max)
npx @rozek/nanoclaw --key sk-ant-...

# Combine options
npx @rozek/nanoclaw --port 8080 --workspace ~/my-workspace --token mySecretToken --sandbox docker
```

### All CLI options

```
Options:
  --host <address>      Bind address for the web channel  (default: 127.0.0.1)
  --port <number>       Port for the web channel           (default: 3099)
  --workspace <path>    Workspace directory                (default: current directory)
  --key <api-key>       Anthropic API key
                          Not required with Claude Pro/Max — NanoClaw uses
                          Claude Code, which is included in those plans.
  --token <token>       Access token for the web interface (default: no protection)
                          Clients supply it via:
                            Authorization: Bearer <token>
                            ?token=<value> query parameter
                            or a session cookie
  --sandbox <type>      Container runtime: "docker" or "apple"
                          Defaults to auto-detect (docker → apple).
  -h, --help            Show this help and exit
```

### Environment variables

CLI flags take precedence. Alternatively, set environment variables:

```bash
NANOCLAW_HOST=127.0.0.1
NANOCLAW_PORT=3099
NANOCLAW_TOKEN=mySecretToken
NANOCLAW_KEY=sk-ant-...
NANOCLAW_WORKSPACE=/path/to/workspace
NANOCLAW_SANDBOX=docker   # or: apple
```

---

## HTTP API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the web UI (HTML) |
| `GET` | `/events?sid=…` | SSE stream for real-time updates |
| `GET` | `/sessions` | All web sessions with custom display order (JSON) |
| `GET` | `/history?sid=…` | Conversation history (JSON) |
| `GET` | `/favicon.ico` | Favicon (ICO) |
| `GET` | `/favicon.png` | Favicon (PNG) |
| `GET` | `/apple-touch-icon.png` | iOS home-screen icon |
| `POST` | `/message` | Send a chat message |
| `POST` | `/session-name` | Rename a session |
| `POST` | `/session-order` | Persist the user-defined session display order (drag-and-drop) |
| `POST` | `/delete-session` | Delete a session and all its messages |
| `POST` | `/delete-message` | Delete a single message `{sid, id}` |
| `GET` | `/pwd?sid=…` | Get the current working folder for a session (JSON: `{cwd}`) |
| `POST` | `/cwd` | Set the working folder for a session (`{cwd, sessionId}`) |
| `POST` | `/upload` | Upload a file (Base64-encoded body) |
| `POST` | `/cancel?sid=…` | Cancel the active request for a session |

---

## Architecture

```
Browser                        Server (web.ts)               DB (SQLite)
───────                        ───────────────               ───────────
GET /          ←─────────────  Embedded HTML/CSS/JS
GET /events    ←── SSE ──────  sseClients Map
POST /message  ────────────→   onMessage() → agent run
                               agent replies → broadcastToSession()
GET /sessions  ←── poll 5s ─   getAllChats() + sessionCwds   chats table
POST /session-name  ────────→  updateChatName() (with guard) chats.name
POST /session-order ────────→  setWebSessionOrder()          router_state
GET /history   ←─────────────  getConversation()             messages table
POST /delete-session  ──────→  deleteChat()                  chats + messages
POST /delete-message  ──────→  deleteMessage(id)             messages table
GET /pwd       ←─────────────  sessionCwds.get(sid)
POST /cwd      ────────────→   updateChatCwd() → broadcast   chats.cwd
POST /upload   ────────────→   fs.writeFile() into CWD dir
POST /cancel   ────────────→   onCancelRequest()
```

### In-Memory Server State

| Variable | Type | Content |
|----------|------|---------|
| `sseClients` | `Map<sid, Set<Response>>` | Open SSE connections per session |
| `sessionCwds` | `Map<sid, string>` | Current CWD per session |
| `sessionTyping` | `Map<sid, boolean>` | Whether the agent is processing |
| `sessionStatus` | `Map<sid, string\|null>` | Last tool-status payload |
| `registeredSessions` | `Set<sid>` | Sessions already registered with NanoClaw |

### Database Schema (relevant columns in `chats`)

| Column | Type | Purpose |
|--------|------|---------|
| `jid` | TEXT PK | `local@web-{sessionId}` |
| `name` | TEXT | Session display name |
| `name_updated_at` | INTEGER | UNIX epoch of the last rename |
| `cwd` | TEXT | Current working directory |
| `last_message_time` | TEXT | ISO timestamp updated on every message |

---

## Development Workflow

If you are running NanoClaw from source (not via `npx`):

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Run
node dist/cli.js [options]
```

To apply changes and rebuild in one step:

```bash
npm run build && node dist/cli.js
```

---

## What's New

The following files were added or changed relative to [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) `main`:

### New files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point — parses arguments, validates them, starts NanoClaw; enables `npx @rozek/nanoclaw` |
| `src/channels/web.ts` | Complete HTTP server with embedded browser chat UI (HTML/CSS/JS inline) |
| `src/mount-security.ts` | Validates additional container mounts against an allowlist stored outside the project root (prevents agents from tampering with security config) |
| `src/session-commands.ts` | Session management commands (e.g. `/compact` for context compaction) — merged from upstream `skill/compact` branch |
| `src/session-commands.test.ts` | Unit tests for session commands |
| `container/skills/cwd/SKILL.md` | Built-in skill: instructs the AI to output `switching to folder: <path>` to update the working folder display |
| `container/skills/pwd/SKILL.md` | Built-in skill: instructs the AI how to determine and report the current working folder |

### Modified files

| File | What changed |
|------|-------------|
| `package.json` | Added `"bin": {"nanoclaw": "dist/cli.js"}` so the package works as an `npx` command |
| `src/channels/index.ts` | Exports the new web channel |
| `src/channels/registry.ts` | Adds `registerGroup` and `onCancelRequest` to `ChannelOpts` so channels can register groups and handle cancel requests |
| `src/index.ts` | Integrates the web channel and session commands into the orchestrator's main loop; exports `main()` for use by `cli.ts`; adds `formatApiError()` to display Anthropic API errors (401/429/529/500) as user-facing chat messages; uses per-session chat IDs as Claude session keys; adds `statusCallback` to forward live tool-use events to the channel |
| `src/group-queue.ts` | Adds `cancelContainer()` — writes the close sentinel and sends SIGTERM to the container process for immediate cancellation |
| `src/db.ts` | Adds `name_updated_at` and `cwd` columns to the `chats` table; updates `updateChatName()` with timestamp guard and optional `nameUpdatedAt` argument; extends `getAllChats()` to return the new columns; adds `getWebSessionOrder()`, `setWebSessionOrder()`, `updateChatCwd()`, `getConversation()`, `deleteChat()`, `clearChatMessages()`, `deleteMessage()` |
| `src/types.ts` | Adds optional `setStatus?(jid, tool, inputSnippet)` to the channel interface so channels can show live tool-use status |
| `src/container-runner.ts` | Adds status-marker protocol (`---NANOCLAW_STATUS_START---` / `---NANOCLAW_STATUS_END---`) so the agent runner can emit tool-use status events; always syncs agent-runner source from master on container start |
| `src/task-scheduler.ts` | Routes scheduled task output for web sessions to a dedicated `local@web-cron` session (with task header); each task runs in its own queue slot (`task:<id>`) for parallel execution; uses per-session session IDs; falls back to the first `isMain` group when the task's `group_folder` is not found |
| `container/agent-runner/src/index.ts` | Updated agent runner: emits status markers for tool use; supports external MCP servers from `MCP-Servers/`; supports context compaction (`/compact`) |

---

## License

MIT — same as the upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).
