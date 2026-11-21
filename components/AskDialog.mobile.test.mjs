import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");

// Everything renders through ExtensionDialog: an `ask` request is routed to
// the tabbed AskDialog, and these are the phone fixes for that panel (#234,
// #235, #236) — routing included, because the routing is what decides whose
// DOM the user sees.
const { ExtensionDialog } = await import("./ExtensionDialog.tsx");
const { MOBILE_QUERY } = await import("@/hooks/useIsMobile");

const OPTIONS = [
  { label: "Red", description: "A warm, very long description that has to wrap instead of widening the row" },
  { label: "Green", preview: "green:\n  hue: 120\n  token: veryLongPreviewTokenWithoutAnyBreakOpportunity" },
];

function askRequest(questions = [{ id: "color", header: "Color", question: "Pick a color", options: OPTIONS, recommended: 1 }]) {
  return { type: "extension_ui_request", id: "ask-1", method: "ask", questions };
}

/** Renders the composer-attached panel — the mobile path these fixes cover. */
function renderAttached(request = askRequest(), attached = true) {
  const responses = [];
  const view = render(React.createElement(ExtensionDialog, {
    request,
    onRespond: (_request, response) => responses.push(response),
    attached,
  }));
  return { responses, view };
}

function staticMarkup(request = askRequest(), props = {}) {
  return renderToStaticMarkup(React.createElement(ExtensionDialog, {
    request,
    onRespond: () => {},
    attached: true,
    ...props,
  }));
}

/** Stubs the media queries the panel reads, the way the ChatInput tests do. */
function stubMedia({ coarse = false, fine = false, narrow = false } = {}) {
  const original = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === "(pointer: coarse)"
      ? coarse
      : query === "(pointer: fine)"
        ? fine
        : query === MOBILE_QUERY
          ? narrow
          : false,
    addEventListener() {},
    removeEventListener() {},
  });
  return () => {
    if (original) window.matchMedia = original;
    else delete window.matchMedia;
  };
}

/** Stubs the visual viewport: a `height` below the window height means the
 * on-screen keyboard covers part of the visible area. `undefined` removes the
 * API entirely, which is what SSR and jsdom see. */
function stubVisualViewport(height) {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  if (height !== undefined) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height,
        addEventListener() {},
        removeEventListener() {},
      },
    });
  } else {
    delete window.visualViewport;
  }
  return () => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete window.visualViewport;
  };
}

const otherField = () => screen.getByRole("textbox", { name: "Other (type your own)" });

let restoreMedia = () => {};
let restoreViewport = () => {};

beforeEach(() => {
  // jsdom has no matchMedia and no visualViewport: the default is the
  // desktop-without-a-keyboard case (except `fine`, which jsdom also cannot
  // answer, so tests that care about it stub it explicitly).
  restoreMedia = stubMedia({ fine: true });
  restoreViewport = stubVisualViewport(undefined);
});

afterEach(() => {
  cleanup();
  restoreMedia();
  restoreViewport();
});

test("an ask request is answered by the tabbed dialog, not the inline panel", () => {
  renderAttached();
  assert.ok(screen.getByRole("tab", { name: "Review" }), "the tabbed dialog owns `ask`");
});

// ---- #234: horizontal overflow ------------------------------------------------

test("the ask grids pin their column so a wide question cannot stretch the panel", () => {
  const html = staticMarkup();
  // An implicit `grid-template-columns: none` sizes its track by max-content,
  // so one long unwrapped question makes the panel wider than the composer
  // column and the phone clips the option rows at the right edge (#234).
  const grids = html.match(/grid-template-columns:minmax\(0, 1fr\)/g) ?? [];
  assert.equal(grids.length, 5, "the tabpanel, the option group and all three rows");
  assert.match(html, /role="tabpanel"[^>]*grid-template-columns:minmax\(0, 1fr\)/);
  assert.match(html, /role="radiogroup"[^>]*grid-template-columns:minmax\(0, 1fr\)/);
});

test("the option row, its text, its description and the preview cannot push past the panel edge", () => {
  const html = staticMarkup();
  // Each row is a grid of flex lines: they need a zero minimum and wrapping
  // text of their own, otherwise a long label keeps the track at min-content.
  assert.match(html, /<label style="display:flex[^"]*min-width:0[^"]*"/);
  assert.match(html, /<span style="flex:1;min-width:0;overflow-wrap:anywhere">Red/);
  assert.match(html, /min-width:0;color:var\(--text-muted\)[^"]*overflow-wrap:anywhere">A warm/);
  // The highlighted option's markdown preview wraps inside the panel instead
  // of letting a long token widen the row.
  assert.match(html, /<div style="min-width:0;overflow-x:hidden;border:1px solid var\(--border\)/);
});

test("the panel, its scroller and the Other field can shrink inside the column", () => {
  const html = staticMarkup();
  assert.match(html, /role="dialog"[^>]*style="[^"]*box-sizing:border-box;min-width:0/);
  assert.match(html, /class="ask-dialog-content" style="min-width:0;min-height:0;flex:1 1 auto;overflow-y:auto;overflow-x:hidden/);
  assert.match(html, /<input type="text"[^>]*style="flex:1;min-width:0;box-sizing:border-box/);
  assert.doesNotMatch(html, /white-space:pre;/);
});

// ---- #235: composer-attached focus --------------------------------------------

/** The panel focuses itself one frame after paint; `act` flushes whatever
 * that focus moves inside React before the test reads the DOM. */
const settleFocusFrame = () => act(async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
});

test("a composer-attached ask request on a touch device leaves focus alone", async () => {
  const restore = stubMedia({ coarse: true });
  try {
    renderAttached();
    await settleFocusFrame();
    assert.notEqual(document.activeElement, screen.getByRole("dialog"), "the unread question is not pulled into view");
    assert.notEqual(document.activeElement, otherField());
  } finally {
    restore();
  }
});

test("a desktop pointer still gets the panel focused for keyboard navigation", async () => {
  renderAttached();
  await settleFocusFrame();
  assert.equal(document.activeElement, screen.getByRole("dialog"));
});

// ---- #236: the submit affordance ----------------------------------------------

test("an open keyboard caps the panel to the visible area", () => {
  const viewportHeight = Math.round(window.innerHeight * 0.5);
  const restore = stubVisualViewport(viewportHeight);
  try {
    renderAttached();
    const panel = screen.getByRole("dialog");
    assert.equal(panel.style.maxHeight, "min(480px, 65dvh)", "no keyboard: the CSS cap stands");

    fireEvent.focus(otherField());
    assert.equal(panel.style.maxHeight, `${viewportHeight - 12}px`, "the footer must stay inside the visible area");
  } finally {
    restore();
  }
});

test("Enter in the Other field commits the answer and moves on to Review", () => {
  const { responses } = renderAttached();
  const other = otherField();
  fireEvent.focus(other);
  fireEvent.change(other, { target: { value: "Teal" } });
  fireEvent.keyDown(other, { key: "Enter" });

  // Leaving the field drops the on-screen keyboard, and the last question
  // lands on Review, where the footer's Submit lives: no second send control
  // is needed beside the field.
  assert.ok(document.activeElement !== other, "the keyboard goes away with the field's focus");
  assert.equal(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected"), "true");
  assert.deepEqual(responses, [], "committing an answer never submits the dialog behind the user's back");
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
});

test("Enter on an empty field stays put, and a multi question keeps collecting", () => {
  renderAttached(askRequest([
    { id: "size", question: "Pick a size", options: [{ label: "S" }, { label: "M" }] },
    { id: "extras", question: "Pick extras", multi: true, options: [{ label: "Bag" }] },
  ]));
  const other = otherField();
  fireEvent.focus(other);
  fireEvent.keyDown(other, { key: "Enter" });
  assert.equal(screen.getByRole("tab", { name: /Pick a size/ }).getAttribute("aria-selected"), "true", "an empty field does not advance");

  fireEvent.change(other, { target: { value: "L" } });
  fireEvent.keyDown(other, { key: "Enter" });
  assert.equal(screen.getByRole("tab", { name: /Pick extras/ }).getAttribute("aria-selected"), "true");

  // A multi question keeps collecting answers: committing only leaves the
  // field, which drops the keyboard.
  const multiOther = otherField();
  fireEvent.focus(multiOther);
  fireEvent.change(multiOther, { target: { value: "Strap" } });
  fireEvent.keyDown(multiOther, { key: "Enter" });
  assert.equal(screen.getByRole("tab", { name: /Pick extras/ }).getAttribute("aria-selected"), "true", "a multi question stays put: there is more to pick");
});

test("without a visible-area API the panel keeps its CSS cap", () => {
  const { responses } = renderAttached();
  const panel = screen.getByRole("dialog");
  assert.equal(panel.style.maxHeight, "min(480px, 65dvh)");
  const other = otherField();
  fireEvent.focus(other);
  fireEvent.change(other, { target: { value: "Teal" } });
  assert.equal(panel.style.maxHeight, "min(480px, 65dvh)");

  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] }]);
});

test("on touch, focusing an option or button keeps the panel's height", () => {
  const restoreMedia = stubMedia({ coarse: true });
  const restore = stubVisualViewport(Math.round(window.innerHeight * 0.5));
  try {
    renderAttached();
    const panel = screen.getByRole("dialog");
    // No keyboard comes up for them, and a resize under the finger made the
    // tap that focused them miss.
    for (const control of [screen.getByRole("radio", { name: "Red" }), screen.getByRole("button", { name: "Cancel" })]) {
      fireEvent.focus(control);
      assert.equal(panel.style.maxHeight, "min(480px, 65dvh)");
    }
  } finally {
    restore();
    restoreMedia();
  }
});

// ---- #252 / #255: the keyboard stays up until the choice is made --------------

/** A press as the browser sends it: pointerdown, then the compat mousedown.
 * Returns whether mousedown's default (moving focus) still runs. */
function press(target, pointerType) {
  fireEvent.pointerDown(target, { pointerType });
  return fireEvent.mouseDown(target);
}

test("on touch, while Other is being typed, a press elsewhere in the panel keeps focus there", async () => {
  // A phone: the panel leaves focus alone until tapped (#235).
  const restore = stubMedia({ coarse: true });
  const composer = document.body.appendChild(document.createElement("textarea"));
  try {
    renderAttached();
    await settleFocusFrame();
    const other = otherField();
    const red = screen.getByRole("radio", { name: "Red" });
    const targets = [red, red.closest("label"), screen.getByRole("button", { name: "Cancel" }), screen.getByRole("button", { name: "Chat about this" })];
    // No text box of the panel focused: no keyboard of ours to protect.
    for (const target of targets) assert.equal(press(target, "touch"), true);
    act(() => composer.focus());
    for (const target of targets) assert.equal(press(target, "touch"), true, "a field outside the panel is not ours to keep");

    act(() => other.focus());
    // A focus change on press closes the phone keyboard and resizes the panel
    // before the click, so the click misses the option or button it aimed at.
    for (const pointerType of ["touch", "pen"]) {
      for (const target of targets) assert.equal(press(target, pointerType), false, `${target.textContent} must not take focus (${pointerType})`);
    }
    assert.equal(press(other, "touch"), true, "the text box itself still takes the press");
  } finally {
    composer.remove();
    restore();
  }
});

test("a mouse press in the panel moves focus as usual, even on a touch-first device", () => {
  // The pointer media query describes the primary pointer only; a hybrid
  // device's mouse must keep text selection and the caret.
  const restore = stubMedia({ coarse: true });
  try {
    renderAttached();
    act(() => otherField().focus());
    assert.equal(press(screen.getByText("Red"), "mouse"), true);
  } finally {
    restore();
  }
});

test("choosing an option takes focus from Other, so later typing cannot pick Other again", () => {
  renderAttached();
  const other = otherField();
  const red = screen.getByRole("radio", { name: "Red" });
  act(() => other.focus());
  // A touch press on the option itself keeps focus in Other; the choice must
  // move it, to the panel the arrow-key cursor lives on.
  assert.equal(press(red, "touch"), false);
  fireEvent.click(red);
  // Compare identities: a failing element diff walks the whole jsdom graph.
  assert.ok(document.activeElement === screen.getByRole("dialog"), "the panel has focus");
});

test("responding releases the Other field at once, so the keyboard does not wait for the server", () => {
  const { responses } = renderAttached();
  const other = otherField();
  act(() => other.focus());
  fireEvent.change(other, { target: { value: "Teal" } });
  // The panel stays mounted until omp acknowledges the response (plus a hand-off delay).
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
  assert.ok(document.activeElement !== other, "the Other field must not keep focus");
});

test("the footer carries the touch-target class and honours the accessible preference", () => {
  localStorage.setItem("omp-touch-targets", "accessible");
  try {
    renderAttached();
    const footer = screen.getByRole("button", { name: "Chat about this" }).parentElement;
    assert.equal(footer.className, "extension-dialog-footer");
    for (const name of ["Cancel", "Chat about this"]) {
      assert.equal(screen.getByRole("button", { name }).style.minHeight, "44px");
    }
  } finally {
    localStorage.removeItem("omp-touch-targets");
  }
});
