"use client";

import { createElement, Fragment, type ReactNode } from "react";
import type { HtmlFormData } from "@/lib/pi-types";

/**
 * The agent's `<form>` markup as React controls, and the plan that splits it
 * into one tab per question.
 *
 * Nothing here is ever attached to the page as markup: the HTML is parsed in
 * an inert document and only the elements rebuilt below reach the DOM, with
 * the attributes copied here and no others. What the controls submit is read
 * back with {@link readFormData}, which mirrors omp's own html-form rules
 * (packages/tui/src/html-form/data.ts) so the agent sees the values its
 * terminal dialog would have sent.
 */

// These tags render as themselves; others contribute just their text, and dropped ones nothing at all.
const FORM_TAGS: Record<string, true> = {
  fieldset: true, legend: true, p: true, label: true, div: true, span: true, section: true, strong: true, em: true, b: true, i: true,
  code: true, pre: true, small: true, br: true, hr: true, ul: true, ol: true, li: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
  input: true, select: true, option: true, optgroup: true, textarea: true,
};
const DROPPED_TAGS: Record<string, true> = {
  script: true, style: true, template: true, noscript: true, button: true, iframe: true, object: true, embed: true, math: true,
};
const INPUT_TYPES: Record<string, true> = {
  radio: true, checkbox: true, text: true, number: true, range: true, email: true, url: true, tel: true, search: true, date: true, time: true, hidden: true,
};

const CONTROL_SELECTOR = "input, select, textarea";

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** A radio/checkbox group that offers a free-text "Other" answer, as omp's html-form adds one. */
interface OtherGroup { type: string; name: string; required: boolean }

export interface FormCtx {
  prefix: string;
  otherLabel: string;
  /** Option element after which a group's Other box is rendered. */
  others: Map<Element, OtherGroup>;
  /** Options of those groups: their `required` moves to the Other box (see syncOtherValidity). */
  grouped: Set<Element>;
  /** Bare radio/checkbox inputs mapped to their `<label for>`, drawn together as one row. */
  rows: Map<Element, Element>;
  adopted: Set<Element>;
}

const choiceType = (element: Element) => {
  const type = element.getAttribute("type")?.toLowerCase();
  return type === "radio" || type === "checkbox" ? type : undefined;
};

// A control named "elements", "querySelectorAll", ... shadows that property on its form, so read the DOM through the prototypes.
const queryAll = <T extends Element>(form: HTMLFormElement, selector: string) => Array.from(Element.prototype.querySelectorAll.call(form, selector)) as T[];

const namedInputs = (form: HTMLFormElement, name: string, type: string) =>
  queryAll<HTMLInputElement>(form, "input").filter((input) => input.name === name && input.type === type);

// Mirrors omp's parser: a named radio/checkbox group of two or more options gets an Other answer
// unless one of its options is already labelled "Other".
export function planForm(root: ParentNode, prefix: string, otherLabel: string): FormCtx {
  const ctx: FormCtx = { prefix, otherLabel, others: new Map(), grouped: new Set(), rows: new Map(), adopted: new Set() };
  const labelFor = new Map<string, Element>();
  for (const label of root.querySelectorAll("label[for]")) {
    if (!labelFor.has(label.getAttribute("for")!)) labelFor.set(label.getAttribute("for")!, label);
  }
  const groups = new Map<string, { input: Element; label?: Element }[]>();
  for (const input of root.querySelectorAll("input")) {
    const type = choiceType(input);
    if (!type) continue;
    const wrapper = input.closest("label");
    const id = input.getAttribute("id");
    const label = wrapper ?? (id ? labelFor.get(id) : undefined);
    if (!wrapper && label) {
      ctx.rows.set(input, label);
      ctx.adopted.add(label);
    }
    const name = input.getAttribute("name");
    if (name) {
      const key = `${type}\0${name}`;
      groups.set(key, [...(groups.get(key) ?? []), { input, label }]);
    }
  }
  for (const [key, options] of groups) {
    if (options.length < 2 || options.some(({ label }) => /^\s*other\b/i.test(label?.textContent ?? ""))) continue;
    const [type, name] = key.split("\0");
    const last = options[options.length - 1].input;
    ctx.others.set(ctx.rows.has(last) ? last : last.closest("label") ?? last, { type, name, required: options.some(({ input }) => input.hasAttribute("required")) });
    for (const { input } of options) ctx.grouped.add(input);
  }
  return ctx;
}

/** Whether a required Other-bearing group has an answer: an option, or Other text. */
export function syncOtherValidity(form: HTMLFormElement) {
  for (const other of queryAll<HTMLInputElement>(form, "input[data-other]")) {
    const { other: name, otherType: type = "" } = other.dataset;
    const answered = other.value.trim() !== "" || namedInputs(form, name!, type).some((input) => input.checked && !input.disabled);
    other.setCustomValidity(other.dataset.required && !answered ? (type === "checkbox" ? "Select at least one" : "Required") : "");
  }
}

function otherBox({ type, name, required }: OtherGroup, ctx: FormCtx, key: string) {
  return createElement("input", {
    key,
    type: "text",
    "data-other": name,
    "data-other-type": type,
    "data-required": required || undefined,
    "aria-label": ctx.otherLabel,
    placeholder: ctx.otherLabel,
    // Typing a radio group's own answer drops the picked option, as in omp.
    onInput: (event: { currentTarget: HTMLInputElement }) => {
      const box = event.currentTarget;
      if (type === "radio" && box.value.trim() !== "" && box.form) for (const radio of namedInputs(box.form, name, type)) radio.checked = false;
      if (box.form) syncOtherValidity(box.form);
    },
    className: "extension-field",
    style: { width: "100%" },
  });
}

export function formNode(node: ChildNode, ctx: FormCtx, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  if (ctx.adopted.has(element)) return null;
  let out = formElement(element, ctx, key);
  const label = ctx.rows.get(element);
  if (label) {
    out = createElement("div", { key, className: "extension-choice" }, out, formElement(label, ctx, `${key}.label`));
  }
  const other = ctx.others.get(element);
  return other ? createElement(Fragment, { key }, out, otherBox(other, ctx, `${key}.other`)) : out;
}

/**
 * omp's picture contract: an `<img>` with a `data:` src draws (anything else is
 * defence in depth against a src the runner's rewrite missed — it shows only the
 * alt); an `<svg>` draws through a `data:image/svg+xml` `<img>` so nothing inside
 * it ever runs. Inside a `<label>` either contributes only its alt text (an
 * `<svg>`'s `<title>`, if any), the same as the control's own label text.
 */
function formImage(element: Element, tag: string, key: string): ReactNode {
  if (element.closest("label")) {
    return tag === "svg" ? collapse(element.querySelector("title")?.textContent ?? "") || null : element.getAttribute("alt") || null;
  }
  if (tag === "svg") {
    const alt = collapse(element.querySelector("title")?.textContent ?? "");
    return createElement("img", { key, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(element.outerHTML)}`, alt, className: "extension-image" });
  }
  const src = element.getAttribute("src") ?? "";
  const alt = element.getAttribute("alt") ?? "";
  if (!src.startsWith("data:")) return alt ? createElement("span", { key, className: "extension-image-alt" }, alt) : null;
  return createElement("img", { key, src, alt, className: "extension-image" });
}

function formElement(element: Element, ctx: FormCtx, key: string): ReactNode {
  const tag = element.localName;
  if (DROPPED_TAGS[tag]) return null;
  if (tag === "img" || tag === "svg") return formImage(element, tag, key);
  const children = Array.from(element.childNodes, (child, index) => formNode(child, ctx, `${key}.${index}`));
  if (!FORM_TAGS[tag]) return createElement(Fragment, { key }, ...children);
  const attr = (name: string) => element.getAttribute(name) ?? undefined;
  const length = (name: string) => element.hasAttribute(name) ? Number(element.getAttribute(name)) : undefined;
  const props: Record<string, unknown> = { key };
  const id = attr("id");
  if (id) props.id = `${ctx.prefix}-${id}`;
  if (tag === "pre") props.tabIndex = 0;
  if (tag === "label" && attr("for")) props.htmlFor = `${ctx.prefix}-${attr("for")}`;
  // Each radio/checkbox option sits on its own row, its control spaced from its label. The row is a
  // flex container, so everything but the control goes into one text block: on their own, each text
  // run and each <code> or <strong> would become a column of its own.
  if (tag === "label" && Array.from(element.querySelectorAll("input")).some(choiceType)) {
    const nodes = Array.from(element.childNodes);
    const isControl = (index: number) => nodes[index].nodeType === 1 && (nodes[index] as Element).localName === "input" && choiceType(nodes[index] as Element) !== undefined;
    return createElement(
      "label",
      { ...props, className: "extension-choice" },
      ...children.filter((_, index) => isControl(index)),
      createElement("span", { key: `${key}.text`, className: "extension-choice-text" }, ...children.filter((_, index) => !isControl(index))),
    );
  }
  if (tag === "input" || tag === "select" || tag === "textarea") {
    Object.assign(props, { name: attr("name"), required: element.hasAttribute("required") && !ctx.grouped.has(element), disabled: element.hasAttribute("disabled") });
  }
  if (tag === "input") {
    const rawType = attr("type")?.toLowerCase() ?? "text";
    const type = INPUT_TYPES[rawType] ? rawType : "text";
    Object.assign(props, { type, placeholder: attr("placeholder"), min: attr("min"), max: attr("max"), step: attr("step"), pattern: attr("pattern"), minLength: length("minlength"), maxLength: length("maxlength") });
    if (type === "radio" || type === "checkbox") {
      Object.assign(props, { value: attr("value") ?? "on", defaultChecked: element.hasAttribute("checked") });
    } else {
      Object.assign(props, { defaultValue: attr("value") ?? "", className: "extension-field" });
    }
    return createElement("input", props);
  }
  if (tag === "textarea") {
    Object.assign(props, { placeholder: attr("placeholder"), rows: length("rows"), minLength: length("minlength"), maxLength: length("maxlength"), defaultValue: element.textContent ?? "", className: "extension-field", style: { width: "100%", resize: "vertical" } });
    return createElement("textarea", props);
  }
  if (tag === "select") {
    const multiple = element.hasAttribute("multiple");
    const selected = Array.from(element.querySelectorAll("option"))
      .filter((option) => option.hasAttribute("selected"))
      .map((option) => option.getAttribute("value") ?? option.textContent ?? "");
    Object.assign(props, { multiple, defaultValue: multiple ? selected : selected[0], className: "extension-field" });
  }
  if (tag === "option") Object.assign(props, { value: attr("value") ?? element.textContent ?? "", disabled: element.hasAttribute("disabled") });
  if (tag === "optgroup") props.label = attr("label");
  if (tag === "br" || tag === "hr") return createElement(tag, props);
  return createElement(tag, props, ...children);
}

/** What the form submits, as omp's html-form reports it (see HtmlFormData). */
export function readFormData(form: HTMLFormElement): HtmlFormData {
  const data: HtmlFormData = {};
  const controls = queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form, "input, select, textarea").filter((control) => control.name && !control.disabled);
  for (const control of controls) {
    const { name } = control;
    if (control.tagName === "SELECT") {
      const select = control as HTMLSelectElement;
      const values = Array.from(select.selectedOptions).filter((option) => !option.disabled).map((option) => option.value);
      if (select.multiple) data[name] = values;
      else if (values[0] !== undefined) data[name] = values[0];
      continue;
    }
    const { type, value } = control as HTMLInputElement;
    if (type === "radio" || type === "checkbox") {
      const options = namedInputs(form, name, type);
      const checked = options.filter((input) => input.checked && !input.disabled).map((input) => input.value);
      const other = queryAll<HTMLInputElement>(form, "input[data-other]").find((box) => box.dataset.other === name && box.dataset.otherType === type);
      const typed = other?.value.trim();
      // Other's text joins a checkbox group's array; it stands in for a radio group's value only while no option is picked.
      if (type === "checkbox" && options.length > 1) data[name] = typed ? [...checked, typed] : checked;
      else if (checked[0] !== undefined) data[name] = checked[0];
      else if (typed) data[name] = typed;
    } else if ((type === "number" || type === "range") && value.trim() !== "" && Number.isFinite(Number(value))) {
      data[name] = Number(value);
    } else {
      data[name] = value;
    }
  }
  return data;
}

/** One answer of a choice group, as it is shown and as it is submitted. */
export interface FormOption { label: string; value: string }

/** One question of a form: the control group that answers it, with the content that introduces it. */
export interface FormTab {
  key: string;
  /** The control `name` the answer is submitted under. */
  name: string;
  /** The question this field answers, derived as omp's `fieldQuestions` derives it. */
  question: string;
  /** The enclosing `<fieldset>`'s legend, when it is not the question itself. */
  header?: string;
  /** Content between the previous field and this one. */
  context: ReactNode[];
  /** The control itself: every option of a group, its Other box, a select or a text field. */
  control: ReactNode[];
  /** Answers of a choice group, in document order; empty for text fields. */
  options: FormOption[];
}

export interface FormPlan {
  tabs: FormTab[];
  /** Content after the last field, which no field introduces. */
  trailing: ReactNode[];
}

/** Tags omp treats as blocks of their own rather than as the caption of the field below. */
const CAPTION_BREAKS: Record<string, true> = { ul: true, ol: true, pre: true, table: true, img: true, svg: true, hr: true, fieldset: true };

/** `type\0name` of the group a control answers in; undefined for hidden and unnamed controls. */
function groupKey(control: Element): string | undefined {
  const name = control.getAttribute("name");
  if (!name) return undefined;
  if (control.localName !== "input") return `${control.localName}\0${name}`;
  const type = control.getAttribute("type")?.toLowerCase() ?? "text";
  if (type === "hidden") return undefined;
  return `${type === "radio" || type === "checkbox" ? type : "text"}\0${name}`;
}

const controlsIn = (element: Element): Element[] =>
  [...(element.matches(CONTROL_SELECTOR) ? [element] : []), ...element.querySelectorAll(CONTROL_SELECTOR)]
    .filter((control) => groupKey(control) !== undefined);

/** A control's own label text: its wrapping `<label>` or the `<label for>` naming it, controls stripped. */
function labelText(control: Element, labelFor: Map<string, Element>): string {
  const id = control.getAttribute("id");
  const label = control.closest("label") ?? (id ? labelFor.get(id) : undefined);
  if (!label) return "";
  const clone = label.cloneNode(true) as Element;
  for (const nested of clone.querySelectorAll(CONTROL_SELECTOR)) nested.remove();
  return collapse(clone.textContent ?? "");
}

function optionsOf(controls: Element[], labelFor: Map<string, Element>): FormOption[] {
  const [first] = controls;
  if (first.localName === "select") {
    return Array.from(first.querySelectorAll("option"), (option) => ({
      label: collapse(option.textContent ?? "") || (option.getAttribute("value") ?? ""),
      value: option.getAttribute("value") ?? option.textContent ?? "",
    }));
  }
  if (first.localName !== "input" || choiceType(first) === undefined) return [];
  return controls.map((control) => ({
    label: labelText(control, labelFor) || (control.getAttribute("value") ?? "on"),
    value: control.getAttribute("value") ?? "on",
  }));
}

interface PlanState {
  tabs: FormTab[];
  byKey: Map<string, FormTab>;
  /** Content seen since the last field, waiting for the field it introduces. */
  context: ReactNode[];
  /** Text of the last content piece: omp's fallback question for the next field. */
  caption: string;
  /** Position of that piece in `context`, so a field does not repeat its own question. */
  captionIndex: number;
  /** Group still collecting options, so text between its options stays with it. */
  open?: { tab: FormTab; last: Element };
}

/**
 * Splits a parsed form into one tab per control group, in document order.
 *
 * A radio or checkbox group is one question wherever its options sit, and the
 * blocks before a field introduce it — the same model omp's terminal dialog
 * draws from (`packages/tui/src/html-form/parse.ts`). Each tab keeps the
 * rendered nodes of its own controls, so every control of the form is mounted
 * in one `<form>` and {@link readFormData} reads the whole submission however
 * the user moved between tabs.
 */
export function planFormTabs(root: ParentNode, ctx: FormCtx): FormPlan {
  const labelFor = new Map<string, Element>();
  for (const label of root.querySelectorAll("label[for]")) {
    if (!labelFor.has(label.getAttribute("for")!)) labelFor.set(label.getAttribute("for")!, label);
  }
  const groups = new Map<string, Element[]>();
  for (const control of root.querySelectorAll(CONTROL_SELECTOR)) {
    const key = groupKey(control);
    if (key) groups.set(key, [...(groups.get(key) ?? []), control]);
  }
  const state: PlanState = { tabs: [], byKey: new Map(), context: [], caption: "", captionIndex: -1 };

  const addContext = (node: ReactNode, caption: string) => {
    if (node === null || node === undefined || node === false) return;
    // Text between the options of a group belongs to that group, not to the next field.
    if (state.open) {
      state.open.tab.control.push(node);
      return;
    }
    state.context.push(node);
    state.caption = caption;
    state.captionIndex = caption ? state.context.length - 1 : -1;
  };

  const openTab = (control: Element, key: string, section: string): FormTab => {
    const controls = groups.get(key)!;
    const [type, name] = key.split("\0");
    const isChoice = type === "radio" || type === "checkbox";
    const options = optionsOf(controls, labelFor);
    // omp's rule: the control's own label, else the text right above it, else the
    // section title, else a lone option's label, else the name.
    const lone = isChoice && controls.length === 1 ? options[0]?.label ?? "" : "";
    const question = (isChoice ? "" : labelText(control, labelFor)) || state.caption || section || lone || name;
    const context = state.context.filter((_, index) => index !== state.captionIndex || state.caption !== question);
    const tab: FormTab = {
      key,
      name,
      question,
      header: section && section !== question ? section : undefined,
      context,
      control: [],
      options,
    };
    state.tabs.push(tab);
    state.byKey.set(key, tab);
    state.context = [];
    state.caption = "";
    state.captionIndex = -1;
    return tab;
  };

  const walk = (nodes: Iterable<ChildNode>, section: string, prefix: string) => {
    let index = 0;
    for (const node of nodes) {
      const key = `${prefix}.${index++}`;
      if (node.nodeType === 3) {
        if (collapse(node.textContent ?? "")) addContext(formNode(node, ctx, key), collapse(node.textContent ?? ""));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      // A label drawn inside its control's row is not a node of its own here.
      if (ctx.adopted.has(element)) continue;
      const controls = controlsIn(element);
      if (controls.length === 0) {
        addContext(formNode(element, ctx, key), CAPTION_BREAKS[element.localName] ? "" : collapse(element.textContent ?? ""));
        continue;
      }
      if (element.localName === "fieldset") {
        const legend = Array.from(element.children).find((child) => child.localName === "legend");
        const title = legend ? collapse(legend.textContent ?? "") : section;
        walk(Array.from(element.childNodes).filter((child) => child !== legend), title, key);
        continue;
      }
      const keys = new Set(controls.map((control) => groupKey(control)!));
      if (keys.size > 1 || (controls.length > 1 && !element.matches(CONTROL_SELECTOR) && element.localName !== "label")) {
        // A wrapper around several questions is layout: its children are the content.
        walk(element.childNodes, section, key);
        continue;
      }
      const groupId = [...keys][0];
      const tab = state.byKey.get(groupId) ?? openTab(controls[0], groupId, section);
      tab.control.push(formNode(element, ctx, key));
      const group = groups.get(groupId)!;
      const last = group[group.length - 1];
      state.open = controls.includes(last) ? undefined : { tab, last };
    }
  };

  walk(root.childNodes, "", "f");
  return { tabs: state.tabs, trailing: state.context };
}

/** The live controls answering a tab, the group's Other box included. */
export function tabControls(form: HTMLFormElement, tab: FormTab): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  return queryAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form, CONTROL_SELECTOR)
    .filter((control) => control.name === tab.name || control.dataset.other === tab.name);
}

/** The answers a tab currently carries, paired with the option label that shows them. */
export function tabAnswers(tab: FormTab, data: HtmlFormData): { value: string; label: string; isOption: boolean }[] {
  const raw = data[tab.name];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [String(raw)];
  return values.filter((value) => value !== "").map((value) => {
    const option = tab.options.find((candidate) => candidate.value === value);
    return { value, label: option?.label ?? value, isOption: option !== undefined };
  });
}
