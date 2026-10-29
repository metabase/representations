export type LintSeverity = "error" | "warning";

/**
 * Every rule, in the order the lint's output groups its findings, with the
 * severity of its findings. An error is something Metabase refuses or cannot
 * resolve. A warning is a check the lint could not decide, or a tree Metabase
 * accepts but that is likely a mistake.
 */
export const LINT_RULE_SEVERITY = {
  schema: "error",
  "skipped-by-metabase": "warning",
  "duplicate-entity-id": "error",
  "duplicate-target": "warning",
  "transform-cycle": "error",
  "unknown-table": "warning",
  "null-schema-reference": "warning",
  "reads-not-checked": "warning",
} as const satisfies Record<string, LintSeverity>;

export type LintRule = keyof typeof LINT_RULE_SEVERITY;

/** Every rule, in the order the lint's output groups its findings. */
export const LINT_RULES = Object.keys(
  LINT_RULE_SEVERITY,
) as readonly LintRule[];

export type LintEntity = {
  model: string | null;
  entity_id: string | null;
  name: string | null;
};

export type LintFinding = {
  rule: LintRule;
  severity: LintSeverity;
  file: string;
  entity: LintEntity;
  message: string;
  related: string[];
};

/** The file a finding is on, with the model and the body the lint read from it. */
export type FindingSubject = {
  file: string;
  model: string | null;
  body: Readonly<Record<string, unknown>>;
};

/**
 * Records a finding on `subject` at its rule's severity; `related` names the
 * other files involved.
 */
export type Report = (
  rule: LintRule,
  subject: FindingSubject,
  message: string,
  related?: string[],
) => void;
