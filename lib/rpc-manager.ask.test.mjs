import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Focused coverage for the `ask` extension UI method: it must be tracked,
// expired, cancelled and replayed exactly like the existing `select`/`input`
// dialog methods (see the "dialog replay" / "expired dialogs" cases in
// rpc-manager.test.mjs, whose snapshotSession helper this mirrors).

const runtimeJiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await runtimeJiti.import("./rpc-manager.ts");

function snapshotSession(t, sendCommand = async () => ({})) {
  let emit;
  const sentFrames = [];
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd());
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, emit: (event) => emit(event) };
}

function askFrame(overrides = {}) {
  return {
    type: "extension_ui_request",
    id: "ask-1",
    method: "ask",
    questions: [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    ...overrides,
  };
}

test("an ask request is tracked as a pending dialog and replayed to a later subscriber", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  emit(askFrame());
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay.length, 1);
  assert.equal(replay[0].id, "ask-1");
  assert.equal(replay[0].method, "ask");
  assert.deepEqual(replay[0].questions, askFrame().questions);
});

test("an ask request with a timeout expires and is no longer replayed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit } = snapshotSession(t);
  emit(askFrame({ timeout: 100 }));
  t.mock.timers.tick(101);
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(replay, []);
});

test("a cancel frame targeting a pending ask clears it before any replay", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  emit(askFrame());
  emit({ type: "extension_ui_request", method: "cancel", targetId: "ask-1" });
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(replay, []);
});

test("extension_ui_response results/chat bodies are forwarded to omp verbatim and clear the pending ask", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit(askFrame());
  await wrapper.send({
    type: "extension_ui_response",
    id: "ask-1",
    results: [{ id: "q1", selectedOptions: ["A"], note: "leaning A" }],
  });
  assert.deepEqual(sentFrames[0], {
    type: "extension_ui_response",
    id: "ask-1",
    results: [{ id: "q1", selectedOptions: ["A"], note: "leaning A" }],
  });
  // The pending dialog was forgotten by the response: a fresh subscriber sees nothing.
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(replay, []);

  emit(askFrame({ id: "ask-2" }));
  await wrapper.send({ type: "extension_ui_response", id: "ask-2", chat: true });
  assert.deepEqual(sentFrames[1], { type: "extension_ui_response", id: "ask-2", chat: true });
});
