// Groups a provider's flat model list into "latest version per family" plus
// "every version", both ordered by capability tier (cheapest first) so the
// model picker can show the few models someone actually wants up top.
//
// omp's catalog classifies every model's `identity.family`, but the
// precision of that label varies by vendor. Anthropic names each tier
// (opus/sonnet/haiku/fable/mythos) as its own `identity.family`, so it maps
// 1:1 onto what a human would call a "family". OpenAI instead tags every
// "gpt" id — from `gpt-4o` to `gpt-6-astra` — with the same `family: "gpt"`;
// the tier name (luna/sol/astra/...) only shows up in the id itself.
// `familyKey` below trusts `identity.family` when the id agrees with it, and
// falls back to the id's own words whenever the id carries something
// `identity.family` doesn't.

/** The subset of omp's `ModelIdentity` the family/version rules read. */
export interface PickerModelIdentity {
  /** Vendor lineage id, `"unknown"` when the catalog couldn't classify it. */
  class: string;
  /** Product family within the class, when classified. */
  family?: string;
  /** Canonical `major.minor.patch`, when extracted. */
  revision?: string;
}

/** The subset of a model the family/version/tier rules read. */
export interface PickerModel {
  modelId: string;
  name: string;
  provider: string;
  identity?: PickerModelIdentity;
  /** `cost.output` (USD per Mtok) from the catalog; absent for unpriced/unknown models. */
  costOutput?: number;
}

const NUMERIC_TOKEN_RE = /^\d+(?:\.\d+)*$/;

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[-_]/).filter(Boolean);
}

export interface ModelFamilyOverride {
  /** Replace the computed family key outright. */
  family?: string;
  /** Replace the computed tier rank outright (ascending = lower tier). */
  rank?: number;
  /**
   * Exclude this model from ever being chosen as its family's `latest`
   * representative. It still appears in `all`, in its normal sorted spot —
   * this only keeps it out of the curated top-of-list rollup.
   */
  hidden?: boolean;
}

interface ModelFamilyOverrideEntry {
  /** Matched against the bare model id (not `provider/id`). */
  pattern: RegExp;
  override: ModelFamilyOverride;
}

/**
 * Exceptions the id/identity rules below can't express on their own. Keep
 * this list to real catalog cases only — it is not a place to pre-empt
 * hypothetical future ids.
 */
export const MODEL_FAMILY_OVERRIDES: readonly ModelFamilyOverrideEntry[] = [
  {
    // Zero-cost, decisions-only trim of GPT-6 Luna (same revision as
    // `gpt-6-luna`, no chat pricing — see Facts). `familyKey` already keys
    // it as its own family ("gpt-luna-decisions"), and the default
    // missing/zero-price rule would rank that family after every priced one
    // and still show it as a standalone tile in the curated "Latest" row,
    // next to luna/sol/astra. Hiding it keeps "Latest" to genuine chat
    // tiers; it stays fully reachable, in its sorted position, under "All
    // versions".
    pattern: /^gpt-6-luna-decisions$/,
    override: { hidden: true },
  },
];

function matchOverride(modelId: string): ModelFamilyOverride | undefined {
  for (const entry of MODEL_FAMILY_OVERRIDES) {
    if (entry.pattern.test(modelId)) return entry.override;
  }
  return undefined;
}

/**
 * The model's family key, scoped to its provider's own id vocabulary (two
 * providers happening to use the word "sol" never collide because the
 * picker groups per provider before calling this). Strips version numbers
 * and date stamps; keeps every other word verbatim.
 */
export function familyKey(model: PickerModel): string {
  const overrideFamily = matchOverride(model.modelId)?.family;
  if (overrideFamily) return overrideFamily;

  const idWords = tokenize(model.modelId).filter((t) => !NUMERIC_TOKEN_RE.test(t));
  const idKey = (idWords.length > 0 ? idWords : tokenize(model.modelId)).join("-");

  const identity = model.identity;
  if (!identity?.family || identity.class === "unknown") return idKey;

  const familyWords = tokenize(identity.family).filter((t) => !NUMERIC_TOKEN_RE.test(t));
  const vendorWord = idWords[0];
  // A word in the id that identity.family doesn't know about is the real
  // differentiator (OpenAI's shared "gpt" family can't tell luna from sol);
  // keep the id-derived key whenever that happens.
  const unexplained = idWords.filter((w) => w !== vendorWord && !familyWords.includes(w));
  if (unexplained.length > 0) return idKey;

  // The id has nothing identity doesn't already account for — trust
  // identity's class/family boundary rather than the id's own spelling,
  // which keeps ids that don't literally spell the family out (wire ids
  // from non-Claude/GPT-shaped providers) grouped correctly too.
  if (familyWords.every((w) => idWords.includes(w))) return idKey;
  return [vendorWord, ...familyWords].filter(Boolean).join("-");
}

export interface ModelVersion {
  /** `[major, minor, patch, ...]`, parsed from `identity.revision` or, failing that, from the id's own digit runs. */
  parts: number[];
  /** A dated re-publish of another id at the same version (`claude-haiku-4-5-20251001` vs `claude-haiku-4-5`). */
  snapshot: boolean;
}

const EIGHT_DIGIT_DATE_RE = /\d{8}/;

/**
 * The model's version, for sorting newest-first within a family.
 * `identity.revision` is the catalog's own parsed version and wins when
 * present; otherwise the id's digit runs (split on "-" and ".") stand in,
 * with any 8-digit date run excluded so a snapshot doesn't read as a huge
 * version number.
 */
export function versionOf(model: PickerModel): ModelVersion {
  const revision = model.identity?.revision;
  const parts = revision
    ? revision.split(".").map((p) => Number(p) || 0)
    : (model.modelId.match(/\d+(?:\.\d+)*/g) ?? [])
        .filter((token) => !EIGHT_DIGIT_DATE_RE.test(token))
        .flatMap((token) => token.split(".").map((p) => Number(p) || 0));
  return { parts, snapshot: EIGHT_DIGIT_DATE_RE.test(model.modelId) };
}

/**
 * Sort rank for a family, computed from its latest (highest-version)
 * member's output price: ascending, so cheaper/lower-capability tiers come
 * first. A missing or `0` price (unknown pricing, not "free") ranks after
 * every priced family; `groupModelsForPicker` breaks remaining ties by name.
 */
export function tierRank(familyLatest: PickerModel): number {
  const overrideRank = matchOverride(familyLatest.modelId)?.rank;
  if (overrideRank !== undefined) return overrideRank;
  const price = familyLatest.costOutput;
  return price !== undefined && price > 0 ? price : Number.POSITIVE_INFINITY;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function displayName(model: PickerModel): string {
  return model.name || model.modelId;
}

/** Descending comparison of version-part tuples (`[5, 5]` before `[5, 0]` before `[4, 7]`). */
function compareVersionPartsDesc(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareWithinFamily(a: PickerModel, b: PickerModel): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  return compareVersionPartsDesc(va.parts, vb.parts)
    || (Number(va.snapshot) - Number(vb.snapshot)) // alias (false) before its snapshot (true)
    || nameCollator.compare(displayName(a), displayName(b));
}

export interface GroupedModels<M extends PickerModel = PickerModel> {
  /** One model per family — its highest, non-hidden version — ordered by tier. */
  latest: M[];
  /** Every model, grouped by family (ordered by tier) then version descending; snapshots sort after their dateless alias. */
  all: M[];
}

/**
 * Buckets `models` (already scoped to one provider) by family and orders
 * both the curated `latest` rollup and the full `all` list by capability
 * tier. Members of `latest` also appear in `all` — that's intended, `all`
 * is the complete list, not "the rest".
 */
export function groupModelsForPicker<M extends PickerModel>(models: readonly M[]): GroupedModels<M> {
  const byFamily = new Map<string, M[]>();
  for (const model of models) {
    const key = familyKey(model);
    const bucket = byFamily.get(key);
    if (bucket) bucket.push(model);
    else byFamily.set(key, [model]);
  }

  const families = [...byFamily.values()].map((members) => {
    const sorted = [...members].sort(compareWithinFamily);
    // The rank is always priced off the true latest version, even if it's
    // hidden from the curated rollup — hiding a model only affects which
    // version represents the family up top, not where the family sorts.
    const rankModel = sorted[0];
    const latest = sorted.find((m) => !matchOverride(m.modelId)?.hidden);
    return { rank: tierRank(rankModel), rankModel, latest, members: sorted };
  });

  families.sort((a, b) => a.rank - b.rank || nameCollator.compare(displayName(a.rankModel), displayName(b.rankModel)));

  return {
    latest: families.map((f) => f.latest).filter((m): m is M => m !== undefined),
    all: families.flatMap((f) => f.members),
  };
}
