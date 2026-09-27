import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { passthroughProfile } = await jiti.import("./profile-passthrough.ts");

const profileAgentDir = (name) => join(homedir(), ".omp", "profiles", name, "agent");

test("keeps the profile when PI_CODING_AGENT_DIR is that profile's agent dir", () => {
  assert.equal(passthroughProfile({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: profileAgentDir("work") }), "work");
  assert.equal(passthroughProfile({ PI_PROFILE: "work", PI_CODING_AGENT_DIR: `${profileAgentDir("work")}/` }), "work");
});

test("drops the profile when omp-web would read a different agent dir", () => {
  assert.equal(passthroughProfile({ OMP_PROFILE: "work" }), undefined);
  assert.equal(passthroughProfile({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: profileAgentDir("home") }), undefined);
  assert.equal(passthroughProfile({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: join(homedir(), ".omp", "agent") }), undefined);
});

test("OMP_PROFILE takes precedence over PI_PROFILE, and empty selects the default profile", () => {
  assert.equal(
    passthroughProfile({ OMP_PROFILE: "work", PI_PROFILE: "home", PI_CODING_AGENT_DIR: profileAgentDir("home") }),
    undefined,
  );
  assert.equal(passthroughProfile({ OMP_PROFILE: "", PI_PROFILE: "home", PI_CODING_AGENT_DIR: profileAgentDir("home") }), undefined);
});
