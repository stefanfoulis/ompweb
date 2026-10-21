import assert from "node:assert/strict";
import test from "node:test";

const {
  familyKey, versionOf, tierRank, groupModelsForPicker, MODEL_FAMILY_OVERRIDES,
} = await import("./model-families.ts");

// Real catalog shapes (oh-my-pi/packages/catalog/src/models.json), trimmed to
// what the picker needs. Anthropic classifies each tier as its own
// `identity.family`; OpenAI tags every "gpt" id with `family: "gpt"`
// regardless of tier, so luna/sol/astra only show up in the id itself.
const haiku55 = { modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", identity: { class: "anthropic", family: "haiku", revision: "5.5.0" }, costOutput: 0.5 };
const haiku45 = { modelId: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", identity: { class: "anthropic", family: "haiku", revision: "4.5.0" }, costOutput: 5 };
const haiku45Snapshot = { modelId: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (20251001)", provider: "anthropic", identity: { class: "anthropic", family: "haiku", revision: "4.5.0" }, costOutput: 5 };
const sonnet55 = { modelId: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", identity: { class: "anthropic", family: "sonnet", revision: "5.5.0" }, costOutput: 10 };
const opus55 = { modelId: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", identity: { class: "anthropic", family: "opus", revision: "5.5.0" }, costOutput: 20 };
const opus5 = { modelId: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", identity: { class: "anthropic", family: "opus", revision: "5.0.0" }, costOutput: 25 };
const opus45 = { modelId: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", identity: { class: "anthropic", family: "opus", revision: "4.5.0" }, costOutput: 25 };
const fable51 = { modelId: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", identity: { class: "anthropic", family: "fable", revision: "5.1.0" }, costOutput: 50 };

const luna = { modelId: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", identity: { class: "openai", family: "gpt", revision: "6.0.0" }, costOutput: 0.5 };
const lunaDecisions = { modelId: "gpt-6-luna-decisions", name: "GPT-6 Luna Decisions", provider: "openai", identity: { class: "openai", family: "gpt", revision: "6.0.0" }, costOutput: 0 };
const sol = { modelId: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", identity: { class: "openai", family: "gpt", revision: "6.0.0" }, costOutput: 10 };
const sol61 = { modelId: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", identity: { class: "openai", family: "gpt", revision: "6.1.0" }, costOutput: 10 };
const astra = { modelId: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", identity: { class: "openai", family: "gpt", revision: "6.0.0" }, costOutput: 50 };

test("familyKey: Anthropic identity.family is precise, matches the id's own word", () => {
  assert.equal(familyKey(opus55), "claude-opus");
  assert.equal(familyKey(haiku45Snapshot), "claude-haiku");
  assert.equal(familyKey(fable51), "claude-fable");
});

test("familyKey: a word the id carries beyond identity.family is a real variant family", () => {
  // Hypothetical long-context variant: no catalog `identity` (falls back to
  // pure id parsing either way), id keeps "1m" after stripping versions.
  assert.equal(familyKey({ modelId: "claude-opus-4-7-1m", name: "Claude Opus 4.7 (1M)", provider: "anthropic" }), "claude-opus-1m");
});

test("familyKey: OpenAI's shared family: \"gpt\" can't tell tiers apart, id words win", () => {
  assert.equal(familyKey(luna), "gpt-luna");
  assert.equal(familyKey(sol61), "gpt-sol");
  assert.equal(familyKey(lunaDecisions), "gpt-luna-decisions");
});

test("familyKey: id-only fallback with no identity at all", () => {
  assert.equal(familyKey({ modelId: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" }), "gpt-luna");
});

test("MODEL_FAMILY_OVERRIDES: the seeded -decisions entry matches its id and only hides it", () => {
  const entry = MODEL_FAMILY_OVERRIDES.find((e) => e.pattern.test("gpt-6-luna-decisions"));
  assert.ok(entry, "expected an override matching gpt-6-luna-decisions");
  assert.deepEqual(entry.override, { hidden: true });
  assert.equal(entry.pattern.test("gpt-6-luna"), false);
});

test("versionOf: prefers identity.revision, parsed as major/minor/patch numbers", () => {
  assert.deepEqual(versionOf(opus55).parts, [5, 5, 0]);
  assert.deepEqual(versionOf(sol61).parts, [6, 1, 0]);
});

test("versionOf: falls back to numbers parsed from the id without identity", () => {
  const v = versionOf({ modelId: "claude-opus-4-7-1m", name: "x", provider: "anthropic" });
  // digit runs in id order; "1m"'s leading "1" counts too, same as "4" and "7".
  assert.deepEqual(v.parts, [4, 7, 1]);
  assert.equal(v.snapshot, false);
});

test("versionOf: an 8-digit date in the id marks a snapshot at the same version as its alias", () => {
  const alias = versionOf(haiku45);
  const snapshot = versionOf(haiku45Snapshot);
  assert.deepEqual(alias.parts, snapshot.parts);
  assert.equal(alias.snapshot, false);
  assert.equal(snapshot.snapshot, true);
});

test("tierRank: ascending by output price — haiku < sonnet < opus < fable", () => {
  const ranks = [haiku55, sonnet55, opus55, fable51].map(tierRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(ranks[0] < ranks[1] && ranks[1] < ranks[2] && ranks[2] < ranks[3]);
});

test("tierRank: ascending by output price — luna < sol < astra", () => {
  const ranks = [luna, sol, astra].map(tierRank);
  assert.ok(ranks[0] < ranks[1] && ranks[1] < ranks[2]);
});

test("tierRank: a zero or missing output price ranks after every priced family", () => {
  assert.equal(tierRank(lunaDecisions), Number.POSITIVE_INFINITY);
  assert.equal(tierRank({ modelId: "mystery", name: "Mystery", provider: "x" }), Number.POSITIVE_INFINITY);
  assert.ok(tierRank(astra) < tierRank(lunaDecisions));
});

test("groupModelsForPicker: Anthropic — latest is one per family ordered by tier", () => {
  const models = [opus55, opus5, opus45, sonnet55, haiku55, haiku45, haiku45Snapshot, fable51];
  const { latest } = groupModelsForPicker(models);
  assert.deepEqual(latest.map((m) => m.modelId), ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);
});

test("groupModelsForPicker: Anthropic — all keeps every version, newest first, snapshot after its alias, families ordered by tier", () => {
  const models = [opus55, opus5, opus45, haiku45, haiku45Snapshot];
  const { all } = groupModelsForPicker(models);
  // haiku's cheapest-tier price (5) ranks its family before opus's (20).
  assert.deepEqual(all.map((m) => m.modelId), [
    "claude-haiku-4-5", "claude-haiku-4-5-20251001",
    "claude-opus-5-5", "claude-opus-5", "claude-opus-4-5",
  ]);
});

test("groupModelsForPicker: latest entries also appear in all", () => {
  const models = [opus55, opus5, sonnet55];
  const { latest, all } = groupModelsForPicker(models);
  for (const m of latest) assert.ok(all.includes(m));
});

test("groupModelsForPicker: OpenAI — luna/sol/astra tiers; gpt-6.1-sol is a newer version of gpt-6-sol, not a new family", () => {
  const models = [luna, sol, sol61, astra, lunaDecisions];
  const { latest, all } = groupModelsForPicker(models);
  // The family's `latest` representative is whichever version is newest —
  // gpt-6.1-sol (6.1.0) outranks gpt-6-sol (6.0.0).
  assert.deepEqual(latest.map((m) => m.modelId), ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]);
  const solVersions = all.filter((m) => familyKey(m) === "gpt-sol").map((m) => m.modelId);
  assert.deepEqual(solVersions, ["gpt-6.1-sol", "gpt-6-sol"]);
});

test("groupModelsForPicker: the -decisions override hides it from latest but keeps it in all", () => {
  const models = [luna, sol, astra, lunaDecisions];
  const { latest, all } = groupModelsForPicker(models);
  assert.ok(!latest.some((m) => m.modelId === "gpt-6-luna-decisions"));
  assert.ok(all.some((m) => m.modelId === "gpt-6-luna-decisions"));
  // zero-price family sorts after every priced one
  assert.equal(all[all.length - 1].modelId, "gpt-6-luna-decisions");
});
