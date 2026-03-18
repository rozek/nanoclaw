import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import { NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import {
  getAllChats,
  getConversation,
  storeMessage,
  storeChatMetadata,
  updateChatName,
  updateChatCwd,
  deleteChat,
  clearChatMessages,
  deleteMessage,
  getWebSessionOrder,
  setWebSessionOrder,
} from '../db.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';

// NANOCLAW_PORT/HOST/TOKEN are the canonical env var names; WEB_CHANNEL_* kept for backward compat.
const PORT = parseInt(
  process.env.NANOCLAW_PORT || process.env.WEB_CHANNEL_PORT || '3099',
  10,
);
const HOST =
  process.env.NANOCLAW_HOST || process.env.WEB_CHANNEL_HOST || '0.0.0.0';
/** Optional access token for the web interface. Empty string = no protection. */
const TOKEN = process.env.NANOCLAW_TOKEN || '';
const WEB_JID_PREFIX = 'local@web-';
const GROUP_FOLDER = 'main';
const CRON_GROUP_FOLDER = 'web-cron'; // separate folder so cron container gets its own IPC directory
const GROUP_NAME = 'Web Chat';
const CRON_SESSION_ID = 'cron';
const CRON_SESSION_NAME = 'Cron Jobs';
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB  — default for all POST bodies
const MAX_UPLOAD_BODY_SIZE = 10 * 1024 * 1024; // 10 MB — for /upload (Base64 file data)

// Per-session SSE clients and ephemeral UI state
const sseClients = new Map<string, Set<http.ServerResponse>>();
const sessionCwds = new Map<string, string>();
const sessionTyping = new Map<string, boolean>(); // true while agent is processing
const sessionStatus = new Map<string, string>(); // last status SSE payload (or 'null')
const registeredSessions = new Set<string>();

/**
 * Sanitize a session name:
 *  - removes Unicode control characters (Cc: U+0000–U+001F, U+007F–U+009F)
 *  - trims leading/trailing whitespace
 *  - limits to 256 characters
 * Returns null if the result is empty (name should be rejected).
 */
function sanitizeSessionName(raw: string): string | null {
  const cleaned = raw
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, 256);
  return cleaned || null;
}

/** Parse the Cookie request header into a key→value map. */
function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const eq = part.indexOf('=');
      if (eq < 1) return [];
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      try {
        return [[k, decodeURIComponent(v)]];
      } catch {
        return [[k, v]];
      }
    }),
  );
}

/**
 * Authorize the request and optionally upgrade to a session cookie.
 *
 * - No TOKEN configured → always returns true (no-op).
 * - Token matches via ?token= query param → sets HttpOnly cookie so subsequent
 *   requests (SSE, API calls) are automatically authorized without repeating the token.
 * - Token does not match → sends 401 and returns false.
 *
 * Accepted token locations (checked in order):
 *   1. Cookie          nanoclaw_token=<token>
 *   2. Authorization   Bearer <token>
 *   3. Query param     ?token=<value>  (also upgrades to cookie on match)
 *
 * Must be called before response headers are written. If it returns false the
 * response has already been sent — return from the caller immediately.
 */
function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!TOKEN) return true;
  const cookies = parseCookies(req);
  if (cookies['nanoclaw_token'] === TOKEN) return true;
  const auth = req.headers['authorization'] ?? '';
  if (auth.startsWith('Bearer ') && auth.slice(7) === TOKEN) return true;
  // Parse ?token= once — used for both the auth check and the cookie upgrade.
  const raw = req.url?.match(/[?&]token=([^&]*)/)?.[1];
  if (raw !== undefined) {
    try {
      if (decodeURIComponent(raw) === TOKEN) {
        res.setHeader(
          'Set-Cookie',
          `nanoclaw_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return true;
      }
    } catch {
      /* ignore malformed param */
    }
  }
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="NanoClaw"',
  });
  res.end('{"error":"Unauthorized"}');
  return false;
}

/**
 * Collect the full POST body, enforcing a size limit.
 * Sends 413 and returns early if the body exceeds maxSize.
 * Calls callback(body) once the full body has been read.
 *
 * @param maxSize - byte limit (defaults to MAX_BODY_SIZE = 1 MB)
 */
function collectBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  callback: (body: string) => void,
  maxSize: number = MAX_BODY_SIZE,
): void {
  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > maxSize) {
      tooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end('{"error":"Request too large"}');
      req.resume(); // drain so the socket can close cleanly
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    callback(body);
  });
  req.on('error', () => {
    tooLarge = true; // prevent callback from firing after a request error
    if (!res.headersSent) {
      res.writeHead(400);
      res.end('Bad request');
    }
  });
}

/** Set CWD in the in-memory cache AND persist it to the DB. */
function setCwd(sessionId: string, cwd: string): void {
  sessionCwds.set(sessionId, cwd);
  try {
    updateChatCwd(WEB_JID_PREFIX + sessionId, cwd);
  } catch {}
}

function getOrCreateClientSet(sessionId: string): Set<http.ServerResponse> {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  return sseClients.get(sessionId)!;
}

function broadcastToSession(
  sessionId: string,
  event: string,
  data: string,
): void {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${data}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function sessionIdFromJid(jid: string): string {
  return jid.startsWith(WEB_JID_PREFIX)
    ? jid.slice(WEB_JID_PREFIX.length)
    : jid;
}

function sidFromUrl(url: string | undefined): string {
  const raw = url?.match(/[?&]sid=([^&]+)/)?.[1] ?? 'default';
  // Sanitize: only alphanumeric, hyphens and underscores, max 64 chars
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
}

function getLocalIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NanoClaw</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; display: flex; flex-direction: column; overflow: hidden; }

    /* Header */
    #header { background: #fff; padding: 10px 16px; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 16px; flex-shrink: 0; }
    #toggle-sidebar { background: none; border: none; cursor: pointer; font-size: 20px; color: #555; padding: 2px 6px; border-radius: 4px; line-height: 1; }
    #toggle-sidebar:hover { background: #f0f0f0; }
    #header-title { flex-shrink: 0; white-space: nowrap; }
    #header-cwd { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #888; font-weight: normal; font-size: 14px; min-width: 0; font-family: monospace; }

    /* Main area */
    #main-area { display: flex; flex: 1; overflow: hidden; }

    /* Sidebar */
    #sidebar { width: 220px; min-width: 220px; background: #fff; border-right: 1px solid #e0e0e0; display: flex; flex-direction: column; transition: width 0.2s, min-width 0.2s; overflow: hidden; }
    #sidebar.collapsed { width: 0; min-width: 0; }
    #sidebar-header { padding: 10px 12px; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    #sidebar-title { font-weight: 600; font-size: 13px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; }
    #new-session-btn { background: none; border: 1px solid #d0d0d0; color: #555; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; flex-shrink: 0; }
    #new-session-btn:hover { background: #f0f0f0; border-color: #aaa; }
    #session-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
    .session-item { display: flex; align-items: center; padding: 7px 8px; border-radius: 6px; cursor: pointer; gap: 6px; min-width: 0; }
    .session-item:hover { background: #f5f5f5; }
    .session-item.active { background: #eff6ff; }
    .session-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1a1a1a; }
    .session-item.active .session-name { color: #2563eb; font-weight: 500; }
    .session-item.unread .session-name { font-weight: 600; }
    .session-unread-dot { width: 7px; height: 7px; border-radius: 50%; background: #2563eb; flex-shrink: 0; display: none; }
    .session-item.unread .session-unread-dot { display: block; }
    .session-name-input { flex: 1; font-size: 13px; border: 1px solid #2563eb; border-radius: 3px; padding: 1px 4px; outline: none; min-width: 0; }
    .session-actions { display: none; align-items: center; gap: 1px; flex-shrink: 0; }
    .session-item:hover .session-actions { display: flex; }
    .session-btn { background: none; border: none; cursor: pointer; color: #999; padding: 2px 3px; border-radius: 3px; font-size: 13px; line-height: 1; }
    .session-btn:hover { background: #e0e0e0; color: #333; }

    /* Messages */
    #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg-row { display: flex; align-items: flex-start; gap: 5px; }
    .msg-row.bot { justify-content: flex-start; }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.user .del-btn { order: -1; }
    .del-btn { flex-shrink: 0; background: none; border: none; cursor: pointer; color: #ccc; padding: 2px 3px; line-height: 1; border-radius: 4px; transition: color 0.15s; margin-top: 7px; }
    .del-btn:hover { color: #ef4444; }
    .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; line-height: 1.6; word-break: break-word; font-size: 15px; }
    .msg.user { background: #2563eb; color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
    .msg.bot { background: #ffffff; border: 1px solid #e0e0e0; border-bottom-left-radius: 4px; position: relative; }
    .msg.typing { color: #888; font-style: italic; }
    .msg.status { color: #999; font-size: 12px; font-style: italic; background: transparent; border: none; padding: 2px 0; max-width: 100%; }
    .msg.bot p { margin: 0.4em 0; }
    .msg.bot p:first-child { margin-top: 0; }
    .msg.bot p:last-child { margin-bottom: 0; }
    .msg.bot ul, .msg.bot ol { padding-left: 1.5em; margin: 0.4em 0; }
    .msg.bot li { margin: 0.2em 0; }
    .msg.bot h1, .msg.bot h2, .msg.bot h3, .msg.bot h4 { margin: 0.6em 0 0.3em; line-height: 1.3; }
    .msg.bot pre { background: #f6f8fa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px 14px; overflow-x: auto; margin: 0.6em 0; white-space: pre; position: relative; }
    .copy-btn { position: absolute; top: 6px; right: 6px; background: none; border: none; border-radius: 4px; padding: 2px 4px; cursor: pointer; color: #bbb; transition: color 0.15s; line-height: 1; }
    .copy-btn:hover { color: #555; }
    .copy-btn.copied { color: #16a34a; }
    .msg.bot code { background: #f0f2f4; padding: 2px 5px; border-radius: 4px; font-size: 0.88em; font-family: monospace; }
    .msg.bot pre code { background: none; padding: 0; font-size: 0.88em; }
    .msg.bot blockquote { border-left: 3px solid #d0d0d0; padding-left: 12px; color: #666; margin: 0.5em 0; }
    .msg.bot table { border-collapse: collapse; margin: 0.6em 0; }
    .msg.bot th, .msg.bot td { border: 1px solid #e0e0e0; padding: 6px 12px; }
    .msg.bot th { background: #f0f2f4; font-weight: 600; }
    .msg.bot a { color: #2563eb; text-decoration: underline; }
    .msg.bot hr { border: none; border-top: 1px solid #e0e0e0; margin: 0.6em 0; }

    /* Input */
    #input-area { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e0e0e0; background: #f5f5f5; flex-shrink: 0; }
    #input { flex: 1; background: #fff; border: 1px solid #d0d0d0; color: #1a1a1a; padding: 10px 14px; border-radius: 8px; font-size: 15px; outline: none; resize: none; max-height: 120px; }
    #input:focus { border-color: #2563eb; }
    #send { background: #2563eb; color: #fff; border: none; padding: 10px 18px; border-radius: 8px; cursor: pointer; font-size: 15px; }
    #send:hover { background: #1d4ed8; }
    #send:disabled { background: #aaa; cursor: default; }
    #cancel-btn { background: #ef4444; color: #fff; border: none; padding: 10px 14px; border-radius: 8px; cursor: pointer; font-size: 15px; display: none; }
    #cancel-btn:hover { background: #dc2626; }

    /* Drop overlay */
    #drop-overlay { display:none; position:fixed; inset:0; background:rgba(74,144,217,0.15); border:3px dashed #4a90d9; z-index:100; align-items:center; justify-content:center; font-size:24px; color:#4a90d9; pointer-events:none; }
    #drop-overlay.active { display:flex; }

    /* Connection indicator dot */
    #conn-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: #ccc; transition: background 0.4s; }
    #conn-dot.connected    { background: #22c55e; }
    #conn-dot.connecting   { background: #f59e0b; animation: pulse-dot 1.2s ease-in-out infinite; }
    #conn-dot.disconnected { background: #ef4444; }
    @keyframes pulse-dot { 0%,100% { opacity:1; } 50% { opacity:0.35; } }

    /* Session drag-and-drop */
    .session-item.drag-src  { opacity: 0.45; }
    .session-item.drag-over { border-top: 2px solid #2563eb; margin-top: -2px; }

    /* Mobile: sidebar as overlay so it doesn't squish the chat area */
    @media (max-width: 640px) {
      #main-area { position: relative; }
      #sidebar { position: absolute; top: 0; left: 0; height: 100%; z-index: 50; box-shadow: 2px 0 8px rgba(0,0,0,0.18); }
    }
    /* Backdrop sits behind the sidebar but above the chat — JS controls display */
    #sidebar-backdrop { display: none; position: absolute; inset: 0; z-index: 49; background: transparent; }
  </style>
</head>
<body>
  <div id="drop-overlay">Dateien hier ablegen</div>

  <div id="header">
    <button id="toggle-sidebar" title="Sidebar ein-/ausblenden">☰</button>
    <span id="header-title">NanoClaw — __SERVER_ADDRESS__</span>
    <span id="header-cwd"></span>
    <span id="conn-dot" title="Verbindet…"></span>
  </div>

  <div id="main-area">
    <div id="sidebar-backdrop"></div>
    <div id="sidebar">
      <div id="sidebar-header">
        <span id="sidebar-title">Chats</span>
        <button id="new-session-btn" title="Neuen Chat starten">+</button>
      </div>
      <div id="session-list"></div>
    </div>
    <div id="messages"></div>
  </div>

  <div id="input-area">
    <textarea id="input" rows="1" placeholder="Type a message…"></textarea>
    <button id="cancel-btn" title="Anfrage abbrechen">✕</button>
    <button id="send">Send</button>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/java.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script>
    // ── Markdown renderer ──────────────────────────────────────────────────
    const renderer = {
      code(code, lang) {
        if (lang === 'mermaid') return '<pre class="mermaid">' + code + '</pre>';
        const language = (lang && hljs.getLanguage(lang)) ? lang : 'plaintext';
        return '<pre><code class="hljs language-' + language + '">' +
          hljs.highlight(code, { language }).value + '</code></pre>';
      }
    };
    marked.use({ renderer, gfm: true, breaks: true });
    mermaid.initialize({ startOnLoad: false, theme: 'default' });

    // ── UUID helper (works in non-secure contexts, e.g. http:// on Android) ──
    function uuid() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }

    // ── Session storage helpers ────────────────────────────────────────────
    function loadSessions() {
      try {
        const list = JSON.parse(localStorage.getItem('sessions') || '[]');
        // Repair sessions with missing names (defensive, handles stale/corrupted data)
        let repaired = false;
        for (const s of list) {
          if (!s.name) {
            s.name = sessionLabel(new Date(s.createdAt || Date.now()));
            // Use old timestamp (createdAt) so server wins on next merge if it has a real name
            s.nameUpdatedAt = s.createdAt || 0;
            repaired = true;
          }
        }
        if (repaired) localStorage.setItem('sessions', JSON.stringify(list));
        return list;
      } catch { return []; }
    }
    function saveSessions(list) { localStorage.setItem('sessions', JSON.stringify(list)); }
    function sessionLabel(date) {
      if (!date || isNaN(date.getTime())) date = new Date(); // guard against Invalid Date
      try {
        const s = date.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
        if (s && s.length > 3) return s;
      } catch {}
      // Fallback for environments where Intl/de-DE is unavailable (e.g. some Android WebViews)
      const p = n => String(n).padStart(2, '0');
      return p(date.getDate()) + '.' + p(date.getMonth()+1) + '.' + String(date.getFullYear()).slice(2)
           + ', ' + p(date.getHours()) + ':' + p(date.getMinutes());
    }
    function saveCwd(sid, cwd) { localStorage.setItem('cwd:' + sid, cwd); }
    function loadCwd(sid) { return localStorage.getItem('cwd:' + sid) || ''; }

    function ensureSessionInList(sid) {
      const list = loadSessions();
      const existing = list.find(s => s.id === sid);
      if (!existing) {
        const now = Date.now();
        list.unshift({ id: sid, name: sessionLabel(new Date()), createdAt: now, isOwn: true, nameUpdatedAt: now });
        saveSessions(list);
        return true; // newly created
      } else {
        // Fix missing isOwn flag or empty name from previous versions
        let changed = false;
        if (!existing.isOwn) { existing.isOwn = true; changed = true; }
        if (!existing.name) {
          existing.name = sessionLabel(new Date(existing.createdAt || Date.now()));
          // Use old timestamp so server wins on merge if it has a real name
          existing.nameUpdatedAt = existing.createdAt || 0;
          changed = true;
        }
        if (changed) saveSessions(list);
        return false; // already existed
      }
    }

    // ── Message history (per session, in localStorage) ─────────────────────
    const MAX_HISTORY = 200;
    function saveScroll(sid) {
      if (!sid) return;
      try { localStorage.setItem('scroll:' + sid, String(msgsEl.scrollTop)); } catch {}
    }
    function loadScroll(sid) {
      try { const v = localStorage.getItem('scroll:' + sid); return v !== null ? parseInt(v, 10) : null; } catch { return null; }
    }
    function deleteScroll(sid) { localStorage.removeItem('scroll:' + sid); }

    function appendHistory(sid, text, cls, msgId) {
      try {
        const key = 'hist:' + sid;
        const hist = JSON.parse(localStorage.getItem(key) || '[]');
        hist.push({ text, cls, id: msgId || null });
        if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
        localStorage.setItem(key, JSON.stringify(hist));
      } catch {}
    }
    function loadHistory(sid) {
      try { return JSON.parse(localStorage.getItem('hist:' + sid) || '[]'); } catch { return []; }
    }
    function deleteHistory(sid) { localStorage.removeItem('hist:' + sid); }

    // ── DOM refs ──────────────────────────────────────────────────────────
    const msgsEl      = document.getElementById('messages');
    const inputEl     = document.getElementById('input');
    const sendBtn     = document.getElementById('send');
    const sidebar     = document.getElementById('sidebar');
    const listEl      = document.getElementById('session-list');
    const headerTitle = document.getElementById('header-title');
    const connDot     = document.getElementById('conn-dot');
    const headerCwd   = document.getElementById('header-cwd');
    const serverAddress = '__SERVER_ADDRESS__';

    let typingEl        = null;
    let statusEl        = null;   // live tool-use status element (shown below typing indicator)
    let sessionId       = sessionStorage.getItem('sid');
    let es              = null;   // EventSource
    let sseGeneration   = 0;      // incremented each setupSSE() call; guards against stale events
    let currentTyping   = false;  // last-known typing state from SSE
    let currentStatus   = null;   // last-known status payload from SSE
    let dragSrcId       = null;   // session being dragged
    let dragOverEl      = null;   // item currently highlighted as drop target
    let botHasResponded = false;  // true after bot sends a reply; reset on new user message / session switch

    // ── Unread tracking ───────────────────────────────────────────────────
    // Persisted in localStorage ('seen:{sid}') so unread state survives reloads.
    // A session is unread if server's lastMessage timestamp > last-seen timestamp.
    const unreadSessions = new Set();
    function loadLastSeen(sid) {
      try { const v = localStorage.getItem('seen:' + sid); return v !== null ? parseInt(v, 10) : null; } catch { return null; }
    }
    function saveLastSeen(sid, ts) {
      try { localStorage.setItem('seen:' + sid, String(ts)); } catch {}
    }
    function markRead(sid) {
      saveLastSeen(sid, Date.now());
      if (unreadSessions.delete(sid)) renderSessions();
    }

    // ── Connection indicator ──────────────────────────────────────────────
    const connLabels = { connecting: 'Verbindet…', connected: 'Verbunden', disconnected: 'Getrennt' };
    function setConnState(state) {
      connDot.className = state;
      connDot.title = connLabels[state] || '';
    }
    setConnState('connecting');

    // ── Sidebar toggle ────────────────────────────────────────────────────
    const isMobile = window.innerWidth <= 640;
    // On mobile: always open initially (overlay mode); on desktop: respect saved pref
    let sidebarOpen = isMobile ? true : (localStorage.getItem('sidebarOpen') !== 'false');
    const backdrop = document.getElementById('sidebar-backdrop');
    function setSidebar(open) {
      sidebarOpen = open;
      // Only persist state on desktop — on mobile sidebar is always an overlay
      if (!isMobile) localStorage.setItem('sidebarOpen', String(open));
      sidebar.classList.toggle('collapsed', !open);
      // Backdrop only active (visible + interactive) when sidebar is open on mobile
      if (backdrop) backdrop.style.display = (isMobile && open) ? 'block' : 'none';
    }
    setSidebar(sidebarOpen);
    document.getElementById('toggle-sidebar').addEventListener('click', () => setSidebar(!sidebarOpen));
    // Tap backdrop to close sidebar on mobile
    if (backdrop) backdrop.addEventListener('click', () => setSidebar(false));

    // ── Header ────────────────────────────────────────────────────────────
    function updateHeader(cwd) {
      headerTitle.textContent = 'NanoClaw \u2014 ' + serverAddress;
      headerCwd.textContent = ' \u2014 /' + (cwd || '');
    }

    // ── Messages ──────────────────────────────────────────────────────────
    const ICON_COPY  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

    function flashCopied(btn) {
      btn.innerHTML = ICON_CHECK;
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = ICON_COPY; btn.classList.remove('copied'); }, 1500);
    }

    function renderMsg(text, cls, msgId) {
      const row = document.createElement('div');
      row.className = 'msg-row ' + (cls.startsWith('bot') || cls === 'status' ? 'bot' : 'user');
      const d = document.createElement('div');
      d.className = 'msg ' + cls;
      if (cls === 'bot') {
        d.innerHTML = marked.parse(text);
        renderMathInElement(d, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\\\[', right: '\\\\]', display: true },
            { left: '\\\\(', right: '\\\\)', display: false }
          ],
          throwOnError: false
        });
        try { mermaid.run({ nodes: d.querySelectorAll('.mermaid') }); } catch { /* mermaid bug in strict mode — ignore */ }
        // Add copy button to each fenced code block
        d.querySelectorAll('pre').forEach(pre => {
          const btn = document.createElement('button');
          btn.className = 'copy-btn';
          btn.innerHTML = ICON_COPY;
          btn.title = 'Code kopieren';
          btn.addEventListener('click', e => {
            e.stopPropagation();
            const code = pre.querySelector('code');
            navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => flashCopied(btn)).catch(() => {});
          });
          pre.appendChild(btn);
        });
        // Add copy-whole-message button (top-right, same line as trash)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = ICON_COPY;
        copyBtn.title = 'Antwort kopieren';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => flashCopied(copyBtn)).catch(() => {});
        });
        d.appendChild(copyBtn);
      } else {
        d.textContent = text;
      }
      // Trash button — inside the bubble, top corner, always visible; only for real messages with a DB id
      row.appendChild(d);
      // Trash button — outside the bubble, always visible; only for real messages with a DB id
      if (msgId && cls !== 'bot typing' && cls !== 'status') {
        const delBtn = document.createElement('button');
        delBtn.className = 'del-btn';
        delBtn.title = 'Nachricht löschen';
        delBtn.innerHTML = ICON_TRASH;
        delBtn.addEventListener('click', async () => {
          try {
            await fetch('/delete-message', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sid: sessionId, id: msgId }),
            });
            row.remove();
            // Remove from localStorage cache
            try {
              const hist = loadHistory(sessionId).filter(m => m.id !== msgId);
              localStorage.setItem('hist:' + sessionId, JSON.stringify(hist));
            } catch {}
          } catch {}
        });
        row.appendChild(delBtn);
      }
      msgsEl.appendChild(row);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      return row;
    }

    function addMsg(text, cls, msgId) {
      // Save to history (skip typing indicator)
      if (cls !== 'bot typing') appendHistory(sessionId, text, cls, msgId);
      return renderMsg(text, cls, msgId);
    }

    const cancelBtn = document.getElementById('cancel-btn');

    function setTyping(on) {
      currentTyping = on;
      if (on && !typingEl) { typingEl = renderMsg('…', 'bot typing'); }
      if (!on && typingEl) { typingEl.remove(); typingEl = null; }
      if (!on) setStatusDisplay(null); // clear status when typing stops
      cancelBtn.style.display = on ? 'block' : 'none';
    }

    cancelBtn.addEventListener('click', () => {
      fetch('/cancel?sid=' + sessionId, { method: 'POST' }).catch(() => {});
    });

    /** Show/update/clear the live tool-use status line below the typing indicator. */
    function setStatusDisplay(tool, inputSnippet) {
      currentStatus = tool ? { tool, inputSnippet } : null;
      if (!tool) {
        if (statusEl) { statusEl.remove(); statusEl = null; }
        return;
      }
      // Format display text: tool name + optional brief input snippet
      let label = tool === 'thinking' ? 'thinking\u2026' : tool + '\u2026';
      if (inputSnippet && tool !== 'thinking') {
        const snippet = inputSnippet.length > 60 ? inputSnippet.slice(0, 60) + '\u2026' : inputSnippet;
        label = tool + ': ' + snippet;
      }
      if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.className = 'msg status';
        msgsEl.appendChild(statusEl);
      }
      statusEl.textContent = label;
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }

    function restoreHistory(sid) {
      for (const { text, cls, id } of loadHistory(sid)) renderMsg(text, cls, id);
      const saved = loadScroll(sid);
      msgsEl.scrollTop = saved !== null ? saved : msgsEl.scrollHeight;
    }

    async function fetchServerHistory(sid) {
      try {
        const resp = await fetch('/history?sid=' + sid);
        if (!resp.ok) return;
        if (sid !== sessionId) return; // session changed while fetching — discard stale result
        const hist = await resp.json();
        if (sid !== sessionId) return; // check again after JSON parse
        msgsEl.innerHTML = '';
        typingEl = null;
        statusEl = null;
        for (const { text, cls, id } of hist) renderMsg(text, cls, id);
        // Re-append typing/status indicators only if the agent is still processing.
        // If the last DB message is already a bot response, the agent has finished —
        // force-clear any stale typing/status state (server's sessionTyping may lag
        // behind due to a race between the bot response and an SSE reconnect).
        const agentDone = hist.length > 0 && hist[hist.length - 1].cls === 'bot';
        if (agentDone) {
          botHasResponded = true;
          setTyping(false); // resets currentTyping + currentStatus via setStatusDisplay(null)
        } else {
          if (currentTyping) setTyping(true);
          if (currentStatus) setStatusDisplay(currentStatus.tool, currentStatus.inputSnippet);
        }
        const saved = loadScroll(sid);
        msgsEl.scrollTop = saved !== null ? saved : msgsEl.scrollHeight;
        // Mark this session as read — history was fully loaded, user has "seen" all messages
        markRead(sid);
        // Cache in localStorage for faster access next time
        try {
          localStorage.setItem('hist:' + sid, JSON.stringify(
            hist.slice(-MAX_HISTORY)
          ));
        } catch {}
      } catch {}
    }

    async function mergeServerSessions() {
      try {
        const resp = await fetch('/sessions');
        if (!resp.ok) return;
        const payload = await resp.json();
        // Response is now { sessions, order } — fall back to plain array for compat
        const serverSessions = Array.isArray(payload) ? payload : (payload.sessions ?? []);
        const serverOrder = Array.isArray(payload) ? [] : (payload.order ?? []);
        const serverIds = new Set(serverSessions.map(ss => ss.id));
        let local = loadSessions();
        let changed = false;

        // Add or update sessions from server
        for (const ss of serverSessions) {
          const existing = local.find(s => s.id === ss.id);
          if (!existing) {
            // New session from another window/browser — use server name, fall back to date label
            const serverName = ss.name && ss.name !== 'Web Chat' ? ss.name : null;
            const lastMsgDate = ss.lastMessage ? new Date(ss.lastMessage) : null;
            const validDate = (lastMsgDate && !isNaN(lastMsgDate.getTime())) ? lastMsgDate : new Date();
            // unshift() so new sessions appear at the top without re-sorting the whole
            // list (which would destroy any manual drag-and-drop ordering).
            local.unshift({
              id: ss.id,
              name: serverName || sessionLabel(validDate),
              createdAt: validDate.getTime(),
              fromServer: true,
              nameUpdatedAt: ss.nameUpdatedAt || 0,
            });
            changed = true;
          } else {
            // Mark as known to server
            if (!existing.fromServer) { existing.fromServer = true; changed = true; }
            // Compare nameUpdatedAt timestamps to decide who wins.
            // Default to createdAt (or 0) if nameUpdatedAt is missing (old data).
            const localTs  = existing.nameUpdatedAt ?? existing.createdAt ?? 0;
            const serverTs = ss.nameUpdatedAt || 0;
            if (serverTs > localTs && ss.name && ss.name !== 'Web Chat') {
              // Server has a newer rename → update local
              existing.name = ss.name;
              existing.nameUpdatedAt = serverTs;
              changed = true;
            } else if (localTs > serverTs && existing.name && existing.name !== 'Web Chat' && existing.name !== ss.name) {
              // Local is newer → push back to server so other devices sync
              // (server-side guard prevents overwrite if server already has something newer)
              pushNameToServer(existing.id, existing.name, localTs);
            }
          }
        }

        // Remove local sessions that were from the server but are no longer there (deleted elsewhere)
        const before = local.length;
        let activeSessionRemoved = false;
        local = local.filter(s => {
          if (!s.fromServer) return true;          // locally-created, not yet confirmed by server → keep
          if (s.isOwn) return true;               // created in this browser → never auto-remove
          if (serverIds.has(s.id)) return true;   // still on server → keep
          if (s.id === sessionId) activeSessionRemoved = true;
          deleteHistory(s.id);
          localStorage.removeItem('cwd:' + s.id);
          unreadSessions.delete(s.id);
          return false; // remove
        });
        if (local.length !== before) {
          changed = true;
          if (activeSessionRemoved) {
            // Switch to first remaining session after filter is fully applied
            if (local.length > 0) setTimeout(() => switchSession(local[0].id), 0);
            else setTimeout(newSession, 0);
          }
        }

        // Sync CWD from server for all sessions
        for (const ss of serverSessions) {
          if (ss.cwd) {
            const localCwd = loadCwd(ss.id);
            if (ss.cwd !== localCwd) {
              saveCwd(ss.id, ss.cwd);
              if (ss.id === sessionId) {
                sessionStorage.setItem('currentCwd', ss.cwd);
                updateHeader(ss.cwd);
              }
            }
          }
        }

        // Update unread indicators: a session is unread if the server's lastMessage
        // is newer than the stored last-seen timestamp for that session.
        for (const ss of serverSessions) {
          if (ss.id === sessionId) { saveLastSeen(ss.id, Date.now()); continue; } // current session → always seen
          if (!ss.lastMessage) continue;
          const msgTs = new Date(ss.lastMessage).getTime();
          const seen = loadLastSeen(ss.id);
          if (seen === null) { saveLastSeen(ss.id, msgTs); continue; } // first time ever: init without marking unread
          if (msgTs > seen && !unreadSessions.has(ss.id)) { unreadSessions.add(ss.id); changed = true; }
        }

        // Apply server-defined order if available (from /session-order endpoint).
        // This ensures cross-device/cross-browser order sync.
        if (serverOrder.length > 0) {
          const orderMap = new Map(serverOrder.map((id, i) => [id, i]));
          const maxOrder = serverOrder.length;
          const prevOrder = local.map(s => s.id).join(',');
          local.sort((a, b) => {
            // isOwn sessions not yet confirmed in serverOrder stay above all server-ordered sessions
            const rawIa = orderMap.get(a.id);
            const rawIb = orderMap.get(b.id);
            const ia = rawIa !== undefined ? rawIa : (a.isOwn ? -1 : maxOrder);
            const ib = rawIb !== undefined ? rawIb : (b.isOwn ? -1 : maxOrder);
            if (ia !== ib) return ia - ib;
            // Sessions not in the order list: sort by newest first
            return (b.createdAt || 0) - (a.createdAt || 0);
          });
          const newOrder = local.map(s => s.id).join(',');
          if (newOrder !== prevOrder) changed = true;
        }

        if (changed) {
          saveSessions(local);
          if (!isRenaming()) renderSessions();
        }
      } catch {}
    }

    msgsEl.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('topic:')) {
        e.preventDefault();
        inputEl.value = 'switching to topic: ' + href.slice('topic:'.length);
        sendMsg();
      }
    });

    // ── SSE ───────────────────────────────────────────────────────────────
    function setupSSE() {
      if (es) es.close();
      setConnState('connecting');
      const myGen = ++sseGeneration; // guard: ignore events from superseded connections
      const mySid = sessionId;
      es = new EventSource('/events?sid=' + sessionId);
      // On SSE open: push current session name to server so ensureSession() (which
      // runs server-side on first connect and may default to "Web Chat") sees the
      // correct name right away. This fixes the race on Android/mobile where the
      // pushNameToServer from newSession() might arrive AFTER ensureSession() runs.
      let sseEverConnected = false; // distinguish initial connect from reconnects
      es.addEventListener('open', () => {
        if (sseGeneration !== myGen || sessionId !== mySid) return;
        const wasConnected = sseEverConnected;
        sseEverConnected = true;
        setConnState('connected');
        // Push session name on every connect so ensureSession() on the server (which
        // runs after the SSE handshake and may default to "Web Chat") always sees the
        // correct name. The server-side guard (name_updated_at comparison) ensures
        // a stale local push never overwrites a newer server-side rename.
        const _s = loadSessions().find(s => s.id === sessionId);
        if (_s?.name) pushNameToServer(sessionId, _s.name, _s.nameUpdatedAt ?? _s.createdAt ?? Date.now());
        // On reconnect (not initial connect): re-fetch history to catch missed messages
        // (e.g. bot response or typing: false delivered while the connection was down).
        if (wasConnected) {
          // Reset stale typing/status before re-fetching history. The SSE's
          // initial typing/status events will restore the correct state.
          setTyping(false);
          fetchServerHistory(sessionId);
        }
      });
      es.addEventListener('error', () => { if (sseGeneration === myGen) setConnState('disconnected'); });
      es.addEventListener('message', e => {
        if (sseGeneration !== myGen || sessionId !== mySid) return; // stale — discard
        setStatusDisplay(null); // clear live status when response arrives
        setTyping(false);
        botHasResponded = true;
        try {
          const payload = JSON.parse(e.data);
          // payload is either {text, id} (new format) or a plain string (backward compat)
          const text = typeof payload === 'string' ? payload : payload.text;
          const msgId = typeof payload === 'object' && payload ? payload.id : null;
          addMsg(text, 'bot', msgId);
        } catch { /* render error — don't block markRead */ }
        markRead(sessionId);   // message arrived in active session → keep it read
      });
      es.addEventListener('typing', e => {
        if (sseGeneration !== myGen || sessionId !== mySid) return;
        // Ignore stale "typing: true" from the server's initial SSE state push
        // if the bot has already sent its response (race: SSE events arrive after
        // fetchServerHistory has already confirmed agentDone).
        if (e.data === 'true' && botHasResponded) return;
        setTyping(e.data === 'true');
      });
      es.addEventListener('status', e => {
        if (sseGeneration !== myGen || sessionId !== mySid) return;
        try {
          const payload = JSON.parse(e.data);
          if (!payload) { setStatusDisplay(null); return; }
          // Ignore stale status (e.g. "thinking") if bot has already responded
          if (botHasResponded) return;
          setStatusDisplay(payload.tool || null, payload.input || null);
        } catch { /* ignore malformed status event */ }
      });
      es.addEventListener('cwd', e => {
        if (sseGeneration !== myGen || sessionId !== mySid) return;
        try {
          const cwd = JSON.parse(e.data);
          saveCwd(sessionId, cwd);
          sessionStorage.setItem('currentCwd', cwd);
          updateHeader(cwd);
        } catch { /* ignore malformed cwd event */ }
      });
    }

    // ── Session management ────────────────────────────────────────────────
    function setInputEnabled(enabled) {
      inputEl.disabled = !enabled;
      sendBtn.disabled = !enabled;
      inputEl.placeholder = enabled ? 'Type a message\u2026' : 'Dieses Tab ist für geplante Aufgaben reserviert.';
    }

    function switchSession(newId) {
      saveScroll(sessionId);  // persist scroll position of outgoing session
      sessionId = newId;      // set before markRead so renderSessions sees correct active session
      markRead(newId);        // clear unread indicator (uses updated sessionId)
      sessionStorage.setItem('sid', newId);
      msgsEl.innerHTML = '';
      typingEl = null;        // reset before setTyping so it doesn't try to .remove() a stale element
      statusEl = null;        // reset before setStatusDisplay for the same reason
      botHasResponded = false; // reset: we don't yet know if the new session's bot has responded
      setTyping(false);  // resets currentTyping, hides cancel button, clears status via setStatusDisplay(null)
      setInputEnabled(newId !== 'cron');
      // Always fetch complete history from the server so that user messages
      // written in other browser tabs/windows are not missing. (If only bot
      // responses were cached locally via SSE, restoreHistory would skip user
      // messages entirely.)
      restoreHistory(newId);     // show local cache immediately while fetching
      fetchServerHistory(newId); // always sync complete history from DB
      const cwd = loadCwd(newId);
      sessionStorage.setItem('currentCwd', cwd);
      updateHeader(cwd);
      setupSSE();
      renderSessions();
      if (newId !== 'cron') inputEl.focus();
    }

    function pushNameToServer(sid, name, nameUpdatedAt) {
      fetch('/session-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, name, nameUpdatedAt: nameUpdatedAt ?? Date.now() }),
      }).catch(() => {});
    }

    function syncOrderToServer(list) {
      fetch('/session-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: list.map(x => x.id) }),
      }).catch(() => {});
    }

    function newSession() {
      const id = uuid();
      const name = sessionLabel(new Date());
      const nameUpdatedAt = Date.now();
      const list = loadSessions();
      list.unshift({ id, name, createdAt: nameUpdatedAt, isOwn: true, nameUpdatedAt });
      saveSessions(list);
      pushNameToServer(id, name, nameUpdatedAt);
      syncOrderToServer(list);
      switchSession(id);
    }

    function deleteSession(id) {
      let list = loadSessions().filter(s => s.id !== id);
      localStorage.removeItem('cwd:' + id);
      deleteHistory(id);
      deleteScroll(id);
      unreadSessions.delete(id);
      // Notify server so other browsers can sync the deletion
      fetch('/delete-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: id }),
      }).catch(() => {});
      if (list.length === 0) {
        // Always keep at least one session
        const newId = uuid();
        const newName = sessionLabel(new Date());
        const newNameUpdatedAt = Date.now();
        list = [{ id: newId, name: newName, createdAt: newNameUpdatedAt, isOwn: true, nameUpdatedAt: newNameUpdatedAt }];
        saveSessions(list);
        pushNameToServer(newId, newName, newNameUpdatedAt);
        switchSession(newId);
      } else {
        saveSessions(list);
        if (id === sessionId) switchSession(list[0].id);
        else renderSessions();
      }
    }

    function renameSession(id, newName) {
      const list = loadSessions();
      const s = list.find(s => s.id === id);
      if (s && newName.trim()) {
        s.name = newName.trim();
        s.nameUpdatedAt = Date.now();
        saveSessions(list);
        pushNameToServer(id, s.name, s.nameUpdatedAt);
      }
      renderSessions();
    }

    function startRename(id, nameEl) {
      const current = nameEl.textContent;
      const inp = document.createElement('input');
      inp.className = 'session-name-input';
      inp.value = current;
      nameEl.replaceWith(inp);
      inp.focus();
      inp.select();
      const commit = () => { renameSession(id, inp.value || current); };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        if (e.key === 'Escape') { inp.value = current; inp.blur(); }
      });
    }

    /** Returns true while a session rename input is active — suppresses background re-renders. */
    function isRenaming() {
      return !!listEl.querySelector('.session-name-input');
    }

    function renderSessions() {
      const list = loadSessions();
      listEl.innerHTML = '';
      for (const s of list) {
        const item = document.createElement('div');
        const isUnread = unreadSessions.has(s.id) && s.id !== sessionId;
        item.className = 'session-item' + (s.id === sessionId ? ' active' : '') + (isUnread ? ' unread' : '');
        item.dataset.id = s.id;
        item.draggable = true;

        const dot = document.createElement('span');
        dot.className = 'session-unread-dot';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'session-name';
        const displayName = s.name || sessionLabel(new Date(s.createdAt || Date.now()));
        nameSpan.textContent = displayName;
        nameSpan.title = displayName;

        const actions = document.createElement('div');
        actions.className = 'session-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'session-btn';
        renameBtn.title = 'Umbenennen';
        renameBtn.textContent = '✏';
        renameBtn.addEventListener('click', e => { e.stopPropagation(); startRename(s.id, nameSpan); });

        const delBtn = document.createElement('button');
        delBtn.className = 'session-btn';
        delBtn.title = 'Löschen';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', e => { e.stopPropagation(); deleteSession(s.id); });

        actions.append(renameBtn, delBtn);
        item.append(dot, nameSpan, actions);
        item.addEventListener('click', () => {
          if (s.id !== sessionId) switchSession(s.id);
          if (isMobile) setSidebar(false); // close overlay after selection on mobile
        });

        // ── Drag-and-drop reordering ────────────────────────────────────
        item.addEventListener('dragstart', e => {
          dragSrcId = s.id;
          e.dataTransfer.effectAllowed = 'move';
          item.classList.add('drag-src');
        });
        item.addEventListener('dragend', () => {
          dragSrcId = null;
          item.classList.remove('drag-src');
          if (dragOverEl) { dragOverEl.classList.remove('drag-over'); dragOverEl = null; }
        });
        item.addEventListener('dragover', e => {
          if (!dragSrcId || dragSrcId === s.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragOverEl && dragOverEl !== item) { dragOverEl.classList.remove('drag-over'); }
          dragOverEl = item;
          item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', e => {
          // Only remove if leaving the item entirely (not entering a child)
          if (!item.contains(e.relatedTarget)) {
            item.classList.remove('drag-over');
            if (dragOverEl === item) dragOverEl = null;
          }
        });
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('drag-over');
          dragOverEl = null;
          if (!dragSrcId || dragSrcId === s.id) return;
          const sessions = loadSessions();
          const fromIdx = sessions.findIndex(x => x.id === dragSrcId);
          const toIdx   = sessions.findIndex(x => x.id === s.id);
          if (fromIdx < 0 || toIdx < 0) return;
          const [moved] = sessions.splice(fromIdx, 1);
          sessions.splice(toIdx, 0, moved);
          saveSessions(sessions);
          renderSessions();
          syncOrderToServer(sessions);
        });

        listEl.appendChild(item);
      }
    }

    // ── Init ──────────────────────────────────────────────────────────────
    if (!sessionId) {
      sessionId = uuid();
      sessionStorage.setItem('sid', sessionId);
    }
    const isNewSession = ensureSessionInList(sessionId);
    // For new sessions: push name to server immediately.
    // For existing sessions: SSE open event handles it (with nameUpdatedAt so server
    // guard ensures only a genuinely newer name overwrites a server-side rename).
    if (isNewSession) {
      const _s = loadSessions().find(s => s.id === sessionId);
      if (_s?.name) pushNameToServer(sessionId, _s.name, _s.nameUpdatedAt ?? _s.createdAt ?? Date.now());
    }
    markRead(sessionId);                 // ensure current session never appears as unread on first poll
    setInputEnabled(sessionId !== 'cron');
    renderSessions();
    restoreHistory(sessionId);           // show local cache immediately (fast)
    fetchServerHistory(sessionId);       // sync full history from DB (catches cross-device messages)
    const initCwd = loadCwd(sessionId) || sessionStorage.getItem('currentCwd') || '';
    updateHeader(initCwd);
    setupSSE();

    document.getElementById('new-session-btn').addEventListener('click', newSession);
    mergeServerSessions(); // populate sidebar with sessions known to the server

    // ── Cross-window sync ─────────────────────────────────────────────────
    let lastSessionsJson = localStorage.getItem('sessions');
    function checkAndSyncSessions() {
      const current = localStorage.getItem('sessions');
      if (current !== lastSessionsJson) {
        lastSessionsJson = current;
        if (!isRenaming()) renderSessions();
      }
    }
    // Primary: storage event (fires immediately when another tab in the same browser changes localStorage)
    window.addEventListener('storage', e => {
      if (e.key === 'sessions' || e.key === null) {
        lastSessionsJson = localStorage.getItem('sessions');
        if (!isRenaming()) renderSessions();
      }
    });
    // Fast polling for same-browser cross-tab sync (fallback)
    setInterval(checkAndSyncSessions, 1000);
    // Server polling: picks up sessions from other browsers/devices
    setInterval(mergeServerSessions, 5000);

    // ── Send message ──────────────────────────────────────────────────────
    async function sendMsg() {
      const text = inputEl.value.trim();
      if (!text) return;
      inputEl.value = '';
      inputEl.style.height = '';

      // ── Built-in commands (not forwarded to bot) ──────────────────────────
      if (text === '/clear') {
        msgsEl.innerHTML = '';
        typingEl = null;
        deleteHistory(sessionId);
        fetch('/clear-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: sessionId }),
        }).catch(() => {});
        inputEl.focus();
        return;
      }

      botHasResponded = false; // reset: new user message, bot hasn't responded to this one yet
      // Generate ID client-side so we can assign it to the DOM element immediately
      const userMsgId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      addMsg(text, 'user', userMsgId);
      sendBtn.disabled = true;
      try {
        const cwdMatch = text.match(/^switching to topic:\\s*(.+)$/i);
        if (cwdMatch) {
          const cwd = 'Topics/' + cwdMatch[1].trim();
          saveCwd(sessionId, cwd);
          sessionStorage.setItem('currentCwd', cwd);
          updateHeader(cwd);
        }
        await fetch('/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, sessionId, id: userMsgId }),
        });
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener('click', sendMsg);
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    // ── File drop ─────────────────────────────────────────────────────────
    const overlay = document.getElementById('drop-overlay');
    function toBase64(buf) {
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.slice(i, i + 8192));
      return btoa(binary);
    }
    document.addEventListener('dragover', e => { e.preventDefault(); overlay.classList.add('active'); });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) overlay.classList.remove('active'); });
    document.addEventListener('drop', async e => {
      e.preventDefault();
      overlay.classList.remove('active');
      for (const file of [...e.dataTransfer.files]) {
        const b64 = toBase64(await file.arrayBuffer());
        const res = await fetch('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, data: b64, sessionId })
        });
        const json = await res.json();
        addMsg(json.ok ? 'Gespeichert: ' + json.path : 'Fehler: ' + json.error, 'bot');
      }
    });
  </script>
</body>`;

class WebChannel {
  name = 'web';
  private server: http.Server | null = null;
  private connected = false;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];
  private registerGroup: ChannelOpts['registerGroup'];
  private onCancelRequest: ChannelOpts['onCancelRequest'];

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registerGroup = opts.registerGroup;
    this.onCancelRequest = opts.onCancelRequest;
  }

  private ensureSession(sessionId: string): void {
    if (registeredSessions.has(sessionId)) return;
    registeredSessions.add(sessionId);
    const jid = WEB_JID_PREFIX + sessionId;
    // Preserve custom name if already set (e.g. by /session-name endpoint)
    const existing = getAllChats().find((c) => c.jid === jid);
    const chatName =
      existing?.name && existing.name !== GROUP_NAME
        ? existing.name
        : GROUP_NAME;
    if (this.registerGroup) {
      // Each web session gets its own IPC-isolated folder so that parallel
      // containers don't accidentally read each other's follow-up IPC messages.
      //
      // • Cron session  → CRON_GROUP_FOLDER ('web-cron') — own workspace + IPC
      // • User sessions → 'web-{sessionId}' — unique IPC directory, but the
      //   workspace (groups/main/) and Claude sessions dir (data/sessions/main/)
      //   are shared via symlinks so all sessions see the same agent context,
      //   memory, skills, tools, etc.
      let folder: string;
      if (sessionId === CRON_SESSION_ID) {
        folder = CRON_GROUP_FOLDER;
      } else {
        folder = 'web-' + sessionId;
        // Create symlinks so this session's containers share the main workspace
        // and .claude directory while getting an isolated IPC directory.
        const groupLink = path.join(GROUPS_DIR, folder);
        if (!fs.existsSync(groupLink)) {
          try {
            fs.symlinkSync('main', groupLink);
          } catch {
            /* already exists */
          }
        }
        const sessionsLink = path.join(DATA_DIR, 'sessions', folder);
        if (!fs.existsSync(sessionsLink)) {
          try {
            fs.symlinkSync('main', sessionsLink);
          } catch {
            /* already exists */
          }
        }
      }
      this.registerGroup(jid, {
        name: chatName,
        folder,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: true,
      });
    }
    // Use epoch timestamp so MAX() in storeChatMetadata never overwrites the actual
    // last_message_time — we only want to register name/channel/isGroup here.
    this.onChatMetadata(
      jid,
      '1970-01-01T00:00:00.000Z',
      chatName,
      'web',
      false,
    );
  }

  /**
   * Remove web-session symlinks in GROUPS_DIR and DATA_DIR/sessions that no
   * longer have a corresponding entry in the chats DB table.
   * Runs once at startup so orphans from deleted/expired sessions don't pile up.
   */
  private cleanupOrphanedSessionLinks(): void {
    const known = new Set(
      getAllChats()
        .map((c) => c.jid)
        .filter(
          (j) =>
            j.startsWith(WEB_JID_PREFIX) &&
            j !== WEB_JID_PREFIX + CRON_SESSION_ID,
        )
        .map((j) => j.slice(WEB_JID_PREFIX.length)),
    );

    for (const dir of [GROUPS_DIR, path.join(DATA_DIR, 'sessions')]) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith('web-')) continue;
        const sid = entry.slice('web-'.length);
        if (!known.has(sid)) {
          try {
            fs.unlinkSync(path.join(dir, entry));
            logger.debug({ entry, dir }, 'Removed orphaned session symlink');
          } catch {
            /* ignore — may already be gone */
          }
        }
      }
    }
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      // ── Token-based access control ──────────────────────────────────────────
      // authorizeRequest() returns false and sends 401 if the token is wrong.
      // If the token arrived via ?token= it also sets a session cookie so that
      // subsequent requests (SSE, API calls, asset loads) pass without repeating it.
      if (!authorizeRequest(req, res)) return;

      if (req.method === 'GET' && req.url?.split('?')[0] === '/') {
        const html = HTML.replaceAll(
          '__SERVER_ADDRESS__',
          `${getLocalIp()}:${PORT}`,
        );
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        });
        res.end(html);
        return;
      }

      // GET /sessions — list all web sessions known to the server (from DB)
      // Response: { sessions: Session[], order: string[] }
      // order contains session IDs in the user-defined drag order (empty = no custom order).
      if (req.method === 'GET' && req.url === '/sessions') {
        const chats = getAllChats();
        const sessions = chats
          .filter((c) => c.jid.startsWith(WEB_JID_PREFIX))
          .map((c) => {
            const id = c.jid.slice(WEB_JID_PREFIX.length);
            return {
              id,
              name: c.name,
              lastMessage: c.last_message_time,
              nameUpdatedAt: c.name_updated_at || 0,
              cwd: sessionCwds.get(id) || c.cwd || '',
            };
          });
        // Strip WEB_JID_PREFIX from stored JIDs so clients see plain session IDs
        const rawOrder = getWebSessionOrder();
        const order = rawOrder.map((jid) =>
          jid.startsWith(WEB_JID_PREFIX)
            ? jid.slice(WEB_JID_PREFIX.length)
            : jid,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions, order }));
        return;
      }

      // POST /session-order — persist the user-defined session display order
      if (req.method === 'POST' && req.url === '/session-order') {
        collectBody(req, res, (body) => {
          try {
            const { order } = JSON.parse(body);
            if (
              !Array.isArray(order) ||
              !order.every((id) => typeof id === 'string')
            ) {
              throw new Error('order must be an array of strings');
            }
            // Store as full JIDs internally
            setWebSessionOrder(order.map((id) => WEB_JID_PREFIX + id));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end('{"error":"Bad request"}');
          }
        });
        return;
      }

      // POST /session-name — persist a custom session name to the DB
      if (req.method === 'POST' && req.url === '/session-name') {
        collectBody(req, res, (body) => {
          try {
            const { sid, name, nameUpdatedAt } = JSON.parse(body);
            if (sid && name && typeof name === 'string') {
              const safeName = sanitizeSessionName(name);
              if (safeName) {
                // Server-side guard: updateChatName only writes if nameUpdatedAt >= stored value
                const ts =
                  typeof nameUpdatedAt === 'number'
                    ? nameUpdatedAt
                    : Date.now();
                updateChatName(WEB_JID_PREFIX + sid, safeName, ts);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      // POST /delete-session — remove a session and its messages from the DB
      if (req.method === 'POST' && req.url === '/delete-session') {
        collectBody(req, res, (body) => {
          try {
            const { sid } = JSON.parse(body);
            if (sid && typeof sid === 'string') {
              deleteChat(WEB_JID_PREFIX + sid);
              registeredSessions.delete(sid);
              sseClients.delete(sid);
              sessionCwds.delete(sid);
              sessionTyping.delete(sid);
              sessionStatus.delete(sid);
              // Clean up per-session symlinks (user sessions only; cron has real dirs)
              if (sid !== CRON_SESSION_ID) {
                const folder = 'web-' + sid;
                try {
                  fs.unlinkSync(path.join(GROUPS_DIR, folder));
                } catch {
                  /* ignore */
                }
                try {
                  fs.unlinkSync(path.join(DATA_DIR, 'sessions', folder));
                } catch {
                  /* ignore */
                }
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      // POST /delete-message — delete a single message by id
      if (req.method === 'POST' && req.url === '/delete-message') {
        collectBody(req, res, (body) => {
          try {
            const { id } = JSON.parse(body);
            if (id && typeof id === 'string') {
              deleteMessage(id);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      // POST /clear-history — delete all messages for a session (keeps session entry)
      if (req.method === 'POST' && req.url === '/clear-history') {
        collectBody(req, res, (body) => {
          try {
            const { sid } = JSON.parse(body);
            if (sid && typeof sid === 'string') {
              clearChatMessages(WEB_JID_PREFIX + sid);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      // GET /history?sid=... — full conversation for a session (user + bot)
      if (req.method === 'GET' && req.url?.startsWith('/history')) {
        const sid = sidFromUrl(req.url);
        const jid = WEB_JID_PREFIX + sid;
        const messages = getConversation(jid, 500);
        const history = messages.map((m) => ({
          text: m.content,
          cls: m.is_bot_message || m.is_from_me ? 'bot' : 'user',
          id: m.id,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(history));
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/events')) {
        const sessionId = sidFromUrl(req.url);
        // Set up SSE connection first, then register session (avoids interrupting the stream)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':\n\n');
        const clients = getOrCreateClientSet(sessionId);
        clients.add(res);
        // Restore CWD from DB if not in memory (e.g. after server restart)
        if (!sessionCwds.has(sessionId)) {
          const chat = getAllChats().find(
            (c) => c.jid === WEB_JID_PREFIX + sessionId,
          );
          if (chat?.cwd) sessionCwds.set(sessionId, chat.cwd);
        }
        const cwd = sessionCwds.get(sessionId);
        if (cwd) res.write(`event: cwd\ndata: ${JSON.stringify(cwd)}\n\n`);
        // Always send current typing/status state so client syncs correctly on reconnect
        res.write(
          `event: typing\ndata: ${sessionTyping.get(sessionId) ? 'true' : 'false'}\n\n`,
        );
        const status = sessionStatus.get(sessionId);
        res.write(`event: status\ndata: ${status ?? 'null'}\n\n`);
        req.on('close', () => clients.delete(res));
        // Register in DB after SSE is established — so other browsers can discover this session
        try {
          this.ensureSession(sessionId);
        } catch {}
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/cancel')) {
        const sid = sidFromUrl(req.url);
        if (sid && this.onCancelRequest) {
          this.onCancelRequest(WEB_JID_PREFIX + sid);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      if (req.method === 'POST' && req.url === '/message') {
        collectBody(req, res, (body) => {
          try {
            const {
              content,
              sessionId = 'default',
              id: clientMsgId,
            } = JSON.parse(body);
            if (content && typeof content === 'string') {
              this.ensureSession(sessionId);
              const jid = WEB_JID_PREFIX + sessionId;

              const cwdMatch = content.match(/^switching to topic:\s*(.+)$/i);
              if (cwdMatch) {
                const cwd = 'Topics/' + cwdMatch[1].trim();
                setCwd(sessionId, cwd);
                broadcastToSession(sessionId, 'cwd', JSON.stringify(cwd));
              }

              // Use client-provided ID if valid (allows delete button to work immediately),
              // otherwise generate one server-side.
              const msgId =
                typeof clientMsgId === 'string' &&
                /^[\w-]{1,80}$/.test(clientMsgId)
                  ? clientMsgId
                  : `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const msg: NewMessage = {
                id: msgId,
                chat_jid: jid,
                sender: 'user@web',
                sender_name: 'User',
                content: content.trim(),
                timestamp: new Date().toISOString(),
                is_from_me: false,
                is_bot_message: false,
              };
              try {
                storeMessage(msg); // persist to DB for cross-browser history
                storeChatMetadata(jid, msg.timestamp); // keep chats.last_message_time current for unread detection
              } catch {}
              this.onMessage(jid, msg);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/cwd') {
        collectBody(req, res, (body) => {
          try {
            const { cwd, sessionId = 'default' } = JSON.parse(body);
            if (typeof cwd === 'string') {
              // Validate that the resolved path stays within the workspace
              const workspace = process.cwd();
              const resolved = path.resolve(workspace, cwd);
              if (
                resolved !== workspace &&
                !resolved.startsWith(workspace + path.sep)
              ) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"error":"CWD outside workspace"}');
                return;
              }
              const safeCwd = path.relative(workspace, resolved);
              setCwd(sessionId, safeCwd);
              broadcastToSession(sessionId, 'cwd', JSON.stringify(safeCwd));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          } catch {
            res.writeHead(400);
            res.end('Bad request');
          }
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/upload') {
        // File data is Base64-encoded (~33 % overhead → ~7.5 MB effective file size).
        collectBody(
          req,
          res,
          (body) => {
            try {
              const {
                filename,
                data,
                sessionId = 'default',
              } = JSON.parse(body);
              if (!filename || !data) throw new Error('Missing fields');
              const safeName = path.basename(filename);
              const groupDir = path.join(process.cwd(), 'groups', GROUP_FOLDER);
              const cwd = sessionCwds.get(sessionId) ?? '';
              const dir = cwd ? path.join(groupDir, cwd) : groupDir;
              // Verify upload directory stays within groupDir (defense-in-depth)
              if (dir !== groupDir && !dir.startsWith(groupDir + path.sep)) {
                throw new Error('Upload path outside workspace');
              }
              fs.mkdirSync(dir, { recursive: true });
              const filePath = path.join(dir, safeName);
              fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
              const relPath = path.relative(groupDir, filePath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, path: relPath }));
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: e.message }));
            }
          },
          MAX_UPLOAD_BODY_SIZE,
        );
        return;
      }

      // Static assets: favicon.ico and apple-touch-icon.png from group folder
      const staticFiles: Record<string, string> = {
        '/favicon.ico': 'image/x-icon',
        '/favicon.png': 'image/png',
        '/apple-touch-icon.png': 'image/png',
      };
      const urlPath = req.url?.split('?')[0] ?? '';
      if (req.method === 'GET' && staticFiles[urlPath]) {
        const filePath = path.join(
          process.cwd(),
          'groups',
          GROUP_FOLDER,
          urlPath.slice(1),
        );
        try {
          const data = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': staticFiles[urlPath],
            'Cache-Control': 'max-age=3600',
          });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(PORT, HOST, () => resolve());
      this.server!.on('error', reject);
    });

    this.connected = true;
    logger.info({ port: PORT }, 'Web chat channel listening');

    // Ensure dedicated cron session exists (low timestamp so user renames always win)
    try {
      updateChatName(WEB_JID_PREFIX + CRON_SESSION_ID, CRON_SESSION_NAME, 1);
      this.ensureSession(CRON_SESSION_ID);
    } catch {}

    // Remove symlinks for sessions that no longer exist in the DB
    try {
      this.cleanupOrphanedSessionLinks();
    } catch {
      /* non-critical */
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sessionId = sessionIdFromJid(jid);
    const topicMatch = text.match(/^switching to topic:\s*(\S+)/im);
    if (topicMatch) {
      const cwd = 'Topics/' + topicMatch[1].trim();
      setCwd(sessionId, cwd);
      broadcastToSession(sessionId, 'cwd', JSON.stringify(cwd));
    }
    // Persist bot response to DB so history works across browsers/windows
    const botTs = new Date().toISOString();
    const botMsgId = `web-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      storeMessage({
        id: botMsgId,
        chat_jid: jid,
        sender: 'bot@web',
        sender_name: 'Nemo',
        content: text,
        timestamp: botTs,
        is_from_me: true,
        is_bot_message: true,
      });
      // storeMessage only writes to the messages table; update chats.last_message_time
      // so that mergeServerSessions() can detect this session as unread in other browsers/tabs.
      storeChatMetadata(jid, botTs);
    } catch {}
    // Broadcast {text, id} so the client can assign a trash button with the correct DB id
    broadcastToSession(
      sessionId,
      'message',
      JSON.stringify({ text, id: botMsgId }),
    );
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = sessionIdFromJid(jid);
    if (isTyping) {
      sessionTyping.set(sessionId, true);
    } else {
      sessionTyping.delete(sessionId);
      // Also clear status so reconnecting clients don't see a stale tool-use line
      sessionStatus.delete(sessionId);
      broadcastToSession(sessionId, 'status', 'null');
    }
    broadcastToSession(sessionId, 'typing', String(isTyping));
  }

  setStatus(jid: string, tool: string | null, inputSnippet?: string): void {
    const sessionId = sessionIdFromJid(jid);
    const payload = tool
      ? JSON.stringify({ tool, input: inputSnippet ?? null })
      : 'null';
    if (tool) sessionStatus.set(sessionId, payload);
    else sessionStatus.delete(sessionId);
    broadcastToSession(sessionId, 'status', payload);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WEB_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const clients of sseClients.values()) {
      for (const client of clients) client.end();
    }
    sseClients.clear();
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

registerChannel('web', (opts) => new WebChannel(opts));
