import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./app-url.ts");
}

test("returns the bare base unchanged when both panels are at their default", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl("/", { left: false, right: false }), "/");
});

test("writes left=0 when the sidebar is collapsed", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl("/", { left: true, right: false }), "?left=0");
});

test("writes right=1 when the right panel is open", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl("/", { left: false, right: true }), "?right=1");
});

test("writes both panel params together", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(buildAppUrl("/", { left: true, right: true }), "?left=0&right=1");
});

test("appends panel params after a session+host base without dropping either", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(
    buildAppUrl("?session=abc-123&host=worker-2", { left: true, right: true }),
    "?session=abc-123&host=worker-2&left=0&right=1",
  );
});

test("keeps a plain session+host base unchanged when both panels are at their default", async () => {
  const { buildAppUrl } = await loadSubject();
  assert.equal(
    buildAppUrl("?session=abc-123&host=local", { left: false, right: false }),
    "?session=abc-123&host=local",
  );
});
