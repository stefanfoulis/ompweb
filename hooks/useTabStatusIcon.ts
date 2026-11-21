"use client";

import { useCallback, useEffect, useRef } from "react";
import type { TabStatus } from "@/lib/tab-status";

/** Stable id for the `<link>` this hook owns, so repeated calls find it instead of creating duplicates. */
const FAVICON_LINK_ID = "tab-status-favicon";
/** Same-origin PNG so the canvas isn't tainted (an .ico cannot be drawn at all). */
const BASE_ICON_SRC = "/icon-192.png";
const CANVAS_SIZE = 64;
const DOT_RADIUS = 11;
const RING_RADIUS = 13;
const RING_COLOR = "#FFFFFF";

const DOT_COLORS: Record<Exclude<TabStatus, "idle">, string> = {
  waiting: "#F59E0B",
  error: "#EF4444",
  busy: "#3B82F6",
  done: "#22C55E",
};

// Module-scoped: the base icon and each state's rendered PNG are the same
// for every session, so a session switch (which remounts the hook) reuses
// them instead of redecoding the icon and redrawing the canvas.
let baseIconPromise: Promise<HTMLImageElement> | null = null;
function loadBaseIcon(): Promise<HTMLImageElement> {
  if (!baseIconPromise) {
    const { promise, resolve, reject } = Promise.withResolvers<HTMLImageElement>();
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      // Forget the failure so a later status change can try again.
      baseIconPromise = null;
      reject(new Error("failed to load base favicon"));
    };
    img.src = BASE_ICON_SRC;
    baseIconPromise = promise;
  }
  return baseIconPromise;
}

const iconDataUrlCache = new Map<TabStatus, string>();

/** Draws the base icon with the status dot overlaid, bottom-right, ring first so the fill sits on top. */
async function renderStatusIcon(status: Exclude<TabStatus, "idle">): Promise<string> {
  const cached = iconDataUrlCache.get(status);
  if (cached) return cached;
  const img = await loadBaseIcon();
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return BASE_ICON_SRC;
  ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const cx = CANVAS_SIZE - RING_RADIUS - 2;
  const cy = CANVAS_SIZE - RING_RADIUS - 2;
  ctx.beginPath();
  ctx.arc(cx, cy, RING_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = RING_COLOR;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = DOT_COLORS[status];
  ctx.fill();
  const dataUrl = canvas.toDataURL("image/png");
  iconDataUrlCache.set(status, dataUrl);
  return dataUrl;
}

/**
 * Renders the open session's status as a colored dot over the app's favicon,
 * replacing the page's `<link rel="icon">` tags while active and restoring
 * them on "idle" or unmount. Never touches the PWA manifest or document.title.
 */
export function useTabStatusIcon(status: TabStatus): void {
  // True once this hook has detached the page's native icon links in favor
  // of its own; guards against re-stashing an already-empty native set.
  const appliedRef = useRef(false);
  const stashedLinksRef = useRef<HTMLLinkElement[]>([]);

  const restoreIcons = useCallback(() => {
    if (!appliedRef.current) return;
    appliedRef.current = false;
    for (const el of stashedLinksRef.current) document.head.appendChild(el);
    stashedLinksRef.current = [];
    document.getElementById(FAVICON_LINK_ID)?.remove();
  }, []);

  useEffect(() => {
    if (status === "idle") {
      restoreIcons();
      return;
    }
    let cancelled = false;
    if (!appliedRef.current) {
      appliedRef.current = true;
      // Next renders `<link rel="icon">`/`"shortcut icon"` for app/favicon.ico;
      // left in place the browser may keep showing it instead of ours.
      const natives = Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
        .filter((el) => el.id !== FAVICON_LINK_ID);
      stashedLinksRef.current = natives;
      for (const el of natives) el.remove();
    }
    let link = document.getElementById(FAVICON_LINK_ID) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = FAVICON_LINK_ID;
      link.rel = "icon";
      document.head.appendChild(link);
    }
    const ownLink = link;
    // A dot that cannot be drawn (icon failed to load, no canvas) falls back
    // to the plain icon rather than leaving the tab without one.
    renderStatusIcon(status).then(
      (href) => { if (!cancelled) ownLink.href = href; },
      () => { if (!cancelled) ownLink.href = BASE_ICON_SRC; },
    );
    return () => {
      cancelled = true;
    };
  }, [status, restoreIcons]);

  // Unmount (session switch, navigating away): always hand the favicon back.
  useEffect(() => () => restoreIcons(), [restoreIcons]);
}
