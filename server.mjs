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

// Explicit threading for /v1/messages: client-supplied conversation id ->
// { sessionId, toolsHash }. The client mints the id; the proxy stays stateless
// unless it is given one.
const conversations = new Map();

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

// CORS. Must come BEFORE auth: a preflight OPTIONS carries no credentials, so
// authenticating it would reject every browser request before it starts — and the
// browser hides the reason, surfacing only "Connection error".
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": req.get("origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Echo whatever the preflight asked for rather than keeping a fixed list.
    // A fixed list looks fine against curl (you only request the headers you
    // thought of) and then fails in a real browser: the Anthropic SDK also sends
    // x-stainless-lang, x-stainless-runtime, x-stainless-retry-count, x-stainless-
    // timeout and friends, and one unlisted header fails the whole preflight.
    "Access-Control-Allow-Headers":
      req.get("access-control-request-headers") ||
      "authorization, content-type, x-api-key, x-conversation-id, " +
      "anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access",
    // Custom response headers are invisible to a browser unless listed here.
    "Access-Control-Expose-Headers":
      "x-conversation-id, x-claude-session-id, x-conversation-threaded",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use((req, res, next) => {
  // Bearer is the OpenAI convention; x-api-key is Anthropic's. Accept both, since
  // this proxy now answers on both shapes.
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const token = bearer || req.get("x-api-key") || "";
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
    conversations: [...conversations.entries()].map(([id, v]) => ({
      conversationId: id,
      sessionId: v.sessionId,
    })),
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

// ────────────────────────────────────────────────────────────────────────
//  Anthropic Messages API  (POST /v1/messages)
//
//  The OpenAI endpoint above cannot drive a tool-using client: the Agent SDK
//  runs tools itself, in this process, and has no way to hand a call back to an
//  HTTP caller and resume later. That is exactly what the tool-use flow needs.
//
//  So tool calling here is EMULATED at the prompt level: the tool schemas go
//  into the system prompt, the model is asked to answer with a marked JSON
//  block when it wants a tool, and that block is parsed back into a `tool_use`
//  content block. Ordinary shims do the same thing.
//
//  Be clear-eyed about the tradeoff: this depends on the model emitting
//  well-formed JSON in a specific shape. It is good enough for a demo and it is
//  not the real thing. A genuine API key skips all of it.
// ────────────────────────────────────────────────────────────────────────

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";

function toolInstructions(tools = []) {
  if (!tools.length) return "";
  const listed = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema ?? {})}`)
    .join("\n");
  return [
    "",
    "You can call tools. The available tools are:",
    listed,
    "",
    `To call one, reply with ONLY this and nothing else:`,
    `${TOOL_OPEN}{"name": "<tool name>", "input": { ...arguments... }}${TOOL_CLOSE}`,
    "",
    "Rules:",
    "- One tool call per reply. No prose before or after the block.",
    "- The input must be valid JSON matching that tool's input schema.",
    "- After a tool result comes back, either call another tool or answer normally.",
    "- If no tool is needed, just answer normally with no block.",
  ].join("\n");
}

/** Renders one Anthropic message — text, tool_use and tool_result blocks — as text. */
function renderMessage(m) {
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "tool_use") {
      parts.push(`${TOOL_OPEN}${JSON.stringify({ name: b.name, input: b.input })}${TOOL_CLOSE}`);
    } else if (b.type === "tool_result") {
      const body = typeof b.content === "string"
        ? b.content
        : (b.content || []).map((c) => c.text ?? "").join("\n");
      parts.push(`Tool result${b.is_error ? " (error)" : ""}: ${body}`);
    }
  }
  return parts.join("\n");
}

/** Flattens a whole conversation into one prompt, for unthreaded requests. */
function buildAnthropicPrompt(messages = []) {
  const turns = [];
  for (const m of messages) {
    const text = renderMessage(m);
    if (!text) continue;
    turns.push(`${m.role === "assistant" ? "Assistant" : "Human"}: ${text}`);
  }
  return turns.length > 1 ? `${turns.join("\n\n")}\n\nAssistant:` : turns[0] || "";
}

/** Identifies the tool set, so a mid-conversation change can be detected. */
const hashTools = (tools = []) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(tools.map((t) => [t.name, t.description, t.input_schema])))
    .digest("hex")
    .slice(0, 16);

/** Pulls a tool call out of the reply, if the model emitted one. */
function parseToolCall(text) {
  const start = text.indexOf(TOOL_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(TOOL_CLOSE, start);
  const body = text.slice(start + TOOL_OPEN.length, end === -1 ? undefined : end).trim();
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed.name !== "string") return null;
    return { name: parsed.name, input: parsed.input ?? {} };
  } catch {
    return null;   // malformed — fall through and treat the reply as prose
  }
}

app.post("/v1/messages", async (req, res) => {
  const { messages, model, system, tools = [], stream = false } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "`messages` is required" },
    });
  }
  if (stream) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "streaming is not implemented on /v1/messages" },
    });
  }

  const resolvedModel = MODEL_ALIASES[model] || model || DEFAULT_MODEL;
  const systemText = Array.isArray(system)
    ? system.map((s) => s.text ?? "").join("\n\n")
    : system || "";

  // Optional threading. The API stays stateless by default, exactly like the real
  // one: the client replays its history and nothing is remembered. Send an
  // X-Conversation-Id and this relays the turn into that Claude session instead,
  // so only the new message travels and the prompt cache is reused.
  //
  // The client mints the id, rather than the proxy returning one, because the
  // Messages API response has nowhere to put a session id — a stock SDK would
  // drop it. The id comes back as a response header for visibility.
  const convId = req.get("x-conversation-id") || null;
  const prior = convId ? conversations.get(convId) : null;
  const resumeId = PERSIST ? prior?.sessionId ?? null : null;
  const toolsHash = hashTools(tools);

  // Tools come and go as the user navigates a WebMCP page, so a resumed session
  // can hold a stale list. Re-state them in the turn itself when they change —
  // resetting the system prompt mid-session would not take effect.
  const toolsChanged = Boolean(resumeId && prior && prior.toolsHash !== toolsHash);

  const prompt = resumeId
    ? [
        toolsChanged ? `(The available tools have changed.)${toolInstructions(tools)}` : "",
        renderMessage(messages[messages.length - 1]),
      ].filter(Boolean).join("\n\n")
    : buildAnthropicPrompt(messages);

  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const run = query({
    prompt,
    options: {
      model: resolvedModel,
      // On resume the session already carries the system prompt; re-sending it
      // has no effect, so only set it when starting a session.
      systemPrompt: resumeId
        ? undefined
        : `${systemText}${toolInstructions(tools)}`.trim() || undefined,
      tools: [],
      maxTurns: 1,
      persistSession: PERSIST && Boolean(convId),
      ...(resumeId ? { resume: resumeId } : {}),
      abortController: abort,
    },
  });

  try {
    let text = "";
    let usage = null;
    let sessionId = null;
    for await (const msg of run) {
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(msg.result || "Claude Code returned an error");
        text = msg.result;
        usage = msg.usage;
        sessionId = msg.session_id ?? null;
      }
    }

    if (convId && PERSIST && sessionId) {
      conversations.set(convId, { sessionId, toolsHash });
    }

    res.set({
      "X-Conversation-Threaded": String(Boolean(resumeId)),
      ...(convId ? { "X-Conversation-Id": convId } : {}),
      // Only when the session was actually persisted — an unthreaded request gets
      // a session id from the SDK too, but nothing was written, so reporting it
      // would imply a `claude --resume` target that does not exist.
      ...(sessionId && PERSIST && convId ? { "X-Claude-Session-Id": sessionId } : {}),
    });

    const call = tools.length ? parseToolCall(text) : null;
    const content = call
      ? [{ type: "tool_use", id: `toolu_${crypto.randomBytes(12).toString("hex")}`, name: call.name, input: call.input }]
      : [{ type: "text", text }];

    res.json({
      id: `msg_${crypto.randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: resolvedModel,
      content,
      stop_reason: call ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
      },
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    res.status(500).json({
      type: "error",
      error: { type: "api_error", message: err?.message || String(err) },
    });
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
