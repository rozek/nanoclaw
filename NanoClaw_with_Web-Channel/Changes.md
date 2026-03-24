# Changes vs. upstream qwibitai/nanoclaw

All additions and modifications in the [rozek/nanoclaw](https://github.com/rozek/nanoclaw) fork relative to [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) `main`.

---

## Simplified Installation

Start NanoClaw with a single command — no cloning, no manual setup:

```bash
npx @rozek/nanoclaw
```

On first run, NanoClaw automatically detects the missing database, executes the required setup steps (`environment`, `container`, `mounts --empty`, `verify`), and then starts normally.

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--host <address>` | `127.0.0.1` | Bind address for the web channel |
| `--port <number>` | `3099` | Port for the web channel |
| `--workspace <path>` | current directory | Workspace directory |
| `--key <api-key>` | — | Anthropic API key (not needed with Claude Pro/Max) |
| `--token <token>` | — | Access token for the web UI |
| `--sandbox <type>` | auto-detect | Container runtime: `docker` or `apple` |

### Environment Variables

| Variable | Equivalent option |
|----------|------------------|
| `NANOCLAW_HOST` | `--host` |
| `NANOCLAW_PORT` | `--port` |
| `NANOCLAW_WORKSPACE` | `--workspace` |
| `NANOCLAW_KEY` | `--key` |
| `NANOCLAW_TOKEN` | `--token` |
| `NANOCLAW_SANDBOX` | `--sandbox` |

CLI flags take precedence over environment variables.

---

## Web Channel

A dedicated web channel is built into this fork — in addition to the messaging channels already supported (WhatsApp, Telegram, Discord, …). It consists of an HTTP server and an embedded browser UI, both contained within a single TypeScript file (`src/channels/web.ts`).

---

## HTTP Server

### Endpoints

The HTTP server exposes the following endpoints for access from any client:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Embedded web UI (HTML, CSS, JavaScript) |
| `GET` | `/manifest.json` | PWA web app manifest |
| `GET` | `/favicon.ico` / `/favicon.png` | Favicon |
| `GET` | `/apple-touch-icon.png` | iOS home-screen icon |
| `GET` | `/events?sid=…` | SSE stream for real-time updates |
| `GET` | `/sessions` | All sessions with display order (JSON) |
| `GET` | `/history?sid=…` | Conversation history (JSON) |
| `GET` | `/pwd?sid=…` | Current working folder for a session |
| `POST` | `/message` | Send a chat message |
| `POST` | `/session-name` | Rename a session |
| `POST` | `/session-order` | Persist drag-and-drop session order |
| `POST` | `/delete-session` | Delete a session and all its messages |
| `POST` | `/delete-message` | Delete a single message `{sid, id}` |
| `POST` | `/clear-history` | Delete all messages for a session |
| `POST` | `/cwd` | Set the working folder for a session |
| `POST` | `/upload` | Upload a file (Base64-encoded, max 10 MB) |
| `POST` | `/cancel?sid=…` | Cancel an active agent request |

### Server-Sent Events (SSE)

All live updates are delivered via a single SSE connection per session (`GET /events?sid=…`). On connect, the server immediately pushes the current `typing`, `status`, and `cwd` state so reconnects are seamless.

| Event | Payload | Purpose |
|-------|---------|---------|
| `message` | `{"text":"…","id":"…"}` | Append bot reply |
| `typing` | `"true"` / `"false"` | Show/hide typing indicator |
| `status` | `{"tool":"…","input":"…"}` or `null` | Active tool display |
| `cwd` | path string | Working-folder update |
| `user_message` | `{"text":"…","id":"…"}` | User message from another device |
| `delete_message` | `{"id":"…"}` | Message deleted — remove from UI |
| `sessions_changed` | `{"added"/"renamed"/"deleted":"…"}` | Session list mutation — all clients refresh immediately |
| `ping` | *(empty)* | Heartbeat every 20 s; client reconnects if no ping received within 35 s |

### Access Control

Token protection is optional but recommended when NanoClaw is accessible from the LAN. Clients authenticate via any of:

1. `Authorization: Bearer <token>` HTTP header
2. `?token=<token>` URL query parameter — automatically upgraded to an HttpOnly session cookie
3. The session cookie (`nanoclaw_token`, `HttpOnly`, `SameSite=Strict`) set after step 2

### Request Size Limits

- Standard POST requests: **1 MB**
- File upload (`/upload`): **10 MB** per file

---

## Session Management

Each session is a NanoClaw group with the internal name `web-<uuid>`:

- **Isolated IPC directory** — agent containers run independently of each other
- **Shared workspace via symlink** — all sessions share the same agent context (`groups/main/`), memory, skills, tools, and MCP servers
- **Dedicated `web-cron` session** — output from all scheduled cron jobs is routed here
- **Custom session names** — user-editable, conflict-free across devices via `nameUpdatedAt` timestamp guard
- **Custom session order** — drag-and-drop, persisted on the server
- **All clients see the same sessions and messages** — NanoClaw is designed for a single user; every browser/device is fully in sync
- **Custom working directory per session** — always relative to the NanoClaw workspace; absolute paths outside the workspace are silently clamped to the root
- **File uploads** go into the session's current working directory (max 10 MB per file)

---

## Web UI

### Layout & Design

- Responsive full-viewport layout: fixed sidebar on desktop, slide-over overlay on mobile
- Sidebar width adjustable by dragging the grip handle; persisted in `localStorage`
- Connection status indicator (green / red dot)
- Header shows the NanoClaw server address and the session's current working directory

### Working Directory Commands

Type directly in the chat input:

- `/cwd <path>` — change the working folder instantly (no agent invocation)
- `/pwd` — display the current working folder

### Session List (Sidebar)

- Real-time sync across all connected clients via SSE `sessions_changed` events
- Sort sessions by drag-and-drop
- Create, rename, and delete sessions
- Unread indicator (blue dot) for sessions with new messages not yet viewed
- New sessions initially always appear at the top of the list
- Session ID persisted in `localStorage` — Android tab eviction does not create a new session on reload

### Chat View

- Classic chat layout with user messages (right) and bot replies (left)
- Bot replies rendered with full Markdown support:
  - [marked.js](https://marked.js.org) for GitHub Flavored Markdown
  - [highlight.js](https://highlightjs.org) for syntax highlighting
  - [KaTeX](https://katex.org) for inline (`$…$`) and block (`$$…$$`) math
  - [Mermaid](https://mermaid.js.org) for flowcharts, sequence diagrams, etc.
- Live tool-use status line while the agent is processing (e.g. "Searching…")
- Cancel button to abort an in-progress request (sends SIGTERM to the container)
- Trash button on every message — individual user and bot messages can be deleted; deletion is broadcast to all clients immediately
- Copy button on bot replies (whole message) and on individual fenced code blocks
- Copy button on user messages
- Auto-scroll to bottom only when the user is already near the bottom (≤ 150 px); scrolling up to read history is not interrupted

### File Upload

Drag one or more files onto the chat window to upload them into the session's current working directory.

### Progressive Web App (PWA)

NanoClaw can be installed as a PWA and added to the home screen or desktop:

- **Android / Chrome**: browser menu → *Add to Home Screen*
- **iOS / Safari**: Share → *Add to Home Screen*
- **Desktop Chrome / Edge**: install icon in the address bar

The app runs in standalone mode (no browser chrome) and always loads the current version from the server — no service worker, no offline cache.

Important: while the NanoClaw may be installed as a PWA, it does not follow the **not offline-first** model (as you will need a connection to Claude Code anyway)

### Android Reliability

- SSE heartbeat (`ping` every 20 s) keeps connections alive on Android
- Stale-connection detector: if no `ping` is received in 35 s while the connection appears live, the client reconnects and re-fetches history
- `visibilitychange` handler reconnects immediately when the tab becomes visible again (foldable open, screen on, app switched back)
- Touch detection via `pointer: coarse` media query — suppresses auto-focus on the text input so the virtual keyboard does not always pop up on session switch

---

## Live Configuration Updates

Changes to the following directories take effect with the next agent request — no restart required, and changes are available from every session:

| Path | Content |
|------|---------|
| `groups/main/Skills/` | Subdirectories, each containing a `SKILL.md` — loaded automatically when the description matches a request |
| `groups/main/Tools/` | Subdirectories with `TOOL.md` + `TOOL.js` — exposed as callable tools to the agent |
| `groups/main/MCP-Servers/` | JSON files, each configuring an external MCP server (stdio or HTTP/SSE) |

This is the preferred way to extend NanoClaw — including by NanoClaw itself.
