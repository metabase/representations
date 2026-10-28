// The lint, outside the package's semver guarantees: its rules, findings and
// options can change in any release.
export {
  type DefaultSchemas,
  type DefaultSchemaWanted,
  MissingDefaultSchemasError,
} from "./default-schemas.js";
export {
  LINT_RULE_SEVERITY,
  LINT_RULES,
  type LintEntity,
  type LintFinding,
  type LintRule,
  type LintSeverity,
} from "./findings.js";
export {
  DEFECTS,
  type DefectInfo,
  inject,
  InjectError,
  type InjectOptions,
  type Injection,
} from "./inject.js";
export { lint, type LintOptions, type LintResult } from "./lint.js";
export { CONFIG_FILE, LintSetupError, type LintSettings } from "./settings.js";
