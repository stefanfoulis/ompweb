// Chats started without a workspace. `defaultCwd` (lib/hosts/workspace-ops.ts)
// gives every one of them a fresh directory under the chats root, so the files
// one chat writes never show up in the next chat's context; `/move <path>`
// later takes such a conversation into a real workspace.
//
// Pure and browser-safe: the sidebar, the breadcrumb and the daemon all decide
// the same way what a chat directory is.

/** Directory under the user's home that holds one directory per chat. */
export const CHATS_ROOT_DIRNAME = ".omp-chats";

const SEPARATOR = /[\\/]/;
const TRAILING_SEPARATORS = /[\\/]+$/;

/** The chats root of `<home>/.omp-chats/<name>`, or null for any other path.
 *  The browser only ever sees absolute paths and does not know a host's home
 *  directory, so the `.omp-chats` path segment alone decides. */
export function chatsRootOf(path: string): string | null {
  const trimmed = path.replace(TRAILING_SEPARATORS, "");
  const segments = trimmed.split(SEPARATOR);
  const name = segments[segments.length - 1];
  // At least `<home>/.omp-chats/<name>`: a bare `.omp-chats/<name>` is a
  // relative path to some other directory, not the user's chats root.
  if (segments.length < 3 || !name || segments[segments.length - 2] !== CHATS_ROOT_DIRNAME) return null;
  return trimmed.slice(0, trimmed.length - name.length - 1);
}

/** True for a chat's own directory, `<home>/.omp-chats/<name>`. */
export function isChatDirectory(path: string): boolean {
  return chatsRootOf(path) !== null;
}

/** True for the chats root itself: the sidebar's one "Chats" row stands for
 *  every chat directory under it, so it is never a working directory. */
export function isChatsRoot(path: string): boolean {
  const segments = path.replace(TRAILING_SEPARATORS, "").split(SEPARATOR);
  return segments.length > 1 && segments[segments.length - 1] === CHATS_ROOT_DIRNAME;
}
