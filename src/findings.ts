import type { Doc } from "./documents.js";

export type LintSeverity = "error" | "warning";

/**
 * Every rule, in the order the lint's output groups its findings, with the
 * severity of its findings. An error is something Metabase refuses or cannot
 * resolve. A warning is a check the lint could not decide, or a tree Metabase
 * accepts but that is likely a mistake.
 */
export const LINT_RULE_SEVERITY = {
  schema: "error",
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

export type LintFinding = {
  rule: LintRule;
  severity: LintSeverity;
  file: string;
  entity: LintEntity;
  message: string;
  related: string[];
};

/**
 * Records a finding on `doc` at its rule's severity; `related` names the other
 * files involved.
 */
export type Report = (
  rule: LintRule,
  doc: Doc,
  message: string,
  related?: string[],
) => void;
