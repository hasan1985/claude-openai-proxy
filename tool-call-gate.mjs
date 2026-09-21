// Decides, token by token, whether a reply is prose or an emulated tool call.
//
// Tool calls on /v1/messages are emulated: the model is asked to answer with a
// `<tool_call>{...}</tool_call>` block. A streamed reply therefore cannot be
// forwarded blindly — the Messages API announces a content block's type in
// `content_block_start`, before any of its content, and the type is not known
// until the marker has (or has not) appeared. This gate holds back exactly as
// much text as could still turn into the marker, and releases everything else.
//
// Given deltas "Sure, ", "<tool", "_call>{...}</tool_call>" it releases
// "Sure, " as text, holds "<tool" (it might be the marker), then on the third
// delta switches to tool mode and holds the rest. `end()` then parses the held
// JSON into a tool call — or, if it is malformed, releases the held text as
// prose, which is what the non-streaming path does too.

export const TOOL_OPEN = "<tool_call>";
export const TOOL_CLOSE = "</tool_call>";

/** Pulls a tool call out of a reply, if the model emitted one. */
export function parseToolCall(text) {
  const start = text.indexOf(TOOL_OPEN);
  if (start === -1) return null;
  const end = text.indexOf(TOOL_CLOSE, start);
  const body = text.slice(start + TOOL_OPEN.length, end === -1 ? undefined : end).trim();
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed.name !== "string") return null;
    return { name: parsed.name, input: parsed.input ?? {} };
  } catch {
    return null; // malformed — treat the reply as prose
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `marker`. */
function danglingPrefix(text, marker) {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Feed deltas with `push(text)`, which returns the text safe to forward now
 * (possibly ""). Call `end()` once: it returns either
 *   { text }                     — trailing prose that was held back, or a
 *                                  malformed block released as prose, or ""
 *   { toolCall: {name, input} }  — the parsed call, when the reply was one.
 */
export class ToolCallGate {
  #pending = ""; // text not yet released, in prose mode
  #held = null;  // everything from the marker on, once in tool mode

  get inToolCall() {
    return this.#held !== null;
  }

  push(delta) {
    if (this.#held !== null) {
      this.#held += delta;
      return "";
    }
    this.#pending += delta;
    const at = this.#pending.indexOf(TOOL_OPEN);
    if (at !== -1) {
      const before = this.#pending.slice(0, at);
      this.#held = this.#pending.slice(at);
      this.#pending = "";
      return before;
    }
    const keep = danglingPrefix(this.#pending, TOOL_OPEN);
    const release = this.#pending.slice(0, this.#pending.length - keep);
    this.#pending = this.#pending.slice(this.#pending.length - keep);
    return release;
  }

  end() {
    if (this.#held === null) {
      const text = this.#pending;
      this.#pending = "";
      return { text };
    }
    const held = this.#held;
    this.#held = null;
    const toolCall = parseToolCall(held);
    return toolCall ? { toolCall } : { text: held };
  }
}
