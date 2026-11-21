import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

// omp's `askDialog` is answered by the tabbed panel: one tab per question, a
// Review tab, per-answer notes and "Chat about this".
const { AskDialog } = await import("./AskDialog.tsx");

afterEach(cleanup);

function makeRequest(questions, extra) {
  return { type: "ui_request", id: 1, method: "askDialog", args: [questions], ...extra };
}

function renderAsk(questions, onRespond = () => {}) {
  const request = makeRequest(questions);
  render(React.createElement(AskDialog, { request, onRespond, attached: true }));
  return request;
}

/** omp's ExtensionAskDialogResultItem for `question`. */
function result(question, selectedOptions, extra = {}) {
  return {
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multi: question.multi ?? false,
    selectedOptions,
    ...extra,
  };
}

const otherField = () => screen.getByRole("textbox", { name: "Other (type your own)" });

test("renders 3 questions as tabs and can answer them in order 2 -> 3 -> 1 via clicks", async () => {
  const user = userEvent.setup();
  let response;
  const questions = [
    { id: "q1", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] },
    { id: "q2", header: "Size", question: "Pick a size", options: [{ label: "Small" }, { label: "Large" }] },
    { id: "q3", header: "Features", question: "Pick features", multi: true, options: [{ label: "Search" }, { label: "Sync" }] },
  ];
  renderAsk(questions, (_request, value) => { response = value; });

  await user.click(screen.getByRole("tab", { name: /Size/ }));
  await user.click(screen.getByRole("radio", { name: "Small" }));

  await user.click(screen.getByRole("tab", { name: /Features/ }));
  await user.click(screen.getByRole("checkbox", { name: "Search" }));

  await user.click(screen.getByRole("tab", { name: /Pick a color/ }));
  await user.click(screen.getByRole("radio", { name: "Red" }));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  const review = screen.getByRole("tabpanel").textContent;
  assert.match(review, /Red/);
  assert.match(review, /Small/);
  assert.match(review, /Search/);

  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    kind: "submit",
    results: [result(questions[0], ["Red"]), result(questions[1], ["Small"]), result(questions[2], ["Search"])],
  });
});

test("multi questions toggle via checkbox clicks and Space on the focused option", async () => {
  const user = userEvent.setup();
  let response;
  const question = { id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] };
  renderAsk([question], (_request, value) => { response = value; });

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  assert.equal(screen.getByRole("checkbox", { name: "A" }).checked, true);

  screen.getByRole("checkbox", { name: "B" }).focus();
  await user.keyboard(" ");
  assert.equal(screen.getByRole("checkbox", { name: "B" }).checked, true);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(question, ["A", "B"])] });
});

test("a single-select pick moves on to the next tab; the last lands on Review and only Submit sends", async () => {
  const user = userEvent.setup();
  let response;
  const questions = [
    { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
    { id: "q2", question: "Pick another", options: [{ label: "X" }, { label: "Y" }] },
  ];
  renderAsk(questions, (_request, value) => { response = value; });

  await user.click(screen.getByRole("radio", { name: "A" }));
  assert.equal(screen.getByRole("tab", { name: /Pick another/ }).getAttribute("aria-selected"), "true");
  await user.click(screen.getByRole("radio", { name: "X" }));
  assert.equal(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected"), "true");
  assert.equal(response, undefined, "picking an option never submits behind the user's back");

  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(questions[0], ["A"]), result(questions[1], ["X"])] });
});

test("the Other text answers the question and replaces a single-select choice", async () => {
  const user = userEvent.setup();
  let response;
  const questions = [
    { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
    { id: "q2", question: "Pick another", options: [{ label: "X" }, { label: "Y" }] },
  ];
  renderAsk(questions, (_request, value) => { response = value; });

  await user.click(screen.getByRole("radio", { name: "A" }));
  await user.click(screen.getByRole("tab", { name: /Pick one/ }));
  assert.equal(screen.getByRole("radio", { name: "A" }).checked, true);

  await user.type(otherField(), "custom text");
  assert.equal(screen.getByRole("radio", { name: "A" }).checked, false);

  await user.click(screen.getByRole("tab", { name: /Pick another/ }));
  await user.click(screen.getByRole("radio", { name: "X" }));

  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    kind: "submit",
    results: [result(questions[0], [], { customInput: "custom text" }), result(questions[1], ["X"])],
  });
});

test("the Other text stays when another option is chosen, and counts again when Other is", async () => {
  const user = userEvent.setup();
  let response;
  const question = { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] };
  renderAsk([question], (_request, value) => { response = value; });

  const other = otherField();
  await user.type(other, "Teal");
  await user.click(screen.getByRole("tab", { name: /Pick one/ }));
  await user.click(screen.getByRole("radio", { name: "A" }));
  await user.click(screen.getByRole("tab", { name: /Pick one/ }));
  assert.equal(otherField().value, "Teal", "the typed answer stays in its row");

  await user.click(otherField());
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(question, [], { customInput: "Teal" })] });
});

test("a note on an answer reaches Review and the submitted result, and drops once deselected", async () => {
  const user = userEvent.setup();
  let response;
  const question = { id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }] };
  renderAsk([question], (_request, value) => { response = value; });

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByPlaceholderText("Add a note…"), "please pick this");
  await user.keyboard("{Enter}");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(screen.getByRole("tabpanel").textContent, /please pick this/);

  await user.click(screen.getByRole("tab", { name: /Pick features/ }));
  await user.click(screen.getByRole("checkbox", { name: "A" }));
  assert.equal(screen.queryByRole("button", { name: "Edit note" }), null, "an answer that is gone has no note to edit");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.doesNotMatch(screen.getByRole("tabpanel").textContent, /please pick this/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(question, [])] });
});

test("a single note names the option it is on; several notes are merged into the one omp carries", async () => {
  const user = userEvent.setup();
  let response;
  const question = { id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] };
  renderAsk([question], (_request, value) => { response = value; });

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByPlaceholderText("Add a note…"), "needs SSO");
  await user.keyboard("{Enter}");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    kind: "submit",
    results: [result(question, ["A"], { note: "needs SSO", noteOption: "A" })],
  });

  await user.click(screen.getByRole("tab", { name: /Pick features/ }));
  await user.click(screen.getByRole("checkbox", { name: "C" }));
  // Notes list the answers in order: A keeps its note, C gets the second one.
  await user.click(screen.getAllByRole("button", { name: "Add note" })[0]);
  await user.type(screen.getByPlaceholderText("Add a note…"), "CSV only");
  await user.keyboard("{Enter}");
  const panel = screen.getByRole("tabpanel").textContent;
  assert.match(panel, /needs SSO/);
  assert.match(panel, /CSV only/);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    kind: "submit",
    results: [result(question, ["A", "C"], { note: "A: needs SSO; C: CSV only" })],
  });
});

test("the submitted results follow question order whatever order they were answered in", async () => {
  const user = userEvent.setup();
  let response;
  const questions = [
    { id: "q1", question: "One", options: [{ label: "A" }] },
    { id: "q2", question: "Two", options: [{ label: "B" }] },
  ];
  renderAsk(questions, (_request, value) => { response = value; });

  await user.click(screen.getByRole("tab", { name: /Two/ }));
  await user.click(screen.getByRole("radio", { name: "B" }));
  await user.click(screen.getByRole("tab", { name: /One/ }));
  await user.click(screen.getByRole("radio", { name: "A" }));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(questions[0], ["A"]), result(questions[1], ["B"])] });
  assert.deepEqual(Object.keys(response.results[0]), ["id", "question", "options", "multi", "selectedOptions"]);
});

test("'Chat about this' answers with omp's chat result and Cancel with no value", async () => {
  const user = userEvent.setup();
  const responses = [];
  renderAsk([{ id: "q1", question: "One", options: [{ label: "A" }] }], (_request, value) => { responses.push(value); });

  await user.click(screen.getByRole("button", { name: "Chat about this" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ kind: "chat" }, undefined]);
});

test("Escape cancels, but Escape in a text box only leaves the box", async () => {
  const user = userEvent.setup();
  const responses = [];
  renderAsk([{ id: "q1", question: "One", options: [{ label: "A" }, { label: "B" }] }], (_request, value) => { responses.push(value); });

  const other = otherField();
  await user.click(other);
  await user.keyboard("{Escape}");
  assert.deepEqual(responses, []);
  assert.notEqual(document.activeElement, other);

  screen.getByRole("dialog").focus();
  await user.keyboard("{Escape}");
  assert.deepEqual(responses, [undefined]);
});

test("Review shows the unanswered warning and marks each unanswered question", async () => {
  const user = userEvent.setup();
  renderAsk([
    { id: "q1", question: "One", options: [{ label: "A" }] },
    { id: "q2", question: "Two", options: [{ label: "B" }] },
  ]);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  const review = screen.getByRole("tabpanel").textContent;
  assert.match(review, /2 questions need answers/);
  assert.match(review, /Unanswered/);
});

test("the recommended option is marked and preselected", async () => {
  const user = userEvent.setup();
  let response;
  const question = { id: "q1", question: "Pick a color", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }], recommended: 1 };
  renderAsk([question], (_request, value) => { response = value; });

  assert.match(screen.getByRole("radio", { name: /Green/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false);

  await user.click(screen.getByRole("radio", { name: /Blue/ }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { kind: "submit", results: [result(question, ["Blue"])] });
});

test("the arrow keys walk the tab strip, and the title counts the timeout down", async () => {
  const user = userEvent.setup();
  render(React.createElement(AskDialog, {
    request: makeRequest([
      { id: "q1", question: "One", options: [{ label: "A" }] },
      { id: "q2", question: "Two", options: [{ label: "B" }] },
    ], { expiresAt: Date.now() + 30_000 }),
    onRespond: () => {},
    attached: true,
  }));

  assert.match(screen.getByRole("dialog").getAttribute("aria-label"), /^Ask \(\d+s\)$/);
  screen.getByRole("tab", { name: /One/ }).focus();
  await user.keyboard("{ArrowRight}");
  assert.equal(screen.getByRole("tab", { name: /Two/ }).getAttribute("aria-selected"), "true");
  await user.keyboard("{ArrowRight}{ArrowRight}");
  assert.equal(screen.getByRole("tab", { name: /One/ }).getAttribute("aria-selected"), "true", "the strip wraps around");
});
