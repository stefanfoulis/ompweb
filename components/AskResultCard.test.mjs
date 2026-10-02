import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");
import { renderToStaticMarkup } from "react-dom/server";

const { AskResultCard, buildAskResultCard, collectAskResults } = await import("./AskResultCard.tsx");

afterEach(cleanup);

function askToolCall(toolCallId, questions) {
  return { type: "toolCall", toolCallId, toolName: "ask", input: { questions } };
}

function toolResult(toolCallId, details, extra) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "" }], details, ...extra };
}

test("multi-question results render each question with selected options, custom input, and note", () => {
  const block = askToolCall("call-ask", [
    { id: "q1", header: "Color", question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] },
    { id: "q2", header: "Features", question: "Which features?", multi: true, options: [{ label: "Search" }, { label: "Sync" }] },
  ]);
  const result = toolResult("call-ask", {
    results: [
      { id: "q1", question: "Which color?", options: ["Red", "Blue"], multi: false, selectedOptions: ["Red"] },
      {
        id: "q2",
        question: "Which features?",
        options: ["Search", "Sync"],
        multi: true,
        selectedOptions: ["Search", "Sync"],
        customInput: "also add offline mode",
        note: "nice to have",
      },
    ],
  });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, {
    data: buildAskResultCard(block, result),
  }));

  assert.match(html, /Color: <\/span>Which color\?/);
  assert.match(html, /Features: <\/span>Which features\?/);
  assert.match(html, />Red</);
  assert.match(html, />Search</);
  assert.match(html, />Sync</);
  assert.match(html, /also add offline mode/);
  assert.match(html, /nice to have/);
});

test("single-question details shape renders without an id", () => {
  const block = askToolCall("call-single", [
    { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
  ]);
  const result = toolResult("call-single", {
    question: "Proceed?",
    options: ["Yes", "No"],
    multi: false,
    selectedOptions: ["Yes"],
  });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, {
    data: buildAskResultCard(block, result),
  }));

  assert.match(html, /Proceed\?/);
  assert.match(html, />Yes</);
});

test("chatRedirect details show the original questions and the chat-redirect state", () => {
  const block = askToolCall("call-chat", [
    { id: "q1", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] },
  ]);
  const result = toolResult("call-chat", { chatRedirect: true, questions: ["Which approach?"] });

  const data = buildAskResultCard(block, result);
  assert.equal(data.state, "chatRedirect");

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Which approach\?/);
  assert.match(html, /Chose to chat about this/);
});

test("isError result shows the cancelled state", () => {
  const block = askToolCall("call-cancel", [
    { id: "q1", header: "Plan", question: "Proceed with deploy?", options: [{ label: "Yes" }, { label: "No" }] },
  ]);
  const result = toolResult("call-cancel", {}, { isError: true, content: [{ type: "text", text: "Ask tool was cancelled by the user" }] });

  const data = buildAskResultCard(block, result);
  assert.equal(data.state, "cancelled");

  const html = renderToStaticMarkup(React.createElement(AskResultCard, { data }));
  assert.match(html, /Cancelled/);
  assert.match(html, /Plan: <\/span>Proceed with deploy\?/);
});

test("no matching toolResult means still pending — builds nothing", () => {
  const block = askToolCall("call-pending", [{ id: "q1", question: "Pending?", options: [{ label: "Yes" }] }]);
  assert.equal(buildAskResultCard(block, undefined), null);
});

test("multi-select with an empty selection shows 'No selection'", () => {
  const block = askToolCall("call-empty", [
    { id: "q1", question: "Which extras?", multi: true, options: [{ label: "A" }, { label: "B" }] },
  ]);
  const result = toolResult("call-empty", {
    results: [{ id: "q1", question: "Which extras?", options: ["A", "B"], multi: true, selectedOptions: [] }],
  });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, {
    data: buildAskResultCard(block, result),
  }));
  assert.match(html, /No selection/);
});

test("a custom answer without a selected option keeps the offered options and omits 'No selection'", () => {
  const block = askToolCall("call-custom", [
    { id: "deploy", question: "Deployment target?", options: [{ label: "Docker" }, { label: "Bare metal" }] },
  ]);
  const result = toolResult("call-custom", {
    results: [{ id: "deploy", question: "Deployment target?", options: ["Docker", "Bare metal"], multi: false, selectedOptions: [], customInput: "Kubernetes on Hetzner" }],
  });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, {
    data: buildAskResultCard(block, result),
  }));
  assert.match(html, /Kubernetes on Hetzner/);
  assert.match(html, /Docker/);
  assert.match(html, /Bare metal/);
  assert.doesNotMatch(html, /No selection/);
});

test("a timed-out question shows the auto-selected marker", () => {
  const block = askToolCall("call-timeout", [
    { id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
  ]);
  const result = toolResult("call-timeout", {
    results: [{ id: "q1", question: "Continue?", options: ["Yes", "No"], multi: false, selectedOptions: ["Yes"], timedOut: true }],
  });

  const html = renderToStaticMarkup(React.createElement(AskResultCard, {
    data: buildAskResultCard(block, result),
  }));
  assert.match(html, /Auto-selected after timeout/);
});

test("collectAskResults gathers answered asks from a segment's activity pieces in order", () => {
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [askToolCall("call-1", [{ id: "q1", question: "First question?", options: [{ label: "A" }] }])],
      model: "m",
      provider: "p",
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "" }],
      details: { results: [{ id: "q1", question: "First question?", options: ["A"], multi: false, selectedOptions: ["A"] }] },
    },
    {
      role: "assistant",
      content: [
        askToolCall("call-2", [{ id: "q2", question: "Second question?", options: [{ label: "B" }] }]),
        { type: "text", text: "Done." },
      ],
      model: "m",
      provider: "p",
    },
    {
      role: "toolResult",
      toolCallId: "call-2",
      content: [{ type: "text", text: "" }],
      details: { results: [{ id: "q2", question: "Second question?", options: ["B"], multi: false, selectedOptions: ["B"] }] },
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
  assert.equal(cards[0].questions[0].question, "First question?");
  assert.equal(cards[1].questions[0].question, "Second question?");
});

test("collectAskResults skips a still-pending ask (no toolResult yet)", () => {
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [askToolCall("call-pending", [{ id: "q1", question: "Pending?", options: [{ label: "A" }] }])],
      model: "m",
      provider: "p",
    },
  ];
  const cards = collectAskResults(messages, [{ index: 1 }], new Map());
  assert.equal(cards.length, 0);
});

test("renders in Strict Mode without warnings", () => {
  const block = askToolCall("call-strict", [{ id: "q1", question: "OK?", options: [{ label: "Yes" }] }]);
  const result = toolResult("call-strict", {
    results: [{ id: "q1", question: "OK?", options: ["Yes"], multi: false, selectedOptions: ["Yes"] }],
  });
  const { container } = render(
    React.createElement(React.StrictMode, null, React.createElement(AskResultCard, { data: buildAskResultCard(block, result) })),
  );
  assert.match(container.textContent, /OK\?/);
});
