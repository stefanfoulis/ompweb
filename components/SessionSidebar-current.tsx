"use client";

import { memo, useCallback, useSyncExternalStore } from "react";
import type { ExitedRpcSession, SessionInfo } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { SIDEBAR_BUTTON_TRANSITION } from "./SessionSidebar-chrome";
import { projectLabel } from "./SessionSidebar-helpers";
import { SessionItem } from "./SessionSidebar-rows";

/**
 * The sidebar's "Current" view: one flat list of the sessions that matter
 * right now, as opposed to the "All" view's workspace tree.
 *
 * A session is current when it is pinned (server-side, shared by every
 * browser), running (which covers a turn waiting on a question — the turn is
 * still in progress), or unread (it finished while the user was elsewhere).
 * Forks are listed next to their parents instead of nested, so each row names
 * its own workspace.
 */

export type SidebarView = "current" | "all";

const SIDEBAR_VIEW_STORAGE_KEY = "omp-web:sidebar-view";

const viewListeners = new Set<() => void>();

function subscribeSidebarView(onChange: () => void): () => void {
  viewListeners.add(onChange);
  return () => {
    viewListeners.delete(onChange);
  };
}

/** The stored view; "all" (the workspace tree) whenever nothing usable is stored. */
function storedSidebarView(): SidebarView {
  try {
    return window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "current" ? "current" : "all";
  } catch {
    return "all";
  }
}

function serverSidebarView(): SidebarView {
  return "all";
}

/**
 * The active view and a setter that persists it, per browser.
 *
 * An external store rather than state seeded from localStorage: the server
 * cannot know the stored choice, and a seeded `useState` would leave the
 * server's markup (the toggle's pressed button) next to a list the client
 * already re-rendered from storage. Here the stored value arrives as a normal
 * post-hydration render, so header and list always agree.
 */
export function useSidebarView(): [SidebarView, (view: SidebarView) => void] {
  const view = useSyncExternalStore(subscribeSidebarView, storedSidebarView, serverSidebarView);
  return [view, selectSidebarView];
}

function selectSidebarView(view: SidebarView): void {
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
  } catch {
    // ignore storage quota / privacy-mode errors
  }
  for (const listener of viewListeners) listener();
}

/**
 * The current sessions, most recent activity first. Running sessions lead:
 * their file's `modified` only catches up when omp flushes the turn, so
 * sorting on it alone would bury the session the user is watching.
 */
export function selectCurrentSessions(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): SessionInfo[] {
  const current = sessions.filter(
    (session) => session.pinned === true || runningSessionIds.has(session.id) || unreadSessionIds.has(session.id),
  );
  return current.sort((a, b) => {
    const running = Number(runningSessionIds.has(b.id)) - Number(runningSessionIds.has(a.id));
    if (running !== 0) return running;
    return b.modified.localeCompare(a.modified);
  });
}

/** The Current / All switch, in the sidebar's section header. */
export function SidebarViewToggle({ view, onChange }: { view: SidebarView; onChange: (view: SidebarView) => void }) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={t("sessionSidebar.viewToggle")} style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
      <ViewToggleButton label={t("sessionSidebar.viewCurrent")} active={view === "current"} onClick={() => onChange("current")} />
      <ViewToggleButton label={t("sessionSidebar.viewAll")} active={view === "all"} onClick={() => onChange("all")} />
    </div>
  );
}

function ViewToggleButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-view-toggle-button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        height: 22,
        padding: "0 7px",
        flexShrink: 0,
        border: "none",
        borderRadius: "var(--radius-control)",
        background: active ? "var(--bg-hover)" : "none",
        color: active ? "var(--accent)" : "var(--text-dim)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        transition: SIDEBAR_BUTTON_TRANSITION,
      }}
    >
      {label}
    </button>
  );
}

interface CurrentSessionListProps {
  /** Already filtered by the header's search and running-only controls. */
  sessions: readonly SessionInfo[];
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  exitedSessions: ReadonlyMap<string, ExitedRpcSession>;
  relativeTimeNow: number;
  /** Display name of a session's workspace (registry alias when it has one). */
  workspaceLabelFor?: (session: SessionInfo) => string;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  /** True while a filter is on: the empty state then reads as "no matches". */
  filtersActive?: boolean;
}

export function CurrentSessionList({
  sessions,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  exitedSessions,
  relativeTimeNow,
  workspaceLabelFor,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  filtersActive = false,
}: CurrentSessionListProps) {
  const { t } = useI18n();
  if (sessions.length === 0) {
    return (
      <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>
        {filtersActive ? t("sessionSidebar.noMatches") : t("sessionSidebar.currentEmpty")}
      </div>
    );
  }
  return (
    <div>
      {sessions.map((session) => (
        <CurrentSessionRow
          key={session.id}
          session={session}
          workspaceLabel={workspaceLabelFor?.(session) ?? projectLabel(session.projectRoot || session.cwd)}
          isSelected={session.id === selectedSessionId}
          isRunning={runningSessionIds.has(session.id)}
          isUnread={unreadSessionIds.has(session.id)}
          exited={exitedSessions.get(session.id)}
          relativeTimeNow={relativeTimeNow}
          onSelectSession={onSelectSession}
          onRenamed={onRenamed}
          onSessionDeleted={onSessionDeleted}
        />
      ))}
    </div>
  );
}

/** Holds the per-session callbacks so SessionItem's memo check keeps working. */
const CurrentSessionRow = memo(function CurrentSessionRow({
  session,
  workspaceLabel,
  isSelected,
  isRunning,
  isUnread,
  exited,
  relativeTimeNow,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
}: {
  session: SessionInfo;
  workspaceLabel: string;
  isSelected: boolean;
  isRunning: boolean;
  isUnread: boolean;
  exited?: ExitedRpcSession;
  relativeTimeNow: number;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
}) {
  const handleClick = useCallback(() => {
    onSelectSession(session);
  }, [onSelectSession, session]);
  const handleDeleted = useCallback((id: string) => {
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);
  return (
    <SessionItem
      session={session}
      workspaceLabel={workspaceLabel}
      isSelected={isSelected}
      isRunning={isRunning}
      isUnread={isUnread}
      exited={exited}
      relativeTimeNow={relativeTimeNow}
      onClick={handleClick}
      onRenamed={onRenamed}
      onDeleted={handleDeleted}
    />
  );
});
