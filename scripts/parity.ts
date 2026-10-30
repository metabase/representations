// The comparisons lint-parity.ts makes, apart from its calls to Metabase.
import type { LintFinding, LintRule } from "../src/findings.js";
import { tableLabel, type TableName } from "../src/tables.js";

/**
 * Whether `label`, a table as Metabase's refusals name it, and `table`, as the
 * lint reads it, are one table. Metabase labels a table as its SQL names it:
 * `schema.name`, or `name` alone when the SQL gives no schema. The lint keeps a
 * table as the SQL names it too, so the two compare exactly, ignoring case: a
 * table with no schema matches only a bare label, and a qualified table only
 * the label with its schema. A dot in the label is not split, so a schema or
 * name holding a dot compares whole.
 */
export function sameTableLabel(label: string, table: TableName): boolean {
  const written =
    table.schema === null ? table.name : `${table.schema}.${table.name}`;
  return label.toLowerCase() === written.toLowerCase();
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

/**
 * The rules of RULE_OF_REFUSAL in the order Metabase checks a transform test,
 * and stops at the first refusal: whether the transform is a query transform,
 * then missing, unused and duplicate inputs, then whether the transform's SQL,
 * and then each expectation's, reads only the test's tables. The transform's
 * own unremapped reference has no rule; it sits between duplicate-input and
 * expectation-reads-other-table.
 */
export const TEST_RULE_ORDER: readonly LintRule[] = [
  "untestable-transform",
  "missing-input",
  "unused-input",
  "duplicate-input",
  "expectation-reads-other-table",
];

const TEST_RULES = new Set(TEST_RULE_ORDER);

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
 * Metabase stops at its first refusal (TEST_RULE_ORDER), so a refusal proves
 * that the checks before it passed, and says nothing of the checks after it. A
 * refusal agrees when the lint reports that refusal's rule and no rule Metabase
 * checks earlier; the lint's errors on later rules are ignored. A refusal with
 * no rule, such as an unremapped reference in the transform's own SQL, is a
 * difference. Returns null when the two agree, else the difference.
 */
export function testVerdictDiffers(
  refusal: TestRefusal | null,
  findings: readonly LintFinding[],
): string | null {
  const errorRules = new Set(
    findings
      .filter((f) => f.severity === "error" && TEST_RULES.has(f.rule))
      .map((f) => f.rule),
  );
  if (refusal === null) {
    return errorRules.size === 0
      ? null
      : `Metabase accepts it; the lint reports ${[...errorRules].join(", ")}`;
  }
  const rule = refusal.onTransform
    ? undefined
    : RULE_OF_REFUSAL.get(refusal.code);
  if (rule === undefined) {
    return `Metabase refuses it with ${describeRefusal(refusal)}, which no lint rule predicts`;
  }
  const earlier = TEST_RULE_ORDER.slice(
    0,
    TEST_RULE_ORDER.indexOf(rule),
  ).filter((r) => errorRules.has(r));
  if (earlier.length > 0) {
    return `Metabase refuses it with ${describeRefusal(refusal)}, so it passed the checks before ${rule}; the lint reports ${earlier.join(", ")}`;
  }
  return errorRules.has(rule)
    ? null
    : `Metabase refuses it with ${describeRefusal(refusal)}; the lint reports no ${rule}`;
}
