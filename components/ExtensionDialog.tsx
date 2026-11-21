"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AgentConfirmPayload, UiApprovalAnswer, UiDialogRequest, UiDialogValue } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { matchMobileViewport } from "@/hooks/useIsMobile";
import { SessionLink } from "./SessionLink";
import { AskDialog } from "./AskDialog";

// Fields that raise the on-screen keyboard: every input but a radio/checkbox.
const TEXT_ENTRY = "input:not([type=radio]):not([type=checkbox]), textarea";

// Keyboard-aware panel height. The on-screen keyboard shrinks the visible
// area, so a panel sized against the layout viewport alone keeps its footer
// (Cancel / Submit) below the keyboard. `dvh` follows the layout viewport —
// the placeholder cap — which older mobile browsers shrink for the keyboard
// too, so this is a backstop rather than a duplicate.
const DEFAULT_PANEL_MAX_HEIGHT = "min(420px, 60dvh)";
// Room the browser chrome and the keyboard accessory bar need above the panel.
const VIEWPORT_BLEED = 12;
// How much shorter the visual viewport must be before we call it a keyboard.
const KEYBOARD_INSET = 120;
// Some mobile browsers open the keyboard without resizing anything we can
// observe; a slow re-check costs nothing while a question is on screen.
const KEYBOARD_POLL_MS = 400;

function readPanelMaxHeight(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const visual = window.visualViewport?.height;
  const height = typeof visual === "number" && visual > 0
    ? Math.min(visual, window.innerHeight)
    : window.innerHeight;
  return height > 0 ? Math.max(180, Math.round(height - VIEWPORT_BLEED)) : undefined;
}

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  // Feature-detect the methods too: Safari 13 shipped a bare `visualViewport`.
  if (typeof viewport?.addEventListener !== "function") return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * CSS length px cap for a panel in the composer: the height of the visible
 * area, so the footer stays on screen while the soft keyboard is up. Reads
 * `undefined` when there is no window (SSR, tests) — the CSS default then
 * applies unchanged.
 */
export function useViewportMaxHeight(): number | undefined {
  return useSyncExternalStore(subscribeViewport, readPanelMaxHeight, () => undefined);
}

/** Height of the visible area, falling back to the layout viewport. */
function visibleHeight(): number {
  const visual = window.visualViewport?.height;
  return typeof visual === "number" && visual > 0 ? visual : window.innerHeight;
}

/**
 * Per-panel soft-keyboard tracking for a composer-attached request, active
 * only while a text field inside the panel has focus. A panel in the composer
 * is not a modal, so the browser is free to scroll the page when the keyboard
 * opens; this is what keeps the footer (Cancel / Submit) inside the visible
 * area (#236). A focused option or button raises no keyboard, so it must not
 * resize the panel either: that resize made the tap that focused it miss.
 *
 * Two signals, because neither alone is enough: `visualViewport` shrinking is
 * the real keyboard (fingerprint-free), and a coarse pointer means the tap
 * that focused a field will raise one even before the browser has repainted.
 * A slow re-check covers mobile browsers that resize nothing on focus.
 */
export function useMobileInputOpen(panelRef: RefObject<HTMLDivElement | null>, attached: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!attached) {
      setOpen(false);
      return;
    }
    let focused = false;
    // Browsers cannot report the keyboard itself. It opens when the visible
    // area drops well below the tallest seen at this width, and closes when
    // the area grows well above its lowest since then. Comparing to
    // `innerHeight` cannot work: with `interactive-widget: resizes-content`
    // (app/index.html) the keyboard shrinks the layout viewport too.
    let width = window.innerWidth;
    let fullHeight = Math.max(visibleHeight(), window.innerHeight);
    // Lowest visible height while the keyboard is up; null while it is down.
    let keyboardLow: number | null = null;
    // `pointerType` of the latest press anywhere: a hybrid laptop's primary
    // pointer is fine, yet a touch tap there still raises a soft keyboard.
    let lastPointer: string | null = null;
    const onPointerDown = (event: PointerEvent) => { lastPointer = event.pointerType; };
    const update = () => {
      const height = visibleHeight();
      const touch = lastPointer ? lastPointer !== "mouse" : touchPointer();
      if (window.innerWidth !== width) {
        // Rotation or a resized window: the old heights mean nothing at the
        // new size. An open keyboard stays open; its collapse is still a rise.
        width = window.innerWidth;
        fullHeight = height;
        if (keyboardLow !== null) keyboardLow = height;
      }
      fullHeight = Math.max(fullHeight, height);
      if (!touch) {
        // No soft keyboard: a window or docked dev tools resizing is not one.
        keyboardLow = null;
      } else if (keyboardLow === null) {
        if (height < fullHeight - KEYBOARD_INSET) keyboardLow = height;
      } else if (height > keyboardLow + KEYBOARD_INSET) {
        keyboardLow = null;
        // Collapsing the keyboard (back button, swipe) keeps the text field
        // focused, and the next tap anywhere would raise it again for a
        // moment. A closed keyboard means the user is done typing.
        if (focused && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      } else {
        keyboardLow = Math.min(keyboardLow, height);
      }
      // A keyboard over the page (no layout resize) shows on any device.
      const overlaid = height < window.innerHeight - KEYBOARD_INSET;
      const isOpen = focused && (touch || overlaid);
      setOpen((current) => (current === isOpen ? current : isOpen));
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focused = target instanceof Element && target.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(target));
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      focused = next instanceof Element && next.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(next));
      update();
    };
    update();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    const poll = setInterval(update, KEYBOARD_POLL_MS);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      clearInterval(poll);
    };
  }, [attached, panelRef]);
  return open;
}

/**
 * Whether a composer-attached request should leave focus alone. Touch input
 * means the browser would raise the on-screen keyboard and yank the panel the
 * user has not read yet into view, so the request waits for a tap. The mobile
 * breakpoint covers where pointer media queries do not answer (older mobile
 * browsers, jsdom, a desktop browser's touch emulation); a narrow *desktop*
 * window is deferred too, which is the deliberate trade for never raising a
 * phone keyboard. Exported for the regression tests (#235).
 */
export function shouldDeferAttachedFocus(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return touchPointer() || matchMobileViewport();
}

/** The primary pointer is a finger: `(pointer: fine)` is the repo's test for a
 * mouse/trackpad, the same one `lib/composer-prefs.ts` uses for word
 * completion, so an unanswerable media query never counts as touch. */
function touchPointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(pointer: fine)").matches;
}

const SENSITIVE_PATTERN = /\b(passwords?|passphrases?|secrets?|tokens?|api[_\s-]?keys?|access[_\s-]?tokens?|private[_\s-]?keys?|auth[_\s-]?tokens?|credentials?)\b/i;
const NON_SECRET_METADATA_PATTERN = /\b(token\s+(?:name|count|limit|budget|usage)|max\s+tokens)\b/i;

export function isSensitivePrompt(title?: string, placeholder?: string): boolean {
  const titleText = (title ?? "").trim();
  const placeholderText = (placeholder ?? "").trim();
  const fullText = `${titleText} ${placeholderText}`.trim();
  if (!fullText) return false;
  const strippedTitle = titleText.replace(NON_SECRET_METADATA_PATTERN, "");
  if (SENSITIVE_PATTERN.test(strippedTitle)) return true;
  const strippedFull = fullText.replace(NON_SECRET_METADATA_PATTERN, "");
  return SENSITIVE_PATTERN.test(strippedFull);
}

/**
 * Panel props that keep the soft keyboard up while one of the panel's own
 * text boxes has focus: a press elsewhere in it (an option, Cancel, Submit)
 * must not move focus, or the keyboard closes and the panel resizes before
 * the click, so the press misses what it aimed at. A pressed option label
 * still focuses its radio once the click lands, so the keyboard closes after
 * the choice is made. Touch and pen only, judged per press (a hybrid laptop
 * has both): a mouse keeps text selection and radio arrow keys.
 */
export function useKeyboardPressGuard() {
  // `pointerType` of the latest press: the pointer media query only describes
  // the primary pointer, not the one pressing now.
  const pressPointer = useRef<string | null>(null);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => { pressPointer.current = event.pointerType; },
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target as Element;
      const pointer = pressPointer.current;
      if (pointer && pointer !== "mouse" && document.activeElement?.matches(TEXT_ENTRY) && event.currentTarget.contains(document.activeElement) && !target.closest(TEXT_ENTRY)) {
        event.preventDefault();
      }
    },
  };
}

/** A request the standard panel draws: a question goes to the tabbed AskDialog instead. */
type StandardDialogRequest = Exclude<UiDialogRequest, { method: "askDialog" | "formDialog" }>;

function dialogTitle(request: StandardDialogRequest): string {
  return request.method === "approve" ? request.args[0].full.split("\n", 1)[0] : request.args[0];
}

/** omp's approval choices, in its order: this call, the session, each grant, then no. */
function approvalChoices(request: Extract<UiDialogRequest, { method: "approve" }>, allow: string, deny: string): { label: string; value: UiApprovalAnswer }[] {
  const [prompt] = request.args;
  return [
    { label: allow, value: "once" },
    ...(prompt.session ? [{ label: prompt.session, value: "session" as const }] : []),
    ...(prompt.grants ?? []).flatMap((grant) => [
      { label: grant.label, value: { grant: grant.scope, always: false } },
      { label: grant.alwaysLabel, value: { grant: grant.scope, always: true } },
    ]),
    { label: deny, value: "deny" },
  ];
}


function ServerConfirmBody({ payload }: { payload: AgentConfirmPayload }) {
  const row = (label: string, value: ReactNode) => (
    <div style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr)", gap: 8 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ minWidth: 0, color: "var(--text)" }}>{value}</span>
    </div>
  );
  const message = payload.message;
  return (
    <div style={{ display: "grid", gap: 8, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
      {row("From", <><SessionLink session={payload.from} newTab /> · {payload.from.hostLabel}</>)}
      {payload.kind === "send_to_session" ? (
        <>
          {row("To", payload.to ? <><SessionLink session={payload.to} newTab /> · {payload.to.hostLabel}</> : "Unknown session")}
          {row("Delivery", payload.delivery === "followUp" ? "Follow-up" : payload.delivery === "prompt" ? "New turn" : "Steer")}
        </>
      ) : (
        <>
          {row("Host", payload.host.label)}
          {row("Directory", <code>{payload.cwd}</code>)}
        </>
      )}
      {message && (
        <pre style={{ margin: "4px 0 0", maxHeight: 300, overflow: "auto", padding: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--tool-bg)", color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {message}
        </pre>
      )}
    </div>
  );
}

/** A question — omp's `askDialog` or `formDialog` — is answered by the tabbed panel. */
export function ExtensionDialog(props: {
  request: UiDialogRequest;
  /** Answers with omp's return value (`undefined` cancels); resolves `false` when it could not be sent. */
  onRespond: (request: UiDialogRequest, value: UiDialogValue | undefined) => void | Promise<boolean>;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { request } = props;
  if (request.method === "askDialog" || request.method === "formDialog") {
    return <AskDialog request={request} onRespond={props.onRespond} attached={props.attached ?? false} />;
  }
  return <StandardExtensionDialog request={request} onRespond={props.onRespond} attached={props.attached} />;
}

/**
 * Overlay dialog for omp's `ExtensionUIContext` dialogs as the runner sends them.
 * Polished UX:
 *   - entrance animation (fade backdrop + scale-in panel)
 *   - focus trap: focus moves into the dialog on open and is returned to the
 *     opener on close; Tab/Shift-Tab wrap inside (via useModalDialog)
 *   - Escape closes as "cancelled" (document-level, top-of-stack only)
 *   - backdrop click closes as "cancelled"
 * Logic and i18n keys are unchanged from the in-ChatWindow original.
 */
function StandardExtensionDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: StandardDialogRequest;
  /** Answers with omp's return value (`undefined` cancels); resolves `false` when it could not be sent. */
  onRespond: (request: StandardDialogRequest, value: UiDialogValue | undefined) => void | Promise<boolean>;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.args[1] ?? "" : "");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const requestIdRef = useRef(request.id);
  const pressGuard = useKeyboardPressGuard();
  // omp takes one answer per request id and the panel stays up until the next request arrives, so the
  // select controls are disabled in that window instead of sending a tap omp would silently drop.
  const [answeredId, setAnsweredId] = useState<UiDialogRequest["id"] | null>(null);
  const awaitingNext = request.method === "select" && answeredId === request.id;
  const viewportMaxHeight = useViewportMaxHeight();

  useEffect(() => {
    // SSE reconnects replay the same request as a fresh object, not a new question.
    if (requestIdRef.current === request.id) return;
    requestIdRef.current = request.id;
    setValue(request.method === "editor" ? request.args[1] ?? "" : "");
    setShowPassword(false);
    setSelectedOption(null);
  }, [request]);

  const canSubmit = request.method !== "select" || selectedOption !== null;
  const title = dialogTitle(request);
  const serverPayload = request.method === "confirm" ? request.serverPayload : undefined;

  // Answering removes the panel. Release its text field first, in the same
  // task, so the phone keyboard closes once instead of flashing as the
  // focused field disappears from under it.
  const respond = (response: UiDialogValue | undefined) => {
    if (request.method === "select") {
      if (awaitingNext) return;
      setAnsweredId(request.id);
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    const id = request.id;
    void Promise.resolve(onRespond(request, response)).then((sent) => {
      if (sent === false) setAnsweredId((current) => current === id ? null : current);
    });
  };
  const cancel = () => respond(undefined);

  // useModalDialog gives us: focus-in on open, focus-restore on close,
  // document-level Escape (top-of-stack), and Tab wrapping inside the panel.
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: cancel,
    // A composer-attached request is a regular in-flow panel, not a modal.
    active: !attached,
  });
  const keyboardOpen = useMobileInputOpen(panelRef, attached);
  // While the keyboard is up the panel fills the visible area instead of the
  // taller layout-viewport cap, so the footer with Cancel / Submit stays in
  // reach (#236).
  const attachedMaxHeight = keyboardOpen && viewportMaxHeight !== undefined
    ? `${viewportMaxHeight}px`
    : DEFAULT_PANEL_MAX_HEIGHT;

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
      // Never land on a radio or checkbox: a stray Space on a focused radio
      // selects that option, which silently overwrites what the user typed in
      // "Other". Prefer the first text entry, then any button.
      const target = panel.querySelector<HTMLElement>(
        `${TEXT_ENTRY}, button:not([disabled])`,
      );
      (target ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const submitValue = () => {
    if (request.method === "confirm") {
      respond(true);
    } else if (request.method === "select") {
      if (selectedOption !== null) respond(selectedOption);
    } else if (request.method !== "approve") {
      respond(value);
    }
  };

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
        aria-label={title}
        tabIndex={-1}
        // Keeps the phone keyboard up while a text box of this panel has focus.
        {...pressGuard}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(560px, 100%)",
          boxSizing: "border-box",
          // Grid/flex children below must be able to shrink: a min-content
          // question or option is wider than a phone, and without this the
          // panel grows past its composer column and gets clipped (#234).
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? attachedMaxHeight : "100%",
        }}
      >
        <div className="extension-dialog-content" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}>
        <div className="extension-dialog-header">
          <div style={{ color: "var(--text)", fontSize: 14, lineHeight: "20px", fontWeight: 650, whiteSpace: "pre-wrap" }}>{title}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11, lineHeight: "16px", fontFamily: "var(--font-mono)" }}>{t("chatWindow.extensionRequest")}</div>
        </div>

        <div className="extension-dialog-body">
          {request.method === "confirm" && (
            serverPayload
              ? <ServerConfirmBody payload={serverPayload} />
              : <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.args[1]}</div>
          )}
          {request.method === "approve" && (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ marginBottom: 6, padding: "8px 12px", borderRadius: 8, background: "var(--tool-bg)", color: "var(--text-muted)", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)" }}>
                {request.args[0].full.split("\n").slice(1).join("\n")}
              </div>
              {approvalChoices(request, t("settingsConfig.allow"), t("settingsConfig.deny")).map((choice) => (
                <button key={choice.label} className="extension-choice" onClick={() => respond(choice.value)}>
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {request.method === "select" && (() => {
            const [, items, dialogOptions] = request.args;
            return (
            <div style={{ display: "grid", gap: 6 }}>
              {items.map((item, index) => {
                const option = typeof item === "string" ? item : item.label;
                const selected = selectedOption === option;
                const markable = dialogOptions?.selectionMarker === "checkbox";
                const checkbox = markable && index < (dialogOptions.markableCount ?? items.length);
                const checked = checkbox && (dialogOptions.checkedIndices?.includes(index) ?? false);
                // A checkbox toggle goes out at once even when attached: staging it for Next would let the
                // next row (often "Done selecting") silently replace it, and a stray toggle is undone by one tap.
                const stage = attached && !checkbox;
                return (
                  <button
                    key={option}
                    // A row past omp's markable ones ("Done selecting") is an action, not an answer.
                    className={markable && !checkbox ? "extension-choice extension-choice-action" : "extension-choice"}
                    data-checked={selected || checked || undefined}
                    onClick={() => stage ? setSelectedOption(option) : respond(option)}
                    disabled={awaitingNext}
                    aria-pressed={stage ? selected : undefined}
                  >
                    {checkbox && <span aria-hidden="true" className="extension-choice-mark">{checked ? "☑" : "☐"}</span>}
                    <span style={{ minWidth: 0 }}>
                      {option}
                      {typeof item !== "string" && item.description && (
                        <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: "18px" }}>{item.description}</span>
                      )}
                      {checkbox && <span className="sr-only">, {t(checked ? "chatWindow.optionChecked" : "chatWindow.optionUnchecked")}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            );
          })()}
          {request.method === "input" && (() => {
            const [inputTitle, placeholder, dialogOptions] = request.args;
            const isSensitive = Boolean(dialogOptions?.secret) ||
              (dialogOptions?.secret !== false && isSensitivePrompt(inputTitle, placeholder ?? undefined));
            return (
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  autoFocus
                  type={isSensitive && !showPassword ? "password" : "text"}
                  autoComplete={isSensitive ? "off" : undefined}
                  autoCorrect={isSensitive ? "off" : undefined}
                  autoCapitalize={isSensitive ? "off" : undefined}
                  spellCheck={isSensitive ? false : undefined}
                  data-1p-ignore={isSensitive ? "true" : undefined}
                  aria-label={inputTitle || placeholder || "Input value"}
                  value={value}
                  placeholder={placeholder ?? undefined}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitValue();
                  }}
                  className="extension-field"
                  style={{ width: "100%", paddingRight: isSensitive ? 36 : undefined }}
                />
                {isSensitive && (
                  <button
                    type="button"
                    aria-label={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    title={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    onClick={() => setShowPassword((prev) => !prev)}
                    style={{
                      position: "absolute",
                      right: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 24,
                      height: 24,
                      padding: 0,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                    }}
                  >
                    {showPassword ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                )}
              </div>
            );
          })()}
          {request.method === "editor" && (
            <textarea
              autoFocus
              aria-label={request.args[0] || "Input value"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              className="extension-field"
              style={{
                width: "100%",
                height: "min(220px, 30dvh)",
                minHeight: 80,
                resize: "vertical",
                fontSize: request.args[3]?.promptStyle ? "var(--chat-font-size)" : 13,
                lineHeight: 1.55,
                fontFamily: request.args[3]?.promptStyle ? "inherit" : "var(--font-mono)",
              }}
            />
          )}
        </div>
        </div>

        <div className="extension-dialog-footer" style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button className="extension-dialog-button" onClick={cancel}>
            {serverPayload ? "Deny" : t("chatWindow.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue}>
              {serverPayload?.kind === "send_to_session" ? "Allow and send" : serverPayload ? "Allow and start" : t("chatWindow.confirm")}
            </button>
          ) : request.method === "select" && attached ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue} disabled={!canSubmit || awaitingNext}>
              {t("chatWindow.next")}
            </button>
          ) : request.method !== "select" && request.method !== "approve" ? (
            <button className="extension-dialog-button extension-dialog-button-primary" onClick={submitValue}>
              {t("chatWindow.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
