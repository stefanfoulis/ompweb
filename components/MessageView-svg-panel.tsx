"use client";

import { isRecord } from "@/lib/type-guards";
import { SvgBlock } from "./SvgBlock";

/**
 * Inline SVG preview for `write` tool calls that create an `.svg` file,
 * mirroring how TaskResultPanel/HubResultPanel add a semantic body above the
 * generic input dump. Reuses SvgBlock wholesale, so the raw markup stays
 * reachable through its own Preview/Source toggle. Renders null for every
 * other tool call or input shape, leaving the generic rendering untouched.
 */
export function SvgWritePreviewPanel({ toolName, input }: { toolName: string; input: unknown }) {
  const name = toolName.toLowerCase();
  if (name !== "write" && !name.endsWith(".write")) return null;
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.content !== "string") return null;
  if (!/\.svg$/i.test(input.path)) return null;

  return (
    <div className="tool-call-svg-preview">
      <SvgBlock code={input.content} />
    </div>
  );
}
