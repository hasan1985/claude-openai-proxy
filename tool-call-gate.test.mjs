import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolCallGate, parseToolCall } from "./tool-call-gate.mjs";

/** Runs a delta sequence through a gate; returns what was released and the end result. */
function drive(deltas) {
  const gate = new ToolCallGate();
  const released = deltas.map((d) => gate.push(d));
  return { released, end: gate.end() };
}

test("prose passes straight through, delta by delta", () => {
  const { released, end } = drive(["Hello", ", ", "world"]);
  assert.deepEqual(released, ["Hello", ", ", "world"]);
  assert.deepEqual(end, { text: "" });
});

test("a whole tool call in one delta is held and parsed at the end", () => {
  const { released, end } = drive(['<tool_call>{"name": "make_move", "input": {"square": 4}}</tool_call>']);
  assert.deepEqual(released, [""]);
  assert.deepEqual(end, { toolCall: { name: "make_move", input: { square: 4 } } });
});

test("a tool call split across deltas releases nothing and parses at the end", () => {
  const { released, end } = drive(["<tool", "_call>", '{"name": "get_board", ', '"input": {}}', "</tool_call>"]);
  assert.deepEqual(released, ["", "", "", "", ""]);
  assert.deepEqual(end, { toolCall: { name: "get_board", input: {} } });
});

test("text that merely starts like the marker is held, then released once it is not one", () => {
  const { released, end } = drive(["a < b", " and <tool", "s are nice"]);
  assert.deepEqual(released, ["a < b", " and ", "<tools are nice"]);
  assert.deepEqual(end, { text: "" });
});

test("a dangling marker prefix at the very end comes out as text", () => {
  const { released, end } = drive(["see <"]);
  assert.deepEqual(released, ["see "]);
  assert.deepEqual(end, { text: "<" });
});

test("prose before the marker is released as text; the call still parses", () => {
  const { released, end } = drive(["Sure. ", '<tool_call>{"name": "reset_game"}</tool_call>']);
  assert.deepEqual(released, ["Sure. ", ""]);
  assert.deepEqual(end, { toolCall: { name: "reset_game", input: {} } });
});

test("prose after the closing marker is dropped, as the non-streaming path does", () => {
  const { released, end } = drive(['<tool_call>{"name": "x", "input": {}}</tool_call>', " Done!"]);
  assert.deepEqual(released, ["", ""]);
  assert.deepEqual(end, { toolCall: { name: "x", input: {} } });
});

test("a malformed block is released as prose at the end", () => {
  const { released, end } = drive(["<tool_call>{not json", "</tool_call>"]);
  assert.deepEqual(released, ["", ""]);
  assert.deepEqual(end, { text: "<tool_call>{not json</tool_call>" });
});

test("parseToolCall matches the gate: name required, input defaults to {}", () => {
  assert.equal(parseToolCall("no marker"), null);
  assert.equal(parseToolCall('<tool_call>{"input": {}}</tool_call>'), null);
  assert.deepEqual(parseToolCall('<tool_call>{"name": "a"}'), { name: "a", input: {} });
});
