import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

// The same tabbed dialog answers omp's `form` requests (a parsed agent-written
// <form>): one tab per named field, omp's own submission semantics, and the
// web-only notes / "Chat about this".
const { AskDialog } = await import("./AskDialog.tsx");

afterEach(cleanup);

function choiceField(name, options, extra = {}) {
  return {
    kind: "choice",
    name,
    multi: false,
    select: false,
    other: false,
    label: [],
    required: false,
    ...extra,
    options: options.map((option) => ({
      value: option.value,
      label: [{ text: option.label ?? option.value }],
      checked: option.checked === true,
      disabled: option.disabled === true,
    })),
  };
}

function textField(name, extra = {}) {
  return { kind: "text", name, type: "text", multiline: false, label: [], value: "", placeholder: "", required: false, rows: 1, ...extra };
}

const field = (f) => ({ kind: "field", field: f });
const paragraph = (text, heading = false) => ({ kind: "text", spans: [{ text }], heading });

/** A `form` request from sections; `questions` is what omp's `fieldQuestions` derived. */
function formRequest(sections, questions, extra) {
  const fields = sections.flatMap((section) => section.blocks.flatMap((block) => (block.kind === "field" ? [block.field] : [])));
  return {
    type: "extension_ui_request",
    id: "form-1",
    method: "form",
    form: { sections, fields, hidden: [["source", "cli"]] },
    questions,
    ...extra,
  };
}

function renderForm(sections, questions, onRespond = () => {}) {
  const request = formRequest(sections, questions);
  render(React.createElement(AskDialog, { request, onRespond, attached: true }));
  return request;
}

const panelText = () => screen.getByRole("tabpanel").textContent;

test("a field's tab carries its section title, the blocks before it and its control", async () => {
  const user = userEvent.setup();
  renderForm(
    [{
      title: [{ text: "Database" }],
      blocks: [
        paragraph("Pick what the service stores its state in", true),
        { kind: "list", ordered: false, items: [[{ text: "sqlite needs no server" }], [{ text: "postgres scales" }]] },
        { kind: "pre", text: "psql --version" },
        { kind: "table", rows: [[[{ text: "Engine" }], [{ text: "Setup" }]], [[{ text: "sqlite" }], [{ text: "none" }]]], headerRows: 1 },
        paragraph("Which database?"),
        field(choiceField("db", [{ value: "sqlite", label: "SQLite", checked: true }, { value: "pg", label: "Postgres" }])),
      ],
    }],
    { db: "Which database?" },
  );

  assert.ok(screen.getByRole("tab", { name: /Which database\?/ }));
  assert.ok(screen.getByRole("tab", { name: "Review" }));
  const text = panelText();
  assert.match(text, /Database/);
  assert.match(text, /Pick what the service stores its state in/);
  assert.match(text, /sqlite needs no server/);
  assert.match(text, /psql --version/);
  assert.match(text, /Engine/);
  // The question is the block right before the field: it heads the tab once,
  // not twice.
  assert.equal(text.split("Which database?").length - 1, 1);
  // `checked` in the form is the dialog's default answer.
  assert.equal(screen.getByRole("radio", { name: "SQLite" }).checked, true);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /SQLite/);
});

test("images and svg are drawn through <img>, never injected as markup", () => {
  renderForm(
    [{
      title: [],
      blocks: [
        { kind: "image", src: "data:image/png;base64,AAAA", alt: "architecture diagram" },
        { kind: "image", src: "", alt: "unreadable screenshot" },
        { kind: "svg", markup: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>', alt: "chart" },
        field(choiceField("ok", [{ value: "y", label: "Yes" }, { value: "n", label: "No" }])),
      ],
    }],
    { ok: "Looks right?" },
  );

  assert.equal(screen.getByAltText("architecture diagram").getAttribute("src"), "data:image/png;base64,AAAA");
  // An image omp could not read arrives without a source; its alt is the content.
  assert.match(panelText(), /unreadable screenshot/);

  const svg = screen.getByAltText("chart");
  assert.match(svg.getAttribute("src"), /^data:image\/svg\+xml;base64,/);
  assert.match(atob(svg.getAttribute("src").split(",")[1]), /<circle r="4"\/>/);
  // Nothing of the markup lands in the page: an <img> cannot run what it draws.
  const dialog = screen.getByRole("dialog");
  assert.equal(dialog.querySelector("circle"), null);
  assert.equal(dialog.querySelector("script"), null);
});

test("the Other row and disabled options follow the field", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [
        field(choiceField("plan", [{ value: "free", label: "Free" }, { value: "team", label: "Team", disabled: true, checked: true }])),
      ],
    }],
    { plan: "Which plan?" },
    (_request, result) => { response = result; },
  );

  // `other: false`: no free-text row is offered.
  assert.equal(screen.queryByPlaceholderText("Type your own answer…"), null);
  assert.equal(screen.getByRole("radio", { name: "Team" }).disabled, true);

  await user.click(screen.getByRole("radio", { name: "Free" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { plan: "free" } });
});

test("an option the form ticked but disabled is not an answer", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [field(choiceField("plan", [{ value: "free", label: "Free" }, { value: "team", label: "Team", disabled: true, checked: true }]))],
    }],
    { plan: "Which plan?" },
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /1 question needs an answer/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: {} }, "omp would drop the disabled value anyway");
});

test("submitted data uses option values, arrays for checkbox groups and numbers for number inputs", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [
        field(choiceField("db", [{ value: "sqlite", label: "SQLite" }, { value: "pg", label: "Postgres" }])),
        field(choiceField("features", [{ value: "search", label: "Search" }, { value: "sync", label: "Sync" }], { multi: true, other: true })),
        field(choiceField("tos", [{ value: "accepted", label: "I accept" }], { multi: true })),
        field(textField("port", { type: "number", value: "5432" })),
        field(textField("notes", { multiline: true, rows: 3 })),
      ],
    }],
    { db: "Which database?", features: "Which features?", tos: "Terms", port: "Which port?", notes: "Anything else?" },
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  await user.click(screen.getByRole("radio", { name: "Postgres" }));

  await user.click(screen.getByRole("tab", { name: /Which features/ }));
  await user.click(screen.getByRole("checkbox", { name: "Search" }));
  await user.type(screen.getByPlaceholderText("Type your own answer…"), "offline mode");

  await user.click(screen.getByRole("tab", { name: /Terms/ }));
  await user.click(screen.getByRole("checkbox", { name: "I accept" }));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));

  assert.deepEqual(response, {
    data: {
      db: "pg",
      features: ["search", "offline mode"],
      tos: "accepted",
      // A `number` input reports a number; the prefilled value is the answer
      // until the user edits it. The untouched textarea answers "".
      port: 5432,
      notes: "",
    },
  });
  // Hidden inputs are omp's business: the client never echoes them back.
  assert.equal("source" in response.data, false);
});

test("a choice nobody answered is left out of the submission", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [
        field(choiceField("db", [{ value: "sqlite", label: "SQLite" }, { value: "pg", label: "Postgres" }])),
        field(choiceField("features", [{ value: "search", label: "Search" }, { value: "sync", label: "Sync" }], { multi: true })),
      ],
    }],
    { db: "Which database?", features: "Which features?" },
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /2 questions need answers/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: {} });
});

test("a required field blocks Submit, opens its tab and clears once answered", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [
        field(textField("name", { required: true, minLength: 3 })),
        field(choiceField("db", [{ value: "sqlite", label: "SQLite" }, { value: "pg", label: "Postgres" }], { required: true })),
      ],
    }],
    { name: "Service name?", db: "Which database?" },
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined, "a required field keeps the submission here");
  assert.equal(screen.getByRole("tab", { name: /Service name/ }).getAttribute("aria-selected"), "true");
  assert.match(panelText(), /Required/);

  // Too short is still not an answer omp would take.
  await user.type(screen.getByRole("textbox", { name: "Service name?" }), "ab");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined);
  assert.match(panelText(), /Needs at least 3 characters/);

  await user.type(screen.getByRole("textbox", { name: "Service name?" }), "c");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(screen.getByRole("tab", { name: /Which database/ }).getAttribute("aria-selected"), "true", "the next unanswered required field");
  assert.match(panelText(), /Required/);

  await user.click(screen.getByRole("radio", { name: "SQLite" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { name: "abc", db: "sqlite" } });
});

test("constraints of a text field are enforced the way omp enforces them", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{ title: [], blocks: [field(textField("contact", { type: "email", required: true }))] }],
    { contact: "Where do we reach you?" },
    (_request, result) => { response = result; },
  );

  await user.type(screen.getByRole("textbox", { name: "Where do we reach you?" }), "not-an-address");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined);
  assert.match(panelText(), /Enter an email address/);

  await user.clear(screen.getByRole("textbox", { name: "Where do we reach you?" }));
  await user.type(screen.getByRole("textbox", { name: "Where do we reach you?" }), "dev@example.com");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { contact: "dev@example.com" } });
});

test("notes are sent per field name, and only for fields that were answered", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    [{
      title: [],
      blocks: [
        field(choiceField("db", [{ value: "sqlite", label: "SQLite" }, { value: "pg", label: "Postgres" }])),
        field(textField("port", { type: "number" })),
      ],
    }],
    { db: "Which database?", port: "Which port?" },
    (_request, result) => { response = result; },
  );

  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  await user.click(screen.getByRole("radio", { name: "Postgres" }));
  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  // Rows are [SQLite, Postgres]; the note belongs to the chosen one.
  await user.click(screen.getAllByRole("button", { name: "Add note" })[1]);
  await user.type(screen.getByPlaceholderText("Add a note…"), "already running here");
  await user.keyboard("{Enter}");

  // A note on an unanswered field is not part of any answer.
  await user.click(screen.getByRole("tab", { name: /Which port/ }));
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByPlaceholderText("Add a note…"), "whatever is free");
  await user.keyboard("{Enter}");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /already running here/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { db: "pg", port: "" }, notes: { db: "already running here" } });
});

test("'Chat about this' and Cancel answer the form request itself", async () => {
  const user = userEvent.setup();
  const responses = [];
  renderForm(
    [{ title: [], blocks: [field(choiceField("db", [{ value: "sqlite", label: "SQLite" }]))] }],
    { db: "Which database?" },
    (_request, result) => { responses.push(result); },
  );

  await user.click(screen.getByRole("button", { name: "Chat about this" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ chat: true }, { cancelled: true }]);
});

test("loose content between fields shows on the next tab, and what trails the last field on Review", async () => {
  const user = userEvent.setup();
  renderForm(
    [
      { title: [], blocks: [paragraph("Read the migration notes first")] },
      {
        title: [{ text: "Rollout" }],
        blocks: [field(choiceField("when", [{ value: "now", label: "Now" }, { value: "later", label: "Later" }]))],
      },
      { title: [], blocks: [paragraph("Cancelling leaves the service as it is")] },
    ],
    { when: "When do we roll out?" },
  );

  assert.match(panelText(), /Read the migration notes first/);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /Cancelling leaves the service as it is/);
});
