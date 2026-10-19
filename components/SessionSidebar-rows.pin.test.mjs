import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
const { act, cleanup, render } = await import("@testing-library/react/pure.js");

// A session row's ⋯ menu pins and unpins through the server-side pin store;
// the star flips at once and the refreshed list confirms it.

const { SessionItem } = await import("@/components/SessionSidebar-rows");

let calls = [];
before(() => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
});
afterEach(() => {
  cleanup();
  calls = [];
});

const session = (overrides = {}) => ({
  path: "/sessions/s1.jsonl",
  id: "s1",
  cwd: "/work/alpha",
  name: "A session",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hello",
  projectRoot: "/work/alpha",
  ...overrides,
});

function mount({ session: overrides, ...props } = {}) {
  const view = render(React.createElement(SessionItem, {
    session: session(overrides),
    isSelected: false,
    relativeTimeNow: Date.parse("2026-01-01T00:00:00.000Z"),
    onClick: () => {},
    ...props,
  }));
  act(() => { view.container.querySelector(".session-item-menu-button").click(); });
  // The menu renders through a portal, outside the row's container.
  const items = Array.from(document.body.querySelectorAll('[role="menuitem"]'));
  return { view, items, item: (label) => items.find((element) => element.textContent === label) };
}

const star = () => document.body.querySelector('[aria-label="Pinned session"]');

test("the menu offers Pin session for an unpinned session and posts the pin", async () => {
  let refreshed = 0;
  const { item } = mount({ onRenamed: () => { refreshed += 1; } });
  assert.ok(item("Pin session"), "an unpinned row offers Pin session");
  assert.equal(item("Unpin session"), undefined);
  assert.equal(star(), null);

  await act(async () => { item("Pin session").click(); });

  assert.deepEqual(calls, [{ url: "/api/sessions/s1/pin", method: "POST", body: { pinned: true } }]);
  assert.ok(star(), "the row shows the star without waiting for the next list");
  assert.equal(refreshed, 1, "the list is reloaded so every view picks the pin up");
});

test("the menu offers Unpin session for a pinned session and posts the unpin", async () => {
  const { item } = mount({ session: { pinned: true } });
  assert.ok(star(), "a pinned row shows the star");
  assert.ok(item("Unpin session"), "a pinned row offers Unpin session");
  assert.equal(item("Pin session"), undefined);

  await act(async () => { item("Unpin session").click(); });

  assert.deepEqual(calls, [{ url: "/api/sessions/s1/pin", method: "POST", body: { pinned: false } }]);
  assert.equal(star(), null);
});

test("a rejected pin leaves the row as the server has it", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  const { item } = mount();
  await act(async () => { item("Pin session").click(); });
  assert.equal(star(), null, "the optimistic star is rolled back");
});
