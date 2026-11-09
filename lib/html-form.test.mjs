import assert from "node:assert/strict";
import test from "node:test";

// The dialog's submission rules must stay the ones omp applies when it reads
// the answer back (oh-my-pi/packages/tui/src/html-form/data.ts); a looser
// client would hand the user an error from the agent instead of a field to fix.
const { choiceValue, fieldError, isArrayChoice, spansText, textValue } = await import("./html-form.ts");

function choiceField(options, extra = {}) {
  return {
    kind: "choice",
    name: "field",
    multi: false,
    select: false,
    other: false,
    label: [],
    required: false,
    ...extra,
    options: options.map((option) => ({
      value: option.value,
      label: [{ text: option.label ?? option.value }],
      checked: option.checked === true,
      disabled: option.disabled === true,
    })),
  };
}

function textField(extra = {}) {
  return { kind: "text", name: "field", type: "text", multiline: false, label: [], value: "", placeholder: "", required: false, rows: 1, ...extra };
}

test("a checkbox group of two or more options reports an array; one checkbox reports its value", () => {
  const group = choiceField([{ value: "a" }, { value: "b" }], { multi: true });
  const single = choiceField([{ value: "yes" }], { multi: true });
  assert.equal(isArrayChoice(group), true);
  assert.equal(isArrayChoice(single), false);
  assert.deepEqual(choiceValue(group, new Set([0, 1])), ["a", "b"]);
  assert.equal(choiceValue(single, new Set([0])), "yes");
  assert.equal(choiceValue(single, new Set()), undefined);
});

test("disabled options never answer, and Other text joins or replaces the value", () => {
  const radio = choiceField([{ value: "a" }, { value: "b", disabled: true }], { other: true });
  assert.equal(choiceValue(radio, new Set([1])), undefined);
  assert.equal(choiceValue(radio, new Set([0]), "   "), "a", "blank Other text is no answer");
  assert.equal(choiceValue(radio, new Set([0]), " something else "), "something else");

  const group = choiceField([{ value: "a" }, { value: "b" }], { multi: true, other: true });
  assert.deepEqual(choiceValue(group, new Set([0]), "c"), ["a", "c"]);
  // Without `other` on the field the typed text is not part of the answer.
  const plain = choiceField([{ value: "a" }, { value: "b" }], { multi: true });
  assert.deepEqual(choiceValue(plain, new Set([0]), "c"), ["a"]);
});

test("number and range inputs report numbers, every other input its text", () => {
  assert.equal(textValue(textField({ type: "number" }), "42"), 42);
  assert.equal(textValue(textField({ type: "range" }), "0.5"), 0.5);
  assert.equal(textValue(textField({ type: "number" }), ""), "");
  assert.equal(textValue(textField({ type: "number" }), "ten"), "ten");
  assert.equal(textValue(textField(), "42"), "42");
});

test("required, numeric bounds, lengths, email, url and pattern are enforced", () => {
  assert.equal(fieldError(choiceField([{ value: "a" }], { required: true }), undefined), "Required");
  assert.equal(fieldError(choiceField([{ value: "a" }, { value: "b" }], { multi: true, required: true }), []), "Select at least one");
  assert.equal(fieldError(choiceField([{ value: "a" }], { required: true }), "a"), undefined);
  assert.equal(fieldError(choiceField([{ value: "a" }]), undefined), undefined, "an optional choice may stay empty");

  assert.equal(fieldError(textField({ required: true }), "  "), "Required");
  assert.equal(fieldError(textField({ type: "number", min: 1, max: 10 }), 0), "Must be at least 1");
  assert.equal(fieldError(textField({ type: "number", min: 1, max: 10 }), 11), "Must be at most 10");
  assert.equal(fieldError(textField({ type: "number" }), "ten"), "Enter a number");
  assert.equal(fieldError(textField({ minLength: 3 }), "ab"), "Needs at least 3 characters");
  assert.equal(fieldError(textField({ maxLength: 2 }), "abc"), "At most 2 characters");
  assert.equal(fieldError(textField({ type: "email" }), "nope"), "Enter an email address");
  assert.equal(fieldError(textField({ type: "url" }), "example.com"), "Enter a full URL");
  assert.equal(fieldError(textField({ type: "url" }), "https://example.com"), undefined);
  // Patterns are anchored, as HTML anchors them.
  assert.equal(fieldError(textField({ pattern: "\\d+" }), "12a"), "Must match \\d+");
  assert.equal(fieldError(textField({ pattern: "\\d+" }), "12"), undefined);
  assert.equal(fieldError(textField({ pattern: "([" }), "anything"), undefined, "a pattern the model wrote wrong is ignored");
});

test("spans flatten to the text they carry", () => {
  assert.equal(spansText([{ text: "Use " }, { text: "psql", style: "code" }, { text: "\nfirst" }]), "Use psql\nfirst");
});
