import assert from "node:assert/strict";
import test from "node:test";

const { resolveForkTargets } = await import("./chat-fork.ts");

const keep = (entryId) => ({ entryId });
const edit = (entryId, prefill) => ({ entryId, prefill });
const rows = (...roles) => roles.map((role, index) => (
  role === "summary"
    ? { role: "user", branchSummary: true }
    : { role, content: `${role}-${index}` }
));

test("a reply forks at itself; a prompt forks at the entry before it and comes back in the composer", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "toolResult", "assistant", "user", "assistant"), ["u1", "a1", "t1", "a2", "u2", "a3"]),
    [undefined, keep("a1"), undefined, keep("a2"), edit("a2", "user-4"), keep("a3")],
  );
});

test("the first prompt has nothing to cut at, and neither has one whose only predecessor is bookkeeping", () => {
  assert.deepEqual(resolveForkTargets(rows("user", "assistant"), ["u1", "a1"]), [undefined, keep("a1")]);
  // A compaction summary renders as a "custom" row (lib/session-reader.ts) and
  // is not a `message` entry, so omp cannot cut there.
  assert.deepEqual(
    resolveForkTargets(rows("custom", "user", "assistant"), ["c0", "u1", "a1"]),
    [undefined, undefined, keep("a1")],
  );
});

test("branch summaries are neither fork points nor cut points for the prompt after them", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant", "summary", "user", "assistant"), ["u0", "a0", "u1", "a1", "s1", "u2", "a2"]),
    [undefined, keep("a0"), edit("a0", "user-2"), keep("a1"), undefined, edit("a1", "user-5"), keep("a2")],
  );
});

test("tool results and shell rows carry no fork action of their own", () => {
  assert.deepEqual(
    resolveForkTargets(rows("assistant", "toolResult", "bashExecution"), ["a0", "t0", "b0"]),
    [keep("a0"), undefined, undefined],
  );
});

test("a reply with no entry id yet is not forkable; a prompt still cuts at the entry before it", () => {
  assert.deepEqual(
    resolveForkTargets(rows("user", "assistant", "user", "assistant"), ["u0", "a0", undefined, undefined]),
    [undefined, keep("a0"), edit("a0", "user-2"), undefined],
  );
});

test("image-only prompts fork with no composer text", () => {
  const prompt = { role: "user", content: [{ type: "image", data: "…" }] };
  const withText = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "…" }] };
  assert.deepEqual(
    resolveForkTargets([{ role: "assistant", content: "" }, prompt, withText], ["a0", "u1", "u2"]),
    [keep("a0"), { entryId: "a0", prefill: undefined }, { entryId: "u1", prefill: "look" }],
  );
});
