import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/**
 * Server-side session pins, in omp-web's data directory next to the
 * notification store: every browser talking to this omp-web sees the same
 * pinned sessions.
 *
 * The whole state is one small set of session ids, so it lives in a JSON file
 * written atomically (temp file + rename), like the project registry and the
 * web settings. A mutation re-reads the file instead of trusting a cache, so
 * two tabs (or two omp-web processes on the same agent dir) pinning different
 * sessions only race inside that short read/write window; SQLite's transaction
 * machinery would buy nothing here.
 *
 * Reads never cache either: /api/sessions merges the pins into every session
 * list it serves, and that list must show a pin another process just wrote.
 */

/** Keeps the file bounded; pinning past it drops the oldest pin. */
const MAX_PINNED_SESSIONS = 200;

function storePath(): string {
  return join(getAgentDir(), "omp-web", "pinned-sessions.json");
}

/** Pinned ids in pin order, oldest first. A missing or corrupt file means nothing is pinned. */
export function readPinnedSessionIds(): Set<string> {
  try {
    const raw: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw.pinned)) return new Set();
    return new Set(raw.pinned.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

function writePinnedSessionIds(ids: Iterable<string>): void {
  const path = storePath();
  const pinned = [...ids].slice(-MAX_PINNED_SESSIONS);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // Owner-only like its siblings in omp-web's data directory: the ids name
    // the user's sessions. The mode applies because the temp file is new.
    writeFileSync(temp, `${JSON.stringify({ version: 1, pinned }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

/** Pin or unpin one session. Returns whether the stored state changed. */
export function setSessionPinned(sessionId: string, pinned: boolean): boolean {
  const stored = readPinnedSessionIds();
  if (stored.has(sessionId) === pinned) return false;
  if (pinned) stored.add(sessionId);
  else stored.delete(sessionId);
  writePinnedSessionIds(stored);
  return true;
}

/**
 * The pins whose session still exists, dropping the rest from the store — a
 * deleted or archived session must not keep a pin alive forever.
 *
 * An empty `existingIds` is treated as "the list is not usable" rather than
 * "every session is gone": a transient empty scan would otherwise wipe every
 * pin the user has.
 */
export function listPinnedSessionIds(existingIds: ReadonlySet<string>): Set<string> {
  const stored = readPinnedSessionIds();
  if (stored.size === 0 || existingIds.size === 0) return stored;
  const live = new Set([...stored].filter((id) => existingIds.has(id)));
  if (live.size !== stored.size) writePinnedSessionIds(live);
  return live;
}
