import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { MarkdownBody } = await import("./MarkdownBody.tsx");

test("fenced svg code block renders as an inline SVG preview", () => {
  const md = '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n```';
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, md));
  assert.match(html, /svg-block-preview/);
  assert.match(html, /<img[^>]*src="data:image\/svg\+xml/);
});

test("fenced xml code block whose root element is svg renders a preview", () => {
  const md = '```xml\n<?xml version="1.0"?>\n<!-- comment -->\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n```';
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, md));
  assert.match(html, /svg-block-preview/);
});

test("fenced html code block wrapping an svg stays source-only, not hijacked into a preview", () => {
  const md = '```html\n<html><body><svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg></body></html>\n```';
  const html = renderToStaticMarkup(React.createElement(MarkdownBody, null, md));
  assert.doesNotMatch(html, /svg-block-preview/);
  assert.match(html, /markdown-code-block/);
  assert.match(html, /&lt;html&gt;/);
});
