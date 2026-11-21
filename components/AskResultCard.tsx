"use client";

import { CircleHelp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isRecord } from "@/lib/type-guards";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";
import type { ActivityPiece } from "@/lib/chat-transcript-plan";

/**
 * Read-only recap of an answered `ask` tool call, rendered in the committed
 * transcript outside the collapsed "Process details" group so a user can
 * scroll back and see what they (or a timeout) answered without expanding
 * raw tool JSON. See `collectAskResults` for how cards are gathered from a
 * finished turn.
 *
 * The ask tool's only input is a single HTML form (`{ html }`); its result
 * details are omp's `AskToolDetails` (packages/tui/src/tools/ask.ts):
 * `{ answers: FormAnswer[], notes?: OptionNote[], timedOut? }`, each answer a
 * named field's plain-text question and answer, each note a selected
 * option's free-text remark (separate from the answer data, matched back to
 * its field by `name`). A cancelled ask (aborted by the user) carries no
 * details at all, only `isError`.
 */

/** One named field's question and answer (omp's `FormAnswer`, packages/tui/src/html-form/data.ts). */
export interface AskFormAnswer {
  name: string;
  question: string;
  answer: string;
}

/** A note attached to one selected option (omp's `OptionNote`, packages/tui/src/html-form/data.ts);
 * `imageCount` is shown as a count only — pasted images never render in this recap. */
export interface AskOptionNote {
  name: string;
  option: string;
  text: string;
  imageCount?: number;
}

export type AskResultCardData =
  | { toolCallId: string; state: "answered"; answers: AskFormAnswer[]; notes: AskOptionNote[]; timedOut?: boolean }
  | { toolCallId: string; state: "chatRedirect" }
  | { toolCallId: string; state: "cancelled" };

/** A form answer row; `null` for a malformed entry (missing question/answer). */
function normalizeFormAnswer(row: Record<string, unknown>): AskFormAnswer | null {
  if (typeof row.question !== "string" || typeof row.answer !== "string") return null;
  return {
    name: typeof row.name === "string" ? row.name : "",
    question: row.question,
    answer: row.answer,
  };
}

/** An option-note row; `null` for a malformed entry (missing option/text). `images` (the live,
 * unstripped shape) or `imageCount` (session-reader's bounded history shape) counts pasted images;
 * never rendered, a count only. */
function normalizeOptionNote(row: Record<string, unknown>): AskOptionNote | null {
  if (typeof row.option !== "string" || typeof row.text !== "string") return null;
  const imageCount = typeof row.imageCount === "number"
    ? row.imageCount
    : Array.isArray(row.images) && row.images.length > 0 ? row.images.length : undefined;
  return {
    name: typeof row.name === "string" ? row.name : "",
    option: row.option,
    text: row.text,
    imageCount,
  };
}

/** Builds one card's data from an `ask` tool call and its matching
 * toolResult. Returns `null` for a still-pending ask (no result yet — the
 * live dialog owns that state) or an unrecognized/empty result shape. */
export function buildAskResultCard(block: ToolCallContent, result: ToolResultMessage | undefined): AskResultCardData | null {
  if (!result) return null;
  if (result.isError) return { toolCallId: block.toolCallId, state: "cancelled" };

  const details = result.details;
  if (!isRecord(details)) return null;

  if (details.chatRedirect === true) return { toolCallId: block.toolCallId, state: "chatRedirect" };

  const answerRows = Array.isArray(details.answers) ? details.answers.filter(isRecord) : [];
  const answers = answerRows.map(normalizeFormAnswer).filter((a): a is AskFormAnswer => a !== null);
  if (answers.length === 0) return null;
  const noteRows = Array.isArray(details.notes) ? details.notes.filter(isRecord) : [];
  const notes = noteRows.map(normalizeOptionNote).filter((n): n is AskOptionNote => n !== null);
  return { toolCallId: block.toolCallId, state: "answered", answers, notes, timedOut: details.timedOut === true };
}

function collectAskBlocks(blocks: readonly AssistantContentBlock[] | undefined, out: ToolCallContent[]): void {
  for (const block of blocks ?? []) {
    if (block.type === "toolCall" && (block as ToolCallContent).toolName.toLowerCase() === "ask") {
      out.push(block as ToolCallContent);
    }
  }
}

/**
 * Gathers answered `ask` tool calls, in chronological order, from the
 * activity pieces of one finished turn segment — the rows folded into the
 * collapsed "Process details" group.
 *
 * A piece either carries the subset of blocks that belongs to this segment
 * (a message split across segments) or none at all, meaning the whole
 * message belongs here.
 */
export function collectAskResults(
  messages: AgentMessage[],
  pieces: readonly ActivityPiece[],
  toolResultsMap: Map<string, ToolResultMessage>,
): AskResultCardData[] {
  const blocks: ToolCallContent[] = [];
  for (const piece of pieces) {
    const message = messages[piece.index];
    if (!message || message.role !== "assistant") continue;
    collectAskBlocks(piece.blocks ?? (message as AssistantMessage).content, blocks);
  }

  const cards: AskResultCardData[] = [];
  for (const block of blocks) {
    const card = buildAskResultCard(block, toolResultsMap.get(block.toolCallId));
    if (card) cards.push(card);
  }
  return cards;
}

function AskAnswerRow({ answer, notes }: { answer: AskFormAnswer; notes: AskOptionNote[] }) {
  const { t, tn } = useI18n();
  const ownNotes = notes.filter((note) => note.name === answer.name);
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.4 }}>{answer.question}</div>
      <div style={{ fontSize: 11.5, color: "var(--text)", fontStyle: "italic", overflowWrap: "anywhere" }}>
        {answer.answer
          ? <>&ldquo;{answer.answer}&rdquo;</>
          : <span style={{ color: "var(--text-dim)" }}>{t("chatWindow.askResultNoSelection")}</span>}
      </div>
      {ownNotes.map((note, index) => (
        <div key={index} style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
          <span style={{ fontWeight: 600 }}>{note.option}:</span> {note.text}
          {note.imageCount !== undefined && <span> ({tn("chatWindow.askResultImageCount", note.imageCount)})</span>}
        </div>
      ))}
    </div>
  );
}

/** Compact, read-only recap of one answered `ask` tool call. Renders nothing
 * while the ask is still pending (no matching toolResult). */
export function AskResultCard({ data }: { data: AskResultCardData }) {
  const { t } = useI18n();
  const stateLabel = data.state === "chatRedirect"
    ? t("chatWindow.askResultChatRedirect")
    : data.state === "cancelled"
      ? t("chatWindow.askResultCancelled")
      : t("chatWindow.askResultAnswered");

  return (
    <div className="chat-message" style={{ marginBottom: 6 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderLeft: "3px solid var(--accent)",
          borderRadius: "var(--radius-card)",
          background: "var(--bg-panel)",
          padding: "8px 10px",
          display: "grid",
          gap: 7,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <CircleHelp size={13} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
          <span style={{ fontWeight: 600, color: "var(--text)" }}>{t("chatWindow.askResultHeading")}</span>
          <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>{stateLabel}</span>
        </div>
        {data.state === "answered" && data.timedOut && (
          <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>{t("chatWindow.askResultTimedOut")}</span>
        )}
        {data.state === "answered" && data.answers.map((answer, index) => (
          <AskAnswerRow key={answer.name || index} answer={answer} notes={data.notes} />
        ))}
      </div>
    </div>
  );
}
