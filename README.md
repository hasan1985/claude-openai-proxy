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

- `POST /v1/chat/completions` — streaming (SSE) and non-streaming
- `GET /v1/models`

Model aliases: `gpt-4`/`gpt-4o` → opus-5, `gpt-4o-mini`/`gpt-3.5-turbo` → haiku-4.5,
plus bare `opus`/`sonnet`/`haiku`. Anything else passes through.

## Known limits

- **Stateless.** Each request replays the full `messages` array as a flattened
  prompt, so there's no prompt-cache reuse across turns. Fine for a demo; for
  real multi-turn, keep a session and use the SDK's `resume` option.
- **Tools are off** (`tools: []`) so it behaves like a chat model. Turn them on
  and Claude Code gets filesystem and bash access to `cwd`.
- `max_tokens` is not enforced as an output cap — the SDK has no direct equivalent.
- No `n`, `temperature`, `logprobs`, function calling, or vision.
