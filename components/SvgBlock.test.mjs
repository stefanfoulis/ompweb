import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
import { renderToStaticMarkup } from "react-dom/server";
import { injectSvgTheme, pickPreviewBackground, sanitizeColor } from "../lib/svg-preview.ts";

const { SvgBlock } = await import("./SvgBlock.tsx");

// jsdom ships no matchMedia; useTheme (read for theme injection and
// background auto-detect) queries it at mount.
beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  delete window.matchMedia;
});

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

const themeVars = {
  fg: "#111111", muted: "#222222", border: "#333333", surface: "#444444",
  accent: "#555555", success: "#666666", warning: "#777777", error: "#888888",
  c1: "#111", c2: "#222", c3: "#333", c4: "#444", c5: "#555", c6: "#666",
};

test("injectSvgTheme grafts the theme <style> right after the root <svg> opening tag", () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg" width="4"><rect/></svg>';
  const out = injectSvgTheme(code, themeVars, false);
  const openTagEnd = code.indexOf(">") + 1;

  assert.equal(out.slice(0, openTagEnd), code.slice(0, openTagEnd), "opening tag itself is untouched");
  assert.match(out.slice(openTagEnd), /^<style>svg \{ color: #111111;/);
  assert.equal(
    out.slice(openTagEnd).replace(/^<style>.*?<\/style>/s, ""),
    code.slice(openTagEnd),
    "everything after the injected style matches the original body",
  );
});

test("injectSvgTheme skips a leading <?xml?> prologue and a comment before locating the root <svg>", () => {
  const code = '<?xml version="1.0"?>\n<!-- note --><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const out = injectSvgTheme(code, themeVars, false);
  const openTagEnd = code.indexOf(">", code.indexOf("<svg")) + 1;

  assert.equal(out.slice(0, openTagEnd), code.slice(0, openTagEnd), "prologue, comment and opening tag pass through unchanged");
  assert.match(out.slice(openTagEnd), /^<style>/);
});

test("injectSvgTheme leaves a self-closing root <svg> untouched (no child slot to inject into)", () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" />';
  assert.equal(injectSvgTheme(code, themeVars, false), code);
});

test("injectSvgTheme sanitizes a hostile var value; it never reaches the output, and falls back to the theme default", () => {
  const hostile = { ...themeVars, fg: "red;}</style><script>window.pwned=1</script>" };
  const code = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const out = injectSvgTheme(code, hostile, false);

  assert.ok(!out.includes(hostile.fg), "the raw hostile value must never appear in the output");
  assert.doesNotMatch(out, /<script/);
  assert.equal((out.match(/<style>/g) ?? []).length, 1, "exactly one style block, not broken out of and reopened");
  assert.equal((out.match(/<\/style>/g) ?? []).length, 1);
});

test("sanitizeColor accepts hex/rgb/hsl/oklch tokens and rejects anything else", () => {
  assert.equal(sanitizeColor("#FF00FF"), "#FF00FF");
  assert.equal(sanitizeColor("rgb(255, 0, 0)"), "rgb(255, 0, 0)");
  assert.equal(sanitizeColor("rgba(0, 0, 0, 0.5)"), "rgba(0, 0, 0, 0.5)");
  assert.equal(sanitizeColor("hsl(200deg 50% 50%)"), "hsl(200deg 50% 50%)");
  assert.equal(sanitizeColor("oklch(0.7 0.1 250)"), "oklch(0.7 0.1 250)");
  assert.equal(sanitizeColor("red"), null, "named colors are out of scope — only the four functional/hex forms");
  assert.equal(sanitizeColor("red;}</style><script>"), null);
  assert.equal(sanitizeColor("url(javascript:alert(1))"), null);
});

test("SvgBlock injects the theme style only for chat previews (injectTheme); the write-tool panel's default props render verbatim", () => {
  const code = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
  const prefix = "data:image/svg+xml;charset=utf-8,";

  const verbatim = render(React.createElement(SvgBlock, { code }));
  const verbatimSrc = decodeURIComponent(verbatim.container.querySelector("img").getAttribute("src").slice(prefix.length));
  assert.equal(verbatimSrc, code, "default props (write-tool panel) render the SVG verbatim, no injected style");
  verbatim.unmount();

  const themed = render(React.createElement(SvgBlock, { code, injectTheme: true }));
  const themedSrc = decodeURIComponent(themed.container.querySelector("img").getAttribute("src").slice(prefix.length));
  const openTagEnd = code.indexOf(">") + 1;
  assert.equal(themedSrc.slice(0, openTagEnd), code.slice(0, openTagEnd));
  assert.match(themedSrc.slice(openTagEnd), /^<style>svg \{/, "chat preview (injectTheme) gets the theme style block");
});

test("SvgBlock's background toggle sets data-bg and aria-pressed per mode, defaulting to Auto", () => {
  const view = render(React.createElement(SvgBlock, { code: simpleSvg }));
  const preview = view.container.querySelector(".svg-block-preview");
  const auto = view.getByRole("button", { name: "Auto" });
  const light = view.getByRole("button", { name: "Light" });
  const dark = view.getByRole("button", { name: "Dark" });

  assert.equal(auto.getAttribute("aria-pressed"), "true");
  assert.equal(light.getAttribute("aria-pressed"), "false");
  assert.equal(dark.getAttribute("aria-pressed"), "false");
  assert.equal(preview.getAttribute("data-bg"), null, "no sample yet: Auto keeps the theme-default checkerboard");

  fireEvent.click(light);
  assert.equal(light.getAttribute("aria-pressed"), "true");
  assert.equal(auto.getAttribute("aria-pressed"), "false");
  assert.equal(preview.getAttribute("data-bg"), "light");

  fireEvent.click(dark);
  assert.equal(dark.getAttribute("aria-pressed"), "true");
  assert.equal(light.getAttribute("aria-pressed"), "false");
  assert.equal(preview.getAttribute("data-bg"), "dark");

  fireEvent.click(auto);
  assert.equal(auto.getAttribute("aria-pressed"), "true");
  assert.equal(preview.getAttribute("data-bg"), null);
});

test("SvgBlock's background auto-detect fails safe without a canvas 2D context (jsdom has no canvas backend), keeping the theme default", () => {
  const view = render(React.createElement(SvgBlock, { code: simpleSvg }));
  const img = view.container.querySelector("img");
  assert.doesNotThrow(() => fireEvent.load(img));
  assert.equal(view.container.querySelector(".svg-block-preview").getAttribute("data-bg"), null);
});

test("pickPreviewBackground picks a light checkerboard for dark ink on a mostly transparent canvas in dark mode", () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 40; i++) {
    pixels[i * 4] = 10; pixels[i * 4 + 1] = 10; pixels[i * 4 + 2] = 10; pixels[i * 4 + 3] = 255;
  }
  assert.equal(pickPreviewBackground(pixels, true), "light");
});

test("pickPreviewBackground picks a dark checkerboard for light ink on a mostly transparent canvas in light mode", () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 40; i++) {
    pixels[i * 4] = 245; pixels[i * 4 + 1] = 245; pixels[i * 4 + 2] = 245; pixels[i * 4 + 3] = 255;
  }
  assert.equal(pickPreviewBackground(pixels, false), "dark");
});

test("pickPreviewBackground keeps the theme default for an opaque full-canvas background", () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) {
    pixels[i * 4] = 10; pixels[i * 4 + 1] = 10; pixels[i * 4 + 2] = 10; pixels[i * 4 + 3] = 255;
  }
  assert.equal(pickPreviewBackground(pixels, true), "default");
  assert.equal(pickPreviewBackground(pixels, false), "default");
});

test("pickPreviewBackground keeps the theme default when too few pixels carry ink", () => {
  const pixels = new Uint8ClampedArray(1000 * 4); // fully transparent canvas
  pixels[0] = 10; pixels[1] = 10; pixels[2] = 10; pixels[3] = 255; // one opaque pixel: well under 1%
  assert.equal(pickPreviewBackground(pixels, true), "default");
});
