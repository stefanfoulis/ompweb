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
  const hostId = searchParams.get(requestedCwd ? "hostId" : "host");

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    ...(hostId !== null ? { hostId } : {}),
    sidebarOpen: searchParams.get("left") !== "0",
    rightPanelOpen: searchParams.get("right") === "1",
  };
}

export function initialSessionMatches(
  session: { id: string; hostId?: string },
  navigation: Pick<InitialNavigation, "sessionId" | "hostId">,
): boolean {
  return session.id === navigation.sessionId
    && (navigation.hostId === undefined || (session.hostId ?? "local") === navigation.hostId);
}

type SessionTarget = { id: string; hostId?: string };

export function sameSessionTarget(left: SessionTarget, right: SessionTarget): boolean {
  return left.id === right.id && (left.hostId ?? "local") === (right.hostId ?? "local");
}

export function sessionNavigationUrl(session: SessionTarget): string {
  return `?session=${encodeURIComponent(session.id)}&host=${encodeURIComponent(session.hostId ?? "local")}`;
}

export function findSessionTarget<T extends SessionTarget>(
  sessions: readonly T[],
  target: SessionTarget,
): T | undefined {
  return sessions.find((session) => sameSessionTarget(session, target));
}
