export interface AppUrlPanelState {
  /** Write `left=0`: the left sidebar is collapsed. Defaults (open) stay out of the URL. */
  left: boolean;
  /** Write `right=1`: the right panel is open. Defaults (closed) stay out of the URL. */
  right: boolean;
}

/**
 * Overlays the sidebar/right-panel collapse state onto a navigation href
 * already built elsewhere (`sessionNavigationUrl`'s `?session=…&host=…`, or
 * the bare `/`). `buildAppUrl` never constructs the session/cwd/host part
 * itself, only appends `left`/`right` to whatever `base` already encodes, so
 * every `router.replace` in AppShell keeps carrying the host a session needs.
 */
export function buildAppUrl(base: string, { left, right }: AppUrlPanelState): string {
  const params = new URLSearchParams(base.startsWith("?") ? base.slice(1) : "");
  if (left) params.set("left", "0");
  if (right) params.set("right", "1");
  const query = params.toString();
  return query ? `?${query}` : "/";
}
