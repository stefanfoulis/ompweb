"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AskDialogQuestion, AskDialogResultItem, AskUiRequest, AskUiResponse } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Rich multi-question "ask" dialog — web parity for the TUI ask overlay
 * (oh-my-pi/packages/tui/src/overlays/ask-dialog.ts). One tab per question
 * plus a trailing Review tab (when there is more than one question, or any
 * question is multi-select); options render as radio/checkbox rows with an
 * optional description, a recommended badge, a markdown preview for the
 * highlighted option, and a per-row note. See PLAN-ask-dialog.md for the
 * wire protocol this mirrors.
 */

const MAX_TAB_LABEL_CHARS = 24;

type RowKind = "option" | "other";

interface QuestionRow {
  kind: RowKind;
  key: string;
  index?: number;
}

interface QuestionState {
  selectedOptions: Set<string>;
  customInput: string | undefined;
  /** A question carries at most one note at a time, attached to whichever
   *  row `noteRowKey` names (mirrors the TUI's single note slot). */
  note: string | undefined;
  noteRowKey: string | undefined;
  /** Row currently showing the note text field, if any. */
  noteEditorRowKey: string | undefined;
  cursorIndex: number;
}

function rowsForQuestion(question: AskDialogQuestion): QuestionRow[] {
  const rows: QuestionRow[] = question.options.map((_, index) => ({ kind: "option", key: `option:${index}`, index }));
  rows.push({ kind: "other", key: "other" });
  return rows;
}

function createInitialStates(questions: AskDialogQuestion[]): QuestionState[] {
  return questions.map((question) => ({
    selectedOptions: new Set<string>(),
    customInput: undefined,
    note: undefined,
    noteRowKey: undefined,
    noteEditorRowKey: undefined,
    cursorIndex: Math.min(Math.max(question.recommended ?? 0, 0), Math.max(question.options.length - 1, 0)),
  }));
}

function isAnswered(state: QuestionState): boolean {
  return state.selectedOptions.size > 0 || state.customInput !== undefined;
}

/** A note is only part of the submitted answer while its row is still the
 *  current answer: an option note survives only if that option is still
 *  selected, an "other" note survives only while custom text is present.
 *  Mirrors the TUI's `noteForSubmittedAnswer`. */
function noteForSubmittedAnswer(question: AskDialogQuestion, state: QuestionState): string | undefined {
  if (!state.note || state.noteRowKey === undefined) return undefined;
  if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
  const match = /^option:(\d+)$/.exec(state.noteRowKey);
  const index = match ? Number(match[1]) : Number.NaN;
  const option = Number.isInteger(index) ? question.options[index] : undefined;
  return option && state.selectedOptions.has(option.label) ? state.note : undefined;
}

/** Closing a note editor commits whatever was typed; a blank note clears
 *  the note slot entirely instead of leaving an empty marker. */
function finalizeNoteEditorState(state: QuestionState): QuestionState {
  if (state.noteEditorRowKey === undefined) return state;
  const trimmed = state.note?.trim();
  const note = trimmed ? state.note : undefined;
  return { ...state, noteEditorRowKey: undefined, note, noteRowKey: note === undefined ? undefined : state.noteRowKey };
}

function tabLabel(question: AskDialogQuestion): string {
  const header = question.header?.trim();
  if (header) return header;
  const flat = question.question.trim().replace(/\s+/g, " ");
  if (!flat) return question.id;
  return flat.length > MAX_TAB_LABEL_CHARS ? `${flat.slice(0, MAX_TAB_LABEL_CHARS - 1)}…` : flat;
}

/** Rendered answer summary for the Review tab, or undefined when unanswered. */
function answerSummary(question: AskDialogQuestion, state: QuestionState): string | undefined {
  const selected = question.options.filter((option) => state.selectedOptions.has(option.label)).map((option) => option.label);
  if (question.multi) {
    const parts = [...selected];
    if (state.customInput !== undefined) parts.push(`"${state.customInput}"`);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  if (state.customInput !== undefined) return `"${state.customInput}"`;
  return selected[0];
}

function isEditableElement(target: unknown): target is HTMLElement {
  return target instanceof HTMLElement && target.dataset.askEditable === "1";
}

const secondaryButtonStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
} as const;

const primaryButtonStyle = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--accent-strong)",
  background: "var(--accent-strong)",
  color: "var(--on-accent)",
  cursor: "pointer",
} as const;

const editableInputStyle = {
  marginLeft: 24,
  padding: "5px 7px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
} as const;

export function AskDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: AskUiRequest;
  onRespond: (request: AskUiRequest, response: AskUiResponse) => void;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t, tn } = useI18n();
  const questions = request.questions;
  const [states, setStates] = useState<QuestionState[]>(() => createInitialStates(questions));
  const [activeTab, setActiveTab] = useState(0);
  const [remainingMs, setRemainingMs] = useState<number | undefined>(undefined);
  const otherInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const noteInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    setStates(createInitialStates(questions));
    setActiveTab(0);
    // Only a genuinely new request should reset in-progress answers — the
    // `questions` array identity is not stable across unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);

  useEffect(() => {
    if (request.expiresAt === undefined && request.timeout === undefined) {
      setRemainingMs(undefined);
      return;
    }
    const deadline = request.expiresAt ?? Date.now() + (request.timeout ?? 0);
    let intervalId: number | undefined;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      // Stop ticking at zero: omp resolves the timeout server-side and sends
      // a `cancel` frame that removes this dialog — we never auto-submit.
      if (remaining <= 0 && intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    };
    tick();
    intervalId = window.setInterval(tick, 250);
    return () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [request.id, request.expiresAt, request.timeout]);

  const hasReviewTab = questions.length > 1 || questions.some((question) => question.multi);
  const reviewTabIndex = questions.length;
  const totalTabs = hasReviewTab ? questions.length + 1 : Math.max(1, questions.length);
  const isReviewTab = hasReviewTab && activeTab === reviewTabIndex;
  const currentIndex = Math.min(activeTab, Math.max(0, questions.length - 1));
  const currentQuestion = !isReviewTab ? questions[currentIndex] : undefined;
  const currentState = !isReviewTab ? states[currentIndex] : undefined;
  const currentRows = currentQuestion ? rowsForQuestion(currentQuestion) : [];
  const highlightedRow = currentState ? currentRows[currentState.cursorIndex] : undefined;
  const highlightedOption =
    currentQuestion && highlightedRow?.kind === "option" && highlightedRow.index !== undefined
      ? currentQuestion.options[highlightedRow.index]
      : undefined;
  const highlightedPreview = highlightedOption?.preview?.trim() ? highlightedOption.preview : undefined;
  const unansweredCount = questions.filter((_, index) => !isAnswered(states[index])).length;

  const cancel = () => onRespond(request, { cancelled: true });
  const submit = (statesOverride?: QuestionState[]) => {
    const results: AskDialogResultItem[] = questions.map((question, index) => {
      const state = (statesOverride ?? states)[index];
      const selectedOptions = question.options.map((option) => option.label).filter((label) => state.selectedOptions.has(label));
      const item: AskDialogResultItem = { id: question.id, selectedOptions };
      if (state.customInput) item.customInput = state.customInput;
      const note = noteForSubmittedAnswer(question, state);
      if (note) item.note = note;
      return item;
    });
    onRespond(request, { results });
  };

  // Escape closes whatever text field is focused (custom-answer or note
  // input) instead of canceling the whole dialog; only bare Escape cancels.
  // useModalDialog's onClose is updated every render (see its ref pattern),
  // so a fresh closure here is fine.
  const resolveEscape = () => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (isEditableElement(active)) {
      active.blur();
      setStates((prev) => prev.map(finalizeNoteEditorState));
      return;
    }
    cancel();
  };

  // A composer-attached request is a regular in-flow panel, not a modal, so
  // useModalDialog's document-level Escape/Tab handling only applies when
  // rendered as the full overlay.
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: resolveEscape, active: !attached });
  useEffect(() => {
    if (!attached) return;
    // Keyboard navigation here is fully custom (cursor + tab state on the
    // panel itself), so focus the panel rather than the first form control.
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const advanceAfterQuestion = (qIndex: number, statesOverride?: QuestionState[]) => {
    if (!hasReviewTab) {
      submit(statesOverride);
      return;
    }
    setActiveTab(qIndex + 1 < questions.length ? qIndex + 1 : questions.length);
  };

  const focusOtherInput = (qIndex: number) => {
    requestAnimationFrame(() => otherInputRefs.current.get(qIndex)?.focus());
  };

  const setCursor = (qIndex: number, rowIndex: number) => {
    setStates((prev) => prev.map((state, index) => (index === qIndex ? { ...state, cursorIndex: rowIndex } : state)));
  };

  const setCustomInput = (qIndex: number, raw: string) => {
    const question = questions[qIndex];
    if (!question) return;
    const value = raw.trim() === "" ? undefined : raw;
    setStates((prev) => prev.map((state, index) => {
      if (index !== qIndex) return state;
      if (question.multi) return { ...state, customInput: value };
      return { ...state, customInput: value, selectedOptions: value === undefined ? state.selectedOptions : new Set<string>() };
    }));
  };

  const toggleOrSelectOption = (qIndex: number, optionIndex: number) => {
    const question = questions[qIndex];
    const option = question?.options[optionIndex];
    if (!question || !option) return;
    if (question.multi) {
      setStates((prev) => prev.map((state, index) => {
        if (index !== qIndex) return state;
        const next = new Set(state.selectedOptions);
        if (next.has(option.label)) next.delete(option.label);
        else next.add(option.label);
        return { ...state, selectedOptions: next, cursorIndex: optionIndex };
      }));
      return;
    }
    const nextStates = states.map((state, index) => (
      index === qIndex
        ? { ...state, selectedOptions: new Set([option.label]), customInput: undefined, cursorIndex: optionIndex }
        : state
    ));
    setStates(nextStates);
    advanceAfterQuestion(qIndex, nextStates);
  };

  const openNoteEditor = (qIndex: number, rowKey: string) => {
    setStates((prev) => prev.map((state, index) => {
      if (index !== qIndex) return state;
      const sameRow = state.noteRowKey === rowKey;
      return { ...state, noteEditorRowKey: rowKey, noteRowKey: rowKey, note: sameRow ? state.note ?? "" : "" };
    }));
    requestAnimationFrame(() => noteInputRefs.current.get(`${qIndex}:${rowKey}`)?.focus());
  };

  const activateRow = (qIndex: number, row: QuestionRow) => {
    if (row.kind === "other") {
      focusOtherInput(qIndex);
      return;
    }
    if (row.index !== undefined) toggleOrSelectOption(qIndex, row.index);
  };

  function handleContainerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Note/custom-answer inputs handle their own Enter/Escape locally (and
    // stop propagation); every other key must behave natively while typing.
    if (isEditableElement(e.target)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      resolveEscape();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setActiveTab((prev) => (prev + (e.shiftKey ? -1 : 1) + totalTabs) % totalTabs);
      return;
    }
    if (e.key === "ArrowLeft") {
      setActiveTab((prev) => (prev - 1 + totalTabs) % totalTabs);
      return;
    }
    if (e.key === "ArrowRight") {
      setActiveTab((prev) => (prev + 1) % totalTabs);
      return;
    }
    if (isReviewTab) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (!currentQuestion || !currentState) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(currentIndex, Math.max(0, currentState.cursorIndex - 1));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(currentIndex, Math.min(currentRows.length - 1, currentState.cursorIndex + 1));
      return;
    }
    const row = currentRows[currentState.cursorIndex];
    if (!row) return;
    if (e.key === "n" || e.key === "N") {
      openNoteEditor(currentIndex, row.key);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activateRow(currentIndex, row);
      return;
    }
    if (e.key === " " && currentQuestion.multi) {
      e.preventDefault();
      activateRow(currentIndex, row);
    }
  }

  function renderRow(row: QuestionRow, rowIndex: number) {
    const question = currentQuestion;
    const state = currentState;
    if (!question || !state) return null;
    const qIndex = currentIndex;
    const highlighted = state.cursorIndex === rowIndex;
    const option = row.kind === "option" && row.index !== undefined ? question.options[row.index] : undefined;
    const checked = row.kind === "option" ? (option ? state.selectedOptions.has(option.label) : false) : state.customInput !== undefined;
    const hasNoteMarker = Boolean(state.note) && state.noteRowKey === row.key;
    const isRecommended = row.kind === "option" && question.recommended === row.index;
    const groupName = `ask-${request.id}-${question.id}`;
    return (
      <div
        key={row.key}
        onMouseEnter={() => setCursor(qIndex, rowIndex)}
        style={{
          display: "grid",
          gap: 4,
          padding: "7px 8px",
          borderRadius: 7,
          border: `1px solid ${highlighted ? "var(--accent)" : "transparent"}`,
          background: highlighted ? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))" : "transparent",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text)" }}>
          <input
            type={question.multi ? "checkbox" : "radio"}
            name={groupName}
            tabIndex={-1}
            aria-label={row.kind === "option" ? option?.label : t("askDialog.other")}
            checked={checked}
            onChange={() => {
              if (row.kind === "option" && row.index !== undefined) {
                toggleOrSelectOption(qIndex, row.index);
                return;
              }
              if (state.customInput !== undefined) setCustomInput(qIndex, "");
              else {
                setCursor(qIndex, rowIndex);
                focusOtherInput(qIndex);
              }
            }}
          />
          <span style={{ flex: 1 }}>
            {row.kind === "option" ? option?.label : t("askDialog.other")}
            {isRecommended && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-dim)" }}>({t("askDialog.recommended")})</span>}
          </span>
          {hasNoteMarker && <span style={{ color: "var(--status-success)", fontSize: 12 }}>✎ {t("askDialog.note")}</span>}
        </label>
        {row.kind === "option" && option?.description && (
          <div style={{ marginLeft: 24, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{option.description}</div>
        )}
        {row.kind === "other" && (
          <input
            type="text"
            data-ask-editable="1"
            ref={(el) => {
              if (el) otherInputRefs.current.set(qIndex, el);
              else otherInputRefs.current.delete(qIndex);
            }}
            value={state.customInput ?? ""}
            placeholder={t("askDialog.otherPlaceholder")}
            aria-label={t("askDialog.other")}
            onFocus={() => setCursor(qIndex, rowIndex)}
            onChange={(e) => setCustomInput(qIndex, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (!question.multi && state.customInput) advanceAfterQuestion(qIndex);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            style={editableInputStyle}
          />
        )}
        <div style={{ marginLeft: 24 }}>
          <button
            type="button"
            onClick={() => openNoteEditor(qIndex, row.key)}
            style={{ padding: "2px 6px", fontSize: 11, borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
          >
            {t("askDialog.addNote")}
          </button>
        </div>
        {state.noteEditorRowKey === row.key && (
          <input
            type="text"
            data-ask-editable="1"
            ref={(el) => {
              const key = `${qIndex}:${row.key}`;
              if (el) noteInputRefs.current.set(key, el);
              else noteInputRefs.current.delete(key);
            }}
            value={state.note ?? ""}
            placeholder={t("askDialog.notePlaceholder")}
            aria-label={t("askDialog.notePlaceholder")}
            onChange={(e) => setStates((prev) => prev.map((s, i) => (i === qIndex ? { ...s, note: e.target.value } : s)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setStates((prev) => prev.map((s, i) => (i === qIndex ? finalizeNoteEditorState(s) : s)));
                e.currentTarget.blur();
              }
            }}
            style={editableInputStyle}
          />
        )}
      </div>
    );
  }

  const titleText = remainingMs === undefined ? t("askDialog.title") : `${t("askDialog.title")} (${Math.ceil(remainingMs / 1000)}s)`;

  return (
    <div
      className={attached ? undefined : "animate-fade-in"}
      onMouseDown={attached ? undefined : (event) => {
        if (event.target === event.currentTarget) cancel();
      }}
      style={attached ? { width: "100%", flexShrink: 0 } : {
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={attached ? undefined : "true"}
        aria-label={titleText}
        tabIndex={-1}
        onKeyDown={handleContainerKeyDown}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(640px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? "min(480px, 65dvh)" : "min(640px, 85dvh)",
        }}
      >
        <div style={{ minHeight: 0, overflowY: "auto", overflowWrap: "anywhere" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{titleText}</div>
          </div>

          <div role="tablist" aria-label={t("askDialog.title")} style={{ display: "flex", gap: 4, padding: "6px 10px", borderBottom: "1px solid var(--border)", overflowX: "auto", background: "var(--bg-panel)" }}>
            {questions.map((question, index) => {
              const selected = !isReviewTab && index === currentIndex;
              const answered = isAnswered(states[index]);
              return (
                <button
                  key={question.id}
                  type="button"
                  role="tab"
                  id={`ask-tab-${index}`}
                  aria-selected={selected}
                  aria-controls={`ask-panel-${index}`}
                  aria-label={`${tabLabel(question)} (${answered ? t("askDialog.answered") : t("askDialog.unanswered")})`}
                  onClick={() => setActiveTab(index)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 9px",
                    borderRadius: 999,
                    border: `1px solid ${selected ? "var(--border)" : "transparent"}`,
                    background: selected ? "var(--bg)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: answered ? "var(--status-success)" : "var(--border)", flexShrink: 0 }} />
                  {tabLabel(question)}
                </button>
              );
            })}
            {hasReviewTab && (
              <button
                type="button"
                role="tab"
                id="ask-tab-review"
                aria-selected={isReviewTab}
                aria-controls="ask-panel-review"
                onClick={() => setActiveTab(reviewTabIndex)}
                style={{
                  padding: "5px 9px",
                  borderRadius: 999,
                  border: `1px solid ${isReviewTab ? "var(--border)" : "transparent"}`,
                  background: isReviewTab ? "var(--bg)" : "transparent",
                  color: isReviewTab ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {t("askDialog.review")}
              </button>
            )}
          </div>

          <div style={{ padding: 14 }}>
            {!isReviewTab && currentQuestion && currentState && (
              <div role="tabpanel" id={`ask-panel-${currentIndex}`} aria-labelledby={`ask-tab-${currentIndex}`} style={{ display: "grid", gap: 10 }}>
                {currentQuestion.header && (
                  <span style={{ justifySelf: "start", fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)", background: "var(--bg-panel)" }}>
                    {currentQuestion.header}
                  </span>
                )}
                <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{currentQuestion.question}</div>
                <div role={currentQuestion.multi ? "group" : "radiogroup"} aria-label={currentQuestion.question} style={{ display: "grid", gap: 6 }}>
                  {currentRows.map((row, rowIndex) => renderRow(row, rowIndex))}
                </div>
                {highlightedPreview && (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 10, background: "var(--bg-panel)", fontSize: 12 }}>
                    <MarkdownBody>{highlightedPreview}</MarkdownBody>
                  </div>
                )}
              </div>
            )}

            {isReviewTab && (
              <div role="tabpanel" id="ask-panel-review" aria-labelledby="ask-tab-review" style={{ display: "grid", gap: 10 }}>
                {unansweredCount > 0 && (
                  <div style={{ color: "var(--status-warning)", fontSize: 12 }}>{tn("askDialog.unansweredWarning", unansweredCount)}</div>
                )}
                <div style={{ display: "grid", gap: 8 }}>
                  {questions.map((question, index) => {
                    const state = states[index];
                    const answered = isAnswered(state);
                    const summary = answered ? answerSummary(question, state) : undefined;
                    const note = noteForSubmittedAnswer(question, state);
                    return (
                      <div key={question.id} style={{ fontSize: 13, lineHeight: 1.5 }}>
                        <span style={{ color: "var(--text-dim)" }}>{index + 1}. {tabLabel(question)}:</span>{" "}
                        <span style={{ color: answered ? "var(--text)" : "var(--status-warning)" }}>{answered ? summary : t("askDialog.unanswered")}</span>
                        {note && <div style={{ marginLeft: 14, color: "var(--text-muted)", fontSize: 12 }}>{t("askDialog.note")}: {note}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button type="button" onClick={cancel} style={secondaryButtonStyle}>{t("askDialog.cancel")}</button>
          <button type="button" onClick={() => onRespond(request, { chat: true })} style={secondaryButtonStyle}>{t("askDialog.chatAboutThis")}</button>
          {isReviewTab && (
            <button type="button" onClick={() => submit()} style={primaryButtonStyle}>{t("askDialog.submit")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
