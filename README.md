# claude-openai-proxy

OpenAI-compatible HTTP endpoint backed by your local Claude Code login.
Built on the Claude Agent SDK (not stdout-scraping `claude --print`).

**Local prototype only.** This fronts your personal Claude subscription, which is
licensed for your own use — not for serving other apps, users, or a hosted demo.
For anything beyond your own machine, get a real key at console.anthropic.com.

## Run

```bash
npm install
PROXY_API_KEY=my-secret-key PORT=8080 npm start

# with retrievable conversation history:
PROXY_API_KEY=my-secret-key PORT=8080 PERSIST_SESSIONS=1 npm start
```

Requires `claude` to be installed and logged in (`claude` → /login).

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

Conversations are threaded by fingerprinting the history the client echoes
back, so a normal OpenAI client needs no changes. For an explicit key, send
an `X-Conversation-Id` header — more robust, since the fingerprint depends on
the client replaying assistant replies verbatim.

Threading also means follow-up turns send only the new message rather than
replaying the transcript, so the prompt cache is reused.

Model aliases: `gpt-4`/`gpt-4o` → opus-5, `gpt-4o-mini`/`gpt-3.5-turbo` → haiku-4.5,
plus bare `opus`/`sonnet`/`haiku`. Anything else passes through.

## Known limits

- **Stateless unless `PERSIST_SESSIONS=1`.** Without it, each request replays
  the full `messages` array as a flattened prompt and nothing is recorded.
- The session map is in memory, so a restart drops threading for in-flight
  conversations. Transcripts already on disk are unaffected.
- **Tools are off** (`tools: []`) so it behaves like a chat model. Turn them on
  and Claude Code gets filesystem and bash access to `cwd`.
- `max_tokens` is not enforced as an output cap — the SDK has no direct equivalent.
- No `n`, `temperature`, `logprobs`, function calling, or vision.
