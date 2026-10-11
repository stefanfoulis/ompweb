import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
afterEach(cleanup);

const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';

test("write tool call to an .svg path previews the written content in the expanded card", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "write", input: { path: "assets/logo.SVG", content: svgContent, i: "Writing logo" } }],
    },
  }));

  fireEvent.click(view.getByRole("button", { expanded: false }));
  const img = view.container.querySelector(".tool-call-svg-preview img");
  assert.ok(img, "expected an inline SVG preview in the expanded tool card");
  assert.equal(decodeURIComponent(img.getAttribute("src").slice("data:image/svg+xml;charset=utf-8,".length)), svgContent);
});

test("write tool call to a non-svg path renders no SVG preview", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "write", input: { path: "a.txt", content: "hello", i: "Writing note" } }],
    },
  }));

  fireEvent.click(view.getByRole("button", { expanded: false }));
  assert.equal(view.container.querySelector(".tool-call-svg-preview"), null);
});
