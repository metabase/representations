import type { Doc } from "./documents.js";

/** Every rule, in the order the lint's output groups its findings. */
export const LINT_RULES = [
  "schema",
  "duplicate-entity-id",
  "dangling-transform-id",
  "wrong-type-transform-id",
  "duplicate-target",
  "transform-cycle",
  "missing-input",
  "unused-input",
  "untestable-transform",
  "duplicate-input",
  "expectation-reads-other-table",
  "unknown-table",
  "input-match-undecided",
  "reads-not-checked",
] as const;

export type LintRule = (typeof LINT_RULES)[number];

export type LintSeverity = "error" | "warning";

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

/** Records a finding on `doc`; `related` names the other files involved. */
export type Report = (
  rule: LintRule,
  severity: LintSeverity,
  doc: Doc,
  message: string,
  related?: string[],
) => void;
