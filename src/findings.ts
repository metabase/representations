export type LintSeverity = "error" | "warning";

/**
 * Every rule, in the order the lint's output groups its findings, with the
 * severity of its findings. An error is something Metabase refuses, cannot
 * resolve, or silently drops. A warning is a check the lint could not decide, or a tree Metabase
 * accepts but that is likely a mistake.
 */
export const LINT_RULE_SEVERITY = {
  schema: "error",
  "skipped-by-metabase": "warning",
  "duplicate-entity-id": "error",
  "dangling-transform-id": "error",
  "wrong-type-transform-id": "error",
  "duplicate-target": "warning",
  "transform-cycle": "error",
  "transform-collection": "error",
  "missing-incremental-table-tag": "error",
  "missing-target-database": "error",
  "missing-target-schema": "error",
  "unsupported-transform-engine": "warning",
  "empty-native-query": "warning",
  "missing-input": "error",
  "unused-input": "error",
  "untestable-transform": "error",
  "untestable-engine": "warning",
  "duplicate-input": "error",
  "expectation-reads-other-table": "error",
  "row-columns-mismatch": "error",
  "duplicate-expectation-name": "error",
  "unknown-table": "warning",
  "null-schema-reference": "warning",
  "no-expectations": "warning",
  "input-missing-read-column": "warning",
  "upstream-column-mismatch": "warning",
  "table-qualified-column": "warning",
  "live-sql-input": "warning",
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

/** A finding of the rule `R`, at that rule's severity. */
export type LintFindingOf<R extends LintRule> = {
  rule: R;
  severity: (typeof LINT_RULE_SEVERITY)[R];
  file: string;
  entity: LintEntity;
  message: string;
  related: string[];
};

/** A finding of any rule; its severity is its rule's (`LINT_RULE_SEVERITY`). */
export type LintFinding = { [R in LintRule]: LintFindingOf<R> }[LintRule];

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
