/**
 * Submitted values and validation for an `HtmlForm` dialog (`method: "form"`).
 *
 * The rules mirror omp's own (oh-my-pi/packages/tui/src/html-form/data.ts):
 * omp re-checks every answer and rejects the whole submission when one
 * violates the form, so a dialog that accepted more would lose the user's
 * work to an error from the agent instead of pointing at the field.
 */
import { translate } from "./i18n";
import type { ChoiceField, FormField, FormSpan, HtmlFormValue, TextField } from "./pi-types";

/** Plain text of a span run; `"\n"` inside a span stays a line break. */
export function spansText(spans: FormSpan[]): string {
  return spans.map((span) => span.text).join("");
}

/** Whether a choice field reports an array (checkbox group, multi-select) rather than one value. */
export function isArrayChoice(field: ChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

/**
 * Value a choice field contributes given its checked option indices and, when
 * the user typed into its "Other" row, that text: the typed text stands in for
 * a radio's value, or joins a checkbox group's array. Undefined when the field
 * contributes nothing; blank Other text counts as no answer.
 */
export function choiceValue(
  field: ChoiceField,
  checked: ReadonlySet<number>,
  other?: string,
): HtmlFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) => (checked.has(index) && !option.disabled ? [option.value] : []));
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

/** Value a text field contributes: a number for non-empty `number`/`range` inputs, else the text. */
export function textValue(field: TextField, text: string): HtmlFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

/**
 * Why `value` is not an acceptable answer for `field`, localized, or undefined
 * when it is. Enforces `required`, numeric `min`/`max`, `minlength`/`maxlength`,
 * `email` and `url` shapes, and `pattern` (anchored, as HTML does; an invalid
 * pattern is ignored).
 */
export function fieldError(field: FormField, value: HtmlFormValue | undefined): string | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return translate(isArrayChoice(field) ? "askDialog.errorSelectOne" : "askDialog.errorRequired");
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? translate("askDialog.errorRequired") : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return translate("askDialog.errorNumber");
    if (field.min !== undefined && number < field.min) return translate("askDialog.errorMin", { min: field.min });
    if (field.max !== undefined && number > field.max) return translate("askDialog.errorMax", { max: field.max });
  }
  if (field.minLength !== undefined && text.length < field.minLength) {
    return translate("askDialog.errorMinLength", { count: field.minLength });
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return translate("askDialog.errorMaxLength", { count: field.maxLength });
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return translate("askDialog.errorEmail");
  if (field.type === "url" && !URL.canParse(text)) return translate("askDialog.errorUrl");
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
    const pattern = field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern;
    return translate("askDialog.errorPattern", { pattern });
  }
  return undefined;
}

/** `^(?:pattern)$` as HTML matches `pattern`, or undefined for a pattern the
 *  model wrote wrong. omp compiles with the `v` flag; engines without it still
 *  enforce the pattern, rather than letting every form through unchecked. */
function compilePattern(pattern: string): RegExp | undefined {
  for (const flags of ["v", ""]) {
    try {
      return new RegExp(`^(?:${pattern})$`, flags);
    } catch {
      // Unsupported flag, or a pattern this engine rejects outright.
    }
  }
  return undefined;
}
