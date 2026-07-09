import fetch from "node-fetch";

// Unpaired UTF-16 surrogates (e.g. from a truncated emoji in Asana task text)
// must be stripped from string values BEFORE JSON.stringify — stringify
// re-encodes a lone surrogate as the literal escape text \uXXXX, which reads
// as syntactically valid JSON but isn't valid Unicode, and Anthropic's parser
// rejects it with "no low surrogate in string".
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function sanitizeDeep(value) {
  if (typeof value === "string") return value.replace(LONE_SURROGATE_RE, "�");
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeDeep(value[k]);
    return out;
  }
  return value;
}
function safeJsonStringify(value) {
  return JSON.stringify(sanitizeDeep(value));
}

// ── Provider endpoints & defaults ────────────────────────────────────────────
export const LLM_URLS = {
  groq:      "https://api.groq.com/openai/v1/chat/completions",
  openai:    "https://api.openai.com/v1/chat/completions",
  ollama:    "http://localhost:11434/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};
export const LLM_MODELS = {
  groq:      "llama-3.3-70b-versatile",
  openai:    "gpt-4o-mini",
  ollama:    "qwen2.5:14b",
  anthropic: "claude-haiku-4-5-20251001",
};
// Existing per-provider timeout behavior, preserved from the original inline logic
// (Ollama gets extra headroom since local models can be slow to load/generate).
const LLM_TIMEOUTS = {
  groq:      30000,
  openai:    30000,
  ollama:    120000,
  anthropic: 30000,
};

// Combines an optional caller-provided AbortSignal (e.g. tied to req.on("close"))
// with an internal per-provider timeout, so either one aborts the request.
function combinedSignal(externalSignal, timeoutMs) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutCtrl.signal])
    : timeoutCtrl.signal;
  return { signal, cleanup: () => clearTimeout(timer) };
}

// ── Groq / OpenAI / Ollama (OpenAI-compatible chat completions) ─────────────
async function callOpenAICompatible({ provider, url, model, messages, apiKey, temperature, maxTokens, jsonMode, stream, signal, onPartial, onStreamStart }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const payload = { model, messages, max_tokens: maxTokens };
  if (temperature !== undefined) payload.temperature = temperature;
  if (jsonMode) payload.response_format = { type: "json_object" };
  if (stream) payload.stream = true;
  if (provider === "ollama") payload.keep_alive = "30m";

  const r = await fetch(url, { method: "POST", headers, body: safeJsonStringify(payload), signal });

  if (stream && r.ok && r.body) {
    onStreamStart?.();
    try {
      // Groq/OpenAI/Ollama already emit the exact OpenAI SSE wire format the
      // browser expects, so we forward raw upstream bytes untouched.
      for await (const chunk of r.body) onPartial(chunk);
    } catch {
      // upstream stream error — best-effort close, matching prior behavior
    }
    return { streamed: true };
  }

  // Mirrors the original behavior of always resolving with the raw upstream
  // JSON body (success or provider error shape) at HTTP 200, regardless of
  // the actual upstream status code.
  return { streamed: false, status: 200, body: await r.json() };
}

// ── Anthropic (translated to/from the OpenAI shape so callers stay unchanged)
async function callAnthropic({ url, model, messages, apiKey, temperature, maxTokens, jsonMode, stream, signal, onPartial, onStreamStart }) {
  const sys = messages
    .filter(m => m.role === "system")
    .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n\n");
  const conv = messages.filter(m => m.role !== "system");
  // JSON-mode trick for Anthropic: prefill the assistant turn with "{" to force
  // JSON output (Anthropic has no response_format equivalent).
  const convForRequest = jsonMode ? [...conv, { role: "assistant", content: "{" }] : conv;

  const payload = { model, messages: convForRequest, max_tokens: maxTokens, stream: !!stream };
  if (temperature !== undefined) payload.temperature = temperature;
  if (sys) payload.system = sys;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: safeJsonStringify(payload),
    signal,
  });

  if (!r.ok) {
    const err = await r.text();
    return { streamed: false, status: r.status, body: { error: `Anthropic: ${err}` } };
  }

  if (stream && r.body) {
    onStreamStart?.();
    if (jsonMode) {
      onPartial(`data: ${JSON.stringify({ choices: [{ delta: { content: "{" }, index: 0 }] })}\n\n`);
    }
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
              onPartial(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta.text }, index: 0 }] })}\n\n`);
            } else if (ev.type === "message_stop") {
              onPartial("data: [DONE]\n\n");
            }
          } catch {}
        }
      }
    } catch {
      // upstream stream error — best-effort close, matching prior behavior
    }
    return { streamed: true };
  }

  const data = await r.json();
  const text = (jsonMode ? "{" : "") + (data.content || []).map(b => b.text || "").join("");
  return { streamed: false, status: 200, body: { choices: [{ message: { role: "assistant", content: text } }] } };
}

/**
 * Unified LLM dispatch for Groq, OpenAI, Ollama (OpenAI-compatible endpoint),
 * and Anthropic. Handles both streaming (onPartial called with each wire chunk,
 * exactly as it should be forwarded to an SSE client) and non-streaming
 * (returns { streamed: false, status, body }) modes, JSON-mode forcing, and
 * timeout/abort handling shared across every call site.
 *
 * On streaming success, returns { streamed: true } once the upstream stream
 * has been fully forwarded via onPartial — the caller is responsible for
 * ending its own response. On non-streaming (or a streaming request that fell
 * back because the upstream response wasn't ok/had no body), returns
 * { streamed: false, status, body } for the caller to relay as-is.
 *
 * Throws on network failure or abort (e.msg preserved, e.name === "AbortError"
 * on timeout/client-disconnect) so callers can catch exactly as before.
 */
export async function callLLM({
  provider = "groq",
  model,
  messages,
  apiKey,
  temperature,
  maxTokens = 600,
  jsonMode = false,
  stream = false,
  signal,
  onPartial,
  onStreamStart,
}) {
  const url = LLM_URLS[provider] || LLM_URLS.groq;
  const resolvedModel = model || LLM_MODELS[provider] || LLM_MODELS.groq;
  const timeoutMs = LLM_TIMEOUTS[provider] ?? LLM_TIMEOUTS.groq;

  const { signal: combined, cleanup } = combinedSignal(signal, timeoutMs);
  try {
    const args = {
      provider,
      url,
      model: resolvedModel,
      messages,
      apiKey,
      temperature,
      maxTokens,
      jsonMode,
      stream,
      signal: combined,
      onPartial,
      onStreamStart,
    };
    if (provider === "anthropic") return await callAnthropic(args);
    return await callOpenAICompatible(args);
  } finally {
    cleanup();
  }
}
