# claude-openai-proxy

OpenAI-compatible HTTP endpoint backed by your local Claude Code login.
Built on the Claude Agent SDK (not stdout-scraping `claude --print`).

**Local prototype only.** This fronts your personal Claude subscription, which is
licensed for your own use — not for serving other apps, users, or a hosted demo.
For anything beyond your own machine, get a real key at console.anthropic.com.

**New here?** Read the [usage guide](./USAGE-GUIDE.md) — is this for me, run it,
point your client at it, keep a conversation going, and what each error means. This
README is the reference.

## Run

```bash
npm install
PROXY_API_KEY=my-secret-key PORT=8080 npm start

# with retrievable conversation history:
PROXY_API_KEY=my-secret-key PORT=8080 PERSIST_SESSIONS=1 npm start
```

Requires `claude` to be installed and logged in (`claude` → /login). If it is not,
requests still return `200` — the reply text is *"Not logged in · Please run /login"*,
because the Agent SDK reports that as a successful turn.

The server binds to `127.0.0.1` only; it is not reachable from other machines.

## Use

```bash
curl -N -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","stream":true,
       "messages":[{"role":"user","content":"Reverse a string in Python"}]}' \
  http://127.0.0.1:8080/v1/chat/completions
```

From the OpenAI SDK:

```python
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="my-secret-key")
```

## Endpoints

- `POST /v1/chat/completions` — OpenAI shape; streaming (SSE) and non-streaming
- `POST /v1/messages` — **Anthropic Messages shape**, with emulated tool calling
- `GET /v1/models`
- `GET /v1/sessions` — session ids recorded this run (when history is on)

Requests are CORS-enabled, so a browser app can call this directly. The preflight
echoes back whatever `Access-Control-Request-Headers` asks for — a fixed allow-list
passes curl and then fails in a real browser, because the Anthropic SDK also sends
`x-stainless-lang`, `x-stainless-retry-count` and friends, and one unlisted header
fails the whole preflight.

Auth accepts either `Authorization: Bearer <key>` (OpenAI convention) or
`x-api-key: <key>` (Anthropic's).

## Continuous conversations

Both endpoints are **stateless by default**, like the real APIs: you replay the
whole `messages` array each turn and the proxy remembers nothing. That works, and
for a short chat it is fine.

Threading is the opt-in alternative. The proxy keeps one long-lived Claude session
per conversation, so each turn sends only the new message. You get prompt-cache
reuse, no re-flattening of the transcript, and a conversation you can open later
with `claude --resume`.

Requires `PERSIST_SESSIONS=1`.

### The rule

**Mint one id per chat. Send it on every turn. A new chat means a new id.**

```
new chat        →  conv-abc123        (you generate it — a UUID is fine)
turn 1          →  X-Conversation-Id: conv-abc123    starts a session
turn 2, 3, …    →  X-Conversation-Id: conv-abc123    resumes it
user hits "New" →  conv-def456        new id, new session
```

The **client** mints the id; the proxy never hands you one to adopt. The Messages
API response has nowhere to carry a session id, so a stock SDK would drop it.

### Anthropic SDK (`/v1/messages`)

```ts
const conversationId = `conv-${crypto.randomUUID()}`;   // once per chat

const client = new Anthropic({
  apiKey: "my-secret-key",
  baseURL: "http://127.0.0.1:8080",
  defaultHeaders: { "X-Conversation-Id": conversationId },
  dangerouslyAllowBrowser: true,     // browser only
});

await client.messages.create({ model: "sonnet", max_tokens: 1024, messages });
```

Keep appending to `messages` as you normally would. On a resumed turn the proxy
uses only the last entry and ignores the rest, so replaying costs you nothing and
keeps your client portable — point `baseURL` at Anthropic and it still works.

### OpenAI SDK (`/v1/chat/completions`)

```python
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="my-secret-key")

client.chat.completions.create(
    model="sonnet",
    messages=messages,
    extra_headers={"X-Conversation-Id": conversation_id},
)
```

This endpoint also threads *without* a header, by fingerprinting the history you
echo back. That needs no client change at all, but it is the fragile path: it
depends on you replaying assistant replies verbatim, and it breaks the moment you
edit or summarise history. Prefer the header.

### curl

```bash
curl -s -H "x-api-key: my-secret-key" -H "content-type: application/json" \
     -H "X-Conversation-Id: conv-abc123" \
     -d '{"model":"haiku","max_tokens":200,
          "messages":[{"role":"user","content":"Remember 42."}]}' \
     http://127.0.0.1:8080/v1/messages
```

### Checking that it worked

Three response headers tell you what happened, exposed via CORS so a browser can
read them too:

| Header | Meaning |
|---|---|
| `X-Conversation-Threaded` | `true` if this turn resumed a session. **`false` on the first turn of a conversation — that is correct**, there was nothing to resume yet. |
| `X-Conversation-Id` | echoed back |
| `X-Claude-Session-Id` | the Claude session, i.e. your `claude --resume` target. Only present when a session was actually persisted. |

If `X-Conversation-Threaded` stays `false` on turn 2, threading is not happening —
almost always because `PERSIST_SESSIONS=1` is not set. The request still succeeds,
so nothing will look broken; you just silently lose the benefit.

`GET /v1/sessions` lists the live conversation → session mappings.

### Things that will catch you out

- **Restarting the proxy drops the mapping.** It is in memory. The next turn on an
  old id starts a *fresh* session, so the assistant quietly forgets everything —
  the reply will be coherent, just amnesiac. Old transcripts stay on disk; only the
  id → session link is lost. Mint a new id after a restart, or keep replaying full
  history so a lost session costs you nothing.
- **Threading without `PERSIST_SESSIONS=1` is a silent no-op.** Check the header.
- **One conversation is one Claude session**, so do not share an id across users or
  tabs — they will read each other's history.
- **Tools that change mid-conversation are handled**, but worth knowing about: a
  resumed session already holds the tool list in its system prompt, and resetting a
  system prompt mid-session does nothing. The proxy hashes the tool set and
  re-states it inside the turn only when it changes — which is what a WebMCP page
  does every time the user navigates.

## Tool calling on `/v1/messages`

The Agent SDK runs tools itself, in this process — it has no way to hand a call back
to an HTTP caller and resume on a later request, which is exactly what the tool-use
flow needs. So tool calling here is **emulated at the prompt level**: the tool
schemas go into the system prompt, the model is asked to reply with a marked JSON
block, and that block is parsed back into a `tool_use` content block with
`stop_reason: "tool_use"`.

It works — verified driving a real WebMCP app through two chained tool calls — but
be clear-eyed: it depends on the model emitting well-formed JSON in a specific
shape. Good enough for a demo, not the real thing. A genuine API key skips all of
it. Streaming is not implemented on this endpoint.

## History (`PERSIST_SESSIONS=1`)

Off by default. When on, each conversation becomes one resumable Claude Code
session instead of a series of one-shot calls:

```bash
claude --resume            # pick from a list, run from the repo dir
claude --resume <session-id>
```

Transcripts live in `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.

See [Continuous conversations](#continuous-conversations) for how a client opts
into threading.

Model aliases: `gpt-4`/`gpt-4o` → opus-5, `gpt-4o-mini`/`gpt-3.5-turbo` → haiku-4.5,
plus bare `opus`/`sonnet`/`haiku`. Anything else passes through; no model at all uses
`DEFAULT_MODEL` (env, default `claude-opus-5`).

## Known limits

- **Stateless unless `PERSIST_SESSIONS=1`.** Without it, each request replays
  the full `messages` array as a flattened prompt and nothing is recorded.
- The session map is in memory, so a restart drops threading for in-flight
  conversations. Transcripts already on disk are unaffected.
- **Tools are off** (`tools: []`) so it behaves like a chat model. Turn them on
  and Claude Code gets filesystem and bash access to `cwd`.
- `max_tokens` is not enforced as an output cap — the SDK has no direct equivalent.
- No `n`, `temperature`, `logprobs`, function calling, or vision.
