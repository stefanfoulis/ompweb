"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import type {
  ChoiceField,
  FormBlock,
  FormField,
  FormSpan,
  HtmlForm,
  HtmlFormData,
  HtmlFormValue,
  RpcAskDialogAnswer,
  RpcAskDialogQuestion,
  TextField,
} from "@/lib/pi-types";
import { choiceValue, fieldError, spansText, textValue } from "@/lib/html-form";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useTouchTargets } from "@/hooks/useTouchTargets";
import { shouldDeferAttachedFocus, useKeyboardPressGuard, useMobileInputOpen, useViewportMaxHeight } from "./ExtensionDialog";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Rich question dialog — web parity for the TUI ask overlay
 * (oh-my-pi/packages/tui/src/overlays/ask-dialog.ts). It answers both of omp's
 * question protocols: the `ask` request (one question per item) and the `form`
 * request (a parsed agent-written `<form>`, one tab per named field). Both are
 * adapted to the same item model, so there is one tabbed panel with one set of
 * keyboard rules, notes and "Chat about this".
 *
 * Form content arrives as spans, images and svg markup, never as HTML: text is
 * rendered as text and svg through an `<img>`, so nothing a form carries runs
 * in the page.
 */

const MAX_TAB_LABEL_CHARS = 24;

// Layout-viewport cap for the composer panel. While the soft keyboard is up
// the panel is capped to the visual viewport instead (see useViewportMaxHeight).
const ATTACHED_PANEL_MAX_HEIGHT = "min(480px, 65dvh)";

export type AskDialogRequest = Extract<ExtensionUiRequest, { method: "ask" | "form" }>;
export type AskDialogResponse =
  | { answers: RpcAskDialogAnswer[] }
  | { data: HtmlFormData; notes?: Record<string, string> }
  | { chat: true }
  | { cancelled: true };

type RowKind = "option" | "other" | "text";

interface ItemRow {
  kind: RowKind;
  key: string;
  index?: number;
}

interface ItemOption {
  label: FormSpan[];
  /** What a submission reports for this option: an `ask` label, a form option value. */
  value: string;
  description?: string;
  preview?: string;
  checked: boolean;
  disabled: boolean;
}

type ItemControl =
  | {
      kind: "choice";
      /** Checkbox rows instead of radio rows. */
      multi: boolean;
      /** Offer a free-text "Other" row below the options. */
      other: boolean;
      options: ItemOption[];
      /** Badged option the keyboard cursor starts on (`ask` only). */
      recommended?: number;
      /** The form field this control answers; absent for `ask`. */
      field?: ChoiceField;
    }
  | { kind: "text"; field: TextField };

/** Blocks of one form section, kept together so their title can head them. */
interface ContextRun {
  title: string;
  blocks: FormBlock[];
}

/** One tab: a question and the control that answers it. */
interface DialogItem {
  key: string;
  /** Key the answer is reported under: an `ask` question id, a form field name. */
  id: string;
  label: string;
  question: string;
  /** Badge above the question: an `ask` header, a form section title. */
  header?: string;
  /** Form content that precedes the field, in document order. */
  context: ContextRun[];
  control: ItemControl;
}

interface ItemState {
  /** Indices into the control's options. */
  selected: Set<number>;
  /** Text of the "Other" row; undefined while it is blank. */
  customInput: string | undefined;
  /** Text of a text field. */
  text: string;
  /** Notes keyed by row key (`option:<i>` / `other` / `text`). Unlike the TUI's
   *  single note slot, every row keeps its own note so multi-select answers can
   *  carry one per selected option; they are merged into one note on submit. */
  notes: Record<string, string>;
  /** Row currently showing the note text field, if any. */
  noteEditorRowKey: string | undefined;
  cursorIndex: number;
}

function truncateLabel(text: string, fallback: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return fallback;
  return flat.length > MAX_TAB_LABEL_CHARS ? `${flat.slice(0, MAX_TAB_LABEL_CHARS - 1)}…` : flat;
}

function itemsFromAsk(questions: RpcAskDialogQuestion[]): DialogItem[] {
  return questions.map((question, index) => ({
    key: `ask:${index}:${question.id}`,
    id: question.id,
    label: question.header?.trim() || truncateLabel(question.question, question.id),
    question: question.question,
    header: question.header,
    context: [],
    control: {
      kind: "choice",
      multi: question.multi === true,
      // Every ask question takes a free-text answer of its own.
      other: true,
      options: question.options.map((option) => ({
        label: [{ text: option.label }],
        value: option.label,
        description: option.description,
        preview: option.preview,
        checked: false,
        disabled: false,
      })),
      recommended: question.recommended,
    },
  }));
}

function controlForField(field: FormField): ItemControl {
  if (field.kind === "text") return { kind: "text", field };
  return {
    kind: "choice",
    multi: field.multi,
    other: field.other,
    options: field.options.map((option) => ({
      label: option.label,
      value: option.value,
      checked: option.checked,
      disabled: option.disabled,
    })),
    field,
  };
}

/**
 * Tabs of a parsed form: one per named field, carrying the blocks between it
 * and the field before it — including loose content from sections of their own,
 * which no field would otherwise show. Content after the last field is returned
 * separately and shown on the Review tab.
 */
function itemsFromForm(form: HtmlForm, questions: Record<string, string>): { items: DialogItem[]; trailing: ContextRun[] } {
  const items: DialogItem[] = [];
  let pending: ContextRun[] = [];
  for (const section of form.sections) {
    const title = spansText(section.title).trim();
    let run: ContextRun = { title, blocks: [] };
    for (const block of section.blocks) {
      if (block.kind !== "field") {
        run.blocks.push(block);
        continue;
      }
      const field = block.field;
      // A control without a name submits nothing, so it gets no tab of its own.
      if (!field.name) continue;
      if (run.blocks.length > 0) pending.push(run);
      const question = questions[field.name]?.trim() || spansText(field.label).trim() || field.name;
      // omp derives a field's question from the text right before it; keeping
      // that block as context too would print the question twice.
      const lastRun = pending[pending.length - 1];
      const lastBlock = lastRun?.blocks[lastRun.blocks.length - 1];
      if (lastBlock?.kind === "text" && spansText(lastBlock.spans).trim() === question) {
        lastRun.blocks.pop();
        if (lastRun.blocks.length === 0) pending.pop();
      }
      items.push({
        key: `form:${items.length}:${field.name}`,
        id: field.name,
        label: truncateLabel(question, field.name),
        question,
        // A field whose question omp took from the section title needs no
        // badge repeating it.
        header: title && title !== question ? title : undefined,
        context: pending,
        control: controlForField(field),
      });
      pending = [];
      run = { title, blocks: [] };
    }
    if (run.blocks.length > 0) pending.push(run);
  }
  return { items, trailing: pending };
}

function itemsForRequest(request: AskDialogRequest): { items: DialogItem[]; trailing: ContextRun[] } {
  if (request.method === "form") return itemsFromForm(request.form, request.questions);
  return { items: itemsFromAsk(request.questions), trailing: [] };
}

function rowsForItem(item: DialogItem): ItemRow[] {
  if (item.control.kind === "text") return [{ kind: "text", key: "text" }];
  const rows: ItemRow[] = item.control.options.map((_, index) => ({ kind: "option", key: `option:${index}`, index }));
  if (item.control.other) rows.push({ kind: "other", key: "other" });
  return rows;
}

function createInitialStates(items: DialogItem[]): ItemState[] {
  return items.map((item) => {
    const control = item.control;
    if (control.kind === "text") {
      return { selected: new Set<number>(), customInput: undefined, text: control.field.value, notes: {}, noteEditorRowKey: undefined, cursorIndex: 0 };
    }
    // A form preselects through `checked`; `ask` only badges a recommendation,
    // so no stray key can answer for the user. A radio group reports its first
    // checked option, the same one omp's own defaults report.
    const checked = control.options.flatMap((option, index) => (option.checked ? [index] : []));
    return {
      selected: new Set(control.multi ? checked : checked.slice(0, 1)),
      customInput: undefined,
      text: "",
      notes: {},
      noteEditorRowKey: undefined,
      cursorIndex: Math.min(Math.max(control.recommended ?? 0, 0), Math.max(control.options.length - 1, 0)),
    };
  });
}

function isAnswered(item: DialogItem, state: ItemState): boolean {
  if (item.control.kind === "text") return state.text.trim() !== "";
  // A disabled option a form ticked for the user is not an answer: omp leaves
  // it out of the submission, so the tab is not done because of it.
  const chosen = item.control.options.some((option, index) => state.selected.has(index) && !option.disabled);
  return chosen || state.customInput !== undefined;
}

/** What this item submits under omp's rules, or undefined when it answers nothing. */
function valueForItem(item: DialogItem, state: ItemState): HtmlFormValue | undefined {
  if (item.control.kind === "text") return textValue(item.control.field, state.text);
  const field = item.control.field;
  return field ? choiceValue(field, state.selected, state.customInput) : undefined;
}

/** Localized constraint violation of a form item, or undefined when the answer
 *  stands. An `ask` question carries no constraints of its own. */
function itemError(item: DialogItem, state: ItemState): string | undefined {
  const field = item.control.field;
  return field ? fieldError(field, valueForItem(item, state)) : undefined;
}

/** Notes of the rows that are part of the submitted answer: an option note
 *  only while that option is selected, the "other" note only while custom text
 *  is present (the TUI's `noteForSubmittedAnswer` rule, applied per row). The
 *  wire carries one `note` per field, so when several answered rows carry
 *  notes each is prefixed with its answer: `Auth: needs SSO; Export: CSV only`. */
function noteForSubmittedAnswer(item: DialogItem, state: ItemState): string | undefined {
  if (item.control.kind === "text") {
    const note = state.notes.text?.trim();
    return note && state.text.trim() !== "" ? note : undefined;
  }
  const noted: Array<[answer: string, note: string]> = [];
  item.control.options.forEach((option, index) => {
    const note = state.notes[`option:${index}`]?.trim();
    if (note && state.selected.has(index) && !option.disabled) noted.push([spansText(option.label), note]);
  });
  const otherNote = state.notes.other?.trim();
  if (otherNote && state.customInput !== undefined) noted.push([state.customInput, otherNote]);
  if (noted.length === 0) return undefined;
  const answerCount = item.control.options.filter((option, index) => state.selected.has(index) && !option.disabled).length
    + (state.customInput !== undefined ? 1 : 0);
  if (answerCount <= 1) return noted[0][1];
  return noted.map(([answer, note]) => `${answer}: ${note}`).join("; ");
}

/** Closing a note editor commits whatever was typed; a blank note removes
 *  that row's note instead of leaving an empty entry. */
function finalizeNoteEditorState(state: ItemState): ItemState {
  const rowKey = state.noteEditorRowKey;
  if (rowKey === undefined) return state;
  const notes = { ...state.notes };
  if (!notes[rowKey]?.trim()) delete notes[rowKey];
  return { ...state, noteEditorRowKey: undefined, notes };
}

/** Rendered answer summary for the Review tab, or undefined when unanswered. */
function answerSummary(item: DialogItem, state: ItemState): string | undefined {
  if (item.control.kind === "text") return state.text.trim() === "" ? undefined : state.text;
  const selected = item.control.options.flatMap((option, index) => (state.selected.has(index) && !option.disabled ? [spansText(option.label)] : []));
  if (item.control.multi) {
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

/** An svg as an image source: the browser draws it as a picture, so nothing
 *  inside it runs — unlike markup injected into the page. */
function svgDataUrl(markup: string): string {
  const bytes = new TextEncoder().encode(markup);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
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
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  padding: "5px 7px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
} as const;

const fieldInputStyle = { ...editableInputStyle, flex: undefined, width: "100%", fontSize: 13 } as const;

const contextTextStyle = {
  minWidth: 0,
  color: "var(--text-muted)",
  fontSize: 12,
  lineHeight: 1.6,
  overflowWrap: "anywhere",
} as const;

const tableCellStyle = {
  border: "1px solid var(--border)",
  padding: "3px 6px",
  textAlign: "left",
  verticalAlign: "top",
} as const;

const errorStyle = { color: "var(--status-error)", fontSize: 12, lineHeight: 1.5 } as const;

/** Rows indent their secondary content under the option's checkbox/radio. */
const ROW_INDENT = 24;

/** Inline text of a form, with the emphasis the model wrote. */
function SpanText({ spans }: { spans: FormSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        if (span.style === "code") {
          return (
            <code key={index} style={{ fontFamily: "var(--font-mono)", fontSize: "0.92em", background: "var(--bg-panel)", borderRadius: 4, padding: "0 3px" }}>
              {span.text}
            </code>
          );
        }
        if (span.style === "strong") return <strong key={index}>{span.text}</strong>;
        if (span.style === "em") return <em key={index}>{span.text}</em>;
        return span.text;
      })}
    </>
  );
}

/** One context block of a form. Fields are drawn by their tab, not here. */
function ContextBlock({ block }: { block: FormBlock }) {
  switch (block.kind) {
    case "text":
      return (
        <div style={{ ...contextTextStyle, whiteSpace: "pre-wrap", color: block.heading ? "var(--text)" : "var(--text-muted)", fontWeight: block.heading ? 650 : undefined }}>
          <SpanText spans={block.spans} />
        </div>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} style={{ overflowWrap: "anywhere" }}>
          <SpanText spans={item} />
        </li>
      ));
      const listStyle = { ...contextTextStyle, margin: 0, paddingLeft: 20 };
      return block.ordered ? <ol style={listStyle}>{items}</ol> : <ul style={listStyle}>{items}</ul>;
    }
    case "pre":
      return (
        <pre style={{ minWidth: 0, margin: 0, padding: 8, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, overflowX: "auto" }}>
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div style={{ minWidth: 0, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", color: "var(--text)", fontSize: 12 }}>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (rowIndex < block.headerRows
                    ? <th key={cellIndex} style={{ ...tableCellStyle, background: "var(--bg-panel)" }}><SpanText spans={cell} /></th>
                    : <td key={cellIndex} style={tableCellStyle}><SpanText spans={cell} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      // omp inlines the bytes as a `data:` URL; an image it could not read
      // arrives with an empty src, and then the alt text is all there is.
      return block.src
        ? <img src={block.src} alt={block.alt} style={{ maxWidth: "100%", borderRadius: 6 }} />
        : <div style={contextTextStyle}>{block.alt}</div>;
    case "svg":
      return <img src={svgDataUrl(block.markup)} alt={block.alt} style={{ maxWidth: "100%" }} />;
    default:
      return null;
  }
}

/** Context runs of a tab; a run from another section keeps its own title. */
function ContextRuns({ runs, header }: { runs: ContextRun[]; header?: string }) {
  return (
    <>
      {runs.map((run, runIndex) => (
        <Fragment key={runIndex}>
          {run.title && run.title !== header && (
            <div style={{ ...contextTextStyle, color: "var(--text)", fontWeight: 650 }}>{run.title}</div>
          )}
          {run.blocks.map((block, blockIndex) => <ContextBlock key={blockIndex} block={block} />)}
        </Fragment>
      ))}
    </>
  );
}

export function AskDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: AskDialogRequest;
  onRespond: (request: AskDialogRequest, response: AskDialogResponse) => void;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t, tn } = useI18n();
  const { items, trailing } = useMemo(() => itemsForRequest(request), [request]);
  const [states, setStates] = useState<ItemState[]>(() => createInitialStates(items));
  const [activeTab, setActiveTab] = useState(0);
  // Constraint errors stay hidden until a submit is blocked by one: a form is
  // read before it is filled, and every required field would start red.
  const [showErrors, setShowErrors] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | undefined>(undefined);
  const otherInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const textInputRefs = useRef<Map<number, HTMLInputElement | HTMLTextAreaElement>>(new Map());
  const noteInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const viewportMaxHeight = useViewportMaxHeight();
  const { touchTargets } = useTouchTargets();
  const footerMinHeight = touchTargets === "accessible" ? 44 : undefined;

  useEffect(() => {
    setStates(createInitialStates(itemsForRequest(request).items));
    setActiveTab(0);
    setShowErrors(false);
    // Only a genuinely new request should reset in-progress answers — the
    // request object is not stable across unrelated re-renders.
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

  // Every dialog ends in a Review tab, even a single question: picking an
  // option only advances, so one stray click can never submit.
  const reviewTabIndex = items.length;
  const totalTabs = items.length + 1;
  const isReviewTab = activeTab === reviewTabIndex;
  const currentIndex = Math.min(activeTab, Math.max(0, items.length - 1));
  const currentItem = !isReviewTab ? items[currentIndex] : undefined;
  const currentState = !isReviewTab ? states[currentIndex] : undefined;
  const currentRows = currentItem ? rowsForItem(currentItem) : [];
  const highlightedRow = currentState ? currentRows[currentState.cursorIndex] : undefined;
  const highlightedOption =
    currentItem?.control.kind === "choice" && highlightedRow?.kind === "option" && highlightedRow.index !== undefined
      ? currentItem.control.options[highlightedRow.index]
      : undefined;
  const highlightedPreview = highlightedOption?.preview?.trim() ? highlightedOption.preview : undefined;
  const unansweredCount = items.filter((item, index) => !isAnswered(item, states[index])).length;
  // Errors are live: a field stops being flagged as soon as it is fixed.
  const errors = items.map((item, index) => itemError(item, states[index]));
  const hasErrors = errors.some((error) => error !== undefined);

  // Answering removes the panel. Release its text field first, in the same
  // task, so the phone keyboard closes once instead of flashing as the
  // focused field disappears from under it.
  const respond = (response: AskDialogResponse) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    onRespond(request, response);
  };
  const cancel = () => respond({ cancelled: true });
  const submit = (statesOverride?: ItemState[]) => {
    const current = statesOverride ?? states;
    if (request.method === "form") {
      // omp rejects the whole submission over one violated constraint, so a
      // blocked submit opens the offending field instead of sending.
      const blocked = items.findIndex((item, index) => itemError(item, current[index]) !== undefined);
      if (blocked >= 0) {
        setShowErrors(true);
        setActiveTab(blocked);
        return;
      }
      const data: HtmlFormData = {};
      const notes: Record<string, string> = {};
      items.forEach((item, index) => {
        const state = current[index];
        const value = valueForItem(item, state);
        // An empty array is "nothing chosen": the key stays out of the data.
        if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
        data[item.id] = value;
        const note = noteForSubmittedAnswer(item, state);
        if (note) notes[item.id] = note;
      });
      respond(Object.keys(notes).length > 0 ? { data, notes } : { data });
      return;
    }
    const answers: RpcAskDialogAnswer[] = items.map((item, index) => {
      const state = current[index];
      const options = item.control.kind === "choice" ? item.control.options : [];
      const selectedOptions = options.flatMap((option, optionIndex) => (state.selected.has(optionIndex) ? [option.value] : []));
      const answer: RpcAskDialogAnswer = { id: item.id, selectedOptions };
      if (state.customInput) answer.customInput = state.customInput;
      const note = noteForSubmittedAnswer(item, state);
      if (note) answer.note = note;
      return answer;
    });
    respond({ answers });
  };

  // Escape closes whatever text field is focused (custom-answer, field or note
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
  const keyboardOpen = useMobileInputOpen(panelRef, attached);
  // With the keyboard up the panel fills the visible area instead of the
  // taller layout-viewport cap, so the footer (Cancel / Chat about this /
  // Submit) stays in reach (#236).
  const attachedMaxHeight = keyboardOpen && viewportMaxHeight !== undefined
    ? `${viewportMaxHeight}px`
    : ATTACHED_PANEL_MAX_HEIGHT;
  const pressGuard = useKeyboardPressGuard();
  // Leaving a text field closes the phone keyboard; the panel takes focus
  // back because the arrow-key cursor lives on it.
  const releaseTextFocus = () => {
    const panel = panelRef.current;
    const active = document.activeElement;
    if (!panel || !isEditableElement(active) || !panel.contains(active)) return;
    active.blur();
    panel.focus();
  };

  useEffect(() => {
    if (!attached) return;
    // Keyboard navigation here is fully custom (cursor + tab state on the
    // panel itself), so focus the panel rather than the first form control —
    // unless the user already clicked into the dialog before this frame ran.
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // On touch input or a phone width the question waits to be read: moving
      // focus here scrolls the unread panel around and, with the browser's
      // focus-follows-tap heuristics, can raise the on-screen keyboard (#235).
      if (shouldDeferAttachedFocus()) return;
      if (!panel.contains(document.activeElement)) panel.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const advanceAfterItem = (qIndex: number) => {
    setActiveTab(qIndex + 1 < items.length ? qIndex + 1 : items.length);
  };

  const focusOtherInput = (qIndex: number) => {
    requestAnimationFrame(() => otherInputRefs.current.get(qIndex)?.focus());
  };

  const focusTextInput = (qIndex: number) => {
    requestAnimationFrame(() => textInputRefs.current.get(qIndex)?.focus());
  };

  /** Enter in a free-text field: the text is already stored on every
   *  keystroke, so "sending" it means leaving the field — which drops the
   *  on-screen keyboard and gives the footer its room back — and, for a
   *  single-answer question, moving on exactly as picking an option does. The
   *  last question lands on the Review tab, where the footer's Submit lives. */
  const commitOtherAnswer = (qIndex: number) => {
    const item = items[qIndex];
    // The field stores `undefined` for blank text — nothing to send.
    if (!item || states[qIndex]?.customInput === undefined) return;
    otherInputRefs.current.get(qIndex)?.blur();
    if (item.control.kind === "choice" && !item.control.multi) advanceAfterItem(qIndex);
  };

  const commitTextAnswer = (qIndex: number) => {
    if (!states[qIndex] || states[qIndex].text.trim() === "") return;
    textInputRefs.current.get(qIndex)?.blur();
    advanceAfterItem(qIndex);
  };

  const setCursor = (qIndex: number, rowIndex: number) => {
    setStates((prev) => prev.map((state, index) => (index === qIndex ? { ...state, cursorIndex: rowIndex } : state)));
  };

  const setCustomInput = (qIndex: number, raw: string) => {
    const item = items[qIndex];
    if (!item || item.control.kind !== "choice") return;
    const multi = item.control.multi;
    const value = raw.trim() === "" ? undefined : raw;
    setStates((prev) => prev.map((state, index) => {
      if (index !== qIndex) return state;
      if (multi) return { ...state, customInput: value };
      return { ...state, customInput: value, selected: value === undefined ? state.selected : new Set<number>() };
    }));
  };

  const setText = (qIndex: number, value: string) => {
    setStates((prev) => prev.map((state, index) => (index === qIndex ? { ...state, text: value } : state)));
  };

  const toggleOrSelectOption = (qIndex: number, optionIndex: number) => {
    const item = items[qIndex];
    if (!item || item.control.kind !== "choice") return;
    const option = item.control.options[optionIndex];
    if (!option || option.disabled) return;
    // The press guard left the Other field focused, so the keyboard is still
    // up and further typing would re-choose Other over this option.
    releaseTextFocus();
    if (item.control.multi) {
      setStates((prev) => prev.map((state, index) => {
        if (index !== qIndex) return state;
        const next = new Set(state.selected);
        if (next.has(optionIndex)) next.delete(optionIndex);
        else next.add(optionIndex);
        return { ...state, selected: next, cursorIndex: optionIndex };
      }));
      return;
    }
    setStates((prev) => prev.map((state, index) => (
      index === qIndex
        ? { ...state, selected: new Set([optionIndex]), customInput: undefined, cursorIndex: optionIndex }
        : state
    )));
    advanceAfterItem(qIndex);
  };

  const openNoteEditor = (qIndex: number, rowKey: string) => {
    setStates((prev) => prev.map((state, index) => {
      if (index !== qIndex) return state;
      // Opening another row's editor commits the one currently open.
      return { ...finalizeNoteEditorState(state), noteEditorRowKey: rowKey };
    }));
    requestAnimationFrame(() => noteInputRefs.current.get(`${qIndex}:${rowKey}`)?.focus());
  };

  const activateRow = (qIndex: number, row: ItemRow) => {
    if (row.kind === "other") {
      focusOtherInput(qIndex);
      return;
    }
    if (row.kind === "text") {
      focusTextInput(qIndex);
      return;
    }
    if (row.index !== undefined) toggleOrSelectOption(qIndex, row.index);
  };

  function handleContainerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Note and free-text inputs handle their own Enter/Escape locally (and
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
    if (!currentItem || !currentState) return;
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
    if (e.key === " " && currentItem.control.kind === "choice" && currentItem.control.multi) {
      e.preventDefault();
      activateRow(currentIndex, row);
    }
  }

  function renderNoteControls(qIndex: number, row: ItemRow) {
    const state = states[qIndex];
    const rowNote = state.notes[row.key];
    const editingNote = state.noteEditorRowKey === row.key;
    return (
      <>
        {rowNote && !editingNote && (
          <button
            type="button"
            onClick={() => openNoteEditor(qIndex, row.key)}
            title={t("askDialog.editNote")}
            style={{ marginLeft: ROW_INDENT, padding: 0, border: "none", background: "none", textAlign: "left", cursor: "pointer", color: "var(--status-success)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            ✎ {rowNote}
          </button>
        )}
        {editingNote ? (
          <input
            type="text"
            data-ask-editable="1"
            ref={(el) => {
              const key = `${qIndex}:${row.key}`;
              if (el) noteInputRefs.current.set(key, el);
              else noteInputRefs.current.delete(key);
            }}
            value={rowNote ?? ""}
            placeholder={t("askDialog.notePlaceholder")}
            aria-label={t("askDialog.notePlaceholder")}
            onChange={(e) => {
              const value = e.target.value;
              setStates((prev) => prev.map((s, i) => (i === qIndex ? { ...s, notes: { ...s.notes, [row.key]: value } } : s)));
            }}
            onBlur={() => setStates((prev) => prev.map((s, i) => (i === qIndex && s.noteEditorRowKey === row.key ? finalizeNoteEditorState(s) : s)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setStates((prev) => prev.map((s, i) => (i === qIndex ? finalizeNoteEditorState(s) : s)));
                e.currentTarget.blur();
              }
            }}
            style={{ ...editableInputStyle, marginLeft: ROW_INDENT }}
          />
        ) : (
          <div style={{ marginLeft: ROW_INDENT }}>
            <button
              type="button"
              onClick={() => openNoteEditor(qIndex, row.key)}
              style={{ padding: "2px 6px", fontSize: 11, borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
            >
              {rowNote ? t("askDialog.editNote") : t("askDialog.addNote")}
            </button>
          </div>
        )}
      </>
    );
  }

  function renderTextRow(row: ItemRow) {
    const item = currentItem;
    if (!item || item.control.kind !== "text") return null;
    const field = item.control.field;
    const qIndex = currentIndex;
    const state = states[qIndex];
    const common = {
      "data-ask-editable": "1",
      value: state.text,
      placeholder: field.placeholder || undefined,
      "aria-label": item.question,
      onFocus: () => setCursor(qIndex, 0),
      onChange: (e: { target: { value: string } }) => setText(qIndex, e.target.value),
    };
    return (
      <div key={row.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", minWidth: 0, gap: 4, padding: "7px 8px" }}>
        {field.multiline ? (
          <textarea
            {...common}
            ref={(el) => {
              if (el) textInputRefs.current.set(qIndex, el);
              else textInputRefs.current.delete(qIndex);
            }}
            rows={Math.max(1, field.rows)}
            maxLength={field.maxLength}
            onKeyDown={(e) => {
              // A textarea was asked for because the answer may span lines:
              // Enter types one, and only Escape leaves the field.
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            style={{ ...fieldInputStyle, resize: "vertical" }}
          />
        ) : (
          <input
            {...common}
            type={field.type}
            ref={(el) => {
              if (el) textInputRefs.current.set(qIndex, el);
              else textInputRefs.current.delete(qIndex);
            }}
            min={field.min}
            max={field.max}
            maxLength={field.maxLength}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                commitTextAnswer(qIndex);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            style={fieldInputStyle}
          />
        )}
        {renderNoteControls(qIndex, row)}
      </div>
    );
  }

  function renderRow(row: ItemRow, rowIndex: number) {
    const item = currentItem;
    const state = currentState;
    if (!item || !state) return null;
    if (row.kind === "text") return renderTextRow(row);
    if (item.control.kind !== "choice") return null;
    const qIndex = currentIndex;
    const highlighted = state.cursorIndex === rowIndex;
    const option = row.kind === "option" && row.index !== undefined ? item.control.options[row.index] : undefined;
    const checked = row.kind === "option" ? (row.index !== undefined && state.selected.has(row.index)) : state.customInput !== undefined;
    const isRecommended = row.kind === "option" && item.control.recommended === row.index;
    const groupName = `ask-${request.id}-${item.id}`;
    return (
      <div
        key={row.key}
        onMouseEnter={() => setCursor(qIndex, rowIndex)}
        style={{
          display: "grid",
          // Rows must be able to shrink below their content: a long option
          // label or a typed answer is wider than a phone, and an implicit
          // max-content track would push the panel past the composer column
          // and clip it (#234).
          gridTemplateColumns: "minmax(0, 1fr)",
          minWidth: 0,
          gap: 4,
          padding: "7px 8px",
          borderRadius: 7,
          border: `1px solid ${highlighted ? "var(--accent)" : "transparent"}`,
          background: highlighted ? "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))" : "transparent",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, cursor: option?.disabled ? "not-allowed" : "pointer", fontSize: 13, color: option?.disabled ? "var(--text-dim)" : "var(--text)" }}>
          <input
            type={item.control.multi ? "checkbox" : "radio"}
            name={groupName}
            tabIndex={-1}
            disabled={option?.disabled === true}
            aria-label={row.kind === "option" ? spansText(option?.label ?? []) : t("askDialog.other")}
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
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {row.kind === "option" ? <SpanText spans={option?.label ?? []} /> : t("askDialog.other")}
            {isRecommended && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-dim)" }}>({t("askDialog.recommended")})</span>}
          </span>
        </label>
        {row.kind === "option" && option?.description && (
          <div style={{ marginLeft: ROW_INDENT, minWidth: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{option.description}</div>
        )}
        {row.kind === "other" && (
          <div style={{ display: "flex", alignItems: "center", marginLeft: ROW_INDENT, minWidth: 0 }}>
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
                  commitOtherAnswer(qIndex);
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.blur();
                }
              }}
              style={editableInputStyle}
            />
          </div>
        )}
        {renderNoteControls(qIndex, row)}
      </div>
    );
  }

  const titleText = remainingMs === undefined ? t("askDialog.title") : `${t("askDialog.title")} (${Math.ceil(remainingMs / 1000)}s)`;
  const currentError = !isReviewTab && showErrors ? errors[currentIndex] : undefined;

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
        // Keeps the phone keyboard up while a text box of this panel has focus.
        {...pressGuard}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(640px, 100%)",
          boxSizing: "border-box",
          // Flex/grid children below must be able to shrink: a min-content
          // question, option or preview is wider than a phone, and without
          // this the panel grows past its composer column and gets clipped
          // (#234).
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? attachedMaxHeight : "min(640px, 85dvh)",
        }}
      >
        <div className="ask-dialog-content" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{titleText}</div>
          </div>

          <div role="tablist" aria-label={t("askDialog.title")} style={{ display: "flex", gap: 4, minWidth: 0, padding: "6px 10px", borderBottom: "1px solid var(--border)", overflowX: "auto", background: "var(--bg-panel)" }}>
            {items.map((item, index) => {
              const selected = !isReviewTab && index === currentIndex;
              const answered = isAnswered(item, states[index]);
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  id={`ask-tab-${index}`}
                  aria-selected={selected}
                  aria-controls={`ask-panel-${index}`}
                  aria-label={`${item.label} (${answered ? t("askDialog.answered") : t("askDialog.unanswered")})`}
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
                  {item.label}
                </button>
              );
            })}
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
          </div>

          <div style={{ padding: 14 }}>
            {!isReviewTab && currentItem && currentState && (
              <div role="tabpanel" id={`ask-panel-${currentIndex}`} aria-labelledby={`ask-tab-${currentIndex}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
                {currentItem.header && (
                  <span style={{ justifySelf: "start", fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)", background: "var(--bg-panel)" }}>
                    {currentItem.header}
                  </span>
                )}
                <ContextRuns runs={currentItem.context} header={currentItem.header} />
                <div style={{ minWidth: 0, color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{currentItem.question}</div>
                {currentItem.control.kind === "choice" ? (
                  <div role={currentItem.control.multi ? "group" : "radiogroup"} aria-label={currentItem.question} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
                    {currentRows.map((row, rowIndex) => renderRow(row, rowIndex))}
                  </div>
                ) : (
                  currentRows.map((row, rowIndex) => renderRow(row, rowIndex))
                )}
                {currentError && <div role="alert" style={errorStyle}>{currentError}</div>}
                {highlightedPreview && (
                  // The preview wraps rather than scrolling the row sideways;
                  // only a fenced code block inside keeps its own scroller.
                  <div style={{ minWidth: 0, overflowX: "hidden", border: "1px solid var(--border)", borderRadius: 7, padding: 10, background: "var(--bg-panel)", fontSize: 12 }}>
                    <MarkdownBody>{highlightedPreview}</MarkdownBody>
                  </div>
                )}
              </div>
            )}

            {isReviewTab && (
              <div role="tabpanel" id="ask-panel-review" aria-labelledby="ask-tab-review" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}>
                {showErrors && hasErrors && (
                  <div role="alert" style={errorStyle}>{t("askDialog.fixErrors")}</div>
                )}
                {unansweredCount > 0 && (
                  <div style={{ color: "var(--status-warning)", fontSize: 12 }}>{tn("askDialog.unansweredWarning", unansweredCount)}</div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
                  {items.map((item, index) => {
                    const state = states[index];
                    const answered = isAnswered(item, state);
                    const summary = answered ? answerSummary(item, state) : undefined;
                    const note = noteForSubmittedAnswer(item, state);
                    const error = showErrors ? errors[index] : undefined;
                    return (
                      <div key={item.key} style={{ minWidth: 0, fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                        <span style={{ color: "var(--text-dim)" }}>{index + 1}. {item.label}:</span>{" "}
                        <span style={{ color: answered ? "var(--text)" : "var(--status-warning)" }}>{answered ? summary : t("askDialog.unanswered")}</span>
                        {note && <div style={{ marginLeft: 14, color: "var(--text-muted)", fontSize: 12 }}>{t("askDialog.note")}: {note}</div>}
                        {error && <div style={{ ...errorStyle, marginLeft: 14 }}>{error}</div>}
                      </div>
                    );
                  })}
                </div>
                {/* Form content after the last field has no tab of its own. */}
                <ContextRuns runs={trailing} />
              </div>
            )}
          </div>
        </div>

        <div className="extension-dialog-footer" style={{ display: "flex", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button type="button" onClick={cancel} style={{ ...secondaryButtonStyle, minHeight: footerMinHeight }}>{t("askDialog.cancel")}</button>
          <button type="button" onClick={() => respond({ chat: true })} style={{ ...secondaryButtonStyle, minHeight: footerMinHeight }}>{t("askDialog.chatAboutThis")}</button>
          {isReviewTab && (
            <button type="button" onClick={() => submit()} style={{ ...primaryButtonStyle, minHeight: footerMinHeight }}>{t("askDialog.submit")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
