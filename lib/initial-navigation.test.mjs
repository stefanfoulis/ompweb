import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    sidebarOpen: true,
    rightPanelOpen: false,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", sidebarOpen: true, rightPanelOpen: false },
  );
});

test("restores the requested host when session IDs overlap", async () => {
  const { getInitialNavigation, initialSessionMatches } = await loadSubject();
  const navigation = getInitialNavigation(new URLSearchParams({ session: "shared-id", host: "worker-2" }));
  assert.deepEqual(navigation, { requestedCwd: null, sessionId: "shared-id", hostId: "worker-2", sidebarOpen: true, rightPanelOpen: false });
  assert.equal(initialSessionMatches({ id: "shared-id", hostId: "local" }, navigation), false);
  assert.equal(initialSessionMatches({ id: "shared-id", hostId: "worker-2" }, navigation), true);
});

test("selected session identity and URLs retain the host", async () => {
  const { sameSessionTarget, sessionNavigationUrl } = await loadSubject();
  assert.equal(sameSessionTarget(
    { id: "shared-id", hostId: "local" },
    { id: "shared-id", hostId: "worker-2" },
  ), false);
  assert.equal(sameSessionTarget(
    { id: "shared-id" },
    { id: "shared-id", hostId: "local" },
  ), true);
  assert.equal(sessionNavigationUrl({ id: "shared id", hostId: "worker 2" }), "?session=shared%20id&host=worker%202");
});

test("finds a session by host as well as copied id", async () => {
  const { findSessionTarget } = await loadSubject();
  const sessions = [
    { id: "shared-id", hostId: "local", name: "Local" },
    { id: "shared-id", hostId: "worker-2", name: "Remote" },
  ];
  assert.equal(findSessionTarget(sessions, { id: "shared-id", hostId: "worker-2" })?.name, "Remote");
  assert.equal(findSessionTarget(sessions, { id: "shared-id" })?.name, "Local");
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", sidebarOpen: true, rightPanelOpen: false },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { requestedCwd: "C:\\Projects\\pi-web", sessionId: null, sidebarOpen: true, rightPanelOpen: false },
  );
});

test("reads a collapsed sidebar and an open right panel from the URL", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session", left: "0", right: "1" })),
    { requestedCwd: null, sessionId: "saved-session", sidebarOpen: false, rightPanelOpen: true },
  );
});

test("ignores garbage left/right values and falls back to the defaults", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ left: "nope", right: "yes" })),
    { requestedCwd: null, sessionId: null, sidebarOpen: true, rightPanelOpen: false },
  );
});

test("reads panel params alongside a requested cwd", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "/work/project", left: "0", right: "1" })),
    { requestedCwd: "/work/project", sessionId: null, sidebarOpen: false, rightPanelOpen: true },
  );
});

test("a URL workspace retains its host instead of validating the same path locally", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({ cwd: "C:\\\\Projects\\\\remote", hostId: "remote-windows" }));
  assert.equal(result.hostId, "remote-windows");
  assert.equal(result.requestedCwd, "C:\\\\Projects\\\\remote");
});
