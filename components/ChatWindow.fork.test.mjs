import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
const { act, cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");

const { CommittedTranscript } = await import("./ChatWindow.tsx");
afterEach(cleanup);

const FORK_LABEL = "Fork a new session from this point";

function transcript(overrides = {}) {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "answer one" }] },
    { role: "user", content: "second" },
    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "answer two" }] },
  ];
  return {
    messages,
    entryIds: ["u0", "a0", "u1", "a1"],
    conversationMeta: { toolResultsMap: new Map(), lastAnchorIdx: 2, visibleRefIndexByMessage: new Map() },
    messageRefs: { current: [] },
    isStreaming: false,
    sessionBusy: false,
    isCompacting: false,
    externalRunActive: false,
    isNew: false,
    forkingEntryId: null,
    editingEntryId: null,
    handleFork: () => {},
    handleEdit: async () => false,
    modelNames: {},
    messageCwd: undefined,
    sessionId: "s1",
    toolCallsDefaultCollapsed: true,
    expandThinkingByDefault: false,
    hideThinkingBlock: false,
    visibleCount: 50,
    nearBottom: true,
    sentinelRef: { current: null },
    handleLoadMoreClick: () => {},
    ...overrides,
  };
}

test("a running session still offers Fork on committed rows, at the row's own cut", async () => {
  const forked = [];
  const view = render(React.createElement(CommittedTranscript, transcript({
    sessionBusy: true,
    handleFork: (entryId, prefill) => forked.push([entryId, prefill]),
  })));

  // The first prompt has nothing to cut at; the other three rows do.
  const buttons = view.getAllByRole("button", { name: FORK_LABEL });
  assert.equal(buttons.length, 3);

  // A reply cuts at itself; the prompt after it cuts at that reply and hands
  // its text back for the fork's composer. Each click only opens the
  // confirmation; the fork runs on confirm.
  for (const button of buttons) {
    await act(async () => { fireEvent.click(button); });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Fork" })); });
  }
  assert.deepEqual(forked, [["a0", undefined], ["a0", "second"], ["a1", undefined]]);
});

test("a fresh session with no transcript yet offers no fork", () => {
  const view = render(React.createElement(CommittedTranscript, transcript({ isNew: true, sessionBusy: true })));
  assert.deepEqual(view.queryAllByRole("button", { name: FORK_LABEL }), []);
});
