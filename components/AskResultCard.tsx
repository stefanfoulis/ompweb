"use client";

import { CircleHelp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isRecord } from "@/lib/type-guards";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";
import type { ActivityPiece } from "@/lib/chat-transcript-plan";

/**
 * Read-only recap of an answered `ask` tool call, rendered in the committed
 * transcript outside the collapsed "Process details" group so a user can
 * scroll back and see what they (or a timeout) picked without expanding raw
 * tool JSON. See `collectAskResults` for how cards are gathered from a
 * finished turn.
 */

/** One question as offered by the tool call's `input.questions` (older
 * Claude-style sessions carry `multiSelect` instead of `multi`). */
interface AskInputQuestion {
  id: string | undefined;
  header: string;
  question: string;
  options: string[];
  multi: boolean;
}

function parseAskInputQuestions(input: unknown): AskInputQuestion[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  return input.questions.filter(isRecord).map((q) => ({
    id: typeof q.id === "string" ? q.id : undefined,
    header: typeof q.header === "string" ? q.header.trim() : "",
    question: typeof q.question === "string" ? q.question.trim() : "",
    options: Array.isArray(q.options)
      ? q.options.filter(isRecord).map((o) => (typeof o.label === "string" ? o.label : "")).filter(Boolean)
      : [],
    multi: typeof q.multi === "boolean" ? q.multi : (typeof q.multiSelect === "boolean" ? q.multiSelect : false),
  }));
}

export interface AskResultQuestion {
  id: string;
  header: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  timedOut?: boolean;
}

/** One named field's question and answer, from a form-based ask call's
 * `AskToolDetails.answers` (see packages/tui/src/html-form/data.ts `FormAnswer`). */
export interface AskFormAnswer {
  name: string;
  question: string;
  answer: string;
  note?: string;
}

export type AskResultCardData =
  | { toolCallId: string; state: "answered"; questions: AskResultQuestion[] }
  | { toolCallId: string; state: "answeredForm"; answers: AskFormAnswer[]; timedOut?: boolean }
  | { toolCallId: string; state: "chatRedirect"; questions: string[] }
  | { toolCallId: string; state: "cancelled"; questions: AskInputQuestion[] };

function normalizeAnsweredRow(
  row: Record<string, unknown>,
  index: number,
  byId: Map<string, AskInputQuestion>,
  byIndex: AskInputQuestion[],
): AskResultQuestion {
  const inputMatch = (typeof row.id === "string" ? byId.get(row.id) : undefined) ?? byIndex[index];
  const question = typeof row.question === "string" && row.question.trim()
    ? row.question.trim()
    : (inputMatch?.question ?? "");
  const options = Array.isArray(row.options)
    ? row.options.filter((o): o is string => typeof o === "string")
    : (inputMatch?.options ?? []);
  return {
    id: typeof row.id === "string" ? row.id : (inputMatch?.id ?? `q-${index}`),
    header: inputMatch?.header ?? "",
    question,
    options,
    multi: typeof row.multi === "boolean" ? row.multi : (inputMatch?.multi ?? false),
    selectedOptions: Array.isArray(row.selectedOptions)
      ? row.selectedOptions.filter((o): o is string => typeof o === "string")
      : [],
    customInput: typeof row.customInput === "string" && row.customInput.trim() ? row.customInput : undefined,
    note: typeof row.note === "string" && row.note.trim() ? row.note : undefined,
    timedOut: row.timedOut === true,
  };
}

/** A form-based answer row; `null` for a malformed entry (missing name/question/answer). */
function normalizeFormAnswer(row: Record<string, unknown>): AskFormAnswer | null {
  if (typeof row.name !== "string" || typeof row.question !== "string" || typeof row.answer !== "string") return null;
  return {
    name: row.name,
    question: row.question,
    answer: row.answer,
    note: typeof row.note === "string" && row.note.trim() ? row.note : undefined,
  };
}

/** Builds one card's data from an `ask` tool call and its matching
 * toolResult. Returns `null` for a still-pending ask (no result yet — the
 * live dialog owns that state) or an unrecognized/empty result shape. */
export function buildAskResultCard(block: ToolCallContent, result: ToolResultMessage | undefined): AskResultCardData | null {
  if (!result) return null;
  const inputQuestions = parseAskInputQuestions(block.input);

  if (result.isError) {
    return { toolCallId: block.toolCallId, state: "cancelled", questions: inputQuestions };
  }

  const details = result.details;
  if (!isRecord(details)) return null;

  if (details.chatRedirect === true) {
    // A form-based chat redirect (`{ answers: [], chatRedirect: true }`) carries no
    // question text — the html's visible copy isn't preserved structurally.
    if (Array.isArray(details.answers)) {
      return { toolCallId: block.toolCallId, state: "chatRedirect", questions: [] };
    }
    const questions = Array.isArray(details.questions) ? details.questions.filter((q): q is string => typeof q === "string") : [];
    return { toolCallId: block.toolCallId, state: "chatRedirect", questions };
  }

  if (Array.isArray(details.answers)) {
    const answers = details.answers.filter(isRecord).map(normalizeFormAnswer).filter((a): a is AskFormAnswer => a !== null);
    if (answers.length === 0) return null;
    return { toolCallId: block.toolCallId, state: "answeredForm", answers, timedOut: details.timedOut === true };
  }

  const byId = new Map(
    inputQuestions
      .filter((q): q is AskInputQuestion & { id: string } => !!q.id)
      .map((q) => [q.id, q] as const),
  );

  if (Array.isArray(details.results)) {
    const rows = details.results.filter(isRecord);
    if (rows.length === 0) return null;
    return {
      toolCallId: block.toolCallId,
      state: "answered",
      questions: rows.map((row, index) => normalizeAnsweredRow(row, index, byId, inputQuestions)),
    };
  }

  if (typeof details.question === "string") {
    return {
      toolCallId: block.toolCallId,
      state: "answered",
      questions: [normalizeAnsweredRow(details, 0, byId, inputQuestions)],
    };
  }

  return null;
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

function OptionPills({ options, selectedOptions }: { options: string[]; selectedOptions: string[] }) {
  const offered = Array.from(new Set([...options, ...selectedOptions]));
  if (offered.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {offered.map((option) => {
        const isSelected = selectedOptions.includes(option);
        return (
          <span
            key={option}
            style={{
              fontSize: 11,
              lineHeight: 1.6,
              padding: "1px 8px",
              borderRadius: 999,
              border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
              background: isSelected ? "color-mix(in srgb, var(--accent) 14%, var(--bg-panel))" : "transparent",
              color: isSelected ? "var(--text)" : "var(--text-dim)",
              fontWeight: isSelected ? 600 : 400,
            }}
          >
            {option}
          </span>
        );
      })}
    </div>
  );
}

function AskResultQuestionRow({ question }: { question: AskResultQuestion }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.4 }}>
        {question.header && <span style={{ color: "var(--text-muted)" }}>{question.header}: </span>}
        {question.question}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <OptionPills options={question.options} selectedOptions={question.selectedOptions} />
        {question.selectedOptions.length === 0 && !question.customInput && (
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>{t("chatWindow.askResultNoSelection")}</span>
        )}
        {question.timedOut && (
          <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>{t("chatWindow.askResultTimedOut")}</span>
        )}
      </div>
      {question.customInput && (
        <div style={{ fontSize: 11.5, color: "var(--text)", fontStyle: "italic", overflowWrap: "anywhere" }}>
          &ldquo;{question.customInput}&rdquo;
        </div>
      )}
      {question.note && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
          <span style={{ fontWeight: 600 }}>{t("chatWindow.askResultNote")}:</span> {question.note}
        </div>
      )}
    </div>
  );
}

function AskInputQuestionRow({ question }: { question: AskInputQuestion }) {
  return (
    <div style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.4 }}>
      {question.header && <span>{question.header}: </span>}
      {question.question}
    </div>
  );
}

function AskFormAnswerRow({ answer }: { answer: AskFormAnswer }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.4 }}>{answer.question}</div>
      <div style={{ fontSize: 11.5, color: "var(--text)", fontStyle: "italic", overflowWrap: "anywhere" }}>
        {answer.answer
          ? <>&ldquo;{answer.answer}&rdquo;</>
          : <span style={{ color: "var(--text-dim)" }}>{t("chatWindow.askResultNoSelection")}</span>}
      </div>
      {answer.note && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
          <span style={{ fontWeight: 600 }}>{t("chatWindow.askResultNote")}:</span> {answer.note}
        </div>
      )}
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
        {data.state === "answeredForm" && data.timedOut && (
          <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>{t("chatWindow.askResultTimedOut")}</span>
        )}
        {data.state === "answered" && data.questions.map((question) => (
          <AskResultQuestionRow key={question.id} question={question} />
        ))}
        {data.state === "answeredForm" && data.answers.map((answer) => (
          <AskFormAnswerRow key={answer.name} answer={answer} />
        ))}
        {data.state === "chatRedirect" && data.questions.map((question, index) => (
          <div key={index} style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{question}</div>
        ))}
        {data.state === "cancelled" && data.questions.map((question, index) => (
          <AskInputQuestionRow key={question.id ?? index} question={question} />
        ))}
      </div>
    </div>
  );
}
