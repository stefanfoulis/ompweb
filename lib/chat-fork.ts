/**
 * Fork targets for the message transcript.
 *
 * A fork starts a *separate* omp process on a copy of the session
 * (`omp --fork <file> --fork-at <entryId>`), so it works whether or not the
 * session is busy. The cut is inclusive: the new session holds the path from
 * the root to `entryId`, including that entry (omp extends the cut through the
 * recorded tool results of an assistant message's tool-call batch).
 *
 * That gives each row one meaning:
 * - an assistant reply forks at itself, so the fork keeps that reply;
 * - a user prompt forks at the entry *before* it, so the fork holds the history
 *   up to but excluding the prompt, whose text goes back into the composer
 *   (edit-and-resend, like omp's TUI `/branch`).
 *
 * Only `message` entries are valid cut points: omp rejects compaction, branch
 * summary and other bookkeeping entries with a `SessionResolutionError`. The
 * transcript renders some of those as rows, so the search for a prompt's
 * preceding entry skips every row that is not known to be a message entry —
 * the first prompt of a session (or the first one after a compaction, whose
 * only predecessor is the compaction summary) therefore has no fork target.
 */

/** Roles whose rows are always a `message` entry omp can cut at. The ambiguous
 * `custom` role covers both message entries (developer notes, python runs, file
 * mentions) and bookkeeping entries (compaction, custom_message), so it is not
 * listed: a cut there would fail for the bookkeeping half. */
const MESSAGE_ENTRY_ROLES: Record<string, true> = {
  user: true,
  assistant: true,
  toolResult: true,
  bashExecution: true,
};

interface ForkRow {
  role: string;
  /** Rendered as a user row, but backed by a `branch_summary` entry. */
  branchSummary?: boolean;
  content?: unknown;
}

export interface ForkTarget {
  /** Last entry the forked session keeps (inclusive). */
  entryId: string;
  /** Prompt text to put back into the fork's composer, for prompt rows. */
  prefill?: string;
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object"
    && "type" in block && block.type === "text"
    && "text" in block && typeof block.text === "string";
}

/** The text of a user prompt, as the composer would hold it (images are not
 * carried: the fork's prefill has always been text-only). */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isTextBlock).map((block) => block.text).join("\n");
}

export function resolveForkTargets(
  messages: readonly ForkRow[],
  entryIds: readonly (string | undefined)[],
): (ForkTarget | undefined)[] {
  const cuttable = (index: number): boolean =>
    !!entryIds[index] && !messages[index].branchSummary && MESSAGE_ENTRY_ROLES[messages[index].role] === true;

  return messages.map((message, index) => {
    if (message.branchSummary) return undefined;
    if (message.role === "assistant") {
      // A row with no entry id is not committed to the session file yet.
      const entryId = entryIds[index];
      return entryId ? { entryId } : undefined;
    }
    if (message.role !== "user") return undefined;
    for (let before = index - 1; before >= 0; before--) {
      if (!cuttable(before)) continue;
      return { entryId: entryIds[before]!, prefill: promptText(message.content) || undefined };
    }
    return undefined;
  });
}
