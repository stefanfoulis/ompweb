import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { cleanup, renderHook } = await import("@testing-library/react/pure.js");

const { useDocumentTitle } = await import("./AppShell-document-title.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Counts title writes; past `cap` writes are dropped so a write loop stops instead of hanging the test. */
function countTitleWrites(cap = 50) {
  const native = Object.getOwnPropertyDescriptor(window.Document.prototype, "title");
  const counter = { writes: 0 };
  Object.defineProperty(document, "title", {
    configurable: true,
    get() { return native.get.call(this); },
    set(value) {
      counter.writes += 1;
      if (counter.writes <= cap) native.set.call(this, value);
    },
  });
  counter.restore = () => { delete document.title; };
  return counter;
}

test("a multi-line title settles on the browser-normalized text without rewrite loops", async () => {
  const counter = countTitleWrites();
  try {
    const { unmount } = renderHook(() => useDocumentTitle("  exploring a window manager\n\nLooking\tfor   layouts "));
    await flush();
    assert.equal(document.title, "exploring a window manager Looking for layouts");

    // Unrelated <head> changes (e.g. a style tag from a diagram renderer) must not rewrite the title.
    const writesAfterMount = counter.writes;
    document.head.appendChild(document.createElement("meta"));
    await flush();
    assert.equal(counter.writes, writesAfterMount);
    assert.ok(writesAfterMount <= 1, `expected at most one title write, saw ${writesAfterMount}`);
    unmount();
  } finally {
    counter.restore();
    cleanup();
  }
});

test("the title is restored after something else in <head> replaces it", async () => {
  const { unmount } = renderHook(() => useDocumentTitle("Session title"));
  try {
    await flush();
    document.title = "Something else";
    await flush();
    assert.equal(document.title, "Session title");
  } finally {
    unmount();
    cleanup();
  }
});
