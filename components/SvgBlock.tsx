"use client";

import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/hooks/useTheme";
import { ClickableImage } from "./ImageLightbox";
import { CodeBlock } from "./MermaidBlock";
import { injectSvgTheme, pickPreviewBackground, readDocumentThemeVars, type PreviewBackground } from "@/lib/svg-preview";

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
  /** Inject theme CSS variables (`currentColor` + `--fg`/`--muted`/…) into
   * the root `<svg>` before previewing, for SVGs drawn to omp's convention.
   * Chat code blocks opt in; the write-tool panel leaves this off — a
   * written `.svg` is an asset and previews verbatim. */
  injectTheme?: boolean;
}

/** Above this many characters, skip the preview outright: no toggle, source
 * only. A multi-megabyte SVG is rare, costly to encode into a data URL, and
 * not something a chat bubble should try to render inline. */
const MAX_PREVIEW_LENGTH = 1_000_000;

/** Longest side of the offscreen canvas sampled for background auto-detect —
 * plenty of signal for a mean-luminance estimate, far cheaper than reading
 * the image at full resolution. */
const AUTO_BG_SAMPLE_SIZE = 256;

type BgMode = "auto" | "light" | "dark";
const BG_MODES: readonly BgMode[] = ["auto", "light", "dark"];
const BG_MODE_LABEL_KEY: Record<BgMode, string> = {
  auto: "svgBlock.bgAuto",
  light: "svgBlock.bgLight",
  dark: "svgBlock.bgDark",
};

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
export function SvgBlock({ code, isStreaming, injectTheme = false }: SvgBlockProps) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [showPreview, setShowPreview] = useState(true);
  const [broken, setBroken] = useState(false);
  const [bgMode, setBgMode] = useState<BgMode>("auto");
  const [inkPixels, setInkPixels] = useState<Uint8ClampedArray | null>(null);
  const previewVisible = showPreview && !isStreaming;
  const tooLarge = code.length > MAX_PREVIEW_LENGTH;

  // A retried/edited generation gets a fresh chance to render and to be
  // re-sampled for its background.
  useEffect(() => {
    setBroken(false);
    setInkPixels(null);
  }, [code]);

  // `document` is only absent during SSR; the client render that follows
  // picks up the live palette, same as useTheme's own hydration pass.
  const themedCode = useMemo(() => {
    if (!injectTheme || typeof document === "undefined") return code;
    return injectSvgTheme(code, readDocumentThemeVars(isDark), isDark);
  }, [code, injectTheme, isDark]);

  const dataUrl = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themedCode)}`, [themedCode]);

  // Downsamples the decoded image onto an offscreen canvas to read its mean
  // ink luminance for the background auto-detect. Best-effort: a tainted
  // canvas, a missing 2D context (e.g. no canvas backend in a test DOM), or
  // any decode error just leaves the theme-default checkerboard in place.
  const handleImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    try {
      const img = event.currentTarget;
      const naturalWidth = img.naturalWidth || 1;
      const naturalHeight = img.naturalHeight || 1;
      const scale = Math.min(1, AUTO_BG_SAMPLE_SIZE / Math.max(naturalWidth, naturalHeight));
      const width = Math.max(1, Math.round(naturalWidth * scale));
      const height = Math.max(1, Math.round(naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      setInkPixels(ctx.getImageData(0, 0, width, height).data);
    } catch {
      setInkPixels(null);
    }
  }, []);

  const autoBg: PreviewBackground = useMemo(
    () => (inkPixels ? pickPreviewBackground(inkPixels, isDark) : "default"),
    [inkPixels, isDark],
  );
  const resolvedBg: PreviewBackground = bgMode === "auto" ? autoBg : bgMode;

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

  const bgToggle = (
    <div className="svg-block-bg-toggle" role="group" aria-label={t("svgBlock.backgroundLabel")}>
      {BG_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={bgMode === mode}
          onClick={() => setBgMode(mode)}
          className={["markdown-code-action", bgMode === mode ? "is-active" : ""].filter(Boolean).join(" ")}
        >
          {t(BG_MODE_LABEL_KEY[mode])}
        </button>
      ))}
    </div>
  );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">svg</span>
        <div className="markdown-code-actions">
          {bgToggle}
          {previewButton}
        </div>
      </div>
      <div className="svg-block-preview" data-bg={resolvedBg === "default" ? undefined : resolvedBg}>
        <ClickableImage
          src={dataUrl}
          alt={t("svgBlock.imageAlt")}
          className="svg-block-image"
          onLoad={handleImageLoad}
          onError={() => setBroken(true)}
        />
      </div>
    </div>
  );
}
