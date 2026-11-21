import { createHash } from "crypto";
import { listSessionsAllHosts } from "@/lib/hosts/session-index";
import { listPinnedSessionIds } from "@/lib/pin-store";
import { getRunningRpcSessions } from "@/lib/rpc-manager";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

export async function GET(req: Request) {
  try {
    const filterId = new URL(req.url).searchParams.get("id");

    const listed = await listSessionsAllHosts();
    // Pins are server-side state, so they ride along in the list body: the
    // ETag below then changes the moment a pin does, and every client picks
    // the new state up on its normal refresh. Only pinned rows get a copy —
    // the rest stay the cached list's own objects.
    const pinned = listPinnedSessionIds(new Set(listed.map((session) => session.id)));
    const sessions = pinned.size === 0
      ? listed
      : listed.map((session) => (pinned.has(session.id) ? { ...session, pinned: true } : session));
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);

    if (filterId) {
      const matched = sessions.filter((s) => s.id === filterId);
      const body = { sessions: matched, runningSessionIds, runningSessions };
      const bodyJson = JSON.stringify(body);
      return new Response(bodyJson, {
        headers: { "Content-Type": "application/json", ...SESSION_LIST_HEADERS },
      });
    }

    const body = { sessions, runningSessionIds, runningSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;

    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new Response(bodyJson, {
      headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
