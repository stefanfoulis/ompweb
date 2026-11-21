import { resolveSessionHostOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { setSessionPinned } from "@/lib/pin-store";
import { isRecord } from "@/lib/type-guards";

/** POST /api/sessions/[id]/pin — `{ pinned: boolean }`. The pin lives on the
 * server, so every browser on this omp-web sees it on its next session list.
 * It is keyed by session id alone, so a session on any host can be pinned. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionHostOr404(id);
    if ("response" in resolved) return resolved.response;
    // Oversized or malformed input is the same client error as a missing flag.
    const body = await parseJsonWithinLimit<unknown>(req, 4 * 1024).catch(() => null);
    const pinned = isRecord(body) ? body.pinned : undefined;
    if (typeof pinned !== "boolean") {
      return Response.json({ error: "pinned is required", code: "session_pinned_required" }, { status: 400 });
    }
    setSessionPinned(id, pinned);
    return Response.json({ ok: true, pinned });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "session_pin_failed" }, { status: 500 });
  }
}
