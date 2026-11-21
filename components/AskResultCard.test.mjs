import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");
import { renderToStaticMarkup } from "react-dom/server";

const { AskResultCard, buildAskResultCard, collectAskResults } = await import("./AskResultCard.tsx");

afterEach(cleanup);

function askToolCall(toolCallId, html) {
  return { type: "toolCall", toolCallId, toolName: "ask", input: { html } };
}

function toolResult(toolCallId, details, extra) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "" }], details, ...extra };
}

test("answered details render each answer, plain", () => {
  const block = askToolCall("call-form", "<form><label>Which color?<input name=\"color\"></label></form>");
  const result = toolResult("call-form", {
    answers: [{ name: "color", question: "Which color?", answer: "Blue" }],
  });

  const data = buildAskResultCard(block, result);
  assert.equal(data.state, "answered");

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Which color\?/);
  assert.match(html, /Blue/);
});

test("a selected option's note renders under its answer, labelled with the option, matched by name", () => {
  const block = askToolCall("call-form", "<form><label>Which color?<input name=\"color\"></label></form>");
  const result = toolResult("call-form", {
    answers: [{ name: "color", question: "Which color?", answer: "Blue" }],
    notes: [{ name: "color", option: "Blue", value: "blue", text: "matches the logo" }],
  });

  const data = buildAskResultCard(block, result);
  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Blue:/);
  assert.match(html, /matches the logo/);
});

test("a note's image count renders without the images themselves", () => {
  const block = askToolCall("call-form", "<form><input name=\"color\"></form>");
  const result = toolResult("call-form", {
    answers: [{ name: "color", question: "Which color?", answer: "Blue" }],
    notes: [{ name: "color", option: "Blue", value: "blue", text: "see attached", images: [{ type: "image", data: "a" }, { type: "image", data: "b" }] }],
  });

  const data = buildAskResultCard(block, result);
  assert.equal(data.notes[0].imageCount, 2);
  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.doesNotMatch(html, /data:/);
});

test("a note for a field with no matching answer is not shown (unknown name)", () => {
  const block = askToolCall("call-form", "<form><input name=\"color\"></form>");
  const result = toolResult("call-form", {
    answers: [{ name: "color", question: "Which color?", answer: "Blue" }],
    notes: [{ name: "size", option: "Large", value: "large", text: "orphan note" }],
  });

  const data = buildAskResultCard(block, result);
  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.doesNotMatch(html, /orphan note/);
});

test("timedOut details show the auto-selected marker and an empty answer shows 'No selection'", () => {
  const block = askToolCall("call-timeout", "<form><input name=\"proceed\"></form>");
  const result = toolResult("call-timeout", {
    answers: [{ name: "proceed", question: "Proceed?", answer: "" }],
    timedOut: true,
  });

  const data = buildAskResultCard(block, result);
  assert.equal(data.timedOut, true);

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Auto-selected after timeout/);
  assert.match(html, /No selection/);
});

test("chatRedirect details show the chat-redirect state", () => {
  const block = askToolCall("call-chat", "<form><input name=\"q\"></form>");
  const result = toolResult("call-chat", { answers: [], chatRedirect: true });

  const data = buildAskResultCard(block, result);
  assert.deepEqual(data, { toolCallId: "call-chat", state: "chatRedirect" });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Chose to chat about this/);
});

test("isError result shows the cancelled state", () => {
  const block = askToolCall("call-cancel", "<form><input name=\"q\"></form>");
  const result = toolResult("call-cancel", undefined, { isError: true, content: [{ type: "text", text: "Ask tool was cancelled by the user" }] });

  const data = buildAskResultCard(block, result);
  assert.deepEqual(data, { toolCallId: "call-cancel", state: "cancelled" });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Cancelled/);
});

test("no matching toolResult means still pending — builds nothing", () => {
  const block = askToolCall("call-pending", "<form><input name=\"q\"></form>");
  assert.equal(buildAskResultCard(block, undefined), null);
});

test("empty answers with no chatRedirect — builds nothing (e.g. a form with no named controls)", () => {
  const block = askToolCall("call-empty", "<form></form>");
  const result = toolResult("call-empty", { answers: [] });
  assert.equal(buildAskResultCard(block, result), null);
});

test("collectAskResults gathers answered asks from a segment's activity pieces in order", () => {
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [askToolCall("call-1", "<form><input name=\"q1\"></form>")],
      model: "m",
      provider: "p",
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "" }],
      details: { answers: [{ name: "q1", question: "First question?", answer: "A" }] },
    },
    {
      role: "assistant",
      content: [
        askToolCall("call-2", "<form><input name=\"q2\"></form>"),
        { type: "text", text: "Done." },
      ],
      model: "m",
      provider: "p",
    },
    {
      role: "toolResult",
      toolCallId: "call-2",
      content: [{ type: "text", text: "" }],
      details: { answers: [{ name: "q2", question: "Second question?", answer: "B" }] },
    },
  ];
  const toolResultsMap = new Map([
    ["call-1", messages[2]],
    ["call-2", messages[4]],
  ]);
  // The second assistant message is split: only its ask block is folded into
  // the activity segment, its text block is rendered as the final answer.
  const pieces = [{ index: 1 }, { index: 3, blocks: [messages[3].content[0]] }];

  const cards = collectAskResults(messages, pieces, toolResultsMap);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.toolCallId), ["call-1", "call-2"]);
  assert.equal(cards[0].answers[0].question, "First question?");
  assert.equal(cards[1].answers[0].question, "Second question?");
});

test("collectAskResults skips a still-pending ask (no toolResult yet)", () => {
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [askToolCall("call-pending", "<form><input name=\"q\"></form>")],
      model: "m",
      provider: "p",
    },
  ];
  const cards = collectAskResults(messages, [{ index: 1 }], new Map());
  assert.equal(cards.length, 0);
});

test("renders in Strict Mode without warnings", () => {
  const block = askToolCall("call-strict", "<form><input name=\"q1\"></form>");
  const result = toolResult("call-strict", { answers: [{ name: "q1", question: "OK?", answer: "Yes" }] });
  const { container } = render(
    React.createElement(React.StrictMode, null, React.createElement(AskResultCard, { data: buildAskResultCard(block, result) })),
  );
  assert.match(container.textContent, /OK\?/);
});
