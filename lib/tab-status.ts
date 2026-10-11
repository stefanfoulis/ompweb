// Pure logic for the browser tab's favicon status dot (see useTabStatusIcon).
// Kept free of the DOM/canvas so the precedence and done-unseen transitions
// are unit-testable without a browser.

export type TabStatus = "waiting" | "error" | "busy" | "done" | "idle";

export interface TabStatusInputs {
  /** An `extensionDialog` (ask/select/confirm/input/editor) is open. */
  extensionDialogPending: boolean;
  /** An open_url (including OAuth/login) request is waiting for the user to confirm. */
  openUrlPending: boolean;
  /** The session's last run ended in an error. */
  errored: boolean;
  agentRunning: boolean;
  bashRunning: boolean;
  activeSubagentCount: number;
  /** A run finished while the tab was hidden or unfocused, not yet seen. */
  doneUnseen: boolean;
}

/**
 * Most urgent state wins: a pending question outranks a stale error, which
 * outranks "still working", which outranks an unseen completion.
 */
export function deriveTabStatus(inputs: TabStatusInputs): TabStatus {
  if (inputs.extensionDialogPending || inputs.openUrlPending) return "waiting";
  if (inputs.errored) return "error";
  if (inputs.agentRunning || inputs.bashRunning || inputs.activeSubagentCount > 0) return "busy";
  if (inputs.doneUnseen) return "done";
  return "idle";
}

/**
 * True when the transcript's last message is a failed assistant turn
 * (`stopReason: "error"`, the same signal `readAgentError` stamps in
 * useAgentSession.ts). A new prompt appends a user message before the next
 * run starts, which is never "assistant", so this clears itself as soon as
 * the user tries again — no separate reset is needed.
 */
export function lastMessageErrored(messages: ReadonlyArray<{ role?: string; stopReason?: string }>): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && last.stopReason === "error";
}

export type DoneUnseenAction =
  /** A run just ended; `hidden`/`focused` are the tab's state at that moment. */
  | { type: "run_ended"; hidden: boolean; focused: boolean }
  /** The tab became visible and focused: the user has now seen it. */
  | { type: "visible_and_focused" }
  /** The open session changed: a different session's completion does not apply. */
  | { type: "session_change" };

export function doneUnseenReducer(state: boolean, action: DoneUnseenAction): boolean {
  switch (action.type) {
    case "run_ended":
      return action.hidden || !action.focused;
    case "visible_and_focused":
    case "session_change":
      return false;
    default:
      return state;
  }
}
