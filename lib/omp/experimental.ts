// Experimental-flag parsing for the rich multi-question ask dialog
// (OMP_WEB_EXPERIMENTAL_ASK_DIALOG). Kept separate from rpc-process.ts so the
// spawn-env hunk there stays a couple of lines. Mirrors lib/update-policy.ts.

const TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];

export const EXPERIMENTAL_ASK_DIALOG_ENV_VAR = "OMP_WEB_EXPERIMENTAL_ASK_DIALOG";

/** Whether the rich multi-question ask dialog experiment is enabled for this process. */
export function isAskDialogExperimentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EXPERIMENTAL_ASK_DIALOG_ENV_VAR];
  return typeof value === "string" && TRUTHY_ENV_VALUES.includes(value.trim().toLowerCase());
}
