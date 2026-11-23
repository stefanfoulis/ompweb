import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

// The same tabbed dialog answers omp's `formDialog` requests (the agent's own
// `<form>` HTML): one tab per named control, omp's submission semantics, and
// the web-only notes / "Chat about this".
const { AskDialog } = await import("./AskDialog.tsx");

afterEach(cleanup);

function renderForm(html, onRespond = () => {}) {
  render(React.createElement(AskDialog, {
    request: { type: "ui_request", id: 1, method: "formDialog", args: [html] },
    onRespond,
    attached: true,
  }));
}

const panelText = () => screen.getByRole("tabpanel").textContent;

const deployHtml = `<form>
  <p>Choose how to deploy. <script>window.pwned = true</script></p>
  <fieldset><legend>Database</legend>
    <p>Which database?</p>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
    <label><input type="radio" name="db" value="pg" checked> Postgres</label>
  </fieldset>
  <fieldset><legend>Extras</legend>
    <label><input type="checkbox" name="extras" value="cache" checked> Cache</label>
    <label><input type="checkbox" name="extras" value="logs"> Logs</label>
    <label><input type="checkbox" name="extras" value="metrics" checked> Metrics</label>
  </fieldset>
  <label>Region <select name="region"><option>us</option><option value="eu" selected>Europe</option></select></label>
  <label>Replicas <input type="number" name="replicas" value="3"></label>
  <label>Notes <textarea name="notes">keep it</textarea></label>
  <img src="x" onerror="window.pwned = true"><button type="button" onclick="window.pwned = true">Do it</button>
</form>`;

test("each named control gets a tab: its legend heads it, the text above it is the question", async () => {
  const user = userEvent.setup();
  renderForm(deployHtml);

  for (const name of [/Which database\?/, /Extras/, /Region/, /Replicas/, /Notes/, /^Review$/]) {
    assert.ok(screen.getByRole("tab", { name }), `tab ${name}`);
  }
  // Content before the first field introduces it, and the question is printed once.
  const text = panelText();
  assert.match(text, /Choose how to deploy/);
  assert.match(text, /Database/, "the fieldset legend heads the tab");
  assert.equal(text.split("Which database?").length - 1, 1);
  assert.equal(screen.getByRole("radio", { name: /Postgres/ }).checked, true, "`checked` is the default answer");

  await user.click(screen.getByRole("tab", { name: /Extras/ }));
  assert.equal(screen.getByRole("checkbox", { name: /Cache/ }).checked, true);
});

test("a form submits its pre-checked and prefilled defaults untouched; checkbox groups give arrays", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(deployHtml, (_request, value) => { response = value; });

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { db: "pg", extras: ["cache", "metrics"], region: "eu", replicas: 3, notes: "keep it" } });
});

test("agent markup never becomes live HTML: scripts, handlers and buttons are dropped, and an <img> with a non-data src is never drawn", () => {
  renderForm(deployHtml);
  const dialog = screen.getByRole("dialog");
  assert.equal(dialog.querySelector("script, img, [onerror], [onclick]"), null);
  assert.equal(screen.queryByRole("button", { name: "Do it" }), null);
  assert.equal(window.pwned, undefined);
});

test("answers survive moving between tabs, because every control stays mounted", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(deployHtml, (_request, value) => { response = value; });

  await user.click(screen.getByRole("radio", { name: /SQLite/ }));
  await user.click(screen.getByRole("tab", { name: /Replicas/ }));
  await user.clear(screen.getByRole("spinbutton", { name: /Replicas/ }));
  await user.type(screen.getByRole("spinbutton", { name: /Replicas/ }), "5");
  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  assert.equal(screen.getByRole("radio", { name: /SQLite/ }).checked, true);

  await user.click(screen.getByRole("tab", { name: "Review" }));
  const review = panelText();
  assert.match(review, /SQLite/);
  assert.match(review, /5/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response.data.db, "sqlite");
  assert.equal(response.data.replicas, 5);
});

test("a radio pick decides the question outright and moves on, as the plain askDialog radios do; a checkbox pick does not", async () => {
  const user = userEvent.setup();
  renderForm(`<form>
    <p>Which database?</p>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
    <p>Which features?</p>
    <label><input type="checkbox" name="features" value="auth"> Auth</label>
    <label><input type="checkbox" name="features" value="search"> Search</label>
  </form>`);

  await user.click(screen.getByRole("radio", { name: /SQLite/ }));
  assert.equal(screen.getByRole("tab", { name: /Which features/ }).getAttribute("aria-selected"), "true");

  await user.click(screen.getByRole("checkbox", { name: /Auth/ }));
  assert.equal(screen.getByRole("tab", { name: /Which features/ }).getAttribute("aria-selected"), "true", "a checkbox never decides the question alone, so it never moves the tab on its own");
});

test("form options preserve preformatted text and indentation", () => {
  renderForm(`<form><label><input type="radio" name="choice" value="one"> Example <pre>first line\n  indented second line</pre></label></form>`);
  const pre = screen.getByRole("radio", { name: /Example/ }).closest("label").querySelector("pre");
  assert.ok(pre);
  assert.equal(pre.textContent, "first line\n  indented second line");
  assert.equal(pre.tabIndex, 0);
});

test("a group of two or more gets omp's Other answer: it joins a checkbox array and stands in for a radio", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(`<form>
    <p>Which features?</p>
    <label><input type="checkbox" name="features" value="search"> Search</label>
    <label><input type="checkbox" name="features" value="sync"> Sync</label>
    <p>Which plan?</p>
    <label><input type="radio" name="plan" value="free"> Free</label>
    <label><input type="radio" name="plan" value="team"> Team</label>
  </form>`, (_request, value) => { response = value; });

  await user.click(screen.getByRole("checkbox", { name: /Search/ }));
  await user.type(screen.getAllByRole("textbox", { name: "Other (type your own)" })[0], "offline mode");
  await user.click(screen.getByRole("tab", { name: /Which plan/ }));
  await user.type(screen.getByRole("textbox", { name: "Other (type your own)" }), "enterprise");

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { features: ["search", "offline mode"], plan: "enterprise" } });
});

test("an option the form ticked but disabled is not an answer", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(`<form>
    <p>Which plan?</p>
    <label><input type="radio" name="plan" value="free"> Free</label>
    <label><input type="radio" name="plan" value="team" checked disabled> Team</label>
  </form>`, (_request, value) => { response = value; });

  assert.equal(screen.getByRole("radio", { name: /Team/ }).disabled, true);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /1 question needs an answer/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: {} }, "omp would drop the disabled value anyway");
});

test("a choice nobody answered is left out of the submission", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(`<form>
    <p>Which database?</p>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
    <p>Which features?</p>
    <label><input type="checkbox" name="features" value="search"> Search</label>
    <label><input type="checkbox" name="features" value="sync"> Sync</label>
  </form>`, (_request, value) => { response = value; });

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /2 questions need answers/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { features: [] } }, "an empty checkbox group is omp's empty answer");
});

test("a required field blocks Submit, opens its tab and clears once answered", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(`<form>
    <label>Service name? <input type="text" name="name" required minlength="3"></label>
    <p>Which database?</p>
    <label><input type="radio" name="db" value="sqlite" required> SQLite</label>
    <label><input type="radio" name="db" value="pg" required> Postgres</label>
  </form>`, (_request, value) => { response = value; });

  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined, "a required field keeps the submission here");
  assert.equal(screen.getByRole("tab", { name: /Service name/ }).getAttribute("aria-selected"), "true");
  assert.match(panelText(), /Required/);

  // Too short is still not an answer omp would take.
  await user.type(screen.getByRole("textbox", { name: /Service name/ }), "ab");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined);
  assert.match(panelText(), /Needs at least 3 characters/);

  await user.type(screen.getByRole("textbox", { name: /Service name/ }), "c");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(screen.getByRole("tab", { name: /Which database/ }).getAttribute("aria-selected"), "true", "the next unanswered required field");
  assert.match(panelText(), /Required/);

  await user.click(screen.getByRole("radio", { name: /SQLite/ }));
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { name: "abc", db: "sqlite" } });
});

test("constraints of a text field are enforced the way omp enforces them", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(
    `<form><label>Where do we reach you? <input type="email" name="contact" required></label></form>`,
    (_request, value) => { response = value; },
  );

  await user.type(screen.getByRole("textbox", { name: /Where do we reach you/ }), "not-an-address");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.equal(response, undefined);
  assert.match(panelText(), /Enter an email address/);

  await user.clear(screen.getByRole("textbox", { name: /Where do we reach you/ }));
  await user.type(screen.getByRole("textbox", { name: /Where do we reach you/ }), "dev@example.com");
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, { data: { contact: "dev@example.com" } });
});

test("notes go out as omp's OptionNote list, only for answers that were given", async () => {
  const user = userEvent.setup();
  let response;
  renderForm(`<form>
    <p>Which database?</p>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
    <label><input type="radio" name="db" value="pg"> Postgres</label>
    <p>Which features?</p>
    <label><input type="checkbox" name="features" value="search"> Search</label>
    <label><input type="checkbox" name="features" value="sync"> Sync</label>
  </form>`, (_request, value) => { response = value; });

  await user.click(screen.getByRole("radio", { name: /Postgres/ }));
  // A radio pick advances to the next tab; come back to note the answer just given.
  await user.click(screen.getByRole("tab", { name: /Which database/ }));
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByPlaceholderText("Add a note…"), "already running here");
  await user.keyboard("{Enter}");

  // An answer the user takes back takes its note with it.
  await user.click(screen.getByRole("tab", { name: /Which features/ }));
  await user.click(screen.getByRole("checkbox", { name: /Sync/ }));
  await user.click(screen.getByRole("button", { name: "Add note" }));
  await user.type(screen.getByPlaceholderText("Add a note…"), "only nightly");
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("checkbox", { name: /Sync/ }));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /already running here/);
  assert.doesNotMatch(panelText(), /only nightly/);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(response, {
    data: { db: "pg", features: [] },
    notes: [{ name: "db", question: "Which database?", option: "Postgres", value: "pg", text: "already running here" }],
  });
});

test("'Chat about this' and Cancel answer the form request itself", async () => {
  const user = userEvent.setup();
  const responses = [];
  renderForm(
    `<form><p>Which database?</p><label><input type="radio" name="db" value="sqlite"> SQLite</label></form>`,
    (_request, value) => { responses.push(value); },
  );

  await user.click(screen.getByRole("button", { name: "Chat about this" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ kind: "chat" }, undefined]);
});

test("loose content between fields shows on the next tab, and what trails the last field on Review", async () => {
  const user = userEvent.setup();
  renderForm(`<form>
    <p>Read the migration notes first</p>
    <fieldset><legend>Rollout</legend>
      <label><input type="radio" name="when" value="now"> Now</label>
      <label><input type="radio" name="when" value="later"> Later</label>
    </fieldset>
    <p>Cancelling leaves the service as it is</p>
  </form>`);

  assert.match(panelText(), /Read the migration notes first/);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  assert.match(panelText(), /Cancelling leaves the service as it is/);
});

// A 1x1 transparent PNG, the smallest valid payload omp's media loader could hand back.
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("pictures: a data: img draws, a non-data src falls back to its alt, an inline svg draws via a data URL, and a label keeps only the alt", () => {
  renderForm(`<form>
    <p>Read the diagram below</p>
    <img src="${PNG_DATA_URL}" alt="Deployment diagram">
    <svg viewBox="0 0 10 10"><title>Flow</title><circle cx="5" cy="5" r="4"/></svg>
    <img src="/etc/passwd" alt="Hidden chart">
    <img src="https://example.com/x.png" alt="Remote chart">
    <fieldset><legend>Region</legend>
      <label><img src="${PNG_DATA_URL}" alt="US flag"> <input type="radio" name="region" value="us"> US</label>
      <label><input type="radio" name="region" value="eu"> EU</label>
    </fieldset>
  </form>`);

  const panel = screen.getByRole("tabpanel");
  // The loadable picture draws as its own image, alt kept.
  const picture = panel.querySelector(`img[src="${PNG_DATA_URL}"]`);
  assert.ok(picture, "a data: src draws as an <img>");
  assert.equal(picture.getAttribute("alt"), "Deployment diagram");

  // Neither a local path nor a remote URL is ever loaded here (the runner's job): only the alt shows.
  assert.equal(panel.querySelector('img[src="/etc/passwd"]'), null);
  assert.equal(panel.querySelector('img[src="https://example.com/x.png"]'), null);
  assert.ok(screen.getByText("Hidden chart"));
  assert.ok(screen.getByText("Remote chart"));

  // The inline svg draws only through a data:image/svg+xml <img>, never as a live <svg>.
  assert.equal(panel.querySelector("svg"), null);
  const svgImg = panel.querySelector('img[src^="data:image/svg+xml"]');
  assert.ok(svgImg, "the svg draws as an <img> with a data:image/svg+xml src");
  assert.equal(svgImg.getAttribute("alt"), "Flow");
  assert.equal(decodeURIComponent(svgImg.getAttribute("src").slice("data:image/svg+xml;charset=utf-8,".length)), "<svg viewBox=\"0 0 10 10\" xmlns=\"http://www.w3.org/2000/svg\"><title>Flow</title><circle cx=\"5\" cy=\"5\" r=\"4\"></circle></svg>");

  // Inside the label, the picture that would otherwise draw contributes only its alt.
  const usLabel = screen.getByRole("radio", { name: "US flag US" }).closest("label");
  assert.equal(usLabel.querySelector("img"), null);
  assert.match(usLabel.textContent, /US flag/);

  // The standalone picture between fields is context for the field it introduces, like any other block.
  assert.ok(screen.getByText("Read the diagram below").closest('[role="tabpanel"]'));
});
