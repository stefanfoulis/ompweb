export interface AppUrlTarget {
  sessionId?: string | null;
  cwd?: string | null;
  /** Write `left=0`: the left sidebar is collapsed. Defaults (open) stay out of the URL. */
  left: boolean;
  /** Write `right=1`: the right panel is open. Defaults (closed) stay out of the URL. */
  right: boolean;
}

/**
 * Builds the href for the app's single route, carrying the active session
 * (or cwd) alongside the sidebar/right-panel collapse state. Every
 * `router.replace` call in AppShell goes through this so switching sessions
 * never drops the panel params, and toggling a panel never drops the session.
 */
export function buildAppUrl({ sessionId, cwd, left, right }: AppUrlTarget): string {
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  else if (sessionId) params.set("session", sessionId);
  if (left) params.set("left", "0");
  if (right) params.set("right", "1");
  const query = params.toString();
  return query ? `?${query}` : "/";
}
