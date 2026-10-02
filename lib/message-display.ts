import type { AssistantContentBlock, AssistantMessage, ThinkingContent } from "./types";

/** CustomMessage.customType for omp's `continue` RPC directive (a hidden
 *  role:"developer", `synthetic: true` message that resumes the agent).
 *  Shared by lib/session-reader.ts (reload) and hooks/useAgentSession.ts
 *  (live SSE) so both paths tag it the same way; rendered as the collapsed
 *  "hidden" marker row (see MessageView's friendlyHiddenLabel). */
export const DEVELOPER_MARKER_CUSTOM_TYPE = "developer-marker";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/** Reply content (non-blank text or an image), as opposed to thinking and tool activity. */
export function isReplyBlock(block: AssistantContentBlock): boolean {
  return block.type === "image" || (block.type === "text" && block.text.trim().length > 0);
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}
