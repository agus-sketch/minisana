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

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public")));

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

const LLM_URLS = {
  groq:      "https://api.groq.com/openai/v1/chat/completions",
  openai:    "https://api.openai.com/v1/chat/completions",
  ollama:    "http://localhost:11434/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};
const LLM_MODELS = {
  groq:      "llama-3.3-70b-versatile",
  openai:    "gpt-4o-mini",
  ollama:    "qwen2.5:14b",
  anthropic: "claude-haiku-4-5-20251001",
};

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
app.post("/asana", async (req, res) => {
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
app.post("/asana-attach", upload.single("file"), async (req, res) => {
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

  const url   = LLM_URLS[provider]   || LLM_URLS.groq;
  const model = req.body.model       || LLM_MODELS[provider] || LLM_MODELS.groq;
  const msgs  = messages || [{ role: "user", content: prompt }];

  if (provider === "anthropic") return handleAnthropic({ req, res, llmKey, url, model, msgs, stream });

  const headers = { "Content-Type": "application/json" };
  if (llmKey) headers.Authorization = `Bearer ${llmKey}`;

  const payload = { model, messages: msgs, temperature: 0.2, max_tokens: 600, response_format: { type: "json_object" } };
  if (stream) payload.stream = true;
  if (provider === "ollama") payload.keep_alive = "30m";

  const ctrl = new AbortController();
  const timeout = provider === "ollama" ? 120000 : 30000;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onClientClose = () => ctrl.abort();
  req.on("close", onClientClose);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (stream && r.ok && r.body) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      try {
        for await (const chunk of r.body) res.write(chunk);
      } catch (e) {
        // upstream stream error — best-effort close
      }
      clearTimeout(timer);
      req.off("close", onClientClose);
      res.end();
      return;
    }

    clearTimeout(timer);
    req.off("close", onClientClose);
    res.json(await r.json());
  } catch (e) {
    clearTimeout(timer);
    req.off("close", onClientClose);
    const msg = e.name === "AbortError" ? "LLM timed out — try again" : e.message;
    if (res.headersSent) res.end();
    else res.status(500).json({ error: msg });
  }
});

// ── Anthropic adapter (translates to/from OpenAI shape so the UI is unchanged)
async function handleAnthropic({ req, res, llmKey, url, model, msgs, stream }) {
  const sys = msgs
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
  const conv = msgs.filter(m => m.role !== "system");
  const convWithPrefill = [...conv, { role: "assistant", content: "{" }];

  const payload = {
    model,
    messages: convWithPrefill,
    temperature: 0.2,
    max_tokens: 600,
    stream: !!stream,
  };
  if (sys) payload.system = sys;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const onClientClose = () => ctrl.abort();
  req.on("close", onClientClose);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": llmKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      clearTimeout(timer);
      req.off("close", onClientClose);
      const err = await r.text();
      return res.status(r.status).json({ error: `Anthropic: ${err}` });
    }

    if (stream && r.body) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "{" }, index: 0 }] })}\n\n`);
      let buf = "";
      try {
        for await (const chunk of r.body) {
          buf += chunk.toString();
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta.text }, index: 0 }] })}\n\n`);
              } else if (ev.type === "message_stop") {
                res.write("data: [DONE]\n\n");
              }
            } catch {}
          }
        }
      } catch {}
      clearTimeout(timer);
      req.off("close", onClientClose);
      res.end();
      return;
    }

    clearTimeout(timer);
    req.off("close", onClientClose);
    const data = await r.json();
    const text = "{" + (data.content || []).map(b => b.text || "").join("");
    res.json({ choices: [{ message: { role: "assistant", content: text } }] });
  } catch (e) {
    clearTimeout(timer);
    req.off("close", onClientClose);
    const msg = e.name === "AbortError" ? "LLM timed out — try again" : e.message;
    if (res.headersSent) res.end();
    else res.status(500).json({ error: msg });
  }
}

// ── Upstash KV helpers ────────────────────────────────────────────────────────
async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const d = await r.json();
  return d.result ?? null;
}

async function kvSet(key, value) {
  await fetch(`${process.env.KV_REST_API_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
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
app.get("/auth/asana", (req, res) => {
  const { slack_user_id } = req.query;
  if (!slack_user_id) return res.status(400).send("Missing slack_user_id");
  const params = new URLSearchParams({
    client_id: process.env.ASANA_CLIENT_ID,
    redirect_uri: "https://minisana.vercel.app/auth/callback",
    response_type: "code",
    state: slack_user_id,
  });
  res.redirect(`https://app.asana.com/-/oauth_authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state: slackUserId } = req.query;
  if (!code || !slackUserId) return res.status(400).send("Missing code or state");
  try {
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

function slackFuzzy(list, name) {
  if (!name || !list) return null;
  const n = name.toLowerCase().trim();
  const safe = i => i.name ? i.name.toLowerCase() : "";
  const direct = list.find(i => safe(i) === n)
    || list.find(i => safe(i).startsWith(n))
    || list.find(i => safe(i) && safe(i).includes(n))
    || list.find(i => safe(i) && n.includes(safe(i)))
    || list.find(i => { const w = n.split(/\s+/).filter(x => x.length > 2); return w.length && w.every(x => safe(i).includes(x)); })
    || list.find(i => { const w = n.split(/\s+/).filter(x => x.length > 2); return w.length && w.some(x => safe(i).includes(x)); });
  if (direct) return direct;
  const toks = s => new Set((s || "").split(/[\s\-_/]+/).filter(w => w.length > 1));
  const a = toks(n); if (!a.size) return null;
  let best = null, bestScore = 0;
  for (const i of list) { const b = toks(safe(i)); if (!b.size) continue; let inter = 0; for (const w of a) if (b.has(w)) inter++; const score = inter / Math.max(a.size, b.size); if (score > bestScore) { bestScore = score; best = i; } }
  return bestScore >= 0.5 ? best : null;
}

function slackParseDate(s) {
  if (!s || typeof s !== "string") return s;
  const t = s.trim().toLowerCase(); if (!t) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const DOW = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  if (t === "today") return iso(today);
  if (t === "tomorrow" || t === "tmrw" || t === "tmr") return iso(addDays(today, 1));
  if (t === "yesterday") return iso(addDays(today, -1));
  if (t === "end of week" || t === "eow") { const off = (5 - today.getDay() + 7) % 7 || 7; return iso(addDays(today, off)); }
  if (t === "next week") return iso(addDays(today, 7));
  if (t === "next month") { const x = new Date(today); x.setMonth(x.getMonth() + 1); return iso(x); }
  const inDays = t.match(/^in\s+(\d+)\s+day(s)?$/); if (inDays) return iso(addDays(today, parseInt(inDays[1], 10)));
  const inWeeks = t.match(/^in\s+(\d+)\s+week(s)?$/); if (inWeeks) return iso(addDays(today, parseInt(inWeeks[1], 10) * 7));
  const nextDow = t.match(/^next\s+(\w+)$/); if (nextDow && DOW[nextDow[1]] != null) { const d = DOW[nextDow[1]]; const off = ((d - today.getDay() + 7) % 7) || 7; return iso(addDays(today, off)); }
  if (DOW[t] != null) { const d = DOW[t]; const off = ((d - today.getDay() + 7) % 7) || 7; return iso(addDays(today, off)); }
  return s;
}

// Escapes Slack mrkdwn control characters so Asana-derived text (task names,
// notes, project/section/tag/user names, comments, etc.) can't be interpreted
// as Slack link/mention syntax (e.g. "<!channel>", "<@U123>", "<http://x|y>").
function escapeSlackText(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

async function runSlackAgent(text, channelId, asanaToken, slackUserId) {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!asanaToken || !claudeKey) return "Missing Asana token or ANTHROPIC_API_KEY env var.";

  const state = getSlackChannelState(channelId, slackUserId);

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
    const llmRes = await fetch(LLM_URLS.anthropic, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: LLM_MODELS.anthropic, system: SLACK_RULES_BLOCK, messages: [{ role: "user", content: stateMsg + "\n\nUser message: " + text }], temperature: 0.2, max_tokens: 800 }),
    });
    const data = await llmRes.json();
    raw = data.content?.[0]?.text || "";
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
    if (mentioned.length) state.recentContext = mentioned.slice(0, 10).map(t => ({ type: "task", name: t.name, gid: t.gid }));
    return reply;
  }

  const actions = Array.isArray(parsed) ? parsed : (parsed.actions || []);
  if (!actions.length || actions.every(a => a.action === "unknown")) return "I didn't understand that. Could you rephrase?";

  const resolveUser = id => { if (!id) return null; if (id.includes("@") || /^\d{10,}$/.test(id)) return id; const u = state.workspaceUsers.find(u => u.name.toLowerCase() === id.toLowerCase() || u.name.toLowerCase().includes(id.toLowerCase())); return u ? u.gid : id; };
  const userDisplay = id => state.workspaceUsers.find(u => u.gid === id || u.email === id)?.name || id;
  const subFetch = new Map();
  const fetchSubs = async parentGid => { if (!subFetch.has(parentGid)) { const r = await asanaReq("GET", `/tasks/${parentGid}/subtasks?opt_fields=name,gid,completed&limit=100`, null, asanaToken); if (r.errors) throw new Error(r.errors[0].message); subFetch.set(parentGid, r.data || []); } return subFetch.get(parentGid); };

  for (const a of actions) { if (a.due) a.due = slackParseDate(a.due); }

  const results = [];

  for (const a of actions) {
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
      } else if (a.action === "delete_task") {
        await asanaReq("DELETE", `/tasks/${task.gid}`, null, asanaToken);
        results.push({ ok: true, msg: `Deleted *${task.name}*` });
        state.recentContext = [];
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
        const explainRes = await fetch(LLM_URLS.anthropic, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: LLM_MODELS.anthropic, system: "Explain this Asana task in 3-5 plain sentences. Cover: what must be done, who is responsible, any deadline. If comments add context, include them. Return plain text only.", messages: [{ role: "user", content: `Task: ${JSON.stringify(ctx)}` }], max_tokens: 400 }),
        });
        const explainData = await explainRes.json();
        results.push({ ok: true, readonly: true, msg: explainData.content?.[0]?.text || "(no explanation)" });
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
      } else if (a.action === "delete_subtask") {
        const subs = await fetchSubs(task.gid);
        const sub = slackFuzzy(subs, a.subtask);
        if (!sub) { results.push({ ok: false, msg: `Sub-task "${a.subtask}" not found` }); continue; }
        await asanaReq("DELETE", `/tasks/${sub.gid}`, null, asanaToken);
        results.push({ ok: true, msg: `Deleted sub-task *${sub.name}*` });
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

  state.chatHistory.push({ role: "user", content: text }, { role: "agent", content: results.map(r => r.msg).join("; ") });
  if (state.chatHistory.length > 20) state.chatHistory.splice(0, state.chatHistory.length - 20);

  if (!results.length) return "Done.";
  const allOk = results.every(r => r.ok);
  const prefix = !allOk ? "Finished with issues:" : results.every(r => r.readonly) ? "Here's what I found:" : "Done!";
  // results[].msg may embed Asana-derived data (task/section/tag/user names, notes,
  // comments) interpolated directly by the code above — escape the assembled text
  // as a whole so none of it can be read by Slack as link/mention mrkdwn syntax.
  return escapeSlackText(prefix + "\n" + results.map(r => `${r.ok ? "✓" : "✗"} ${r.msg}`).join("\n"));
}

// ── Slack Events API ─────────────────────────────────────────────────────────
app.post("/slack/events", verifySlackSignature, async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });
  if (!event || event.bot_id || event.type !== "message") return res.sendStatus(200);

  res.sendStatus(200);

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const postMessage = (text) => fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
    body: JSON.stringify({ channel: event.channel, text }),
  });

  waitUntil((async () => {
    try {
      const asanaToken = await getAsanaTokenForUser(event.user);
      if (!asanaToken) {
        const connectUrl = `https://minisana.vercel.app/auth/asana?slack_user_id=${event.user}`;
        await postMessage(`Hi! I need to connect to your Asana account before I can help.\n\n<${connectUrl}|Click here to connect Asana> — it takes about 10 seconds.`);
        return;
      }
      const reply = await runSlackAgent(event.text, event.channel, asanaToken, event.user);
      await postMessage(reply);
    } catch (e) {
      console.error("Slack handler error:", e.message);
      await postMessage("Something went wrong. Please try again.").catch(() => {});
    }
  })());
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
