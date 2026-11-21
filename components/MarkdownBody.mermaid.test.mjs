import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MarkdownBody } = await import("./MarkdownBody.tsx");

const DIAGRAM = "```mermaid\nflowchart LR\n  plan --> build\n```";

test("a finished mermaid block in chat opens on the rendered diagram, not its source", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, DIAGRAM));
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /flowchart LR/);
});

test("a mermaid block still streaming shows its source until the reply ends", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, { isStreaming: true }, DIAGRAM));
  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, /flowchart LR/);
});
