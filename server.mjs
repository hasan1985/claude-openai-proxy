import crypto from "node:crypto";
import express from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = process.env.PORT || 8080;
const PROXY_API_KEY = process.env.PROXY_API_KEY || "local-dev-key";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5";

// When on, conversations are written to ~/.claude/projects/<cwd> and threaded
// across requests, so they're browsable with `claude --resume`.
const PERSIST = process.env.PERSIST_SESSIONS === "1";

// Maps a conversation fingerprint -> Claude session id. In memory only: losing
// it costs threading, not history (the transcripts are already on disk).
const sessions = new Map();

const fingerprint = (msgs) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(msgs.map((m) => [m.role, textOf(m)])))
    .digest("hex")
    .slice(0, 16);

// OpenAI-ish model names your client might send, mapped to real Claude models.
const MODEL_ALIASES = {
  "gpt-4": "claude-opus-5",
  "gpt-4o": "claude-opus-5",
  "gpt-4o-mini": "claude-haiku-4-5",
  "gpt-3.5-turbo": "claude-haiku-4-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token !== PROXY_API_KEY) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "invalid_request_error" } });
  }
  next();
});

app.get("/v1/models", (_req, res) => {
  const ids = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  res.json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "anthropic" })),
  });
});

function textOf(m) {
  return typeof m.content === "string"
    ? m.content
    : (m.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

app.get("/v1/sessions", (_req, res) => {
  const ids = [...new Set(sessions.values())];
  res.json({
    persist: PERSIST,
    cwd: process.cwd(),
    sessions: ids,
    hint: PERSIST
      ? `claude --resume <id>   (run from ${process.cwd()})`
      : "set PERSIST_SESSIONS=1 to record conversations",
  });
});

// Flatten an OpenAI messages array into (systemPrompt, prompt).
// Stateless: each request replays the whole conversation, like the OpenAI API.
function buildPrompt(messages = []) {
  const systemParts = [];
  const turns = [];

  for (const m of messages) {
    const text = textOf(m);

    if (m.role === "system") systemParts.push(text);
    else if (m.role === "assistant") turns.push(`Assistant: ${text}`);
    else turns.push(`Human: ${text}`);
  }

  return {
    systemPrompt: systemParts.length ? systemParts.join("\n\n") : undefined,
    prompt: turns.length > 1 ? `${turns.join("\n\n")}\n\nAssistant:` : turns[0] || "",
  };
}

app.post("/v1/chat/completions", async (req, res) => {
  const { messages, model, stream = false, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "`messages` is required", type: "invalid_request_error" } });
  }

  const resolvedModel = MODEL_ALIASES[model] || model || DEFAULT_MODEL;
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  // Thread the conversation when persistence is on. An explicit
  // X-Conversation-Id header wins; otherwise match on the history prefix the
  // client echoed back (everything before the new user message).
  const convId = req.get("x-conversation-id") || null;
  const priorKey =
    messages.length > 1 ? fingerprint(messages.slice(0, -1)) : null;
  const resumeId = PERSIST
    ? sessions.get(convId || priorKey) || null
    : null;

  // Resuming: the session already holds the history, so send only the new turn.
  // Otherwise replay the whole conversation as a flattened prompt.
  const { systemPrompt, prompt } = resumeId
    ? { systemPrompt: undefined, prompt: textOf(messages[messages.length - 1]) }
    : buildPrompt(messages);

  // Record the mapping once we know the reply, so the next request matches.
  const remember = (sessionId, replyText) => {
    if (!PERSIST || !sessionId) return;
    const next = [...messages, { role: "assistant", content: replyText }];
    sessions.set(fingerprint(next), sessionId);
    if (convId) sessions.set(convId, sessionId);
    console.log(`[session] ${sessionId}${convId ? ` (${convId})` : ""}`);
  };

  const abort = new AbortController();
  // Kill the underlying Claude Code process the moment the client hangs up.
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const run = query({
    prompt,
    options: {
      model: resolvedModel,
      systemPrompt,
      tools: [],              // pure chat: no file/bash access
      maxTurns: 1,
      persistSession: PERSIST,
      ...(resumeId ? { resume: resumeId } : {}),
      abortController: abort,
      includePartialMessages: stream,
      ...(max_tokens ? { maxThinkingTokens: Math.min(max_tokens, 16000) } : {}),
    },
  });

  try {
    if (!stream) {
      let text = "";
      let usage = null;
      for await (const msg of run) {
        if (msg.type === "result") {
          if (msg.subtype !== "success") throw new Error(msg.result || "Claude Code returned an error");
          text = msg.result;
          usage = msg.usage;
          remember(msg.session_id, text);
        }
      }
      return res.json({
        id,
        object: "chat.completion",
        created,
        model: resolvedModel,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        },
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunk = (delta, finish_reason = null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta, finish_reason }],
    });

    send(chunk({ role: "assistant", content: "" }));

    let full = "";
    for await (const msg of run) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        // text_delta only — thinking_delta is internal reasoning, not the answer.
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          full += ev.delta.text;
          send(chunk({ content: ev.delta.text }));
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") {
          send(chunk({}, "stop"));
          res.write(`data: [DONE]\n\n`);
          return res.end();
        }
        remember(msg.session_id, full);
      }
    }

    send(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return; // client disconnected; nothing to report
    const message = err?.message || String(err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: { message, type: "api_error" } });
    }
  }
});

// Bind to loopback only — this endpoint fronts your personal Claude login.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenAI-compatible Claude proxy on http://127.0.0.1:${PORT}/v1`);
  console.log(`API key: ${PROXY_API_KEY}`);
  console.log(
    PERSIST
      ? `History: ON — browse with \`claude --resume\` from ${process.cwd()}`
      : "History: off (PERSIST_SESSIONS=1 to enable)",
  );
});
