import assert from "node:assert/strict";
import test from "node:test";
import { deriveTabStatus, doneUnseenReducer, lastMessageErrored } from "./tab-status.ts";

const BASE = {
  extensionDialogPending: false,
  openUrlPending: false,
  errored: false,
  agentRunning: false,
  bashRunning: false,
  activeSubagentCount: 0,
  doneUnseen: false,
};

test("idle when nothing is happening", () => {
  assert.equal(deriveTabStatus(BASE), "idle");
});

test("waiting outranks every other state", () => {
  assert.equal(deriveTabStatus({ ...BASE, extensionDialogPending: true, errored: true, agentRunning: true, doneUnseen: true }), "waiting");
  assert.equal(deriveTabStatus({ ...BASE, openUrlPending: true, errored: true, bashRunning: true, doneUnseen: true }), "waiting");
});

test("error outranks busy and done, but not waiting", () => {
  assert.equal(deriveTabStatus({ ...BASE, errored: true, agentRunning: true, doneUnseen: true }), "error");
  assert.equal(deriveTabStatus({ ...BASE, errored: true, doneUnseen: true }), "error");
});

test("busy (agent, bash or subagents) outranks done", () => {
  assert.equal(deriveTabStatus({ ...BASE, agentRunning: true, doneUnseen: true }), "busy");
  assert.equal(deriveTabStatus({ ...BASE, bashRunning: true, doneUnseen: true }), "busy");
  assert.equal(deriveTabStatus({ ...BASE, activeSubagentCount: 1, doneUnseen: true }), "busy");
});

test("done only once nothing more urgent applies", () => {
  assert.equal(deriveTabStatus({ ...BASE, doneUnseen: true }), "done");
});

test("lastMessageErrored reads the final assistant message's stopReason", () => {
  assert.equal(lastMessageErrored([]), false);
  assert.equal(lastMessageErrored([{ role: "assistant", stopReason: "stop" }]), false);
  assert.equal(lastMessageErrored([{ role: "assistant", stopReason: "error" }]), true);
  // A tool result or anything else trailing the failed assistant message means
  // that message is no longer the final one — only the very last entry counts.
  assert.equal(lastMessageErrored([{ role: "assistant", stopReason: "error" }, { role: "toolResult" }]), false);
  // A fresh prompt (optimistic user message) clears a previous error immediately.
  assert.equal(lastMessageErrored([{ role: "assistant", stopReason: "error" }, { role: "user" }]), false);
});

test("doneUnseenReducer: a run ending while hidden or unfocused sets done-unseen", () => {
  assert.equal(doneUnseenReducer(false, { type: "run_ended", hidden: true, focused: true }), true);
  assert.equal(doneUnseenReducer(false, { type: "run_ended", hidden: false, focused: false }), true);
  assert.equal(doneUnseenReducer(false, { type: "run_ended", hidden: false, focused: true }), false);
});

test("doneUnseenReducer: visible+focused and session change both clear it", () => {
  assert.equal(doneUnseenReducer(true, { type: "visible_and_focused" }), false);
  assert.equal(doneUnseenReducer(true, { type: "session_change" }), false);
  assert.equal(doneUnseenReducer(false, { type: "visible_and_focused" }), false);
});
