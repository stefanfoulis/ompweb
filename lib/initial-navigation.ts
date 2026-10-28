export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  hostId?: string;
  /** The left sidebar starts open unless the URL asks to collapse it (`left=0`). */
  sidebarOpen: boolean;
  /** The right panel starts closed unless the URL asks to open it (`right=1`). */
  rightPanelOpen: boolean;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    ...(requestedCwd && searchParams.get("hostId") !== null ? { hostId: searchParams.get("hostId")! } : {}),
    sidebarOpen: searchParams.get("left") !== "0",
    rightPanelOpen: searchParams.get("right") === "1",
  };
}
