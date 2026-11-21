/**
 * Pure helpers behind SvgBlock's two preview layers:
 *
 * 1. Theme injection — SVGs that follow omp's drawing convention (plain
 *    `currentColor` + a handful of CSS variables, no painted background) get
 *    a `<style>` block grafted onto their root element so they pick up the
 *    page palette instead of rendering black-on-nothing inside an `<img>`,
 *    which has no access to the document's CSS variables.
 * 2. Background auto-detect — after the image decodes, SvgBlock samples its
 *    pixels and picks a light/dark checkerboard so dark or light ink stays
 *    visible even when the SVG didn't opt into the convention above.
 */

export interface SvgThemeVars {
  fg: string;
  muted: string;
  border: string;
  surface: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  c5: string;
  c6: string;
}

// globals.css has no chart/series color tokens to read, so the categorical
// palette is a fixed set of 6 hues per mode, chosen to stay legible against
// both a near-white and a near-black checkerboard square.
const LIGHT_CATEGORICAL: readonly string[] = ["#2563EB", "#16A34A", "#D97706", "#DC2626", "#7C3AED", "#0891B2"];
const DARK_CATEGORICAL: readonly string[] = ["#60A5FA", "#4ADE80", "#FBBF24", "#F87171", "#C084FC", "#22D3EE"];

// Used whenever a value read from the document (or passed in) fails
// sanitization — e.g. a custom property that isn't set. Mirrors the
// light/`omp` dark values from app/globals.css so the fallback still looks
// native to the current mode.
const FALLBACKS: Record<"light" | "dark", SvgThemeVars> = {
  light: {
    fg: "#2B2823",
    muted: "#69635A",
    border: "#E2DDD2",
    surface: "#F2F0EA",
    accent: "#B03E22",
    success: "#18794E",
    warning: "#8A5A00",
    error: "#B42318",
    c1: LIGHT_CATEGORICAL[0],
    c2: LIGHT_CATEGORICAL[1],
    c3: LIGHT_CATEGORICAL[2],
    c4: LIGHT_CATEGORICAL[3],
    c5: LIGHT_CATEGORICAL[4],
    c6: LIGHT_CATEGORICAL[5],
  },
  dark: {
    fg: "#F5F5F5",
    muted: "#C9C9D1",
    border: "#232329",
    surface: "#0A0A0C",
    accent: "#EC5BAB",
    success: "#7DD8A8",
    warning: "#F0C36A",
    error: "#FF9B92",
    c1: DARK_CATEGORICAL[0],
    c2: DARK_CATEGORICAL[1],
    c3: DARK_CATEGORICAL[2],
    c4: DARK_CATEGORICAL[3],
    c5: DARK_CATEGORICAL[4],
    c6: DARK_CATEGORICAL[5],
  },
};

// Only plain color tokens: a hex literal or one of the functional notations
// a browser's getComputedStyle actually returns. The character class inside
// the functions excludes `;`, `{`, `}`, quotes and angle brackets, so even a
// hostile/malformed input can never close the `<style>` tag it's placed in.
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch)\([0-9a-zA-Z.%,\s/+-]+\))$/;

/** Returns `value` unchanged when it's a safe plain color token, else `null`. */
export function sanitizeColor(value: string): string | null {
  const trimmed = value.trim();
  return COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

/** Reads the live page palette for `<svg style>` injection: `getComputedStyle`
 * on `document.documentElement` for the named tokens, plus the fixed
 * categorical palette for the current mode. Browser-only. */
export function readDocumentThemeVars(isDark: boolean): SvgThemeVars {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  const palette = isDark ? DARK_CATEGORICAL : LIGHT_CATEGORICAL;
  return {
    fg: read("--text"),
    muted: read("--text-muted"),
    border: read("--border"),
    surface: read("--bg-panel"),
    accent: read("--accent"),
    success: read("--status-success"),
    warning: read("--status-warning"),
    error: read("--status-error"),
    c1: palette[0],
    c2: palette[1],
    c3: palette[2],
    c4: palette[3],
    c5: palette[4],
    c6: palette[5],
  };
}

/** Builds the `<style>` block injected as the root `<svg>`'s first child.
 * Every value is sanitized (falling back to the mode's default on
 * rejection) before it reaches the string. */
export function buildThemeStyleBlock(vars: SvgThemeVars, isDark: boolean): string {
  const fallback = FALLBACKS[isDark ? "dark" : "light"];
  const pick = (key: keyof SvgThemeVars) => sanitizeColor(vars[key]) ?? fallback[key];
  const declarations = [
    `color: ${pick("fg")}`,
    `--fg: ${pick("fg")}`,
    `--muted: ${pick("muted")}`,
    `--border: ${pick("border")}`,
    `--surface: ${pick("surface")}`,
    `--accent: ${pick("accent")}`,
    `--success: ${pick("success")}`,
    `--warning: ${pick("warning")}`,
    `--error: ${pick("error")}`,
    `--c1: ${pick("c1")}`,
    `--c2: ${pick("c2")}`,
    `--c3: ${pick("c3")}`,
    `--c4: ${pick("c4")}`,
    `--c5: ${pick("c5")}`,
    `--c6: ${pick("c6")}`,
  ].join("; ");
  return `<style>svg { ${declarations}; }</style>`;
}

/** Skips a leading `<?xml?>` declaration, `<!-- comments -->`, an `svg`
 * `<!DOCTYPE>`, and surrounding whitespace. Returns the index of the first
 * remaining non-whitespace character, or `null` if one of those constructs
 * is left unterminated. Mirrors MarkdownCode's `startsWithSvgRoot`. */
function skipSvgPrefix(code: string): number | null {
  let i = 0;
  for (;;) {
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code.startsWith("<?xml", i)) {
      const end = code.indexOf("?>", i);
      if (end === -1) return null;
      i = end + 2;
    } else if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i);
      if (end === -1) return null;
      i = end + 3;
    } else if (/^<!DOCTYPE\s+svg/i.test(code.slice(i))) {
      const end = code.indexOf(">", i);
      if (end === -1) return null;
      i = end + 1;
    } else {
      break;
    }
  }
  return i;
}

/** Index just past the root `<svg …>` opening tag's closing `>` — where a
 * theme `<style>` belongs as the element's first child. `null` when `code`
 * doesn't start with an `<svg>` root (after skipping the prefix above) or
 * that root is self-closing (`<svg … />`): there's no child slot to inject
 * into. Scans quoted attribute values so a `>` inside one (e.g. a `d` path
 * string) can't end the tag early. */
export function findSvgInjectionPoint(code: string): number | null {
  const start = skipSvgPrefix(code);
  if (start === null) return null;
  if (!/^<svg[\s/>]/i.test(code.slice(start))) return null;

  let quote: string | null = null;
  for (let i = start + 4; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      if (code[i - 1] === "/") return null; // self-closing: no children
      return i + 1;
    }
  }
  return null;
}

/** Grafts the theme `<style>` block onto `code`'s root `<svg>` element.
 * Returns `code` unchanged when there's no usable injection point. */
export function injectSvgTheme(code: string, vars: SvgThemeVars, isDark: boolean): string {
  const point = findSvgInjectionPoint(code);
  if (point === null) return code;
  return code.slice(0, point) + buildThemeStyleBlock(vars, isDark) + code.slice(point);
}

export type PreviewBackground = "default" | "light" | "dark";

// Alpha below this is treated as "no ink" and excluded from the luminance
// average entirely.
const INK_ALPHA_MIN = 0.1 * 255;
// Alpha at/above this counts a pixel as part of an opaque fill for the
// full-background check below.
const OPAQUE_ALPHA_MIN = 0.95 * 255;
// An SVG whose canvas is this opaque already painted its own background —
// auto-detect backs off and leaves the theme default in place.
const OPAQUE_BACKGROUND_FRACTION = 0.95;
// Below this ink fraction there isn't enough signal to judge: a near-empty
// or near-transparent sample keeps the default.
const MIN_INK_FRACTION = 0.01;
const DARK_INK_LUMINANCE = 0.4;
const LIGHT_INK_LUMINANCE = 0.6;

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Picks a checkerboard background for a decoded preview from its raw RGBA
 * pixels (as from `CanvasRenderingContext2D.getImageData().data`), given the
 * current theme. An opaque full-canvas fill or too little opaque ink both
 * keep `"default"` (the theme's own checkerboard); otherwise dark ink in
 * dark mode gets a light square, light ink in light mode gets a dark one —
 * ink that's already legible in the current mode is left alone. */
export function pickPreviewBackground(pixels: ArrayLike<number>, isDark: boolean): PreviewBackground {
  const total = Math.floor(pixels.length / 4);
  if (total === 0) return "default";

  let opaqueCount = 0;
  let inkCount = 0;
  let weightedLuminance = 0;
  let weightSum = 0;
  for (let i = 0; i < total; i++) {
    const offset = i * 4;
    const a = pixels[offset + 3];
    if (a >= OPAQUE_ALPHA_MIN) opaqueCount++;
    if (a > INK_ALPHA_MIN) {
      inkCount++;
      const weight = a / 255;
      weightedLuminance += relativeLuminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]) * weight;
      weightSum += weight;
    }
  }

  if (opaqueCount / total >= OPAQUE_BACKGROUND_FRACTION) return "default";
  if (inkCount / total < MIN_INK_FRACTION || weightSum === 0) return "default";

  const luminance = weightedLuminance / weightSum;
  if (luminance < DARK_INK_LUMINANCE) return isDark ? "light" : "default";
  if (luminance > LIGHT_INK_LUMINANCE) return isDark ? "default" : "dark";
  return "default";
}
