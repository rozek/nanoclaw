# NanoClaw with Web Support

This document describes the changes added in the [rozek/nanoclaw](https://github.com/rozek/nanoclaw) fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). It serves as installation guide, feature reference, and API documentation.

---

## What's New

Two files were added or changed relative to the upstream project:

| File | What changed |
|------|-------------|
| `src/cli.ts` | **New.** CLI entry point — enables `npx nanoclaw` |
| `src/channels/web.ts` | **New.** Built-in HTTP server with a full browser chat UI |
| `package.json` | Added `"bin": {"nanoclaw": "dist/cli.js"}` for `npx` support |

Everything else remains unchanged. No existing file was modified in a breaking way.

---

## Quick Start (npx)

No cloning, no `npm install` — just run:

```bash
npx nanoclaw
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

## Installation & Usage

### Simplest start

```bash
npx nanoclaw
```

Auto-detects the container runtime (Docker first, then Apple Container). Binds to `0.0.0.0:3099`.

### Common options

```bash
# Custom port
npx nanoclaw --port 8080

# Custom workspace (directory NanoClaw works in)
npx nanoclaw --workspace ~/my-workspace

# Token protection — recommended when accessible from the LAN
npx nanoclaw --token mySecretToken

# Explicit container runtime
npx nanoclaw --sandbox docker
npx nanoclaw --sandbox apple

# With an Anthropic API key (for users without Pro/Max)
npx nanoclaw --key sk-ant-...

# Combine options
npx nanoclaw --port 8080 --workspace ~/my-workspace --token mySecretToken --sandbox docker
```

### All CLI options

```
Options:
  --host <address>      Bind address for the web channel  (default: 0.0.0.0)
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
NANOCLAW_HOST=0.0.0.0
NANOCLAW_PORT=3099
NANOCLAW_TOKEN=mySecretToken
NANOCLAW_KEY=sk-ant-...
NANOCLAW_WORKSPACE=/path/to/workspace
NANOCLAW_SANDBOX=docker   # or: apple
```

---

## Web Channel Features

### UI & Design

- **Light theme** — clean, distraction-free (#f5f5f5 background, #ffffff header/cards)
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
- Sessions are listed in the sidebar, freely sortable by most recent activity
- Each session has an editable name (double-click or pencil icon; default: date+time)
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

On connect, the server immediately sends the current `typing`, `status`, and `cwd` state so reconnects are seamless.

### Working Directory (CWD)

- Current working directory shown in the header: `NanoClaw — IP:Port — /Topics/TopicName`
- Automatically detected from agent output (`switching to topic: <name>`)
- Persisted in `chats.cwd` (SQLite) — survives server restarts
- Also cached in `localStorage` per session

### File Upload

- Drag files into the browser window
- Files are written to the session's current working directory (or group root if no CWD)
- Maximum file size: 10 MB

### Cancel In-Progress Requests

- A **Cancel** button appears while the agent is processing
- Sends `POST /cancel?sid=…` to abort the current request

### Access Control

Token-based authentication is optional but recommended when NanoClaw is reachable from the LAN:

```bash
npx nanoclaw --token mySecretToken
```

Clients authenticate via:
1. `Authorization: Bearer mySecretToken` header
2. `?token=mySecretToken` URL query parameter (sets an HttpOnly session cookie)
3. The HttpOnly session cookie set after step 2

---

## HTTP API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the web UI (HTML) |
| `GET` | `/events?sid=…` | SSE stream for real-time updates |
| `GET` | `/sessions` | All web sessions (JSON) |
| `GET` | `/history?sid=…` | Conversation history (JSON) |
| `GET` | `/favicon.ico` | Favicon (ICO) |
| `GET` | `/favicon.png` | Favicon (PNG) |
| `GET` | `/apple-touch-icon.png` | iOS home-screen icon |
| `POST` | `/message` | Send a chat message |
| `POST` | `/session-name` | Rename a session |
| `POST` | `/delete-session` | Delete a session and all its messages |
| `POST` | `/delete-message` | Delete a single message `{sid, id}` |
| `POST` | `/cwd` | Set the working directory for a session |
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
GET /history   ←─────────────  getConversation()             messages table
POST /delete-session  ──────→  deleteChat()                  chats + messages
POST /delete-message  ──────→  deleteMessage(id)             messages table
POST /cwd      ────────────→   setCwd() → broadcast          chats.cwd
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
# or equivalently:
npx nanoclaw [options]
```

To apply changes and rebuild in one step:

```bash
npm run build && node dist/cli.js
```

---

## License

MIT — same as the upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).
