import type { Doc } from "./documents.js";

/** Every rule, in the order the lint's output groups its findings. */
export const LINT_RULES = [
  "schema",
  "duplicate-entity-id",
  "dangling-transform-id",
  "wrong-type-transform-id",
  "duplicate-target",
  "transform-cycle",
  "transform-collection",
  "missing-incremental-table-tag",
  "missing-target-database",
  "missing-target-schema",
  "unsupported-transform-engine",
  "missing-input",
  "unused-input",
  "untestable-transform",
  "untestable-engine",
  "duplicate-input",
  "expectation-reads-other-table",
  "row-columns-mismatch",
  "duplicate-expectation-name",
  "unknown-table",
  "no-expectations",
  "input-missing-read-column",
  "upstream-column-mismatch",
  "table-qualified-column",
  "live-sql-input",
  "reads-not-checked",
] as const;

export type LintRule = (typeof LINT_RULES)[number];

export type LintSeverity = "error" | "warning";

/**
 * The severity of each rule's findings. An error is a reference Metabase
 * refuses or cannot resolve. A warning is a check the lint could not decide,
 * or a tree Metabase accepts but that is likely a mistake.
 */
export const LINT_RULE_SEVERITY: Readonly<Record<LintRule, LintSeverity>> = {
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
  "no-expectations": "warning",
  "input-missing-read-column": "warning",
  "upstream-column-mismatch": "warning",
  "table-qualified-column": "warning",
  "live-sql-input": "warning",
  "reads-not-checked": "warning",
};

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
