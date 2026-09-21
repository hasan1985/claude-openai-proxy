# Streaming guide

Both endpoints stream. Set `stream: true` and the proxy answers with server-sent
events in the format that endpoint's API defines, so the OpenAI and Anthropic SDKs
both read it with their normal streaming calls — nothing proxy-specific on the
client side.

| Endpoint | Event format | What streams |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI `chat.completion.chunk`, ends with `data: [DONE]` | text deltas |
| `POST /v1/messages` | Anthropic `message_start` … `message_stop` | text deltas; a tool call arrives whole as the last block |

The one thing to know before the examples: on `/v1/messages` a **tool call cannot
stream token by token**. Why is in [§4](#4-tool-calls-while-streaming).

---

## 1. curl

Use `-N` so curl does not buffer the body.

```bash
# OpenAI shape
curl -N -H "Authorization: Bearer my-secret-key" -H "Content-Type: application/json" \
  -d '{"model":"sonnet","stream":true,
       "messages":[{"role":"user","content":"Count to ten, slowly"}]}' \
  http://127.0.0.1:8080/v1/chat/completions

# Anthropic shape
curl -N -H "Authorization: Bearer my-secret-key" -H "Content-Type: application/json" \
  -d '{"model":"sonnet","max_tokens":200,"stream":true,
       "messages":[{"role":"user","content":"Count to ten, slowly"}]}' \
  http://127.0.0.1:8080/v1/messages
```

The first prints `data: {"id":…,"object":"chat.completion.chunk",…}` lines; the
second prints `event: message_start`, `event: content_block_delta`, and so on.

## 2. OpenAI SDK — `/v1/chat/completions`

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="my-secret-key")

with client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Count to ten, slowly"}],
    stream=True,
) as stream:
    for chunk in stream:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "my-secret-key" });

const stream = await client.chat.completions.create({
  model: "sonnet",
  messages: [{ role: "user", content: "Count to ten, slowly" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

Each chunk carries one text delta. The last chunk has `finish_reason: "stop"`, then
`[DONE]`.

## 3. Anthropic SDK — `/v1/messages`

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({
  apiKey: "my-secret-key",
  baseURL: "http://127.0.0.1:8080",        // the origin only — the SDK adds /v1
});

const stream = client.messages.stream({
  model: "claude-sonnet-5",
  max_tokens: 200,
  messages: [{ role: "user", content: "Count to ten, slowly" }],
});
stream.on("text", (delta) => process.stdout.write(delta));
const message = await stream.finalMessage();   // the same shape create() returns
```

```python
from anthropic import Anthropic
client = Anthropic(api_key="my-secret-key", base_url="http://127.0.0.1:8080")

with client.messages.stream(
    model="claude-sonnet-5",
    max_tokens=200,
    messages=[{"role": "user", "content": "Count to ten, slowly"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    message = stream.get_final_message()
```

`finalMessage()` / `get_final_message()` assembles the full message from the
events, so code that inspects `content` and `stop_reason` after the stream works
exactly as it does with `create()`. A tool-use loop can therefore stream every
model call and change nothing else — see the next section.

### The events on the wire

For a prose reply:

```
event: message_start        {"message":{"id":"msg_…","role":"assistant","content":[],…}}
event: content_block_start  {"index":0,"content_block":{"type":"text","text":""}}
event: content_block_delta  {"index":0,"delta":{"type":"text_delta","text":"One"}}
event: content_block_delta  {"index":0,"delta":{"type":"text_delta","text":", two"}}
…
event: content_block_stop   {"index":0}
event: message_delta        {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":…}}
event: message_stop
```

For a tool call:

```
event: message_start
event: content_block_start  {"index":0,"content_block":{"type":"tool_use","id":"toolu_…","name":"make_move","input":{}}}
event: content_block_delta  {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"square\":4}"}}
event: content_block_stop   {"index":0}
event: message_delta        {"delta":{"stop_reason":"tool_use"},…}
event: message_stop
```

Token counts are only known at the end, so `message_start` reports zeros and the
real usage is on `message_delta`. If the turn fails after the stream has started,
the last event is `event: error` with `{"type":"error","error":{…}}`, and the SDKs
raise it.

## 4. Tool calls while streaming

Tool calling on `/v1/messages` is emulated: the model is asked to reply with a
`<tool_call>{…}</tool_call>` block, which the proxy turns into a `tool_use` content
block ([usage guide §6](./USAGE-GUIDE.md#6-tool-calling--what-to-expect)).

That collides with streaming in one place. The Messages API announces each block's
type in `content_block_start`, *before* its content, and the proxy cannot know
whether the reply is prose or a tool call until the marker has, or has not,
appeared. So the proxy holds back exactly as much text as could still turn into the
marker and forwards everything else at once:

| The model has produced so far | What the client has received |
|---|---|
| `The centre` | `The centre` |
| `The centre <` | `The centre ` — the `<` might open the marker |
| `The centre <b>is</b>` | `The centre <b>is</b>` — it was not |
| `<tool_call>{"name":` | nothing yet |
| `<tool_call>{"name":"make_move",…}</tool_call>` | one `tool_use` block, at the end |

What this means for your loop:

- **Prose streams normally.** A dangling `<` costs at most one delta of delay.
- **A tool call arrives as one block at the end of the stream**, its whole input in a
  single `input_json_delta`. The SDK's `finalMessage()` returns it as a normal
  `tool_use` block with `stop_reason: "tool_use"`; run the tool and stream again.
- **Prose before the marker streams; prose after it is dropped**, the same as the
  non-streaming path.
- **A malformed block comes out as text**, so a model that garbled the JSON is
  visible rather than silently ignored.

If a model emits a native tool call for the declared tool instead of the marker
(Haiku does), the proxy reports that as a `tool_use` block too. Either way the
stream ends the same way.

## 5. Stopping a stream

Close the connection — abort the SDK call, or Ctrl-C curl — and the proxy cancels
the Claude turn behind it. Nothing runs on after the client has gone.

```ts
const controller = new AbortController();
const stream = client.messages.stream({ … }, { signal: controller.signal });
// later
controller.abort();
```

## 6. Threading and streaming

`X-Conversation-Id` works on streamed requests exactly as on plain ones
([usage guide §5](./USAGE-GUIDE.md#5-keeping-a-conversation-going)). One
difference: a streamed response cannot carry `X-Claude-Session-Id`, because the
headers go out before the turn ends and the session id is only known at the end.
`GET /v1/sessions` still lists the mapping.

## 7. When it does not stream

| What you see | Why | Do |
|---|---|---|
| Everything arrives at once | Something between you and the proxy buffers: curl without `-N`, a dev-server proxy with response buffering, a `fetch` read with `.text()` instead of the body reader | Read the body incrementally; add `-N` to curl |
| `event: error` mid-stream | The Claude turn failed after the headers went out — logged out, model unavailable, cancelled | Check the proxy's terminal; run `claude` once to confirm the login |
| The SDK reports "Connection error" from a browser | CORS — the browser hides the real reason | The proxy sends CORS headers itself; check the URL is the origin with no `/v1` |
| An older copy of the proxy answers `400 streaming is not implemented on /v1/messages` | It predates streaming on that endpoint | Update and restart; a client with a fallback (the playground) has already switched to `create()` for its session |

Every path above is covered by `npm run test:e2e`, which streams both endpoints
and a tool call through your real login ([usage guide §8](./USAGE-GUIDE.md#8-testing-it)).
