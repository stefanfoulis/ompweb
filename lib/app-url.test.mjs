import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./app-url.ts");
}

test("omits both panel params and the session when everything is at its default", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ left: false, right: false }), "/");
});

test("writes left=0 when the sidebar is collapsed", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ left: true, right: false }), "?left=0");
});

test("writes right=1 when the right panel is open", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ left: false, right: true }), "?right=1");
});

test("writes both panel params together", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ left: true, right: true }), "?left=0&right=1");
});

test("preserves the session id alongside panel params", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(
    buildAppUrl({ sessionId: "abc-123", left: true, right: true }),
    "?session=abc-123&left=0&right=1",
  );
});

test("keeps a plain ?session= href when both panels are at their default", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ sessionId: "abc-123", left: false, right: false }), "?session=abc-123");
});

test("prefers cwd over sessionId, matching getInitialNavigation's read side", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(
    buildAppUrl({ sessionId: "abc-123", cwd: "/work/project", left: true, right: false }),
    "?cwd=%2Fwork%2Fproject&left=0",
  );
});

test("omits session/cwd entirely when neither is given, keeping only panel params", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl({ left: true, right: false }), "?left=0");
});
