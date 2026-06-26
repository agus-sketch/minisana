import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import os from "os";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
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
    spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

  if (provider === "anthropic") return handleAnthropic({ res, llmKey, url, model, msgs, stream });

  const headers = { "Content-Type": "application/json" };
  if (llmKey) headers.Authorization = `Bearer ${llmKey}`;

  const payload = { model, messages: msgs, temperature: 0.2, max_tokens: 600 };
  if (stream) payload.stream = true;
  else payload.response_format = { type: "json_object" };
  if (provider === "ollama") payload.keep_alive = "30m";

  const ctrl = new AbortController();
  const timeout = provider === "ollama" ? 120000 : 30000;
  const timer = setTimeout(() => ctrl.abort(), timeout);

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
      res.end();
      return;
    }

    clearTimeout(timer);
    res.json(await r.json());
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === "AbortError" ? "LLM timed out — try again" : e.message;
    if (res.headersSent) res.end();
    else res.status(500).json({ error: msg });
  }
});

// ── Anthropic adapter (translates to/from OpenAI shape so the UI is unchanged)
async function handleAnthropic({ res, llmKey, url, model, msgs, stream }) {
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
      res.end();
      return;
    }

    clearTimeout(timer);
    const data = await r.json();
    const text = "{" + (data.content || []).map(b => b.text || "").join("");
    res.json({ choices: [{ message: { role: "assistant", content: text } }] });
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === "AbortError" ? "LLM timed out — try again" : e.message;
    if (res.headersSent) res.end();
    else res.status(500).json({ error: msg });
  }
}

// ── Slack Events API ─────────────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });
  if (!event || event.bot_id || event.type !== "message") return res.sendStatus(200);

  res.sendStatus(200); // respond immediately before Slack's 3s timeout

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!slackToken || !claudeKey) return;

  try {
    const llmRes = await fetch(LLM_URLS.anthropic, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: LLM_MODELS.anthropic,
        system: "You are Minisana, an AI assistant for Asana task management. Help the user manage their tasks, answer questions about their projects, and provide actionable suggestions.",
        messages: [{ role: "user", content: event.text }],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });
    const data = await llmRes.json();
    const reply = data.content?.[0]?.text ?? "Sorry, I couldn't process that.";

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken}` },
      body: JSON.stringify({ channel: event.channel, text: reply }),
    });
  } catch (e) {
    console.error("Slack handler error:", e.message);
  }
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
