import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Focused coverage for the web-only additions to omp's question protocols: a
// pending `ask` or `form` must also accept `{chat:true}` (the "Chat about
// this" affordance) in addition to its answer or a cancel, and both answers
// may carry notes. Harness mirrors the "ask dialogs stay pending..." case in
// rpc-manager.test.mjs.

// Wrappers publish notifications, which the notification store records: never in the real agent dir.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "omp-ask-chat-test-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
const { closeNotificationStore } = await import("./notification-store.ts");
test.after(() => {
  closeNotificationStore();
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { AgentSessionWrapper } = await import("./rpc-manager.ts");
// A wrapper built directly needs an online host; the daemon's machine host is one.
const { localHost } = await import("./hosts/local-host.ts");

function snapshotSession(t, sendCommand = async () => ({})) {
  let emit;
  const sentFrames = [];
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, emit: (event) => emit(event) };
}

function askFrame(id) {
  return {
    type: "extension_ui_request", id, method: "ask",
    questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }],
  };
}

function formFrame(id) {
  return {
    type: "extension_ui_request", id, method: "form",
    form: { sections: [], fields: [], hidden: [] },
    questions: { db: "Which database?" },
  };
}

test("a pending ask accepts {chat:true} and forwards it to omp verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame("ask-1"));
  await wrapper.send({ type: "extension_ui_response", id: "ask-1", chat: true });
  assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "ask-1", chat: true }]);
  // Answering settles the pending dialog: a fresh subscriber sees nothing.
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(replay, []);
});

test("answers carrying a note are forwarded to omp verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame("ask-1"));
  const answers = [{ id: "q", selectedOptions: ["A"], note: "leaning A" }];
  await wrapper.send({ type: "extension_ui_response", id: "ask-1", answers });
  assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "ask-1", answers }]);
});

test("an answers payload with a malformed note is still rejected and leaves the ask pending", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame("ask-1"));
  await assert.rejects(
    wrapper.send({
      type: "extension_ui_response", id: "ask-1",
      answers: [{ id: "q", selectedOptions: ["A"], note: 5 }],
    }),
    { name: "WebRpcError", code: "invalid_ask_answers" },
  );
  assert.deepEqual(sentFrames, [], "malformed answers never reach omp");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.method, "ask", "a rejected answer leaves the dialog pending for reconnects");
});

test("a pending form forwards its data and notes to omp verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(formFrame("form-1"));
  const data = { db: "pg", features: ["search", "offline mode"], port: 5432 };
  const notes = { db: "already running here" };
  await wrapper.send({ type: "extension_ui_response", id: "form-1", data, notes });
  assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "form-1", data, notes }]);
});

test("a pending form accepts {chat:true} and a cancel", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(formFrame("form-1"));
  await wrapper.send({ type: "extension_ui_response", id: "form-1", chat: true });
  emit(formFrame("form-2"));
  await wrapper.send({ type: "extension_ui_response", id: "form-2", cancelled: true });
  assert.deepEqual(sentFrames, [
    { type: "extension_ui_response", id: "form-1", chat: true },
    { type: "extension_ui_response", id: "form-2", cancelled: true },
  ]);
});

test("a malformed form payload is rejected and leaves the form pending", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(formFrame("form-1"));
  await assert.rejects(
    wrapper.send({ type: "extension_ui_response", id: "form-1", data: { db: { nested: true } } }),
    { name: "WebRpcError", code: "invalid_form_data" },
  );
  await assert.rejects(
    wrapper.send({ type: "extension_ui_response", id: "form-1", data: { db: "pg" }, notes: { db: 5 } }),
    { name: "WebRpcError", code: "invalid_form_data" },
  );
  assert.deepEqual(sentFrames, [], "malformed data never reaches omp");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.method, "form", "a rejected answer leaves the dialog pending for reconnects");
});
