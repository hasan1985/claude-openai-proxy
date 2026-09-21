// End-to-end: a real proxy process, your real Claude Code login, every endpoint.
//
//   npm run test:e2e                       spawns server.mjs on a spare port
//   E2E_BASE_URL=http://127.0.0.1:8080 E2E_API_KEY=111 npm run test:e2e
//                                          targets a proxy you already started
//
// Each request is a real model turn, so the run costs a handful of turns on your
// subscription and takes a minute or so. Needs `claude` to be logged in — a
// logged-out CLI answers "Not logged in" as a 200, and the first assertion on the
// reply text fails with that message in it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const MODEL = process.env.E2E_MODEL || "haiku";     // fastest alias the proxy knows
const TURN_TIMEOUT = 120_000;

let baseUrl = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
let apiKey = process.env.E2E_API_KEY || "e2e-key";
let child = null;

before(async () => {
  if (baseUrl) return;
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), PROXY_API_KEY: apiKey, PERSIST_SESSIONS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("proxy did not start within 10s")), 10_000);
    child.stdout.on("data", (d) => { if (String(d).includes("proxy on")) { clearTimeout(timer); resolve(); } });
    child.stderr.on("data", (d) => process.stderr.write(`[proxy] ${d}`));
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`proxy exited with ${code}`)); });
  });
});

after(() => { child?.kill(); });

// ── helpers ────────────────────────────────────────────────────────────────

const headers = (extra = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
  ...extra,
});

const post = (path, body, extra) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: headers(extra), body: JSON.stringify(body) });

/** Parses a whole SSE body into [{event, data}] — `data` JSON-decoded when it is JSON. */
async function readSse(res) {
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const raw = await res.text();
  return raw
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event = block.match(/^event: (.*)$/m)?.[1] ?? null;
      const data = block.match(/^data: (.*)$/m)?.[1] ?? "";
      let parsed = data;
      try { parsed = JSON.parse(data); } catch { /* [DONE] and the like */ }
      return { event, data: parsed };
    });
}

const SECRET_TOOL = {
  name: "get_secret_number",
  description: "Returns the secret number. Call it whenever the user asks for the secret number.",
  input_schema: { type: "object", properties: {} },
};

const PONG = { role: "user", content: "Reply with exactly the single word PONG and nothing else." };

// ── auth and listing ───────────────────────────────────────────────────────

test("GET /v1/models rejects a wrong key with 401 and lists models with the right one", async () => {
  const bad = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: "Bearer wrong" } });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${baseUrl}/v1/models`, { headers: headers() });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(Array.isArray(body.data) && body.data.length > 0, "models listed");
});

test("OPTIONS preflight succeeds without credentials (CORS for browser clients)", async () => {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:4300", "Access-Control-Request-Headers": "x-api-key, anthropic-version" },
  });
  assert.ok(res.status < 300, `preflight status ${res.status}`);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:4300");
});

// ── OpenAI shape ───────────────────────────────────────────────────────────

test("POST /v1/chat/completions answers without streaming", { timeout: TURN_TIMEOUT }, async () => {
  const res = await post("/v1/chat/completions", { model: MODEL, messages: [PONG] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.match(body.choices[0].message.content, /PONG/);
});

test("POST /v1/chat/completions streams chunks and ends with [DONE]", { timeout: TURN_TIMEOUT }, async () => {
  const res = await post("/v1/chat/completions", { model: MODEL, stream: true, messages: [PONG] });
  assert.equal(res.status, 200);
  const events = await readSse(res);
  assert.equal(events.at(-1).data, "[DONE]");
  const text = events
    .map((e) => e.data?.choices?.[0]?.delta?.content ?? "")
    .join("");
  assert.match(text, /PONG/);
  assert.equal(events.at(-2).data.choices[0].finish_reason, "stop");
});

// ── Anthropic shape: prose ─────────────────────────────────────────────────

test("POST /v1/messages answers prose without streaming", { timeout: TURN_TIMEOUT }, async () => {
  const res = await post("/v1/messages", { model: MODEL, max_tokens: 100, messages: [PONG] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, "message");
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.content[0].type, "text");
  assert.match(body.content[0].text, /PONG/);
});

test("POST /v1/messages streams prose as Messages API events", { timeout: TURN_TIMEOUT }, async () => {
  const res = await post("/v1/messages", { model: MODEL, max_tokens: 100, stream: true, messages: [PONG] });
  assert.equal(res.status, 200);
  const events = await readSse(res);
  const types = events.map((e) => e.event);

  assert.equal(types[0], "message_start");
  assert.equal(types.at(-1), "message_stop");
  assert.equal(events.find((e) => e.event === "content_block_start").data.content_block.type, "text");
  const deltas = events.filter((e) => e.event === "content_block_delta");
  assert.ok(deltas.length >= 1, "at least one text delta");
  assert.ok(deltas.every((e) => e.data.delta.type === "text_delta"));
  assert.match(deltas.map((e) => e.data.delta.text).join(""), /PONG/);
  assert.equal(events.find((e) => e.event === "message_delta").data.delta.stop_reason, "end_turn");
});

// ── Anthropic shape: emulated tool use ─────────────────────────────────────

test("POST /v1/messages turns the model's marked block into tool_use, then finishes after the result", { timeout: 2 * TURN_TIMEOUT }, async () => {
  const ask = { role: "user", content: "What is the secret number? Use the tool." };
  const first = await post("/v1/messages", { model: MODEL, max_tokens: 200, tools: [SECRET_TOOL], messages: [ask] });
  assert.equal(first.status, 200);
  const call = await first.json();
  assert.equal(call.stop_reason, "tool_use", JSON.stringify(call.content));
  const use = call.content.find((b) => b.type === "tool_use");
  assert.equal(use.name, "get_secret_number");
  assert.match(use.id, /^toolu_/);

  const second = await post("/v1/messages", {
    model: MODEL, max_tokens: 200, tools: [SECRET_TOOL],
    messages: [
      ask,
      { role: "assistant", content: call.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "The secret number is 4711." }] },
    ],
  });
  const answer = await second.json();
  assert.equal(answer.stop_reason, "end_turn");
  assert.match(answer.content[0].text, /4711/);
});

test("POST /v1/messages streams a tool call as a tool_use block with one input_json_delta", { timeout: TURN_TIMEOUT }, async () => {
  const res = await post("/v1/messages", {
    model: MODEL, max_tokens: 200, stream: true, tools: [SECRET_TOOL],
    messages: [{ role: "user", content: "What is the secret number? Use the tool." }],
  });
  assert.equal(res.status, 200);
  const events = await readSse(res);

  const starts = events.filter((e) => e.event === "content_block_start");
  const toolStart = starts.find((e) => e.data.content_block.type === "tool_use");
  assert.ok(toolStart, `no tool_use block in ${JSON.stringify(events.map((e) => e.event))}`);
  assert.equal(toolStart.data.content_block.name, "get_secret_number");

  const inputDelta = events.find((e) => e.event === "content_block_delta" && e.data.index === toolStart.data.index);
  assert.equal(inputDelta.data.delta.type, "input_json_delta");
  assert.deepEqual(JSON.parse(inputDelta.data.delta.partial_json), {});

  // The marker text itself must never leak out as prose.
  const prose = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text).join("");
  assert.doesNotMatch(prose, /<tool_call>/);
  assert.equal(events.find((e) => e.event === "message_delta").data.delta.stop_reason, "tool_use");
});

// ── threading ──────────────────────────────────────────────────────────────

test("X-Conversation-Id threads turns into one Claude session (PERSIST_SESSIONS=1)", { timeout: 2 * TURN_TIMEOUT }, async () => {
  const convId = `e2e-${crypto.randomUUID()}`;
  const first = await post("/v1/messages", {
    model: MODEL, max_tokens: 100,
    messages: [{ role: "user", content: "The codeword is MARMALADE. Just say OK." }],
  }, { "X-Conversation-Id": convId });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-conversation-threaded"), "false");
  const sessionId = first.headers.get("x-claude-session-id");
  if (!sessionId) {
    // Persistence is off on the proxy under test (an external one started without it).
    assert.equal((await first.json()).type, "message");
    return;
  }

  // Only the new turn is sent — no history. Only a threaded session can answer.
  const second = await post("/v1/messages", {
    model: MODEL, max_tokens: 100,
    messages: [{ role: "user", content: "What was the codeword? Reply with the word only." }],
  }, { "X-Conversation-Id": convId });
  assert.equal(second.headers.get("x-conversation-threaded"), "true");
  assert.match((await second.json()).content[0].text, /MARMALADE/i);

  const sessions = await (await fetch(`${baseUrl}/v1/sessions`, { headers: headers() })).json();
  assert.ok(sessions.conversations.some((c) => c.conversationId === convId && c.sessionId === sessionId));
});
