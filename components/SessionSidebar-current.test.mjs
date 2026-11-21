import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
const { cleanup, render } = await import("@testing-library/react/pure.js");

// The sidebar's Current view: one flat list of the sessions that matter right
// now — pinned, running, unread, or recently completed (the same set
// upstream's "Show running sessions only" filter keeps in All) — each
// naming its workspace.

const { CurrentSessionList, selectCurrentSessions } = await import("@/components/SessionSidebar-current");
const { SessionSidebar } = await import("./SessionSidebar.tsx");

afterEach(() => cleanup());

const session = (id, overrides = {}) => ({
  path: `/sessions/${id}.jsonl`,
  id,
  cwd: "/work/alpha",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: id,
  projectRoot: "/work/alpha",
  ...overrides,
});

function rows(container) {
  return Array.from(container.querySelectorAll(".session-item-row"));
}

test("current means pinned, running, unread or recently completed — nothing else", () => {
  const sessions = [
    session("plain"),
    session("pinned", { pinned: true }),
    session("running"),
    session("unread"),
  ];
  const current = selectCurrentSessions(sessions, new Set(["running"]), new Set(["unread"]), new Set());
  assert.deepEqual(current.map((s) => s.id).sort(), ["pinned", "running", "unread"]);
});

test("a recently-completed session not otherwise current appears; one outside the caller's limit does not", () => {
  const sessions = [
    session("plain"),
    session("completed-in-limit"),
    session("completed-outside-limit"),
  ];
  // SessionSidebar already trims its recently-completed set to the configured
  // limit before passing it down — selectCurrentSessions trusts it as-is, so
  // a session left out of the set (outside the limit) simply does not appear.
  const current = selectCurrentSessions(sessions, new Set(), new Set(), new Set(["completed-in-limit"]));
  assert.deepEqual(current.map((s) => s.id), ["completed-in-limit"]);
});

test("pinned lists only pinned sessions — running, unread and recently-completed ones stay out unless pinned", () => {
  const sessions = [
    session("plain"),
    session("pinned", { pinned: true }),
    session("running"),
    session("unread"),
    session("pinned-running", { pinned: true }),
    session("recently-completed"),
  ];
  const pinned = selectCurrentSessions(
    sessions,
    new Set(["running", "pinned-running"]),
    new Set(["unread"]),
    new Set(["recently-completed"]),
    { pinnedOnly: true },
  );
  assert.deepEqual(pinned.map((s) => s.id), ["pinned-running", "pinned"]);
});

test("running sessions lead, then most recent activity first", () => {
  const sessions = [
    session("old-pin", { pinned: true, modified: "2026-01-01T09:00:00.000Z" }),
    session("new-pin", { pinned: true, modified: "2026-01-03T09:00:00.000Z" }),
    session("unread", { modified: "2026-01-02T09:00:00.000Z" }),
    // A running session's file only gets its final timestamp when omp flushes
    // the turn, so it must not be sorted behind the pins it is older than.
    session("running", { modified: "2026-01-01T08:00:00.000Z" }),
  ];
  const current = selectCurrentSessions(sessions, new Set(["running"]), new Set(["unread"]), new Set());
  assert.deepEqual(current.map((s) => s.id), ["running", "new-pin", "unread", "old-pin"]);
});

test("the list is flat — forks sit beside their parents, each row naming its workspace", () => {
  const sessions = [
    session("parent", { pinned: true, name: "Parent session" }),
    session("fork", { pinned: true, name: "Fork session", parentSessionId: "parent", cwd: "/work/beta", projectRoot: "/work/beta" }),
  ];
  const view = render(React.createElement(CurrentSessionList, {
    sessions,
    selectedSessionId: null,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-01-01T00:00:00.000Z"),
    onSelectSession: () => {},
  }));

  const listed = rows(view.container);
  assert.equal(listed.length, 2, "the fork is a row of its own, not a child of its parent");
  // depth 0 for every row: the tree view indents children by 14px per level.
  assert.deepEqual(listed.map((row) => row.style.paddingLeft), ["30px", "30px"]);
  assert.equal(view.container.querySelectorAll('[aria-label="Pinned session"]').length, 2, "pinned rows show the star");

  const labels = listed.map((row) => Array.from(row.querySelectorAll("span")).map((span) => span.textContent));
  assert.ok(labels[0].includes("alpha"), "the parent names its workspace");
  assert.ok(labels[1].includes("beta"), "the fork names its own workspace");
});

test("an awaiting-input session shows the question icon, through the same set the workspace tree uses", () => {
  const view = render(React.createElement(CurrentSessionList, {
    sessions: [session("waiting")],
    selectedSessionId: null,
    runningSessionIds: new Set(["waiting"]),
    awaitingInputIds: new Set(["waiting"]),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-01-01T00:00:00.000Z"),
    onSelectSession: () => {},
  }));
  assert.equal(view.container.querySelectorAll('[aria-label="Waiting for your input"]').length, 1);
});

test("a registry alias replaces the folder name, and the empty state explains pinning", () => {
  const view = render(React.createElement(CurrentSessionList, {
    sessions: [session("one", { pinned: true })],
    selectedSessionId: null,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-01-01T00:00:00.000Z"),
    workspaceLabelFor: () => "Alpha Project",
    onSelectSession: () => {},
  }));
  assert.match(view.container.textContent, /Alpha Project/);
  cleanup();

  const empty = render(React.createElement(CurrentSessionList, {
    sessions: [],
    selectedSessionId: null,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: 0,
    onSelectSession: () => {},
  }));
  assert.equal(rows(empty.container).length, 0);
  assert.match(empty.container.textContent, /Pinned sessions.*Pin one from its/s);
  cleanup();

  // With a filter on, an empty result is a search result, not a missing pin.
  const filtered = render(React.createElement(CurrentSessionList, {
    sessions: [],
    selectedSessionId: null,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: 0,
    filtersActive: true,
    onSelectSession: () => {},
  }));
  assert.equal(filtered.container.textContent, "No matching sessions");
});

test("the pinned view's empty state explains pinning, not activity", () => {
  const empty = render(React.createElement(CurrentSessionList, {
    sessions: [],
    selectedSessionId: null,
    runningSessionIds: new Set(),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    exitedSessions: new Map(),
    relativeTimeNow: 0,
    pinnedOnly: true,
    onSelectSession: () => {},
  }));
  assert.match(empty.container.textContent, /Sessions you pin show up here/);
  assert.doesNotMatch(empty.container.textContent, /running/);
});

test("a recently-completed row shows the status marker, unless it is also running", () => {
  const view = render(React.createElement(CurrentSessionList, {
    sessions: [session("done"), session("running", { modified: "2026-01-01T01:00:00.000Z" })],
    selectedSessionId: null,
    runningSessionIds: new Set(["running"]),
    awaitingInputIds: new Set(),
    unreadSessionIds: new Set(),
    recentlyCompletedIds: new Set(["done", "running"]),
    exitedSessions: new Map(),
    relativeTimeNow: Date.parse("2026-01-01T00:00:00.000Z"),
    onSelectSession: () => {},
  }));
  assert.equal(
    view.container.querySelectorAll('[aria-label="Recently completed"]').length,
    1,
    "only the non-running session shows the marker, even though both are in the set",
  );
});

// The header's "Show running sessions only" button is redundant in Current:
// its own inclusion rule already covers running and recently-completed
// sessions. It keeps its upstream meaning (and stays visible) in Pinned and All.
class FakeWorker {
  posted = [];
  constructor() {}
  postMessage(message) { this.posted.push(message); }
}

async function renderSidebarInView(view) {
  window.localStorage.setItem("omp-web:sidebar-view", view);
  let rendered;
  await act(async () => {
    rendered = render(React.createElement(SessionSidebar, {
      selectedSessionId: null,
      onSelectSession: () => {},
      addProjectOpen: false,
      setAddProjectOpen: () => {},
      usageVisible: false,
    }));
  });
  return rendered;
}

test("the running-filter button is hidden in Current, and kept in Pinned and All", async () => {
  const original = { fetch: globalThis.fetch, Worker: globalThis.Worker, SharedWorker: globalThis.SharedWorker, matchMedia: window.matchMedia };
  globalThis.Worker = FakeWorker;
  globalThis.SharedWorker = undefined;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/sessions") return Response.json({ sessions: [], runningSessionIds: [] });
    if (url.pathname === "/api/projects") return Response.json({ projects: [] });
    return Response.json({});
  };
  try {
    const current = await renderSidebarInView("current");
    assert.equal(
      current.container.querySelector('[aria-label="Show running sessions only"]'),
      null,
      "Current hides the redundant filter button",
    );
    cleanup();

    const pinned = await renderSidebarInView("pinned");
    assert.ok(
      pinned.container.querySelector('[aria-label="Show running sessions only"]'),
      "Pinned keeps the filter button",
    );
    cleanup();

    const all = await renderSidebarInView("all");
    assert.ok(
      all.container.querySelector('[aria-label="Show running sessions only"]'),
      "All keeps the filter button",
    );
  } finally {
    cleanup();
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    globalThis.SharedWorker = original.SharedWorker;
    window.matchMedia = original.matchMedia;
  }
});
