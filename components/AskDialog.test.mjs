import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

// omp's `askDialog` is answered by the tabbed panel: one tab per question, a
// Review tab, per-answer notes and "Chat about this".
const { AskDialog } = await import("./AskDialog.tsx");

afterEach(cleanup);
before(() => {
  // jsdom has no pointer capture; the resize handle calls it on every drag.
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.hasPointerCapture = () => false;
  window.Element.prototype.releasePointerCapture = () => {};
});

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

test("expand never remounts the panel: a formDialog's chosen radio, checkbox and notes survive expand and Escape-shrink, and submit carries them (not the HTML defaults)", async () => {
  localStorage.clear();
  const user = userEvent.setup();
  let response;
  const request = {
    type: "ui_request",
    id: 1,
    method: "formDialog",
    args: [`<form>
      <p>Which database?</p>
      <label><input type="radio" name="db" value="sqlite"> SQLite</label>
      <label><input type="radio" name="db" value="pg" checked> Postgres</label>
      <p>Which features?</p>
      <label><input type="checkbox" name="features" value="auth"> Auth</label>
      <label><input type="checkbox" name="features" value="search"> Search</label>
      <label>Notes <textarea name="notes"></textarea></label>
    </form>`],
  };
  const { container } = render(React.createElement(AskDialog, {
    request,
    onRespond: (_request, value) => { response = value; },
    attached: true,
  }));

  // Picking SQLite overrides the HTML default (Postgres, `checked`) and moves
  // on to Features, as a single-select radio does.
  await user.click(screen.getByRole("radio", { name: "SQLite" }));
  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  assert.equal(screen.getByRole("radio", { name: "SQLite" }).checked, true);

  await user.click(screen.getByRole("tab", { name: /Which features/ }));
  await user.click(screen.getByRole("checkbox", { name: "Auth" }));
  await user.click(screen.getByRole("tab", { name: /Notes/ }));
  await user.type(screen.getByRole("textbox", { name: /Notes/ }), "needs backups");

  await user.click(screen.getByRole("button", { name: "Expand" }));
  const expandedDialog = screen.getByRole("dialog");
  assert.equal(container.contains(expandedDialog), true, "expanding keeps the panel in its own DOM subtree — never a remount");
  assert.equal(screen.getByRole("textbox", { name: /Notes/ }).value, "needs backups", "the active tab's answer survives expand");

  expandedDialog.focus();
  await user.keyboard("{Escape}");
  assert.equal(response, undefined, "Escape while expanded must not cancel or submit the dialog");
  // Shrinking back hands focus to the panel on the next frame; wait for it so
  // that focus move cannot land after the assertions below.
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("dialog")));

  // Still the same native controls, their values intact after shrinking back —
  // nothing was ever recreated from the form's HTML defaults.
  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  assert.equal(screen.getByRole("radio", { name: "SQLite" }).checked, true, "the radio answer survives expand and shrink");
  await user.click(screen.getByRole("tab", { name: /Which features/ }));
  assert.equal(screen.getByRole("checkbox", { name: "Auth" }).checked, true, "the checkbox answer survives expand and shrink");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { db: "sqlite", features: ["auth"], notes: "needs backups" } });
  localStorage.clear();
});

test("expand moves the panel to a fixed, near-fullscreen view, Escape shrinks it back without responding, and the resize handle resizes and resets", async () => {
  localStorage.clear();
  const user = userEvent.setup();
  let response;
  const { container } = render(React.createElement(AskDialog, {
    request: makeRequest([
      { id: "q1", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] },
      { id: "q2", question: "Pick a size", options: [{ label: "Small" }, { label: "Large" }] },
    ]),
    onRespond: (_request, value) => { response = value; },
    attached: true,
  }));

  // A single-select pick advances to the next tab; come back so the chosen
  // option is visible across the expand below.
  await user.click(screen.getByRole("radio", { name: "Red" }));
  await user.click(screen.getByRole("tab", { name: /Pick a color/ }));
  assert.equal(screen.getByRole("radio", { name: "Red" }).checked, true);

  await user.click(screen.getByRole("button", { name: "Expand" }));
  const expandedDialog = screen.getByRole("dialog");
  assert.equal(container.contains(expandedDialog), true, "the panel stays in place; only its CSS switches to fixed/near-fullscreen");
  assert.equal(screen.getByRole("radio", { name: "Red" }).checked, true, "answers and tab state survive expanding");
  assert.equal(screen.queryByRole("separator"), null, "the expanded view fills the screen: nothing to resize");

  expandedDialog.focus();
  await user.keyboard("{Escape}");
  assert.equal(response, undefined, "Escape while expanded must not cancel or submit the dialog");
  // Shrinking back hands focus to the panel on the next frame; wait for it so
  // that focus move cannot land after the handle is focused below.
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("dialog")));

  const handle = screen.getByRole("separator", { name: "Resize (drag, double-click to reset)" });
  handle.focus();
  await user.keyboard("{ArrowUp}");
  const panel = screen.getByRole("dialog");
  // jsdom reports 0 for getBoundingClientRect, so the +24 step lands below
  // the floor, and the floor itself is what the handle settles on.
  assert.equal(panel.style.height, "160px");
  assert.equal(localStorage.getItem("omp-web:ask-dialog-height"), "160");

  await user.dblClick(handle);
  assert.equal(screen.getByRole("dialog").style.height, "");

  localStorage.clear();
});

test("a click on the expanded backdrop shrinks back too, and the choice is remembered", async () => {
  localStorage.clear();
  const user = userEvent.setup();
  const responses = [];
  const props = {
    request: makeRequest([{ id: "q1", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] }]),
    onRespond: (_request, value) => { responses.push(value); },
    attached: true,
  };
  const { unmount } = render(React.createElement(AskDialog, props));

  await user.click(screen.getByRole("button", { name: "Expand" }));
  assert.equal(localStorage.getItem("omp-web:ask-dialog-expanded"), "1");
  // The backdrop is the panel's own wrapper, grown fixed and near-fullscreen around it.
  await user.click(screen.getByRole("dialog").parentElement);
  assert.deepEqual(responses, [], "a stray click must not discard the answers");
  assert.equal(screen.queryByRole("separator"), screen.getByRole("dialog").firstChild, "the grip is back on the attached panel");

  // The next question opens the way the user left this one.
  localStorage.setItem("omp-web:ask-dialog-expanded", "1");
  unmount();
  render(React.createElement(AskDialog, props));
  assert.ok(screen.getByRole("button", { name: "Shrink back" }));
  localStorage.clear();
});
