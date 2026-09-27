import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AskDialog } = await jiti.import("./AskDialog.tsx");

afterEach(cleanup);

function makeRequest(questions, extra) {
  return { type: "extension_ui_request", id: "ask-1", method: "ask", questions, ...extra };
}

function renderAsk(questions, onRespond) {
  const request = makeRequest(questions);
  render(React.createElement(AskDialog, { request, onRespond, attached: true }));
  return request;
}

test("renders 3 questions as tabs and can answer them in order 2 -> 3 -> 1 via clicks", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [
      { id: "q1", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] },
      { id: "q2", header: "Size", question: "Pick a size", options: [{ label: "Small" }, { label: "Large" }] },
      { id: "q3", header: "Features", question: "Pick features", multi: true, options: [{ label: "Search" }, { label: "Sync" }] },
    ],
    (_request, result) => { response = result; },
  );

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
    results: [
      { id: "q1", selectedOptions: ["Red"] },
      { id: "q2", selectedOptions: ["Small"] },
      { id: "q3", selectedOptions: ["Search"] },
    ],
  });
});

test("multi questions toggle via checkbox clicks and Space", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  assert.equal(screen.getByRole("checkbox", { name: "A" }).checked, true);

  screen.getByRole("dialog").focus();
  await user.keyboard("{ArrowDown} ");
  assert.equal(screen.getByRole("checkbox", { name: "B" }).checked, true);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { results: [{ id: "q1", selectedOptions: ["A", "B"] }] });
});

test("'Other' input sets customInput and clears option selection in single mode", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [
      { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Pick another", options: [{ label: "X" }, { label: "Y" }] },
    ],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("radio", { name: "A" }));
  await user.click(screen.getByRole("tab", { name: /Pick one/ }));
  assert.equal(screen.getByRole("radio", { name: "A" }).checked, true);

  const otherInput = screen.getByPlaceholderText("Type your own answer…");
  await user.type(otherInput, "custom text");
  assert.equal(screen.getByRole("radio", { name: "A" }).checked, false);

  await user.click(screen.getByRole("tab", { name: /Pick another/ }));
  await user.click(screen.getByRole("radio", { name: "X" }));

  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    results: [
      { id: "q1", selectedOptions: [], customInput: "custom text" },
      { id: "q2", selectedOptions: ["X"] },
    ],
  });
});

test("a note attached to an option appears in Review and the submitted payload, and drops once deselected", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }] }],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  const noteButtons = screen.getAllByRole("button", { name: "Add note" });
  await user.click(noteButtons[0]); // rows render as [A, B, Other]; index 0 is A's row.
  const noteInput = screen.getByPlaceholderText("Add a note…");
  await user.type(noteInput, "please pick this");
  await user.keyboard("{Enter}");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(screen.getByRole("tabpanel").textContent, /please pick this/);

  await user.click(screen.getByRole("tab", { name: /Pick features/ }));
  await user.click(screen.getByRole("checkbox", { name: "A" })); // deselect

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.doesNotMatch(screen.getByRole("tabpanel").textContent, /please pick this/);

  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { results: [{ id: "q1", selectedOptions: [] }] });
});

test("each selected multi option keeps its own note, shown under the row and merged on submit", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "Pick features", multi: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] }],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("checkbox", { name: "A" }));
  await user.click(screen.getByRole("checkbox", { name: "C" }));
  // rows render as [A, B, C, Other]
  await user.click(screen.getAllByRole("button", { name: "Add note" })[0]);
  await user.type(screen.getByPlaceholderText("Add a note…"), "needs SSO");
  await user.keyboard("{Enter}");
  await user.click(screen.getAllByRole("button", { name: "Add note" })[1]); // C (A now shows "Edit note")
  await user.type(screen.getByPlaceholderText("Add a note…"), "CSV only");
  await user.keyboard("{Enter}");

  // Both note texts stay visible in the question pane.
  const panel = screen.getByRole("tabpanel").textContent;
  assert.match(panel, /needs SSO/);
  assert.match(panel, /CSV only/);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    results: [{ id: "q1", selectedOptions: ["A", "C"], note: "A: needs SSO; C: CSV only" }],
  });
});

test("submit payload matches question declaration order and shape regardless of answer order", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [
      { id: "q1", question: "One", options: [{ label: "A" }] },
      { id: "q2", question: "Two", options: [{ label: "B" }] },
    ],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: /Two/ }));
  await user.click(screen.getByRole("radio", { name: "B" }));
  await user.click(screen.getByRole("tab", { name: /One/ }));
  await user.click(screen.getByRole("radio", { name: "A" }));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    results: [
      { id: "q1", selectedOptions: ["A"] },
      { id: "q2", selectedOptions: ["B"] },
    ],
  });
  assert.deepEqual(Object.keys(response.results[0]), ["id", "selectedOptions"]);
});

test("'Chat about this' responds with chat:true", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [
      { id: "q1", question: "One", options: [{ label: "A" }] },
      { id: "q2", question: "Two", options: [{ label: "B" }] },
    ],
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Chat about this" }));
  assert.deepEqual(response, { chat: true });
});

test("Escape cancels the dialog", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "One", options: [{ label: "A" }, { label: "B" }] }],
    (_request, result) => { response = result; },
  );

  screen.getByRole("dialog").focus();
  await user.keyboard("{Escape}");
  assert.deepEqual(response, { cancelled: true });
});

test("Escape while the 'Other' input is focused blurs it instead of canceling the dialog", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "One", options: [{ label: "A" }, { label: "B" }] }],
    (_request, result) => { response = result; },
  );

  const otherInput = screen.getByPlaceholderText("Type your own answer…");
  await user.click(otherInput);
  await user.keyboard("{Escape}");
  assert.equal(response, undefined);
  assert.notEqual(document.activeElement, otherInput);
});

test("a single non-multi question with no Review tab submits immediately on click", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    (_request, result) => { response = result; },
  );
  assert.equal(screen.queryByRole("tab", { name: "Review" }), null);

  await user.click(screen.getByRole("radio", { name: "A" }));
  assert.deepEqual(response, { results: [{ id: "q1", selectedOptions: ["A"] }] });
});

test("a single non-multi question with no Review tab submits immediately on Enter", async () => {
  const user = userEvent.setup();
  let response;
  renderAsk(
    [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    (_request, result) => { response = result; },
  );

  screen.getByRole("dialog").focus();
  await user.keyboard("{Enter}");
  assert.deepEqual(response, { results: [{ id: "q1", selectedOptions: ["A"] }] });
});

test("Review shows an unanswered warning and per-question unanswered labels", async () => {
  const user = userEvent.setup();
  renderAsk(
    [
      { id: "q1", question: "One", options: [{ label: "A" }] },
      { id: "q2", question: "Two", options: [{ label: "B" }] },
    ],
    () => {},
  );

  await user.click(screen.getByRole("tab", { name: "Review" }));
  const review = screen.getByRole("tabpanel").textContent;
  assert.match(review, /2 questions need answers/);
  assert.match(review, /Unanswered/);
});
