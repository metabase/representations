/** The lint cannot run: its settings are missing or invalid, or the SQL parser cannot start. */
export class LintSetupError extends Error {
  override name = "LintSetupError";
}
