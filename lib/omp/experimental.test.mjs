import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isAskDialogExperimentEnabled, EXPERIMENTAL_ASK_DIALOG_ENV_VAR } = await jiti.import("./experimental.ts");

test("unset or empty env leaves the experiment disabled", () => {
  assert.equal(isAskDialogExperimentEnabled({}), false);
  assert.equal(isAskDialogExperimentEnabled({ [EXPERIMENTAL_ASK_DIALOG_ENV_VAR]: "" }), false);
});

test("accepts 1/true/yes/on case-insensitively, with surrounding whitespace", () => {
  for (const value of ["1", "true", "YES", " On ", "TRUE"]) {
    assert.equal(isAskDialogExperimentEnabled({ [EXPERIMENTAL_ASK_DIALOG_ENV_VAR]: value }), true, value);
  }
});

test("rejects falsy-looking or unrelated values", () => {
  for (const value of ["0", "false", "no", "off", "nope", "2"]) {
    assert.equal(isAskDialogExperimentEnabled({ [EXPERIMENTAL_ASK_DIALOG_ENV_VAR]: value }), false, value);
  }
});

test("defaults to process.env when no env object is passed", () => {
  const previous = process.env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR];
  try {
    process.env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR] = "1";
    assert.equal(isAskDialogExperimentEnabled(), true);
    delete process.env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR];
    assert.equal(isAskDialogExperimentEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR];
    else process.env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR] = previous;
  }
});
