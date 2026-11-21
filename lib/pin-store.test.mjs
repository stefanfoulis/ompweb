import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { listPinnedSessionIds, readPinnedSessionIds, setSessionPinned } = await import("./pin-store.ts");

/** Point the omp agent dir at a throwaway location for the duration of `run`. */
function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-pin-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    run(join(agentDir, "omp-web", "pinned-sessions.json"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("pins survive a round trip through the store file", () => {
  withAgentDir((storeFile) => {
    assert.deepEqual([...readPinnedSessionIds()], [], "nothing is pinned before the first write");

    assert.equal(setSessionPinned("alpha", true), true);
    assert.equal(setSessionPinned("beta", true), true);
    assert.deepEqual([...readPinnedSessionIds()], ["alpha", "beta"]);

    // Pinning twice is a no-op, and unpinning leaves the other pin alone.
    assert.equal(setSessionPinned("alpha", true), false);
    assert.equal(setSessionPinned("alpha", false), true);
    assert.equal(setSessionPinned("alpha", false), false);
    assert.deepEqual([...readPinnedSessionIds()], ["beta"]);

    assert.deepEqual(JSON.parse(readFileSync(storeFile, "utf8")), { version: 1, pinned: ["beta"] });
    assert.equal(statSync(storeFile).mode & 0o777, 0o600, "the store stays owner-only");
    assert.equal(existsSync(`${storeFile}.tmp`), false);
  });
});

test("a corrupt or foreign store reads as no pins at all", () => {
  withAgentDir((storeFile) => {
    mkdirSync(join(storeFile, ".."), { recursive: true });
    writeFileSync(storeFile, "{not json");
    assert.deepEqual([...readPinnedSessionIds()], []);

    writeFileSync(storeFile, JSON.stringify({ version: 1, pinned: ["kept", 7, null, ""] }));
    assert.deepEqual([...readPinnedSessionIds()], ["kept"], "non-string entries are dropped");
  });
});

test("listing prunes pins whose session is gone, and keeps the rest", () => {
  withAgentDir((storeFile) => {
    setSessionPinned("alive", true);
    setSessionPinned("deleted", true);

    const live = listPinnedSessionIds(new Set(["alive", "other"]));

    assert.deepEqual([...live], ["alive"]);
    assert.deepEqual(JSON.parse(readFileSync(storeFile, "utf8")).pinned, ["alive"], "the prune is persisted");
  });
});

test("an empty session list never wipes the pins", () => {
  withAgentDir(() => {
    setSessionPinned("alive", true);
    // A transient empty scan means "no usable list", not "every session is gone".
    assert.deepEqual([...listPinnedSessionIds(new Set())], ["alive"]);
  });
});
