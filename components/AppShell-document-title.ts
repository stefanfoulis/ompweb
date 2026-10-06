import { useEffect } from "react";

/**
 * Keeps the browser tab title at `title`, re-applying it when anything else
 * in `<head>` replaces it.
 *
 * The `document.title` getter strips and collapses ASCII whitespace, so the
 * comparison must use the same normalized text. Comparing against a raw
 * multi-line title makes every write look stale, and each write mutates
 * `<head>` again: the observer would rewrite the title forever and lock up
 * the tab.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const text = title.replace(/[\t\n\f\r ]+/g, " ").trim();
    const sync = () => {
      if (document.title !== text) document.title = text;
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
}
