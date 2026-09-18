# Usage guide

You have Claude Code installed and logged in, and you want to call Claude from your
own code — a script, a local web app, an editor plugin — over plain HTTP, without an
API key. This proxy does that: it turns your local `claude` login into an
OpenAI-compatible and an Anthropic-compatible endpoint on `127.0.0.1`.

**For your own use only.** It fronts your personal Claude subscription, which is
licensed to you, not to apps you serve to other people. The server binds to
`127.0.0.1` on purpose and will not accept connections from other machines. For
anything shared or hosted, use a real key from console.anthropic.com — every client
below works unchanged when you point it there instead.

---

## 1. Is this for me?

| You want to… | This proxy |
|---|---|
| Try a tool or library that needs an "OpenAI base URL" against Claude | **yes** |
| Prototype a chat UI in a browser without putting a key in the page | **yes** — CORS is on, the key is one you make up |
| Use the Anthropic SDK's tool-calling loop against a local model | **yes, with limits** — see §6 |
| Run something for teammates, a demo URL, or a product | **no** — get an API key |
| Get streaming on the Anthropic-shaped endpoint | **no** — only the OpenAI endpoint streams |

## 2. Before you start

```bash
node --version    # 18 or newer
claude --version  # Claude Code installed…
claude            # …and logged in: if you see a login prompt, run /login first
```

Not logged in is the one failure that does **not** look like a failure — see §7.

## 3. Run it

```bash
git clone git@github.com:hasan1985/claude-openai-proxy.git
cd claude-openai-proxy
npm install
PROXY_API_KEY=my-secret-key PORT=8080 npm start
```

You should see the port and the history mode printed. Leave it running in that
terminal.

| Variable | Default | What it does |
|---|---|---|
| `PROXY_API_KEY` | `local-dev-key` | the key your clients must send. Make one up; it only has to match |
| `PORT` | `8080` | listens on `127.0.0.1:<PORT>` only |
| `DEFAULT_MODEL` | `claude-opus-5` | used when a request names no model |
| `PERSIST_SESSIONS` | off | `1` records each conversation as a Claude Code session you can reopen with `claude --resume`, and enables threading (§5) |

Check it answers:

```bash
curl -s -H "x-api-key: my-secret-key" http://127.0.0.1:8080/v1/models
```

## 4. Point your client at it

Two endpoints, two shapes. Use whichever your client already speaks.

### OpenAI-shaped — `/v1/chat/completions`

Any OpenAI SDK, or any tool with a "base URL" setting:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="my-secret-key")

r = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Reverse a string in Python"}],
    stream=True,
)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "my-secret-key" });
```

Streaming (SSE) and non-streaming both work.

### Anthropic-shaped — `/v1/messages`

The Anthropic SDK, or anything that speaks the Messages API:

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({
  apiKey: "my-secret-key",
  baseURL: "http://127.0.0.1:8080",        // no /v1 — the SDK adds it
  dangerouslyAllowBrowser: true,           // only if calling from a browser
});

const msg = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Reverse a string in Python" }],
});
```

Not streaming; a `stream: true` request is rejected with 400.

### curl

```bash
curl -s -H "x-api-key: my-secret-key" -H "content-type: application/json" \
  -d '{"model":"haiku","max_tokens":200,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8080/v1/messages
```

### Auth and model names

Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>` — both work on
both endpoints.

| You send | You get |
|---|---|
| `opus` / `sonnet` / `haiku` | `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5` |
| `gpt-4`, `gpt-4o` | `claude-opus-5` |
| `gpt-4o-mini`, `gpt-3.5-turbo` | `claude-haiku-4-5` |
| any full Claude model id | passed through as-is |
| nothing | `DEFAULT_MODEL` |

### From a browser

CORS is enabled and the preflight echoes back whatever headers the browser asks for,
so the Anthropic and OpenAI SDKs work directly from a page. The key is one you made
up, so putting it in the page costs nothing. Keep the browser and the proxy on the
same machine — the proxy is not reachable from anywhere else.

## 5. Keeping a conversation going

Both endpoints are **stateless by default**, like the real APIs: send the whole
`messages` history every turn. That is fine, and it keeps your client portable.

If you would rather the proxy remember, turn on history and send a conversation id:

```bash
PROXY_API_KEY=my-secret-key PORT=8080 PERSIST_SESSIONS=1 npm start
```

```ts
const conversationId = `conv-${crypto.randomUUID()}`;   // once per chat; new chat = new id
const client = new Anthropic({
  apiKey: "my-secret-key",
  baseURL: "http://127.0.0.1:8080",
  defaultHeaders: { "X-Conversation-Id": conversationId },
});
```

Keep appending to `messages` as usual — on a resumed turn the proxy reads only the
last entry, so replaying costs nothing and the same code works against the real API.
The OpenAI endpoint takes the same header via `extra_headers`.

What you gain: each turn sends only the new message, prompt-cache reuse, and a
transcript you can open later:

```bash
claude --resume            # from the proxy's directory; pick from the list
```

Check it is working by reading the `X-Conversation-Threaded` response header: `false`
on turn 1 is correct (nothing to resume yet); `true` from turn 2. If it stays `false`,
`PERSIST_SESSIONS=1` is not set — the request still succeeds, you just lose the
benefit silently.

Two rules: one id per chat, never shared across users or tabs; and **restarting the
proxy forgets the id → session map** (transcripts stay on disk), so the next turn
on an old id starts fresh and the assistant will be coherent but amnesiac. Mint a new
id after a restart, or keep replaying full history so it never matters.

Full detail: [README · Continuous conversations](./README.md#continuous-conversations).

## 6. Tool calling — what to expect

`/v1/messages` supports the Anthropic `tools` parameter and returns `tool_use`
blocks with `stop_reason: "tool_use"`, so a standard tool-use loop works. But it is
**emulated**: the tool schemas go into the system prompt, the model is asked to
answer with a marked JSON block, and that block is parsed back into a `tool_use`.
Verified driving a real app through chained tool calls — but it depends on the model
producing well-formed JSON in the expected shape, and it will occasionally not. Fine
for a prototype; a real key gives you the real thing.

Not supported anywhere: `n`, `temperature`, `logprobs`, vision, OpenAI-style
`functions`, and `max_tokens` as a hard output cap. The model runs with **no tools of
its own** (no filesystem, no bash) — it behaves as a chat model even though Claude
Code is underneath.

## 7. When it does not work

| You see | It means | Do |
|---|---|---|
| `401 Invalid API key` | the key you sent is not `PROXY_API_KEY` — including when you never set it and the default `local-dev-key` applies | send the key you started the proxy with, in either header |
| `Connection error` from an SDK, nothing else | the proxy is not running, or the port differs, or you are on another machine | `curl http://127.0.0.1:<port>/v1/models` from the same machine |
| a normal `200` whose reply is **"Not logged in · Please run /login"** | Claude Code has no login. The SDK reports this as a successful turn, so the proxy cannot turn it into an error — it arrives as the assistant's answer | run `claude`, then `/login`; restart the proxy |
| `400 streaming is not implemented on /v1/messages` | you set `stream: true` on the Anthropic endpoint | drop it, or use `/v1/chat/completions` |
| `400 \`messages\` is required` | body is not JSON, or the header is missing | send `content-type: application/json` |
| `500` with a message | the SDK threw — usually a model id Claude Code does not recognise | try `sonnet` or a listed id from `/v1/models` |
| replies are coherent but the assistant forgot the conversation | the proxy restarted and the session map is gone (§5) | new conversation id |
| a browser request fails but curl works | almost always CORS on a *different* proxy; this one echoes the requested headers | confirm you are on `127.0.0.1` and the port matches |

## 8. What it is, in one paragraph

An Express server on `127.0.0.1` that checks a key you chose, accepts either API
shape, maps model names, and hands each request to the Claude Agent SDK — the same
library Claude Code itself is built on — with tools switched off so it behaves as a
chat model. With `PERSIST_SESSIONS=1` each conversation is a real Claude Code session
on disk. Nothing leaves your machine except the calls Claude Code already makes.
