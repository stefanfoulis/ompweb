"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { HtmlFormData, OptionNote, RpcAskDialogQuestion } from "@/lib/pi-types";
import type { UiAskDialogResult, UiDialogRequest, UiDialogValue } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { shouldDeferAttachedFocus, useKeyboardPressGuard, useMobileInputOpen, useViewportMaxHeight } from "./ExtensionDialog";
import { planForm, planFormTabs, readFormData, syncOtherValidity, tabAnswers, tabControls, type FormPlan, type FormTab } from "./html-form";

/**
 * Rich question dialog — web parity for the TUI ask overlay
 * (oh-my-pi/packages/tui/src/overlays/ask-dialog.ts). It answers both of omp's
 * question methods: `askDialog` (one question per item) and `formDialog` (an
 * agent-written `<form>`, one tab per named control). Both adapt to the same
 * tabbed panel, so they share one set of keyboard rules, per-answer notes,
 * "Chat about this" and the timeout countdown.
 *
 * Every control of a form stays mounted, hidden tabs included: the submission
 * is read from the live `<form>` (`readFormData`), so switching tabs can
 * neither drop an answer nor reorder the data.
 */

export type AskDialogRequest = Extract<UiDialogRequest, { method: "askDialog" | "formDialog" }>;

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// The Other text lives as long as the question: choosing a regular option only
// unchooses it, so the text is still in its row when Other is chosen again.
interface AskDraft { selected: string[]; other: string; otherChosen: boolean }
const EMPTY_ASK_DRAFT: AskDraft = { selected: [], other: "", otherChosen: false };

const MAX_TAB_LABEL_CHARS = 24;

// Layout-viewport cap for the composer panel. While the soft keyboard is up
// the panel is capped to the visual viewport instead (see useViewportMaxHeight).
const ATTACHED_PANEL_MAX_HEIGHT = "min(480px, 65dvh)";

/** Rows indent their secondary content under the option's checkbox/radio. */
const ROW_INDENT = 24;

const errorStyle = { color: "var(--status-error)", fontSize: 12, lineHeight: 1.5 } as const;

const noteButtonStyle = {
  padding: "2px 6px",
  fontSize: 11,
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-muted)",
  cursor: "pointer",
} as const;

const noteInputStyle = {
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

function truncateLabel(text: string, fallback: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return fallback;
  return flat.length > MAX_TAB_LABEL_CHARS ? `${flat.slice(0, MAX_TAB_LABEL_CHARS - 1)}…` : flat;
}

/** Single-select questions start on their recommended option. */
function initialAskDrafts(request: AskDialogRequest): AskDraft[] {
  if (request.method !== "askDialog") return [];
  return request.args[0].map((question) => {
    const recommended = question.multi || question.recommended === undefined ? undefined : question.options[question.recommended];
    return { selected: recommended ? [recommended.label] : [], other: "", otherChosen: false };
  });
}

/** An answer the user gave, as a note can be attached to it. */
interface Answer {
  /** Key its note is stored under, stable across deselecting and choosing again. */
  noteKey: string;
  /** What the answer is called on screen. */
  label: string;
  /** What the submission reports for it: an option's label (`askDialog`) or value (`formDialog`). */
  value: string;
  /** An offered option rather than text the user typed. */
  isOption: boolean;
}

function isEditableElement(target: unknown): target is HTMLElement {
  return target instanceof HTMLElement && target.dataset.askEditable === "1";
}

/**
 * Why omp would reject this control's answer, in the user's language.
 *
 * omp validates the whole submission against its own rules
 * (packages/tui/src/html-form/data.ts `fieldError`) and rejects all of it over
 * one violation, so the same rules are applied here, against the control's
 * attributes rather than the browser's constraint API: a hidden tab's control
 * cannot show a native bubble, and `reportValidity` gives one no text we could
 * place beside the field.
 */
function controlError(control: FormControl, t: (key: string, vars?: Record<string, string | number>) => string): string | undefined {
  if (control.disabled) return undefined;
  // A required group with an Other answer is validated through that box (syncOtherValidity).
  if (control.validity.customError) {
    return control.validationMessage === "Select at least one" ? t("askDialog.errorSelectOne") : t("askDialog.errorRequired");
  }
  if (control.tagName === "SELECT") {
    const select = control as HTMLSelectElement;
    if (!select.required) return undefined;
    return select.selectedOptions.length === 0 || select.value === ""
      ? t(select.multiple ? "askDialog.errorSelectOne" : "askDialog.errorRequired")
      : undefined;
  }
  const type = control.tagName === "INPUT" ? (control as HTMLInputElement).type : "textarea";
  if (type === "radio" || type === "checkbox") {
    if (!control.validity.valueMissing) return undefined;
    return t(type === "checkbox" ? "askDialog.errorSelectOne" : "askDialog.errorRequired");
  }
  const text = control.value;
  if (text.trim() === "") return control.required ? t("askDialog.errorRequired") : undefined;
  const attr = (name: string) => {
    const raw = control.getAttribute(name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  if (type === "number" || type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return t("askDialog.errorNumber");
    const min = attr("min");
    const max = attr("max");
    if (min !== undefined && number < min) return t("askDialog.errorMin", { min });
    if (max !== undefined && number > max) return t("askDialog.errorMax", { max });
  }
  const minLength = attr("minlength");
  const maxLength = attr("maxlength");
  if (minLength !== undefined && text.length < minLength) return t("askDialog.errorMinLength", { count: minLength });
  if (maxLength !== undefined && text.length > maxLength) return t("askDialog.errorMaxLength", { count: maxLength });
  if (type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return t("askDialog.errorEmail");
  if (type === "url" && !URL.canParse(text)) return t("askDialog.errorUrl");
  const pattern = control.getAttribute("pattern");
  if (pattern) {
    // Anchored, as HTML matches it; a pattern the model wrote wrong is ignored.
    let anchored: RegExp | undefined;
    try {
      anchored = new RegExp(`^(?:${pattern})$`, "v");
    } catch {
      anchored = undefined;
    }
    if (anchored?.test(text) === false) {
      return t("askDialog.errorPattern", { pattern: pattern.length > 40 ? `${pattern.slice(0, 39)}…` : pattern });
    }
  }
  return undefined;
}

export function AskDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: AskDialogRequest;
  /** Answers with omp's return value (`undefined` cancels); resolves `false` when it could not be sent. */
  onRespond: (request: AskDialogRequest, value: UiDialogValue | undefined) => void | Promise<boolean>;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t, tn } = useI18n();
  const otherLabel = t("askDialog.other");
  const questions: RpcAskDialogQuestion[] = request.method === "askDialog" ? request.args[0] : [];
  // Parsed in an inert document and never attached: only the elements the
  // plan rebuilds reach the page, with the attributes it copies and no others.
  const plan: FormPlan | null = useMemo(() => {
    if (request.method !== "formDialog") return null;
    const doc = new window.DOMParser().parseFromString(request.args[0], "text/html");
    const root = doc.querySelector("form") ?? doc.body;
    return planFormTabs(root, planForm(root, `form-${request.id}`, otherLabel));
  }, [request, otherLabel]);
  const formTabs = plan?.tabs ?? [];

  const [askDrafts, setAskDrafts] = useState(() => initialAskDrafts(request));
  const [formData, setFormData] = useState<HtmlFormData>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** Answer whose note is being typed, by note key. */
  const [noteEditor, setNoteEditor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  /** Constraint messages by tab key; filled only once a submit was blocked. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showErrors, setShowErrors] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);
  const viewportMaxHeight = useViewportMaxHeight();
  const pressGuard = useKeyboardPressGuard();

  const tabs = formTabs.length > 0
    // The question names the tab: fields of one fieldset would otherwise all carry its legend.
    ? formTabs.map((tab) => ({ key: tab.key, label: truncateLabel(tab.question, tab.name), question: tab.question, header: tab.header }))
    : questions.map((question, index) => ({
      key: `ask-${index}-${question.id}`,
      label: question.header?.trim() || truncateLabel(question.question, question.id),
      question: question.question,
      header: question.header,
    }));
  // Every dialog ends in a Review tab, even a single question: picking an
  // option only advances, so one stray click can never submit.
  const reviewTabIndex = tabs.length;
  const isReviewTab = activeTab >= reviewTabIndex;

  useEffect(() => {
    // SSE reconnects replay the same request as a fresh object, not a new question.
    setAskDrafts(initialAskDrafts(request));
    setNotes({});
    setNoteEditor(null);
    setActiveTab(0);
    setErrors({});
    setShowErrors(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // Required groups with an Other answer are validated through that box.
    syncOtherValidity(form);
    setFormData(readFormData(form));
  }, [plan]);

  useEffect(() => {
    const timeout = request.args[1]?.timeout;
    if (request.expiresAt === undefined && timeout === undefined) {
      setRemainingMs(undefined);
      return;
    }
    const deadline = request.expiresAt ?? Date.now() + (timeout ?? 0);
    let intervalId: number | undefined;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      // Stop ticking at zero: omp resolves the timeout itself and ends the
      // request, which removes this panel — it never auto-submits here.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, request.expiresAt]);

  const askDraftAt = (index: number) => askDrafts[index] ?? EMPTY_ASK_DRAFT;
  const updateAskDraft = (index: number, update: (draft: AskDraft) => AskDraft) =>
    setAskDrafts((drafts) => drafts.map((draft, i) => i === index ? update(draft) : draft));

  const askAnswers = (index: number): Answer[] => {
    const question = questions[index];
    const draft = askDraftAt(index);
    const custom = draft.otherChosen ? draft.other.trim() : "";
    return [
      ...question.options.filter((option) => draft.selected.includes(option.label))
        .map((option) => ({ noteKey: `a${index}\0${option.label}`, label: option.label, value: option.label, isOption: true })),
      ...(custom ? [{ noteKey: `a${index}\0\0other`, label: custom, value: custom, isOption: false }] : []),
    ];
  };

  const formAnswersOf = (tab: FormTab): Answer[] =>
    tabAnswers(tab, formData).map((answer) => ({
      noteKey: `f${tab.name}\0${answer.value}`,
      label: answer.label,
      value: answer.value,
      isOption: answer.isOption,
    }));

  const answersAt = (index: number): Answer[] => (plan ? formAnswersOf(formTabs[index]) : askAnswers(index));
  const answeredAt = (index: number) => answersAt(index).length > 0;
  const unansweredCount = tabs.filter((_, index) => !answeredAt(index)).length;

  const collectErrors = (form: HTMLFormElement): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const tab of formTabs) {
      for (const control of tabControls(form, tab)) {
        const error = controlError(control, t);
        if (error) {
          found[tab.key] = error;
          break;
        }
      }
    }
    return found;
  };

  const refreshForm = (form: HTMLFormElement) => {
    syncOtherValidity(form);
    setFormData(readFormData(form));
    // Errors are live once they are shown: a field stops being flagged as soon as it is fixed.
    if (showErrors) setErrors(collectErrors(form));
  };

  // Answering removes the panel. Release its text field first, in the same
  // task, so the phone keyboard closes once instead of flashing as the
  // focused field disappears from under it.
  const respond = (value: UiDialogValue | undefined) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    void onRespond(request, value);
  };
  const cancel = () => respond(undefined);

  const submit = () => {
    const form = formRef.current;
    if (plan && form) {
      syncOtherValidity(form);
      const found = collectErrors(form);
      const blocked = formTabs.findIndex((tab) => found[tab.key] !== undefined);
      // omp rejects the whole submission over one violated constraint, so a
      // blocked submit opens the offending field instead of sending.
      if (blocked >= 0) {
        setErrors(found);
        setShowErrors(true);
        setActiveTab(blocked);
        return;
      }
      const data = readFormData(form);
      const optionNotes: OptionNote[] = [];
      for (const tab of formTabs) {
        for (const answer of tabAnswers(tab, data)) {
          const text = notes[`f${tab.name}\0${answer.value}`]?.trim();
          if (text) optionNotes.push({ name: tab.name, question: tab.question, option: answer.isOption ? answer.label : otherLabel, value: answer.value, text });
        }
      }
      respond({ data, ...(optionNotes.length > 0 ? { notes: optionNotes } : {}) });
      return;
    }
    const results: UiAskDialogResult["results"] = questions.map((question, index) => {
      const draft = askDraftAt(index);
      const customInput = draft.otherChosen ? draft.other.trim() : "";
      const options = question.options.map((option) => option.label);
      const noted = askAnswers(index)
        .map((answer) => ({ answer, text: notes[answer.noteKey]?.trim() }))
        .filter((entry): entry is { answer: Answer; text: string } => Boolean(entry.text));
      // One note per question is all omp's result carries, so several notes are
      // merged into it, each naming the answer it belongs to.
      const note = noted.length === 1 ? noted[0].text : noted.map(({ answer, text }) => `${answer.label}: ${text}`).join("; ");
      const noteOption = noted.length === 1 && noted[0].answer.isOption ? noted[0].answer.label : undefined;
      return {
        id: question.id,
        question: question.question,
        options,
        multi: question.multi ?? false,
        selectedOptions: options.filter((label) => draft.selected.includes(label)),
        ...(customInput ? { customInput } : {}),
        ...(note ? { note } : {}),
        ...(noteOption ? { noteOption } : {}),
      };
    });
    respond({ kind: "submit", results });
  };

  // Escape closes whatever text field is focused (custom answer, form field or
  // note input) instead of canceling the whole dialog; only bare Escape cancels.
  // useModalDialog's onClose is updated every render (see its ref pattern), so
  // a fresh closure here is fine.
  const resolveEscape = () => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (isEditableElement(active)) {
      active.blur();
      setNoteEditor(null);
      return;
    }
    cancel();
  };

  // A composer-attached request is a regular in-flow panel, not a modal, so
  // useModalDialog's document-level Escape/Tab handling only applies to the
  // full overlay.
  const panelRef = useModalDialog<HTMLDivElement>({ onClose: resolveEscape, active: !attached });
  const keyboardOpen = useMobileInputOpen(panelRef, attached);
  // While the keyboard is up the panel fills the visible area instead of the
  // taller layout-viewport cap, so the footer with Cancel / Chat about this /
  // Submit stays in reach (#236).
  const attachedMaxHeight = keyboardOpen && viewportMaxHeight !== undefined ? `${viewportMaxHeight}px` : ATTACHED_PANEL_MAX_HEIGHT;

  useEffect(() => {
    if (!attached) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // A tap on the composer, not a programmatic focus, opens the keyboard:
      // the request waits to be read on touch devices (#235).
      if (shouldDeferAttachedFocus()) return;
      // The frame runs after paint, by which time the user may already have
      // focused something inside the panel. Never yank focus back.
      if (panel.contains(document.activeElement)) return;
      panel.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  /** Picking a single answer moves on; the last question lands on Review, where Submit lives. */
  const advanceAfterTab = (index: number) => {
    setActiveTab(index + 1 < tabs.length ? index + 1 : reviewTabIndex);
    // The control that was just answered leaves with its tab, so the panel
    // takes focus: the phone keyboard stays down and Escape still reaches us.
    requestAnimationFrame(() => panelRef.current?.focus());
  };

  const openNoteEditor = (noteKey: string) => {
    setNoteEditor(noteKey);
    requestAnimationFrame(() => noteInputRef.current?.focus());
  };

  /** A blank note is no note: it leaves nothing behind when the editor closes. */
  const commitNote = (noteKey: string) => {
    setNotes((current) => {
      if (current[noteKey]?.trim()) return current;
      const rest = { ...current };
      delete rest[noteKey];
      return rest;
    });
    setNoteEditor((current) => (current === noteKey ? null : current));
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const total = tabs.length + 1;
    const move = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const next = move !== 0 ? (activeTab + move + total) % total
      : event.key === "Home" ? 0
      : event.key === "End" ? total - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActiveTab(next);
    const list = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
    list[next]?.focus();
  };

  function renderNotes(index: number) {
    const answers = answersAt(index);
    if (answers.length === 0) return null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6, marginTop: 2 }}>
        {answers.map((answer) => {
          const note = notes[answer.noteKey];
          const editing = noteEditor === answer.noteKey;
          return (
            <div key={answer.noteKey} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", minWidth: 0, gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
                <span style={{ minWidth: 0, color: "var(--text-muted)", fontSize: 12, overflowWrap: "anywhere" }}>{answer.label}</span>
                <button
                  type="button"
                  onClick={() => (editing ? commitNote(answer.noteKey) : openNoteEditor(answer.noteKey))}
                  style={noteButtonStyle}
                >
                  {note ? t("askDialog.editNote") : t("askDialog.addNote")}
                </button>
              </div>
              {editing ? (
                <input
                  type="text"
                  data-ask-editable="1"
                  ref={noteInputRef}
                  value={note ?? ""}
                  placeholder={t("askDialog.notePlaceholder")}
                  aria-label={t("askDialog.notePlaceholder")}
                  onChange={(event) => {
                    const value = event.target.value;
                    setNotes((current) => ({ ...current, [answer.noteKey]: value }));
                  }}
                  onBlur={() => commitNote(answer.noteKey)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== "Escape") return;
                    // Inside a form, Enter would submit it.
                    event.preventDefault();
                    event.stopPropagation();
                    commitNote(answer.noteKey);
                    event.currentTarget.blur();
                  }}
                  style={{ ...noteInputStyle, marginLeft: ROW_INDENT }}
                />
              ) : note ? (
                <button
                  type="button"
                  onClick={() => openNoteEditor(answer.noteKey)}
                  title={t("askDialog.editNote")}
                  style={{ marginLeft: ROW_INDENT, padding: 0, border: "none", background: "none", textAlign: "left", cursor: "pointer", color: "var(--status-success)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  ✎ {note}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  function renderAskQuestion(question: RpcAskDialogQuestion, index: number) {
    const draft = askDraftAt(index);
    const chooseKeptOther = () => {
      if (draft.otherChosen || !draft.other.trim()) return;
      updateAskDraft(index, (current) => ({ ...current, selected: question.multi ? current.selected : [], otherChosen: true }));
    };
    return (
      <div role={question.multi ? "group" : "radiogroup"} aria-label={question.question} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
        {question.options.map((option, optionIndex) => (
          <label key={option.label} className="extension-choice">
            <input
              type={question.multi ? "checkbox" : "radio"}
              name={`ask-${request.id}-${index}`}
              checked={draft.selected.includes(option.label)}
              onChange={(event) => {
                // A tap on the radio itself, unlike one on its label, does not
                // focus it once the press keeps focus in Other. Focus it so the
                // keyboard closes and further typing cannot pick Other.
                event.currentTarget.focus();
                updateAskDraft(index, (current) => question.multi
                  ? { ...current, selected: current.selected.includes(option.label) ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label] }
                  : { ...current, selected: [option.label], otherChosen: false });
                if (!question.multi) advanceAfterTab(index);
              }}
            />
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {option.label}
              {optionIndex === question.recommended && (
                <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>{t("askDialog.recommended")}</span>
              )}
              {option.description && (
                <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{option.description}</span>
              )}
              {option.preview && (
                <span style={{ display: "block", marginTop: 6, padding: 8, border: "1px solid var(--border)", borderRadius: 6, background: "var(--tool-bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{option.preview}</span>
              )}
            </span>
          </label>
        ))}
        {/* The Other option: its text box is the option, so what was typed
            stays in place while another option is chosen. */}
        <div className="extension-choice" data-checked={draft.otherChosen || undefined}>
          <input
            type={question.multi ? "checkbox" : "radio"}
            name={`ask-${request.id}-${index}`}
            aria-label={otherLabel}
            checked={draft.otherChosen}
            onChange={(event) => {
              const chosen = event.target.checked;
              updateAskDraft(index, (current) => ({ ...current, selected: chosen && !question.multi ? [] : current.selected, otherChosen: chosen }));
              if (chosen) document.getElementById(`ask-${request.id}-${index}-other`)?.focus();
            }}
          />
          <textarea
            id={`ask-${request.id}-${index}-other`}
            data-ask-editable="1"
            aria-label={otherLabel}
            placeholder={otherLabel}
            value={draft.other}
            // Going back into kept text means answering with it again. A tap
            // counts too: unticking Other by touch keeps focus in this box, so
            // tapping back into it fires no focus event.
            onFocus={chooseKeptOther}
            onClick={chooseKeptOther}
            rows={1}
            onChange={(event) => {
              const other = event.target.value;
              // Typing chooses Other (replacing a single-select choice);
              // clearing it unchooses, so a blank answer is no answer.
              updateAskDraft(index, (current) => other.trim()
                ? { selected: question.multi ? current.selected : [], other, otherChosen: true }
                : { ...current, other, otherChosen: false });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              // The text is stored on every keystroke, so sending it means
              // leaving the field — which drops the on-screen keyboard and
              // gives the footer its room back — and, for a single answer,
              // moving on exactly as picking an option does.
              event.preventDefault();
              event.stopPropagation();
              if (!draft.other.trim()) return;
              event.currentTarget.blur();
              if (!question.multi) advanceAfterTab(index);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--text)",
              outline: "none",
              resize: "none",
              fontSize: "var(--chat-font-size)",
              lineHeight: 1.55,
              fontFamily: "inherit",
              fieldSizing: "content",
              minHeight: "1.55em",
              maxHeight: 200,
            }}
          />
        </div>
      </div>
    );
  }

  function tabPanel(index: number, header: string | undefined, question: string, body: ReactNode, context?: ReactNode, error?: string) {
    const selected = activeTab === index;
    return (
      <div
        key={tabs[index].key}
        role="tabpanel"
        id={`ask-panel-${index}`}
        aria-labelledby={`ask-tab-${index}`}
        hidden={!selected}
        style={{ display: selected ? "grid" : "none", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}
      >
        {header && (
          <span style={{ justifySelf: "start", fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-muted)", background: "var(--bg-panel)" }}>
            {header}
          </span>
        )}
        {context}
        <div style={{ minWidth: 0, color: "var(--text)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{question}</div>
        {body}
        {error && <div role="alert" style={errorStyle}>{error}</div>}
        {renderNotes(index)}
      </div>
    );
  }

  function reviewPanel() {
    return (
      <div
        role="tabpanel"
        id="ask-panel-review"
        aria-labelledby="ask-tab-review"
        hidden={!isReviewTab}
        style={{ display: isReviewTab ? "grid" : "none", gridTemplateColumns: "minmax(0, 1fr)", gap: 10 }}
      >
        {showErrors && Object.keys(errors).length > 0 && <div role="alert" style={errorStyle}>{t("askDialog.fixErrors")}</div>}
        {unansweredCount > 0 && (
          <div style={{ color: "var(--status-warning)", fontSize: 12 }}>{tn("askDialog.unansweredWarning", unansweredCount)}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
          {tabs.map((tab, index) => {
            const answers = answersAt(index);
            const noted = answers.map((answer) => ({ answer, text: notes[answer.noteKey]?.trim() })).filter((entry) => entry.text);
            const error = showErrors ? errors[tab.key] : undefined;
            return (
              <div key={tab.key} style={{ minWidth: 0, fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                <span style={{ color: "var(--text-dim)" }}>{index + 1}. {tab.label}:</span>{" "}
                <span style={{ color: answers.length > 0 ? "var(--text)" : "var(--status-warning)" }}>
                  {answers.length > 0 ? answers.map((answer) => (answer.isOption ? answer.label : `"${answer.label}"`)).join(", ") : t("askDialog.unanswered")}
                </span>
                {noted.map(({ answer, text }) => (
                  <div key={answer.noteKey} style={{ marginLeft: 14, color: "var(--text-muted)", fontSize: 12 }}>{t("askDialog.note")}: {text}</div>
                ))}
                {error && <div style={{ ...errorStyle, marginLeft: 14 }}>{error}</div>}
              </div>
            );
          })}
        </div>
        {/* Form content after the last field has no tab of its own. */}
        {plan?.trailing}
      </div>
    );
  }

  const titleText = remainingMs === undefined ? t("askDialog.title") : `${t("askDialog.title")} (${Math.ceil(remainingMs / 1000)}s)`;

  const panels = plan ? (
    <form
      key={request.id}
      ref={formRef}
      onChange={(event) => refreshForm(event.currentTarget)}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
      className="extension-dialog-form"
    >
      {formTabs.map((tab, index) => tabPanel(
        index,
        tab.header,
        tab.question,
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>{tab.control}</div>,
        tab.context.length > 0 ? <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>{tab.context}</div> : undefined,
        showErrors ? errors[tab.key] : undefined,
      ))}
      {reviewPanel()}
    </form>
  ) : (
    <>
      {questions.map((question, index) => tabPanel(index, question.header, question.question, renderAskQuestion(question, index)))}
      {reviewPanel()}
    </>
  );

  return (
    <div
      className={attached ? undefined : "animate-fade-in"}
      onMouseDown={attached ? undefined : (event) => {
        // Close when the pointer goes down on the backdrop itself (not when
        // the press starts inside the panel and is dragged out).
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
        onKeyDown={(event) => {
          // The overlay has useModalDialog's document-level Escape; an
          // attached panel is not a modal, so it handles its own.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          resolveEscape();
        }}
        // Keeps the phone keyboard up while a text box of this panel has focus.
        {...pressGuard}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(640px, 100%)",
          boxSizing: "border-box",
          // Grid/flex children below must be able to shrink: a min-content
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
        <div className="ask-dialog-content" style={{ minWidth: 0, minHeight: 0, flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}>
          <div className="extension-dialog-header">
            <div style={{ color: "var(--text)", fontSize: 14, lineHeight: "20px", fontWeight: 650 }}>{titleText}</div>
          </div>

          <div
            role="tablist"
            aria-label={t("askDialog.title")}
            onKeyDown={handleTabKeyDown}
            style={{ display: "flex", gap: 4, minWidth: 0, padding: "6px 10px", borderBottom: "1px solid var(--border)", overflowX: "auto", background: "var(--bg-panel)" }}
          >
            {tabs.map((tab, index) => {
              const selected = activeTab === index;
              const answered = answeredAt(index);
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  id={`ask-tab-${index}`}
                  aria-selected={selected}
                  aria-controls={`ask-panel-${index}`}
                  aria-label={`${tab.label} (${answered ? t("askDialog.answered") : t("askDialog.unanswered")})`}
                  tabIndex={selected ? 0 : -1}
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
                  {tab.label}
                </button>
              );
            })}
            <button
              type="button"
              role="tab"
              id="ask-tab-review"
              aria-selected={isReviewTab}
              aria-controls="ask-panel-review"
              tabIndex={isReviewTab ? 0 : -1}
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

          <div style={{ padding: 14 }}>{panels}</div>
        </div>

        <div className="extension-dialog-footer" style={{ display: "flex", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button type="button" className="extension-dialog-button" onClick={cancel}>{t("askDialog.cancel")}</button>
          <button type="button" className="extension-dialog-button" onClick={() => respond({ kind: "chat" })}>{t("askDialog.chatAboutThis")}</button>
          {isReviewTab && (
            <button type="button" className="extension-dialog-button extension-dialog-button-primary" onClick={submit}>{t("askDialog.submit")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
