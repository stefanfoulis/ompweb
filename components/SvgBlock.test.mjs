import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SvgBlock } = await jiti.import("./SvgBlock.tsx");
afterEach(cleanup);

const simpleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
// Deliberately hostile: a <script> element plus an onload handler, the two
// vectors SVG-as-document would execute.
const maliciousSvg = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.pwned=1"><script>window.pwned=2</script><circle cx="2" cy="2" r="1"/></svg>';

test("SvgBlock previews via an <img> data URL, never inlining markup or executing embedded script/onload", () => {
  const html = renderToStaticMarkup(React.createElement(SvgBlock, { code: maliciousSvg }));

  const match = html.match(/src="(data:image\/svg\+xml;charset=utf-8,[^"]*)"/);
  assert.ok(match, "expected an <img> with a data:image/svg+xml src");
  assert.equal(decodeURIComponent(match[1].slice("data:image/svg+xml;charset=utf-8,".length)), maliciousSvg);

  // No literal <svg>/<script> markup anywhere in the rendered HTML — the only
  // trace of the hostile source is inside the percent-encoded data URL.
  assert.doesNotMatch(html, /<svg[\s>]/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html.replace(match[0], ""), /onload=/);
});

test("SvgBlock shows source while streaming with the toggle disabled, then previews by default once streaming ends", () => {
  const view = render(React.createElement(SvgBlock, { code: simpleSvg, isStreaming: true }));

  assert.equal(view.container.querySelector("img"), null);
  assert.match(view.container.textContent, /<rect/);
  const toggle = view.getByRole("button", { name: "Preview" });
  assert.ok(toggle.disabled);

  view.rerender(React.createElement(SvgBlock, { code: simpleSvg, isStreaming: false }));
  assert.ok(view.container.querySelector("img"), "preview shown by default once streaming finishes");

  fireEvent.click(view.getByRole("button", { name: "Source" }));
  assert.equal(view.container.querySelector("img"), null);
  assert.match(view.container.textContent, /<rect/);
});

test("SvgBlock falls back to source with a notice when the image fails to decode", () => {
  const view = render(React.createElement(SvgBlock, { code: "<svg>not actually valid as an image</svg>" }));
  assert.ok(view.container.querySelector("img"));

  fireEvent.error(view.container.querySelector("img"));
  assert.equal(view.container.querySelector("img"), null);
  assert.match(view.container.textContent, /not actually valid as an image/);
});

test("SvgBlock skips the preview entirely above the size guard", () => {
  const huge = `<svg>${"x".repeat(1_000_001)}</svg>`;
  // isStreaming: true keeps CodeBlock from lazily loading the syntax
  // highlighter — irrelevant here and pathologically slow on a megabyte of
  // a single repeated character.
  const view = render(React.createElement(SvgBlock, { code: huge, isStreaming: true }));
  assert.equal(view.container.querySelector("img"), null);
  // Only Copy renders above the guard — no Preview/Source toggle alongside it.
  assert.equal(view.queryByRole("button", { name: /preview|source/i }), null, "no toggle above the size guard");
});
