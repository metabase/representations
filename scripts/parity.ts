// The comparisons lint-parity.ts makes, apart from its calls to Metabase.
import type { LintFinding, LintRule } from "../src/findings.js";
import { tableLabel, type TableName } from "../src/tables.js";

/**
 * Whether `label`, a table as Metabase's refusals name it (`schema.name`, or
 * `name` with no schema), and `table`, as the lint reads it, are one table.
 * Names compare ignoring case, and schemas too where both sides have one. A
 * dot in the label is not split, so a schema or name holding a dot compares
 * whole.
 */
export function sameTableLabel(label: string, table: TableName): boolean {
  const folded = label.toLowerCase();
  const name = table.name.toLowerCase();
  if (folded === name) {
    return true;
  }
  return table.schema === null
    ? folded.endsWith(`.${name}`)
    : folded === `${table.schema.toLowerCase()}.${name}`;
}

/**
 * The difference between the tables the lint reads and those Metabase lists,
 * as a message, or null when each table on one side is a table on the other.
 */
export function readsDiffer(
  lint: readonly TableName[],
  metabase: readonly string[],
): string | null {
  const lintOnly = lint.filter(
    (t) => !metabase.some((label) => sameTableLabel(label, t)),
  );
  const metabaseOnly = metabase.filter(
    (label) => !lint.some((t) => sameTableLabel(label, t)),
  );
  if (lintOnly.length === 0 && metabaseOnly.length === 0) {
    return null;
  }
  return [
    lintOnly.length > 0
      ? `only the lint reads ${lintOnly.map(tableLabel).join(", ")}`
      : "",
    metabaseOnly.length > 0
      ? `only Metabase reads ${metabaseOnly.join(", ")}`
      : "",
  ]
    .filter((part) => part !== "")
    .join("; ");
}

/**
 * Metabase's refusals of a transform test that say nothing about the lint:
 * the database cannot run transform tests, so Metabase checked nothing.
 */
export const ENVIRONMENT_REFUSALS = new Set([
  "transform-test.unsupported-driver",
]);

/** For each refusal of a transform test, the lint rule that predicts it. */
export const RULE_OF_REFUSAL: ReadonlyMap<string, LintRule> = new Map([
  ["transform-test.missing-inputs", "missing-input"],
  ["transform-test.unused-inputs", "unused-input"],
  ["transform-test.duplicate-input-table", "duplicate-input"],
  ["transform-test.unremapped-reference", "expectation-reads-other-table"],
  ["transform-test.unsupported-transform", "untestable-transform"],
]);

const TEST_RULES = new Set(RULE_OF_REFUSAL.values());

/** Metabase's refusal of a transform test. */
export type TestRefusal = {
  /** The error code, such as `transform-test.missing-inputs`. */
  readonly code: string;
  /** Metabase's message, or null when it sent none. */
  readonly message: string | null;
  /**
   * Whether the refusal is about the transform's own SQL rather than the
   * test's. Only an unremapped-reference refusal can be either.
   */
  readonly onTransform: boolean;
};

/** The refusal as a line of output names it: its code, then its message. */
export function describeRefusal(refusal: TestRefusal): string {
  const where = refusal.onTransform ? " on the transform" : "";
  const message =
    refusal.message === null ? "" : ` (${JSON.stringify(refusal.message)})`;
  return `${refusal.code}${where}${message}`;
}

/**
 * Compares Metabase's answer to a transform test with the lint's errors on it.
 * `refusal` is Metabase's refusal, or null when Metabase accepts the test.
 * Metabase stops at its first refusal, so a refusal agrees when the lint
 * reports that refusal's rule, whatever else it reports. A refusal about the
 * transform's own SQL has no rule: the lint's rules on it are warnings, which
 * the comparison ignores. Returns null when the two agree, else the
 * difference.
 */
export function testVerdictDiffers(
  refusal: TestRefusal | null,
  findings: readonly LintFinding[],
): string | null {
  const errors = findings.filter(
    (f) => f.severity === "error" && TEST_RULES.has(f.rule),
  );
  if (refusal === null) {
    return errors.length === 0
      ? null
      : `Metabase accepts it; the lint reports ${[...new Set(errors.map((f) => f.rule))].join(", ")}`;
  }
  const rule = refusal.onTransform
    ? undefined
    : RULE_OF_REFUSAL.get(refusal.code);
  if (rule === undefined) {
    return `Metabase refuses it with ${describeRefusal(refusal)}, which no lint rule predicts`;
  }
  return errors.some((f) => f.rule === rule)
    ? null
    : `Metabase refuses it with ${describeRefusal(refusal)}; the lint reports no ${rule}`;
}
