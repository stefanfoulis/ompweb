"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ClickableImage } from "./ImageLightbox";
import { CodeBlock } from "./MermaidBlock";

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
}

/** Above this many characters, skip the preview outright: no toggle, source
 * only. A multi-megabyte SVG is rare, costly to encode into a data URL, and
 * not something a chat bubble should try to render inline. */
const MAX_PREVIEW_LENGTH = 1_000_000;

/**
 * Inline preview for an SVG code block. Renders ONLY via `<img src="data:…">`
 * — never `dangerouslySetInnerHTML`, an inline `<svg>`, or `<object>`/`<iframe>` —
 * so the browser treats the markup purely as image pixels: no script
 * execution, no external fetches, regardless of what the SVG source contains.
 *
 * Unlike MermaidBlock, the source here is unreadable as a diagram, so preview
 * is the default once the block has finished streaming (source only while
 * streaming, matching Mermaid's "previewAfterStreaming" disabled toggle).
 */
export function SvgBlock({ code, isStreaming }: SvgBlockProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(true);
  const [broken, setBroken] = useState(false);
  const previewVisible = showPreview && !isStreaming;
  const tooLarge = code.length > MAX_PREVIEW_LENGTH;

  // A retried/edited generation gets a fresh chance to render.
  useEffect(() => {
    setBroken(false);
  }, [code]);

  const dataUrl = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, [code]);

  if (tooLarge) {
    return (
      <>
        <div className="svg-block-notice">{t("svgBlock.tooLarge")}</div>
        <CodeBlock code={code} lang="svg" isStreaming={isStreaming} />
      </>
    );
  }

  const previewButton = (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("mermaidBlock.previewAfterStreaming") : (previewVisible ? t("svgBlock.showSourceTitle") : t("svgBlock.previewTitle"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("mermaidBlock.source") : t("mermaidBlock.preview")}
    </button>
  );

  if (!previewVisible || broken) {
    return (
      <>
        {broken && <div className="svg-block-notice">{t("svgBlock.invalid")}</div>}
        <CodeBlock code={code} lang="svg" headerAction={previewButton} isStreaming={isStreaming} />
      </>
    );
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">svg</span>
        {previewButton}
      </div>
      <div className="svg-block-preview">
        <ClickableImage
          src={dataUrl}
          alt={t("svgBlock.imageAlt")}
          className="svg-block-image"
          onError={() => setBroken(true)}
        />
      </div>
    </div>
  );
}
