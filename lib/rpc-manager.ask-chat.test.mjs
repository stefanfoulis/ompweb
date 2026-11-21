import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Focused coverage for what the tabbed dialog adds to omp's question answers:
// "Chat about this" (`{kind:"chat"}`) for both methods, the notes an ask
// result and a form submission carry, and the malformed shapes that must
// leave the dialog pending. Harness mirrors the "ask and form dialogs stay
// pending..." case in rpc-manager.test.mjs.

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

function snapshotSession(t) {
  const frameListeners = new Set();
  const sentFrames = [];
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    sendCommand: async () => ({}),
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, emit: (event) => { for (const listener of frameListeners) listener(event); } };
}

function askFrame(id) {
  return { type: "ui_request", id, method: "askDialog", args: [[{ id: "q", question: "Pick", options: [{ label: "A" }] }]] };
}

function formFrame(id) {
  return { type: "ui_request", id, method: "formDialog", args: ["<form><p>Which database?</p><input type=radio name=db value=pg></form>"] };
}

/** Events a newly attached tab is replayed: a pending dialog is among them. */
function replayed(wrapper) {
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return events;
}

test("either question accepts omp's chat result and forwards it verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame(1));
  emit(formFrame(2));
  await wrapper.send({ type: "ui_response", id: 1, value: { kind: "chat" } });
  await wrapper.send({ type: "ui_response", id: 2, value: { kind: "chat" } });
  assert.deepEqual(sentFrames, [
    { type: "ui_response", id: 1, value: { kind: "chat" } },
    { type: "ui_response", id: 2, value: { kind: "chat" } },
  ]);
  // Answering settles both dialogs: a fresh subscriber sees nothing.
  assert.deepEqual(replayed(wrapper), []);
});

test("an ask result carrying a note on an option is forwarded verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame(1));
  const value = {
    kind: "submit",
    results: [{ id: "q", question: "Pick", options: ["A"], multi: false, selectedOptions: ["A"], note: "leaning A", noteOption: "A" }],
  };
  await wrapper.send({ type: "ui_response", id: 1, value });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 1, value }]);
});

test("a form submission carrying OptionNotes is forwarded verbatim", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(formFrame(2));
  const value = {
    data: { db: "pg", features: ["search", "offline mode"], port: 5432 },
    notes: [{ name: "db", question: "Which database?", option: "Postgres", value: "pg", text: "already running here" }],
  };
  await wrapper.send({ type: "ui_response", id: 2, value });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 2, value }]);
});

test("a malformed note leaves the question pending instead of reaching omp", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame(1));
  emit(formFrame(2));
  const malformed = [
    [1, { kind: "submit", results: [{ id: "q", question: "Pick", options: ["A"], multi: false, selectedOptions: ["A"], note: 5 }] }],
    [1, { kind: "submit", results: [{ id: "q", selectedOptions: ["A"] }] }],
    [2, { data: { db: "pg" }, notes: { db: "already running here" } }],
    [2, { data: { db: "pg" }, notes: [{ name: "db", question: "Which database?", option: "Postgres", value: "pg" }] }],
    [2, { data: { db: { nested: true } } }],
  ];
  for (const [id, value] of malformed) {
    await assert.rejects(
      wrapper.send({ type: "ui_response", id, value }),
      { name: "WebRpcError", code: "invalid_ui_response" },
      JSON.stringify(value),
    );
  }
  assert.deepEqual(sentFrames, [], "malformed answers never reach omp");
  assert.deepEqual(replayed(wrapper).map((event) => event.method), ["askDialog", "formDialog"], "a rejected answer leaves the dialog pending for reconnects");
});

test("a cancel is a response with no value at all", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(formFrame(2));
  await wrapper.send({ type: "ui_response", id: 2 });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 2, value: undefined }]);
  assert.deepEqual(replayed(wrapper), []);
});
