import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { waitUntil } from "@vercel/functions";
import multer from "multer";
import os from "os";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import crypto from "crypto";
import { recommendModel } from "./recommend.js";
import { callLLM } from "./lib/llmClients.js";
import { fuzzyMatch, parseRelativeDate } from "./lib/agent-shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function readConfig() {
  try { return JSON.parse(readFileSync(path.join(os.homedir(), ".minisana", "config.json"), "utf8")); }
  catch { return {}; }
}
const CONFIG = readConfig();
const USE_OLLAMA = CONFIG.useOllama === true;

async function ensureOllama() {
  try {
    await fetch("http://localhost:11434");
    console.log("✓ Ollama already running");
  } catch {
    console.log("⚙ Starting Ollama...");
    const ollamaProc = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
    ollamaProc.on("error", (err) => {
      console.log(`⚠ Could not start ollama (${err.code || err.message}) — ollama not found, local model unavailable`);
    });
    ollamaProc.unref();
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { await fetch("http://localhost:11434"); console.log("✓ Ollama ready"); return; } catch {}
    }
    console.log("⚠ Ollama didn't respond — continuing anyway");
  }
}

async function installedOllamaModels() {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = await r.json();
    return (d.models || []).map(m => m.name);
  } catch { return []; }
}

async function logRecommendation() {
  const rec = recommendModel();
  const installed = await installedOllamaModels();
  const have = installed.includes(rec.recommended);
  console.log(`💻 Detected ${rec.ramGb} GB RAM → recommended Ollama model: ${rec.recommended} (${rec.size})`);
  if (!have) console.log(`   ↳ pull it with:  ollama pull ${rec.recommended}`);
}

// ── Slack app manual configuration (api.slack.com/apps) ─────────────────────
// This app exposes three Slack request URLs that must be wired up by hand in
// the Slack app's admin config once it's deployed:
//   1. Event Subscriptions  → Request URL: <deployed-base-url>/slack/events
//   2. Slash Commands       → create a command named "/asana" with
//                             Request URL: <deployed-base-url>/slack/commands
//   3. Interactivity & Shortcuts (toggle "Interactivity" on) → Request URL:
//                             <deployed-base-url>/slack/interactions
// All three routes share the same SLACK_SIGNING_SECRET-based HMAC check
// (verifySlackSignature) and both form-encoded routes (/slack/commands,
// /slack/interactions) rely on captureRawBody below to populate req.rawBody.

// Shared verify callback for body-parser: captures the raw request body
// (before parsing) so verifySlackSignature can HMAC it, regardless of
// whether the request is JSON (Events API) or form-encoded (slash commands /
// interactivity payloads).
function captureRawBody(req, res, buf) {
  req.rawBody = buf;
}

// The web UI is served same-origin by this same app (express.static below),
// so it never needs cross-origin CORS at all — this only gates a DIFFERENT
// site's browser JS calling these APIs (in particular POST /asana, which
// forwards a caller-supplied bearer token to the real Asana API and would
// otherwise be usable as an anonymous cross-site relay). Requests with no
// Origin header (curl, server-to-server, Slack) are always allowed since
// they aren't subject to the browser's CORS policy in the first place.
const ALLOWED_ORIGINS = new Set([
  "https://minisana.vercel.app",
  `http://localhost:${process.env.PORT || 3000}`,
]);

// Needed so req.ip resolves the real client IP (via X-Forwarded-For) rather
// than Vercel's proxy — used by the rate limiter below.
const app = express();
app.set("trust proxy", true);
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
}));
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
app.use(express.static(path.join(__dirname, "public")));

// Lightweight in-memory rate limit for the open Asana proxy below. Resets
// per server instance (a soft mitigation on serverless, where instances are
// short-lived, but a real one for the local/self-hosted deployment mode) —
// keyed by client IP, since the proxy takes its Asana bearer token from the
// request body rather than requiring any auth of its own.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const rateLimitHits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const entry = rateLimitHits.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(key, { windowStart: now, count: 1 });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests — please slow down." });
  }
  next();
}

// ── Slack request signature verification (HMAC, replay-protected) ───────────
function verifySlackSignature(req, res, next) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("SLACK_SIGNING_SECRET is not set — rejecting Slack request");
    return res.sendStatus(401);
  }
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return res.sendStatus(401);

  const fiveMinutes = 60 * 5;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) return res.sendStatus(401);

  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${hmac}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== signatureBuf.length || !crypto.timingSafeEqual(expectedBuf, signatureBuf)) {
    return res.sendStatus(401);
  }
  next();
}

const ASANA_API = "https://app.asana.com/api/1.0";

// ── Runtime config exposed to the UI ─────────────────────────────────────────
app.get("/config", (req, res) => {
  res.json({ useOllama: USE_OLLAMA });
});

// ── Hardware-based model recommendation ──────────────────────────────────────
app.get("/recommend-model", async (req, res) => {
  const rec = recommendModel();
  const installed = await installedOllamaModels();
  res.json({ ...rec, installed, recommendedInstalled: installed.includes(rec.recommended) });
});

// ── Ollama model list ─────────────────────────────────────────────────────────
app.get("/ollama-models", async (req, res) => {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = await r.json();
    res.json({ models: (d.models || []).map(m => m.name) });
  } catch {
    res.json({ models: [] });
  }
});

// ── Asana proxy ──────────────────────────────────────────────────────────────
app.post("/asana", rateLimit, async (req, res) => {
  const { method, endpoint, body, token } = req.body;
  if (!token || !endpoint) return res.status(400).json({ error: "Missing token or endpoint" });
  try {
    const opts = {
      method: method || "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    };
    if (body && method !== "GET") opts.body = JSON.stringify(body);
    const r = await fetch(ASANA_API + endpoint, opts);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Asana attachment upload (multipart) ──────────────────────────────────────
app.post("/asana-attach", rateLimit, upload.single("file"), async (req, res) => {
  const { token, parent } = req.body;
  const file = req.file;
  if (!token || !parent || !file) return res.status(400).json({ error: "Missing token, parent, or file" });
  try {
    const fd = new FormData();
    fd.append("parent", parent);
    fd.append("file", new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }), file.originalname || "upload");
    const r = await fetch(`${ASANA_API}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LLM proxy (Groq + OpenAI + Ollama + Anthropic) ───────────────────────────
app.post("/llm", async (req, res) => {
  const { messages, prompt, llmKey, provider = "groq", stream = false } = req.body;
  if (provider === "ollama" && !USE_OLLAMA) return res.status(400).json({ error: "Ollama disabled in setup" });
  if (!llmKey && provider !== "ollama") return res.status(400).json({ error: "Missing LLM API key" });

  const msgs = messages || [{ role: "user", content: prompt }];

  const ctrl = new AbortController();
  const onClientClose = () => ctrl.abort();
  res.on("close", onClientClose);

  try {
    const result = await callLLM({
      provider,
      model: req.body.model,
      messages: msgs,
      apiKey: llmKey,
      temperature: 0.2,
      maxTokens: 600,
      jsonMode: true,
      stream,
      signal: ctrl.signal,
      onStreamStart: () => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
      },
      onPartial: (chunk) => res.write(chunk),
    });

    req.off("close", onClientClose);

    if (result.streamed) {
      res.end();
      return;
    }
    res.status(result.status).json(result.body);
  } catch (e) {
    req.off("close", onClientClose);
    const msg = e.name === "AbortError" ? "LLM timed out — try again" : e.message;
    if (res.headersSent) res.end();
    else res.status(500).json({ error: msg });
  }
});

// ── Upstash KV helpers ────────────────────────────────────────────────────────
async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const d = await r.json();
  return d.result ?? null;
}

// ttlSeconds: optional expiry (Upstash REST maps path segments to Redis command args, so
// `SET key value EX <ttl>` becomes `/set/<key>/<value>/EX/<ttl>`).
async function kvSet(key, value, ttlSeconds) {
  const segments = ["set", encodeURIComponent(key), encodeURIComponent(value)];
  if (ttlSeconds) segments.push("EX", String(ttlSeconds));
  await fetch(`${process.env.KV_REST_API_URL}/${segments.join("/")}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
}

async function kvDel(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  return r.ok;
}

// ── Web UI session persistence ───────────────────────────────────────────────
// Lets the browser client (public/index.html) survive a page reload without
// losing its in-flight chat history / last-viewed project. The client holds
// no server-issued id until the first save: POST /session (optionally with a
// previously issued id) stores an opaque JSON blob under web_session:<id> in
// KV and returns { id }; GET /session/:id reads it back as { data }. This is
// UI state only (chat history, last-viewed project) — never Asana tokens or
// LLM API keys, which stay in localStorage on the client and never touch
// this endpoint.
//
// Chat history is capped at the last 30 messages before saving, mirroring
// the same cap the client already applies to its in-memory chatHistory
// array (see the `chatHistory.length > 30` truncation in public/index.html).
function capSessionChatHistory(data) {
  if (data && Array.isArray(data.chatHistory) && data.chatHistory.length > 30) {
    return { ...data, chatHistory: data.chatHistory.slice(-30) };
  }
  return data;
}

app.post("/session", async (req, res) => {
  const { id, data } = req.body || {};
  if (data === undefined) return res.status(400).json({ error: "Missing data" });
  const sessionId = id || crypto.randomUUID();
  try {
    await kvSet(`web_session:${sessionId}`, JSON.stringify(capSessionChatHistory(data)));
    res.json({ id: sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/session/:id", async (req, res) => {
  try {
    const raw = await kvGet(`web_session:${req.params.id}`);
    if (!raw) return res.status(404).json({ error: "Not found" });
    let data;
    try { data = JSON.parse(raw); } catch { return res.status(404).json({ error: "Not found" }); }
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Connected-users registry ─────────────────────────────────────────────────
// KV (Upstash) only supports get/set by key — there's no native way to list
// "all keys matching asana:*". To let the daily digest cron enumerate every
// connected Slack user, we additionally maintain a small JSON array of
// slackUserIds under this fixed key, updated whenever /auth/callback saves a
// new token. This is a best-effort read-modify-write (not atomic) — if two
// callbacks race, one update could clobber the other, but losing a rare
// concurrent registry append is an acceptable tradeoff for how infrequently
// users connect, and the user can just message the bot again to re-trigger it.
const CONNECTED_USERS_KEY = "asana:connected_users";

async function addConnectedUser(slackUserId) {
  try {
    const raw = await kvGet(CONNECTED_USERS_KEY);
    let list = [];
    if (raw) {
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch {}
    }
    if (!list.includes(slackUserId)) {
      list.push(slackUserId);
      await kvSet(CONNECTED_USERS_KEY, JSON.stringify(list));
    }
  } catch (e) {
    console.error(`Failed to add ${slackUserId} to connected-users registry:`, e.message);
  }
}

async function removeConnectedUser(slackUserId) {
  try {
    const raw = await kvGet(CONNECTED_USERS_KEY);
    if (!raw) return;
    let list = [];
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch { return; }
    const next = list.filter(id => id !== slackUserId);
    if (next.length !== list.length) await kvSet(CONNECTED_USERS_KEY, JSON.stringify(next));
  } catch (e) {
    console.error(`Failed to remove ${slackUserId} from connected-users registry:`, e.message);
  }
}

async function getConnectedUsers() {
  try {
    const raw = await kvGet(CONNECTED_USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Failed to read connected-users registry:", e.message);
    return [];
  }
}

// ── Asana OAuth token helpers ─────────────────────────────────────────────────
async function refreshAsanaToken(refreshToken) {
  const r = await fetch("https://app.asana.com/-/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  return r.json();
}

async function getAsanaTokenForUser(slackUserId) {
  const raw = await kvGet(`asana:${slackUserId}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data.expires_at - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refreshAsanaToken(data.refresh_token);
      if (refreshed.access_token) {
        const updated = { access_token: refreshed.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + refreshed.expires_in * 1000 };
        await kvSet(`asana:${slackUserId}`, JSON.stringify(updated));
        return updated.access_token;
      }
    }
    return data.access_token;
  } catch { return null; }
}

// ── Asana OAuth routes ────────────────────────────────────────────────────────
// A raw ?slack_user_id= query param used to be trusted directly as the OAuth
// `state` — anyone who saw or guessed a connect link (e.g. one bot-posted
// into a shared channel) could bind THEIR OWN Asana account to a stranger's
// Slack identity, or vice versa. Now the only value ever passed as `state`
// is an opaque, single-use, short-lived token minted server-side — and the
// only way to mint one for a given slackUserId is to already be inside a
// handler that verified the request came from Slack (verifySlackSignature).
const ASANA_CONNECT_TOKEN_TTL_SECONDS = 600; // 10 minutes

async function mintAsanaConnectToken(slackUserId) {
  const token = crypto.randomBytes(16).toString("hex");
  await kvSet(`asana_connect:${token}`, slackUserId, ASANA_CONNECT_TOKEN_TTL_SECONDS);
  return token;
}

app.get("/auth/asana", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing or invalid connection link. Please restart from Slack.");
  let slackUserId;
  try {
    slackUserId = await kvGet(`asana_connect:${token}`);
  } catch (e) {
    console.error("Failed to look up Asana connect token:", e.message);
    return res.status(500).send("Failed to start the Asana connection flow. Please try again.");
  }
  if (!slackUserId) {
    return res.status(400).send("This connection link has expired or was already used. Please restart from Slack.");
  }
  const params = new URLSearchParams({
    client_id: process.env.ASANA_CLIENT_ID,
    redirect_uri: "https://minisana.vercel.app/auth/callback",
    response_type: "code",
    state: token,
  });
  res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state: token } = req.query;
  if (!code || !token) return res.status(400).send("Missing code or state");
  try {
    const slackUserId = await kvGet(`asana_connect:${token}`);
    if (!slackUserId) {
      return res.status(400).send("This connection link has expired or was already used. Please restart from Slack.");
    }
    await kvDel(`asana_connect:${token}`); // one-time use
    const tokenRes = await fetch("https://app.asana.com/-/oauth_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ASANA_CLIENT_ID,
        client_secret: process.env.ASANA_CLIENT_SECRET,
        redirect_uri: "https://minisana.vercel.app/auth/callback",
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    await kvSet(`asana:${slackUserId}`, JSON.stringify({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token, expires_at: Date.now() + tokenData.expires_in * 1000 }));
    await addConnectedUser(slackUserId);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fafafa"><h2>✅ Connected!</h2><p>Your Asana account is now linked to Minisana in Slack.</p><p style="color:#888">You can close this tab and return to Slack.</p></body></html>`);
  } catch (e) {
    res.status(500).send(`Connection failed: ${e.message}`);
  }
});

// ── Slack Full Agent ──────────────────────────────────────────────────────────

const SLACK_RULES_BLOCK = `You are Minisana, an advanced productivity assistant integrated with Asana. Your goal: help the user manage work efficiently by prioritizing tasks, detecting risks, and suggesting actions. Be concise, structured, action-oriented — never dump raw data, analyze and summarize. Think before answering: identify intent, urgency, dependencies. Prefer actions over explanations. Never invent task data; if something's missing, ask one short clarifying question (as the "answer"). Return ONLY one valid JSON object — no markdown fences, no text outside JSON.

User identity, current project, today/tomorrow, tasks, sections, projects, tags, team members, recent conversation, and recently shown items are provided in a separate STATE message below — read it for all current data; do not invent any. "I"/"me"/"my" refers to the user named in STATE.

=== INTENT CLASSIFICATION (internal) ===
Silently classify each user request into one of: summarize_project, prioritize_tasks, detect_blockers, suggest_next_steps, create_task, update_task, general_question, off_topic. Infer the most likely intent if unclear.

=== SCOPE ===
Only answer questions about Asana and the user's work (tasks, projects, deadlines, standups, prioritisation, blockers, team workload, comments, productivity within their workspace). If the user asks anything off-topic — recipes, weather, general trivia, coding help, world knowledge, personal advice unrelated to work — classify as off_topic and return {"answer": "I can only help with your Asana tasks and projects. Want me to prioritise your work, draft a standup, or create a task instead?"} (vary the phrasing slightly, keep it short, and offer one concrete Asana-related suggestion). Do NOT attempt to answer the off-topic request, even partially. Do NOT generate actions.

=== TASK ANALYSIS RULES ===
When prioritizing, rank by: (1) deadline proximity (overdue > today > this week > later), (2) blocking other work / dependencies, (3) explicit importance (tags like "urgent", "high").
Flag blockers: overdue tasks; tasks waiting on others; tasks with no due date but stuck in a "blocked" or "review" section.
Flag risks: one person assigned multiple urgent/high-priority items; deadlines clustered on the same day; more than 3 overdue tasks.

=== EFFICIENCY ===
- Do not analyze more than 20 tasks at once. If there are more, focus on the highest-priority subset and say "showing top N of M".
- Summarize before reasoning over large datasets. No redundant analysis.

=== ANSWER FORMAT ===
For prioritize / blockers / standup / "what should I do" / project-status requests, structure the answer as:
*🔥 Priority Tasks*\n• <task name> — <one-line reason>\n...
*⚠️ Risks / Blockers*\n• <issue> — <impact>\n...
*✅ Suggested Actions*\n• <concrete next step>\n...
Skip a section if there's nothing to put in it. Keep the whole answer under ~150 words unless the user explicitly asks for detail.
For simple lookups a plain list is fine — don't force the 3-section structure when it'd be overkill.

=== WHEN TO USE answer vs actions ===
Use {"answer": "..."} when the user is ASKING or VIEWING — questions, listing tasks, summaries, status.
Use {"actions": [...]} ONLY when the user wants to CHANGE something — complete, move, assign, create, comment.

NEVER use actions to list or show tasks. The task data is already in STATE — just read it and answer.

=== OUTPUT FORMAT ===
• {"answer": "<plain text string, use \\n for newlines, *bold* for emphasis>"} — reading, listing, summarising
• {"actions": [{"action":"...","task":"...","subtask":"...","section":"...","assignee":"...","follower":"...","comment":"...","name":"...","notes":"...","due":"YYYY-MM-DD","tag":"...","project":"..."}]} — writing/changing

=== AVAILABLE ACTIONS (write-only) ===
move_to_section | assign | assign_subtask | unassign | unassign_subtask
comment | complete | uncomplete | complete_subtask | uncomplete_subtask
create_task | create_subtask | rename_task | rename_subtask | set_description | delete_task | delete_subtask
set_due_date | set_due_date_subtask | remove_due_date
add_follower | remove_follower
add_tag | remove_tag
switch_project
get_subtasks | get_all_subtasks | get_done_subtasks | get_task_details | explain_task
unknown

=== LANGUAGE RULES ===
- "what do I have" / "my tasks" / "show me my tasks" / "what's on my plate" → {"answer": list of incomplete tasks}
- "what's done" / "what did I finish" → {"answer": list of completed tasks}
- "all tasks" → {"answer": list of all tasks grouped by section}
- "finish"/"done"/"check off"/"wrap up" → complete action
- "reopen"/"undo"/"uncheck" → uncomplete action
- "move to"/"put in"/"send to" → move_to_section action
- "add"/"create"/"new task"/"remind me to" → create_task action
- Match tasks by partial name or keywords ("the login thing" → "Fix login bug")
- Resolve "that"/"it"/"this one"/"those" using conversation history
- Multiple changes in one message → multiple actions in the array
- Use the Today/Tomorrow values from STATE; also accept "yesterday", "next monday", "next week", "end of week", "in 3 days", weekday names — pass them as-is in "due" and the runtime will normalize.
- "switch to <project>"/"open <project>"/"go to <project>" → switch_project action with "project"=name
- "tag <task> as X"/"add tag X to <task>" → add_tag, "tag"=name; "remove tag X from <task>"/"untag <task>" → remove_tag
- Sub-tasks are NOT included in STATE — you MUST fetch them via action, NEVER answer from memory.
- Any question about sub-tasks → always return actions, never {"answer": "..."} saying there are none.
- "any sub-tasks"/"show sub-tasks"/"pending sub-tasks" with no specific task → get_subtasks action for EVERY incomplete task that has num_subtasks > 0
- get_subtasks=incomplete only, get_all_subtasks=all, get_done_subtasks=done only
- create_task: "name"=title; "notes"=description; "section"/"assignee"/"due" optional
- create_subtask: "task"=parent task name, "name"=sub-task title; "assignee"/"due"/"notes" optional
- rename_task: "task"=current name, "name"=new name
- set_description: "task"=task name, "notes"=new description text
- delete_task: "task"=task name (or "unnamed" if no name)
- get_task_details: "show details"/"description of"/"full info" → get_task_details
- explain_task: "explain"/"what's this task about"/"what must be done"/"tell me about <task>" → explain_task
- For "assign"/"add_follower": always use the email from TEAM MEMBERS in STATE
- RECENTLY SHOWN resolution: if type="task" → use its "name" as "task" field; if type="subtask" → use its "parent" as "task" and "name" as "subtask"; "both"/"all of them"/"those" → one action per item in RECENTLY SHOWN
- If ambiguous → {"answer": "clarifying question"}

=== WORKLOAD ANALYSIS ===
"who has the most"/"workload"/"team load"/"how busy is"/"how many tasks does X have" → {"answer": list per person}
Format: *👥 Team Workload*\nthen one line per person sorted by open task count desc:
• *Name* — N open tasks[, N overdue ⚠️][, N due this week 📅]
Highlight anyone with 2+ overdue as a risk. Use INCOMPLETE TASKS from STATE grouped by assignee.name.

=== BATCH OPERATIONS ===
"complete all [in section/by person]" → {"action":"batch_complete","section":"...","assignee":"..."}
"move all [in section/by person] to [section]" → {"action":"batch_move","section":"...","assignee":"...","to_section":"..."}
"assign all [in section] to [person]" → {"action":"batch_assign","section":"...","assignee":"email"}

=== DUE DATE INTELLIGENCE ===
"what's due"/"deadlines"/"overdue"/"due this week"/"due today" → {"answer": tasks grouped by urgency}
🔴 *Overdue* — tasks past their due_on date
🟡 *Due today / tomorrow*
🟠 *Due this week* (within 7 days of Today from STATE)
Each item: • Task name — Assignee — due DATE

=== STANDUP RULES ===
"standup"/"daily update" → format:
*✅ Done* — completed tasks
*🔄 In Progress* — tasks in sections named "Doing"/"In Progress"/"WIP"
*⚠️ Overdue* — incomplete tasks past due date, show assignee
*📅 Up next* — due within 7 days
Skip empty sections.`;

// Canonical implementations live in lib/agent-shared.js (shared with nothing
// else server-side yet, but kept there — not inline here — because
// public/index.html's client copy is meant to mirror it; see that file's
// header comment for why the browser can't just import this module).
const slackFuzzy = fuzzyMatch;
const slackParseDate = parseRelativeDate;

// Escapes Slack mrkdwn control characters so Asana-derived text (task names,
// notes, project/section/tag/user names, comments, etc.) can't be interpreted
// as Slack link/mention syntax (e.g. "<!channel>", "<@U123>", "<http://x|y>").
function escapeSlackText(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Builds Slack Block Kit blocks with "Complete" / "Assign to me" buttons for
// a list of concrete Asana tasks (each needs a known `gid`). Each button's
// `value` JSON-encodes enough info (action, taskGid) to act on it later from
// /slack/interactions without needing any server-side session. The acting
// identity is deliberately NOT embedded here — /slack/interactions uses
// payload.user.id (whoever actually clicks the button) so that a shared
// channel can't let one user's button trigger actions under another user's
// Asana identity. Only ever called for replies that already list specific
// tasks — never attached to every reply.
function buildTaskActionBlocks(taskList) {
  const blocks = [];
  for (const t of (taskList || []).filter(t => t.gid).slice(0, 10)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeSlackText(t.name)}*` } });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Complete", emoji: true },
          action_id: "task_action",
          value: JSON.stringify({ action: "complete_task", taskGid: t.gid }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🙋 Assign to me", emoji: true },
          action_id: "task_action",
          value: JSON.stringify({ action: "assign_to_me", taskGid: t.gid }),
        },
      ],
    });
  }
  return blocks;
}

// Builds Slack Block Kit "Confirm delete" / "Cancel" buttons for one or more
// pending deletions — used so an LLM-decided delete_task/delete_subtask
// never executes straight away (matching the plain browser confirm() gate
// already used for the equivalent bulk-delete button in public/index.html).
// Like buildTaskActionBlocks above, everything needed to act on the click
// (gid, and for a subtask its parent's gid so it can still be found via the
// same GET /subtasks the rest of this file uses) is embedded directly in the
// button's `value` — no server-side session/KV needed to resolve it.
function buildDeleteConfirmBlocks(pendingDeletes) {
  const blocks = [];
  for (const d of pendingDeletes) {
    const label = d.type === "subtask"
      ? `sub-task *${escapeSlackText(d.name)}* (under *${escapeSlackText(d.parentName)}*)`
      : `task *${escapeSlackText(d.name)}*`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `Delete ${label}? This cannot be undone.` } });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "🗑️ Confirm delete", emoji: true },
          action_id: "delete_confirm_action",
          value: JSON.stringify({ action: "confirm_delete", type: d.type, gid: d.gid, name: d.name }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel", emoji: true },
          action_id: "delete_confirm_action",
          value: JSON.stringify({ action: "cancel_delete", name: d.name }),
        },
      ],
    });
  }
  return blocks;
}

function htmlToSlack(html) {
  if (!html) return "";
  return html
    .replace(/<strong>(.*?)<\/strong>/gi, "*$1*")
    .replace(/<em>(.*?)<\/em>/gi, "_$1_")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<div[^>]*>/gi, "\n")
    .replace(/<\/div>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Per-channel-per-user state — lost on Vercel cold start, acceptable for MVP
const slackChannelState = new Map();
function getSlackChannelState(channelId, slackUserId) {
  const key = `${channelId}:${slackUserId}`;
  if (!slackChannelState.has(key)) {
    slackChannelState.set(key, { chatHistory: [], recentContext: [], projectGid: null, projectName: null, allProjects: [], workspaceUsers: [], workspaceTags: [], workspaceGid: null, me: null });
  }
  return slackChannelState.get(key);
}

async function asanaReq(method, endpoint, body, token) {
  const opts = { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" } };
  if (body && method !== "GET") opts.body = JSON.stringify({ data: body });
  const r = await fetch(ASANA_API + endpoint, opts);
  if (r.status === 204 || r.headers.get("content-length") === "0") return {};
  return r.json();
}

// Like asanaReq, but also surfaces the HTTP status code — needed by the cron
// digest below to distinguish "token is revoked/invalid" (401) from other
// errors, since asanaReq alone only returns the parsed JSON body.
async function asanaReqWithStatus(method, endpoint, token) {
  const r = await fetch(ASANA_API + endpoint, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const body = r.status === 204 || r.headers.get("content-length") === "0" ? {} : await r.json();
  return { status: r.status, body };
}

async function runSlackAgent(text, channelId, asanaToken, slackUserId) {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  // Per-request side channel: when this reply lists concrete tasks, the
  // answer branch below populates state.lastBlocks with Slack Block Kit
  // action buttons (Complete / Assign to me) for callers (e.g. /slack/events,
  // /slack/commands) to attach to their outgoing message. Reset it up front
  // so a stale value from a previous call never leaks onto an unrelated reply.
  const state = getSlackChannelState(channelId, slackUserId);
  state.lastBlocks = null;
  if (!asanaToken || !claudeKey) return "Missing Asana token or ANTHROPIC_API_KEY env var.";

  if (!state.workspaceGid) {
    try {
      const ws = await asanaReq("GET", "/workspaces?opt_fields=name,gid&limit=100", null, asanaToken);
      if (ws.errors) return `Asana error: ${ws.errors[0].message}`;
      state.workspaceGid = ws.data[0].gid;
      const [meRes, projR, usersR, tagsR] = await Promise.all([
        asanaReq("GET", "/users/me?opt_fields=name,email,gid", null, asanaToken),
        asanaReq("GET", `/projects?workspace=${state.workspaceGid}&opt_fields=name,gid,members.gid&limit=100&archived=false`, null, asanaToken),
        asanaReq("GET", `/users?workspace=${state.workspaceGid}&opt_fields=name,gid,email&limit=100`, null, asanaToken),
        asanaReq("GET", `/workspaces/${state.workspaceGid}/tags?opt_fields=name,gid&limit=100`, null, asanaToken),
      ]);
      if (meRes.errors) return `Asana error: ${meRes.errors[0].message}`;
      state.me = meRes.data;
      const projects = (projR.data || []).filter(p => p.members?.some(m => m.gid === state.me.gid)).sort((a, b) => a.name.localeCompare(b.name));
      if (!projects.length) return "No Asana projects found where you are a member.";
      state.allProjects = projects;
      state.workspaceUsers = (usersR.data || []).filter(u => u.email);
      state.workspaceTags = tagsR.data || [];
      const found = state.allProjects.find(p => p.gid === process.env.ASANA_PROJECT_GID) || state.allProjects[0];
      state.projectGid = found.gid;
      state.projectName = found.name;
    } catch (e) {
      return `Failed to connect to Asana: ${e.message}`;
    }
  }

  const [tasksR, sectionsR] = await Promise.all([
    asanaReq("GET", `/projects/${state.projectGid}/tasks?opt_fields=name,gid,completed,assignee.name,assignee.email,due_on,memberships.section.name,memberships.project.gid,num_subtasks&limit=200`, null, asanaToken),
    asanaReq("GET", `/projects/${state.projectGid}/sections?opt_fields=name,gid&limit=100`, null, asanaToken),
  ]).catch(e => { throw new Error(`Failed to fetch tasks: ${e.message}`); });

  const tasks = (tasksR.data || []).map(t => ({ ...t, _section: t.memberships?.find(m => m.project?.gid === state.projectGid)?.section?.name || null }));
  const sections = sectionsR.data || [];

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const tl = text.toLowerCase();
  const includeDone = /done|finish|complet|did|standup|yesterday|past|history|recap/.test(tl);
  const includeTags = /\btag(s|ged)?\b|\blabel\b|categor|urgent|priority|important/.test(tl);
  const includeMembers = /assign|@|email|follower|delegate|who\b|team\b/.test(tl) || state.workspaceUsers.some(u => u.name && tl.includes(u.name.toLowerCase()));

  const toSum = t => ({ name: t.name, assignee: t.assignee ? { name: t.assignee.name, email: t.assignee.email } : null, due: t.due_on || null, section: t._section || null, num_subtasks: t.num_subtasks || 0 });
  const openTasks = tasks.filter(t => !t.completed).map(toSum);
  const doneTasks = tasks.filter(t => t.completed).map(toSum);

  const histCtx = state.chatHistory.length ? "\n=== RECENT CONVERSATION ===\n" + state.chatHistory.map(m => `${m.role === "user" ? "User" : "Minisana"}: ${m.content}`).join("\n") + "\n" : "";
  const recentCtx = state.recentContext.length ? "\n=== RECENTLY SHOWN — check this FIRST to resolve \"it\"/\"that\"/\"both\"/\"those\"/\"them\" ===\n" + state.recentContext.map(r => r.type === "subtask" ? `subtask "${r.name}" (parent task: "${r.parent}")` : `task "${r.name}"`).join("\n") + "\n" : "";

  const stateMsg = `=== STATE ===
User: ${state.me?.name} <${state.me?.email}>
Project: "${state.projectName}"
Today: ${today}
Tomorrow: ${tomorrow}

=== INCOMPLETE TASKS ===
${JSON.stringify(openTasks)}
${includeDone ? `\n=== COMPLETED TASKS ===\n${JSON.stringify(doneTasks)}\n` : ""}=== SECTIONS ===
${JSON.stringify(sections.map(s => s.name))}

=== AVAILABLE PROJECTS ===
${JSON.stringify(state.allProjects.map(p => p.name))}
${includeTags ? `\n=== TAGS ===\n${JSON.stringify(state.workspaceTags.map(t => t.name))}\n` : ""}${includeMembers ? `\n=== TEAM MEMBERS ===\n${JSON.stringify(state.workspaceUsers.map(u => ({ name: u.name, email: u.email })))}\n` : ""}${histCtx}${recentCtx}`;

  let raw;
  try {
    const result = await callLLM({
      provider: "anthropic",
      messages: [
        { role: "system", content: SLACK_RULES_BLOCK },
        { role: "user", content: stateMsg + "\n\nUser message: " + text },
      ],
      apiKey: claudeKey,
      temperature: 0.2,
      maxTokens: 800,
      jsonMode: true,
      stream: false,
    });
    raw = result.body?.choices?.[0]?.message?.content || "";
  } catch (e) {
    return `LLM error: ${e.message}`;
  }

  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return "Couldn't parse the response. Try rephrasing."; }

  if (parsed?.answer) {
    const reply = escapeSlackText(htmlToSlack(parsed.answer));
    state.chatHistory.push({ role: "user", content: text }, { role: "agent", content: reply });
    if (state.chatHistory.length > 20) state.chatHistory.splice(0, state.chatHistory.length - 20);
    const mentioned = tasks.filter(t => t.name && reply.toLowerCase().includes(t.name.toLowerCase()));
    if (mentioned.length) {
      state.recentContext = mentioned.slice(0, 10).map(t => ({ type: "task", name: t.name, gid: t.gid }));
      state.lastBlocks = buildTaskActionBlocks(mentioned);
    }
    return reply;
  }

  const actions = Array.isArray(parsed) ? parsed : (parsed.actions || []);
  if (!actions.length || actions.every(a => a.action === "unknown")) return "I didn't understand that. Could you rephrase?";

  const resolveUser = id => { if (!id) return null; if (id.includes("@") || /^\d{10,}$/.test(id)) return id; const u = state.workspaceUsers.find(u => u.name.toLowerCase() === id.toLowerCase() || u.name.toLowerCase().includes(id.toLowerCase())); return u ? u.gid : id; };
  const userDisplay = id => state.workspaceUsers.find(u => u.gid === id || u.email === id)?.name || id;
  const subFetch = new Map();
  const fetchSubs = async parentGid => { if (!subFetch.has(parentGid)) { const r = await asanaReq("GET", `/tasks/${parentGid}/subtasks?opt_fields=name,gid,completed&limit=100`, null, asanaToken); if (r.errors) throw new Error(r.errors[0].message); subFetch.set(parentGid, r.data || []); } return subFetch.get(parentGid); };

  // delete_task/delete_subtask never execute directly from an LLM decision —
  // they're resolved to a concrete gid below, then held for an explicit
  // Slack button confirmation (see buildDeleteConfirmBlocks and the
  // delete_confirm_action handler in /slack/interactions), matching the
  // plain confirm() gate the web UI already uses for the same actions.
  const deleteActions = actions.filter(a => a.action === "delete_task" || a.action === "delete_subtask");
  const otherActions = actions.filter(a => a.action !== "delete_task" && a.action !== "delete_subtask");

  for (const a of otherActions) { if (a.due) a.due = slackParseDate(a.due); }

  const results = [];

  for (const a of otherActions) {
    if (a.action === "unknown") continue;

    if (a.action === "switch_project") {
      const p = slackFuzzy(state.allProjects, a.project || a.name || a.task);
      if (!p) { results.push({ ok: false, msg: `Project "${a.project}" not found` }); continue; }
      state.projectGid = p.gid; state.projectName = p.name;
      results.push({ ok: true, msg: `Switched to *${p.name}*` }); continue;
    }

    if (a.action === "undo") { results.push({ ok: false, msg: "Undo is not supported in Slack." }); continue; }

    if (["batch_complete", "batch_move", "batch_assign"].includes(a.action)) {
      try {
        const isSelf = v => ["me", "my", "i", "myself"].includes((v || "").toLowerCase());
        let targets = tasks.filter(t => !t.completed);
        if (a.section) { const s = slackFuzzy(sections, a.section); if (s) targets = targets.filter(t => t._section === s.name); }
        if (a.assignee) { const name = isSelf(a.assignee) ? state.me?.name : a.assignee; targets = targets.filter(t => t.assignee?.name?.toLowerCase().includes(name.toLowerCase())); }
        if (!targets.length) { results.push({ ok: false, msg: "No matching tasks found." }); continue; }
        if (a.action === "batch_complete") {
          const bRes = await Promise.allSettled(targets.map(t => asanaReq("PUT", `/tasks/${t.gid}`, { completed: true }, asanaToken)));
          const done = bRes.filter(r => r.status === "fulfilled" && !r.value?.errors).length;
          results.push({ ok: true, msg: `Completed *${done}* task${done !== 1 ? "s" : ""}` });
        } else if (a.action === "batch_move") {
          const toSec = slackFuzzy(sections, a.to_section);
          if (!toSec) { results.push({ ok: false, msg: `Section "${a.to_section}" not found` }); continue; }
          const bRes = await Promise.allSettled(targets.map(t => asanaReq("POST", `/sections/${toSec.gid}/addTask`, { task: t.gid }, asanaToken)));
          const moved = bRes.filter(r => r.status === "fulfilled" && !r.value?.errors).length;
          results.push({ ok: true, msg: `Moved *${moved}* task${moved !== 1 ? "s" : ""} → *${toSec.name}*` });
        } else if (a.action === "batch_assign") {
          const aid = resolveUser(a.assignee); const dname = userDisplay(aid);
          const bRes = await Promise.allSettled(targets.map(t => asanaReq("PUT", `/tasks/${t.gid}`, { assignee: aid }, asanaToken)));
          const assigned = bRes.filter(r => r.status === "fulfilled" && !r.value?.errors).length;
          results.push({ ok: true, msg: `Assigned *${assigned}* task${assigned !== 1 ? "s" : ""} to *${dname}*` });
        }
      } catch (e) { results.push({ ok: false, msg: `Batch operation failed: ${e.message}` }); }
      continue;
    }

    if (a.action === "create_task") {
      try {
        const taskName = a.name || a.task;
        const data = { name: taskName, projects: [state.projectGid] };
        if (a.assignee) data.assignee = a.assignee;
        if (a.due) data.due_on = a.due;
        if (a.notes) data.notes = a.notes;
        if (a.section) { const s = slackFuzzy(sections, a.section); if (s) data.memberships = [{ project: state.projectGid, section: s.gid }]; }
        const r = await asanaReq("POST", "/tasks", data, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Created *${taskName}*${a.due ? ` (due ${a.due})` : ""}` });
        state.recentContext = [{ type: "task", name: taskName, gid: r.data?.gid || "" }];
      } catch (e) { results.push({ ok: false, msg: `Couldn't create task: ${e.message}` }); }
      continue;
    }

    if (!a.task) { results.push({ ok: false, msg: "Could not identify which task you meant. Try being more specific." }); continue; }

    const task = slackFuzzy(tasks, a.task);
    if (!task) { results.push({ ok: false, msg: `Task "${a.task}" not found` }); continue; }

    try {
      if (a.action === "move_to_section") {
        const s = slackFuzzy(sections, a.section);
        if (!s) { results.push({ ok: false, msg: `Section "${a.section}" not found` }); continue; }
        const r = await asanaReq("POST", `/sections/${s.gid}/addTask`, { task: task.gid }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Moved *${task.name}* → *${s.name}*` });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "complete") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { completed: true }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Marked *${task.name}* complete ✓` });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "uncomplete") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { completed: false }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Reopened *${task.name}*` });
      } else if (a.action === "assign") {
        const aid = resolveUser(a.assignee);
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { assignee: aid }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Assigned *${task.name}* to ${userDisplay(aid)}` });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "unassign") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { assignee: null }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Removed assignee from *${task.name}*` });
      } else if (a.action === "set_due_date") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { due_on: a.due }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Set due date of *${task.name}* to ${a.due}` });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "remove_due_date") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { due_on: null }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Removed due date from *${task.name}*` });
      } else if (a.action === "comment") {
        const r = await asanaReq("POST", `/tasks/${task.gid}/stories`, { text: a.comment }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Commented on *${task.name}*: "${a.comment}"` });
      } else if (a.action === "rename_task") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { name: a.name }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Renamed to *${a.name}*` });
        state.recentContext = [{ type: "task", name: a.name, gid: task.gid }];
      } else if (a.action === "set_description") {
        const r = await asanaReq("PUT", `/tasks/${task.gid}`, { notes: a.notes || a.description || "" }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Updated description of *${task.name}*` });
      } else if (a.action === "create_subtask") {
        const stData = { name: a.name };
        if (a.assignee) stData.assignee = resolveUser(a.assignee);
        if (a.due) stData.due_on = a.due;
        if (a.notes) stData.notes = a.notes;
        const r = await asanaReq("POST", `/tasks/${task.gid}/subtasks`, stData, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Created sub-task *${a.name}* under *${task.name}*` });
        state.recentContext = [{ type: "subtask", name: a.name, gid: r.data?.gid || "", parent: task.name, parentGid: task.gid }];
      } else if (a.action === "complete_subtask" || a.action === "uncomplete_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        const done = a.action === "complete_subtask";
        const r = await asanaReq("PUT", `/tasks/${sub.gid}`, { completed: done }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Sub-task *${sub.name}* marked ${done ? "complete ✓" : "incomplete"}` });
        state.recentContext = [{ type: "subtask", name: sub.name, gid: sub.gid, parent: task.name, parentGid: task.gid }];
      } else if (a.action === "get_subtasks" || a.action === "get_all_subtasks" || a.action === "get_done_subtasks") {
        const r = await asanaReq("GET", `/tasks/${task.gid}/subtasks?opt_fields=name,gid,completed,assignee.name,due_on&limit=100`, null, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        const all = r.data || [];
        const vis = a.action === "get_all_subtasks" ? all : a.action === "get_done_subtasks" ? all.filter(s => s.completed) : all.filter(s => !s.completed);
        if (!all.length) results.push({ ok: true, readonly: true, msg: `*${task.name}* has no sub-tasks.` });
        else if (!vis.length) results.push({ ok: true, readonly: true, msg: `*${task.name}* has no ${a.action === "get_done_subtasks" ? "completed" : "incomplete"} sub-tasks.` });
        else {
          const list = vis.map(s => `${s.completed ? "✓" : "○"} ${s.name}${s.assignee ? ` — ${s.assignee.name}` : ""}${s.due_on ? ` (due ${s.due_on})` : ""}`).join("\n");
          results.push({ ok: true, readonly: true, msg: `Sub-tasks of *${task.name}*:\n${list}` });
          state.recentContext = vis.slice(0, 10).map(s => ({ type: "subtask", name: s.name, gid: s.gid, parent: task.name, parentGid: task.gid }));
        }
      } else if (a.action === "get_task_details") {
        const [tr, sr, cr] = await Promise.all([
          asanaReq("GET", `/tasks/${task.gid}?opt_fields=name,notes,assignee.name,due_on,completed,followers.name,tags.name,memberships.section.name`, null, asanaToken),
          asanaReq("GET", `/tasks/${task.gid}/subtasks?opt_fields=name,completed,assignee.name,due_on&limit=100`, null, asanaToken),
          asanaReq("GET", `/tasks/${task.gid}/stories?opt_fields=text,resource_subtype,created_by.name,created_at&limit=20`, null, asanaToken),
        ]);
        if (tr.errors) throw new Error(tr.errors[0].message);
        const d = tr.data || {};
        const lines = [`*${d.name || "(unnamed)"}*`];
        if (d.notes) lines.push(`Description: ${d.notes}`);
        if (d.assignee) lines.push(`Assignee: ${d.assignee.name}`);
        if (d.due_on) lines.push(`Due: ${d.due_on}`);
        const sec = d.memberships?.find(m => m.section)?.section?.name;
        if (sec) lines.push(`Section: ${sec}`);
        if (d.followers?.length) lines.push(`Followers: ${d.followers.map(f => f.name).join(", ")}`);
        if (d.tags?.length) lines.push(`Tags: ${d.tags.map(t => t.name).join(", ")}`);
        const subs = sr.data || [];
        if (subs.length) lines.push(`Sub-tasks (${subs.filter(s => !s.completed).length} open / ${subs.length} total):\n` + subs.map(s => `  ${s.completed ? "✓" : "○"} ${s.name}`).join("\n"));
        const comments = (cr.data || []).filter(s => s.resource_subtype === "comment").slice(-3);
        if (comments.length) lines.push(`Recent comments:\n` + comments.map(c => `  ${c.created_by?.name || "Unknown"}: ${c.text}`).join("\n"));
        results.push({ ok: true, readonly: true, msg: lines.join("\n") });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "explain_task") {
        const [tr, sr, cr] = await Promise.all([
          asanaReq("GET", `/tasks/${task.gid}?opt_fields=name,notes,assignee.name,due_on,tags.name,memberships.section.name`, null, asanaToken),
          asanaReq("GET", `/tasks/${task.gid}/subtasks?opt_fields=name,completed,assignee.name&limit=100`, null, asanaToken),
          asanaReq("GET", `/tasks/${task.gid}/stories?opt_fields=text,resource_subtype,created_by.name&limit=30`, null, asanaToken),
        ]);
        if (tr.errors) throw new Error(tr.errors[0].message);
        const d = tr.data || {};
        const ctx = { name: d.name, description: d.notes || "", assignee: d.assignee?.name || null, due: d.due_on || null, subtasks: (sr.data || []).map(s => ({ name: s.name, done: !!s.completed })), comments: (cr.data || []).filter(s => s.resource_subtype === "comment").slice(-5).map(s => ({ author: s.created_by?.name, text: s.text })) };
        const explainResult = await callLLM({
          provider: "anthropic",
          messages: [
            { role: "system", content: "Explain this Asana task in 3-5 plain sentences. Cover: what must be done, who is responsible, any deadline. If comments add context, include them. Return plain text only." },
            { role: "user", content: `Task: ${JSON.stringify(ctx)}` },
          ],
          apiKey: claudeKey,
          maxTokens: 400,
          jsonMode: false,
          stream: false,
        });
        results.push({ ok: true, readonly: true, msg: explainResult.body?.choices?.[0]?.message?.content || "(no explanation)" });
        state.recentContext = [{ type: "task", name: task.name, gid: task.gid }];
      } else if (a.action === "add_follower" || a.action === "remove_follower") {
        const fid = resolveUser(a.follower || a.assignee);
        if (!fid) { results.push({ ok: false, msg: "User not found" }); continue; }
        const endpoint = a.action === "add_follower" ? `/tasks/${task.gid}/addFollowers` : `/tasks/${task.gid}/removeFollowers`;
        const r = await asanaReq("POST", endpoint, { followers: [fid] }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `${a.action === "add_follower" ? "Added" : "Removed"} ${userDisplay(fid)} ${a.action === "add_follower" ? "as follower of" : "from followers of"} *${task.name}*` });
      } else if (a.action === "add_tag") {
        let tag = slackFuzzy(state.workspaceTags, a.tag || a.name);
        if (!tag) { const r = await asanaReq("POST", "/tags", { name: a.tag || a.name, workspace: state.workspaceGid }, asanaToken); if (r.errors) throw new Error(r.errors[0].message); tag = { gid: r.data.gid, name: r.data.name }; state.workspaceTags.push(tag); }
        const r = await asanaReq("POST", `/tasks/${task.gid}/addTag`, { tag: tag.gid }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Tagged *${task.name}* as *${tag.name}*` });
      } else if (a.action === "remove_tag") {
        const tag = slackFuzzy(state.workspaceTags, a.tag || a.name);
        if (!tag) { results.push({ ok: false, msg: `Tag "${a.tag || a.name}" not found` }); continue; }
        const r = await asanaReq("POST", `/tasks/${task.gid}/removeTag`, { tag: tag.gid }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Removed tag *${tag.name}* from *${task.name}*` });
      } else if (a.action === "assign_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        const aid = resolveUser(a.assignee);
        const r = await asanaReq("PUT", `/tasks/${sub.gid}`, { assignee: aid }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Assigned sub-task *${sub.name}* to ${userDisplay(aid)}` });
      } else if (a.action === "rename_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        const r = await asanaReq("PUT", `/tasks/${sub.gid}`, { name: a.name }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Renamed sub-task to *${a.name}*` });
      } else if (a.action === "unassign_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        const r = await asanaReq("PUT", `/tasks/${sub.gid}`, { assignee: null }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Removed assignee from sub-task *${sub.name}*` });
      } else if (a.action === "set_due_date_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        const r = await asanaReq("PUT", `/tasks/${sub.gid}`, { due_on: a.due }, asanaToken);
        if (r.errors) throw new Error(r.errors[0].message);
        results.push({ ok: true, msg: `Set due date of *${sub.name}* to ${a.due}` });
      }
    } catch (e) {
      results.push({ ok: false, msg: `${a.action} failed: ${e.message}` });
    }
  }

  // Resolve each pending delete to a concrete gid now (fuzzy-matching only
  // works against this request's already-fetched tasks/sections), but don't
  // execute it — hand off to buildDeleteConfirmBlocks below and wait for an
  // explicit button click (see delete_confirm_action in /slack/interactions).
  const pendingDeletes = [];
  for (const a of deleteActions) {
    if (!a.task) { results.push({ ok: false, msg: "Could not identify which task to delete. Try being more specific." }); continue; }
    const task = slackFuzzy(tasks, a.task);
    if (!task) { results.push({ ok: false, msg: `Task "${a.task}" not found` }); continue; }
    if (a.action === "delete_task") {
      pendingDeletes.push({ type: "task", gid: task.gid, name: task.name });
    } else {
      try {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        pendingDeletes.push({ type: "subtask", gid: sub.gid, name: sub.name, parentName: task.name });
      } catch (e) {
        results.push({ ok: false, msg: `delete_subtask failed: ${e.message}` });
      }
    }
  }
  if (pendingDeletes.length) state.lastBlocks = buildDeleteConfirmBlocks(pendingDeletes);

  const historyNote = pendingDeletes.length
    ? [...results.map(r => r.msg), `Waiting on delete confirmation for ${pendingDeletes.map(d => d.name).join(", ")}`].join("; ")
    : results.map(r => r.msg).join("; ");
  state.chatHistory.push({ role: "user", content: text }, { role: "agent", content: historyNote });
  if (state.chatHistory.length > 20) state.chatHistory.splice(0, state.chatHistory.length - 20);

  if (!results.length && !pendingDeletes.length) return "Done.";
  // results[].msg may embed Asana-derived data (task/section/tag/user names, notes,
  // comments) interpolated directly by the code above — escape the assembled text
  // as a whole so none of it can be read by Slack as link/mention mrkdwn syntax.
  let reply = "";
  if (results.length) {
    const allOk = results.every(r => r.ok);
    const prefix = !allOk ? "Finished with issues:" : results.every(r => r.readonly) ? "Here's what I found:" : "Done!";
    reply = escapeSlackText(prefix + "\n" + results.map(r => `${r.ok ? "✓" : "✗"} ${r.msg}`).join("\n"));
  }
  if (pendingDeletes.length) {
    const confirmNote = `Please confirm ${pendingDeletes.length > 1 ? "these deletions" : "this deletion"} below — this cannot be undone.`;
    reply = reply ? reply + "\n\n" + confirmNote : confirmNote;
  }
  return reply;
}

// ── Slack Events API ─────────────────────────────────────────────────────────
app.post("/slack/events", verifySlackSignature, async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });
  if (!event || event.bot_id || event.type !== "message") return res.sendStatus(200);

  res.sendStatus(200);

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const postMessage = (text, blocks) => fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
    body: JSON.stringify({ channel: event.channel, text, ...(blocks && blocks.length ? { blocks } : {}) }),
  });

  waitUntil((async () => {
    try {
      const asanaToken = await getAsanaTokenForUser(event.user);
      if (!asanaToken) {
        const connectUrl = `https://minisana.vercel.app/auth/asana?token=${await mintAsanaConnectToken(event.user)}`;
        await postMessage(`Hi! I need to connect to your Asana account before I can help.\n\n<${connectUrl}|Click here to connect Asana> — it takes about 10 seconds.`);
        return;
      }
      const reply = await runSlackAgent(event.text, event.channel, asanaToken, event.user);
      const state = getSlackChannelState(event.channel, event.user);
      await postMessage(reply, state.lastBlocks);
    } catch (e) {
      console.error("Slack handler error:", e.message);
      await postMessage("Something went wrong. Please try again.").catch(() => {});
    }
  })());
});

// ── Slack slash command: /asana ──────────────────────────────────────────────
// Manual Slack app setup required: create a Slash Command named "/asana"
// with Request URL <deployed-base-url>/slack/commands (see comment block near
// the top of this file for the full list of Slack request URLs to wire up).
app.post("/slack/commands", verifySlackSignature, (req, res) => {
  const { text, user_id: slackUserId, channel_id: channelId, response_url: responseUrl } = req.body;

  // Slack requires an ack within 3 seconds — respond immediately, then keep
  // working in the background and deliver the real answer via response_url.
  res.status(200).json({ response_type: "ephemeral", text: "On it…" });
  if (!slackUserId || !channelId || !responseUrl) return;

  const postToResponseUrl = (body) => fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  waitUntil((async () => {
    try {
      const asanaToken = await getAsanaTokenForUser(slackUserId);
      if (!asanaToken) {
        const connectUrl = `https://minisana.vercel.app/auth/asana?token=${await mintAsanaConnectToken(slackUserId)}`;
        await postToResponseUrl({
          response_type: "ephemeral",
          text: `Hi! I need to connect to your Asana account before I can help.\n\n<${connectUrl}|Click here to connect Asana> — it takes about 10 seconds.`,
        });
        return;
      }
      const query = (text || "").trim() || "show me my tasks due today";
      const reply = await runSlackAgent(query, channelId, asanaToken, slackUserId);
      const state = getSlackChannelState(channelId, slackUserId);
      const blocks = state.lastBlocks && state.lastBlocks.length
        ? [{ type: "section", text: { type: "mrkdwn", text: reply } }, ...state.lastBlocks]
        : undefined;
      await postToResponseUrl({ response_type: "in_channel", text: reply, ...(blocks ? { blocks } : {}) });
    } catch (e) {
      console.error("Slack slash command error:", e.message);
      await postToResponseUrl({ response_type: "ephemeral", text: "Something went wrong. Please try again." }).catch(() => {});
    }
  })());
});

// ── Slack interactive buttons: complete / assign-to-me ───────────────────────
// Manual Slack app setup required: enable "Interactivity & Shortcuts" with
// Request URL <deployed-base-url>/slack/interactions (see comment block near
// the top of this file for the full list of Slack request URLs to wire up).
app.post("/slack/interactions", verifySlackSignature, (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send();
  }

  // Ack within Slack's 3-second interaction window immediately.
  res.status(200).send();

  if (payload?.type !== "block_actions" || !Array.isArray(payload.actions)) return;
  const responseUrl = payload.response_url;

  const postToResponseUrl = (body) => fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  waitUntil((async () => {
    for (const buttonAction of payload.actions) {
      let value;
      try {
        value = JSON.parse(buttonAction.value);
      } catch {
        continue;
      }
      const { action: actionType, taskGid } = value;
      const slackUserId = payload.user?.id;
      if (!slackUserId) continue;

      if (actionType === "cancel_delete") {
        await postToResponseUrl({ replace_original: true, text: `Cancelled — *${escapeSlackText(value.name || "that")}* was not deleted.`, blocks: [] }).catch(() => {});
        continue;
      }

      if (actionType === "confirm_delete") {
        try {
          const asanaToken = await getAsanaTokenForUser(slackUserId);
          if (!asanaToken) {
            await postToResponseUrl({
              replace_original: false,
              response_type: "ephemeral",
              text: "Your Asana connection has expired or isn't set up. Please reconnect and try again.",
            });
            continue;
          }
          if (!value.gid) throw new Error("Missing task id");
          await asanaReq("DELETE", `/tasks/${value.gid}`, null, asanaToken);
          const label = value.type === "subtask" ? "sub-task" : "task";
          await postToResponseUrl({ replace_original: true, text: `🗑️ Deleted ${label} *${escapeSlackText(value.name || "")}*`, blocks: [] });
        } catch (e) {
          console.error("Slack delete-confirm interaction error:", e.message);
          await postToResponseUrl({
            replace_original: false,
            response_type: "ephemeral",
            text: `Something went wrong: ${escapeSlackText(e.message)}`,
          }).catch(() => {});
        }
        continue;
      }

      if (!taskGid) continue;

      try {
        const asanaToken = await getAsanaTokenForUser(slackUserId);
        if (!asanaToken) {
          await postToResponseUrl({
            replace_original: false,
            response_type: "ephemeral",
            text: "Your Asana connection has expired or isn't set up. Please reconnect and try again.",
          });
          continue;
        }

        if (actionType === "complete_task") {
          const r = await asanaReq("PUT", `/tasks/${taskGid}?opt_fields=name`, { completed: true }, asanaToken);
          if (r.errors) throw new Error(r.errors[0].message);
          const name = escapeSlackText(r.data?.name || "task");
          await postToResponseUrl({ replace_original: true, text: `✅ Marked *${name}* complete`, blocks: [] });
        } else if (actionType === "assign_to_me") {
          // Resolve the acting Slack user's Asana identity fresh via
          // GET /users/me — rather than trusting any cached workspace state,
          // since the interaction may arrive for a channel/session whose
          // in-memory state (getSlackChannelState) has since been evicted
          // (e.g. after a cold start on Vercel).
          const meRes = await asanaReq("GET", "/users/me?opt_fields=gid,name", null, asanaToken);
          if (meRes.errors) throw new Error(meRes.errors[0].message);
          const r = await asanaReq("PUT", `/tasks/${taskGid}?opt_fields=name`, { assignee: meRes.data.gid }, asanaToken);
          if (r.errors) throw new Error(r.errors[0].message);
          const name = escapeSlackText(r.data?.name || "task");
          const me = escapeSlackText(meRes.data?.name || "you");
          await postToResponseUrl({ replace_original: true, text: `🙋 Assigned *${name}* to ${me}`, blocks: [] });
        }
      } catch (e) {
        console.error("Slack interaction error:", e.message);
        await postToResponseUrl({
          replace_original: false,
          response_type: "ephemeral",
          text: `Something went wrong: ${escapeSlackText(e.message)}`,
        }).catch(() => {});
      }
    }
  })());
});

// ── Daily due-tasks cron ──────────────────────────────────────────────────────
// Required env var: CRON_SECRET — a random secret string, set as an env var
// on the Vercel project (alongside ASANA_CLIENT_ID/SECRET, SLACK_BOT_TOKEN,
// SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY, KV_REST_API_URL/TOKEN, etc). Vercel
// automatically sends `Authorization: Bearer <CRON_SECRET>` on invocations it
// triggers from vercel.json's `crons` entry, so verifyCronSecret below can
// tell a real scheduled run apart from anyone else hitting this path.
//
// vercel.json schedules this route for "0 13 * * *" (13:00 UTC daily), chosen
// as a rough approximation of 9am US Eastern — Vercel Cron schedules are
// always in UTC (no per-project timezone setting), so adjust the hour in
// vercel.json to whatever local morning time actually fits your users.
function verifyCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set — rejecting cron request (fail closed)");
    return res.sendStatus(500);
  }
  if (req.headers.authorization !== `Bearer ${secret}`) return res.sendStatus(401);
  next();
}

// Runs `fn` over `items` with at most `limit` in flight at once — keeps the
// daily digest from firing every connected user's Asana/Slack calls fully in
// parallel if the connected-users registry grows large.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return results;
}

// Fetches a user's incomplete tasks due today or earlier via Asana's search
// API, which (unlike the plain /tasks endpoint) supports the assignee.any +
// due_on.before filters needed here in a single call. Note: the
// /workspaces/{gid}/tasks/search endpoint requires an Asana paid tier
// ("Advanced Search") — on a free/Basic workspace this call itself will
// error, which is caught like any other per-user failure below (logged,
// counted as an error, run continues for other users).
async function fetchDueOrOverdueTasks(token) {
  const ws = await asanaReqWithStatus("GET", "/workspaces?opt_fields=gid&limit=1", token);
  if (ws.status === 401) return { invalidToken: true };
  if (ws.body.errors) throw new Error(ws.body.errors[0]?.message || `Failed to list workspaces (status ${ws.status})`);
  const workspaceGid = ws.body.data?.[0]?.gid;
  if (!workspaceGid) throw new Error("No Asana workspace found for user");

  const me = await asanaReqWithStatus("GET", "/users/me?opt_fields=gid", token);
  if (me.status === 401) return { invalidToken: true };
  if (me.body.errors) throw new Error(me.body.errors[0]?.message || `Failed to fetch current user (status ${me.status})`);
  const userGid = me.body.data?.gid;
  if (!userGid) throw new Error("Could not resolve Asana user gid");

  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  // due_on.before is a strict "<" filter, so due_on.before=tomorrow means
  // "due on or before today" without needing to special-case today's own
  // boundary (avoids ambiguity over whether due_on.before is inclusive).
  const search = await asanaReqWithStatus(
    "GET",
    `/workspaces/${workspaceGid}/tasks/search?assignee.any=${userGid}&due_on.before=${tomorrow}&completed=false&opt_fields=name,gid,due_on&sort_by=due_date&limit=100`,
    token
  );
  if (search.status === 401) return { invalidToken: true };
  if (search.body.errors) throw new Error(search.body.errors[0]?.message || `Task search failed (status ${search.status})`);

  const tasks = search.body.data || [];
  return {
    invalidToken: false,
    overdue: tasks.filter(t => t.due_on && t.due_on < today),
    dueToday: tasks.filter(t => t.due_on === today),
  };
}

function buildDueTasksDigest(overdue, dueToday) {
  const lines = [];
  if (overdue.length) {
    lines.push("*🔴 Overdue*");
    for (const t of overdue) lines.push(`• ${escapeSlackText(t.name)} — was due ${t.due_on}`);
  }
  if (dueToday.length) {
    if (lines.length) lines.push("");
    lines.push("*🟡 Due today*");
    for (const t of dueToday) lines.push(`• ${escapeSlackText(t.name)}`);
  }
  return `Good morning! Here's what needs your attention in Asana:\n${lines.join("\n")}`;
}

async function openSlackDm(slackToken, slackUserId) {
  const r = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
    body: JSON.stringify({ users: slackUserId }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`conversations.open failed: ${d.error || "unknown error"}`);
  return d.channel.id;
}

async function sendSlackMessage(slackToken, channelId, text, blocks) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
    body: JSON.stringify({ channel: channelId, text, ...(blocks && blocks.length ? { blocks } : {}) }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`chat.postMessage failed: ${d.error || "unknown error"}`);
}

// GET /cron/notify-due-tasks — invoked daily by the Vercel Cron entry in
// vercel.json (see verifyCronSecret above for the auth model). For every
// Slack user in the connected-users registry, DMs them a digest of Asana
// tasks that are overdue or due today; users with nothing due get no message
// at all (no empty-digest spam). Users are processed with modest concurrency
// (not fully serial, not fully unbounded parallel) to be gentle on Asana/Slack
// rate limits as the registry grows. Returns a JSON summary for observability
// in Vercel's cron invocation logs.
app.get("/cron/notify-due-tasks", verifyCronSecret, async (req, res) => {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return res.status(500).json({ error: "SLACK_BOT_TOKEN is not configured" });

  const userIds = await getConnectedUsers();

  let notified = 0, skipped = 0, errors = 0;

  await mapWithConcurrency(userIds, 3, async (slackUserId) => {
    try {
      const token = await getAsanaTokenForUser(slackUserId);
      if (!token) { skipped++; return; }

      const result = await fetchDueOrOverdueTasks(token);
      if (result.invalidToken) {
        // Conservative on purpose: a 401 here could also reflect a transient
        // refresh hiccup (getAsanaTokenForUser silently falls back to a stale
        // access token if refreshAsanaToken's response has no access_token),
        // not necessarily a permanently revoked connection — so this is
        // logged and counted as an error rather than auto-removing the user
        // from the registry (removeConnectedUser is available if that's ever
        // wanted, but isn't called from here).
        errors++;
        console.error(`Asana auth failed for Slack user ${slackUserId} (due-tasks cron) — token may be revoked`);
        return;
      }

      const { overdue, dueToday } = result;
      if (!overdue.length && !dueToday.length) { skipped++; return; }

      const text = buildDueTasksDigest(overdue, dueToday);
      const blocks = buildTaskActionBlocks([...overdue, ...dueToday]);
      const channelId = await openSlackDm(slackToken, slackUserId);
      await sendSlackMessage(slackToken, channelId, text, blocks);
      notified++;
    } catch (e) {
      errors++;
      console.error(`Failed to send due-tasks digest to ${slackUserId}:`, e.message);
    }
  });

  res.json({ notified, skipped, errors });
});

// ── Warm a specific Ollama model on demand ───────────────────────────────────
app.post("/warm", async (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: "Missing model" });
  try {
    await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, keep_alive: "30m" }),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function warmOllama() {
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const { models = [] } = await r.json();
    if (!models.length) return;
    const model = models[0].name;
    console.log(`⚡ Warming up ${model}…`);
    await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    console.log(`✓ ${model} ready`);
  } catch {}
}

const PORT = process.env.PORT || 3000;

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (USE_OLLAMA) {
    await ensureOllama();
    await logRecommendation();
  } else {
    console.log("ℹ Ollama disabled in setup — using cloud providers (Groq / OpenAI / Anthropic)");
  }
  app.listen(PORT, () => {
    console.log(`\n✅ Minisana running at http://localhost:${PORT}\n`);
    if (USE_OLLAMA) warmOllama();
  });
}

export default app;
