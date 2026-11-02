// The comparisons lint-parity.ts makes, apart from its calls to Metabase.
import { loadDocs, validDocsOf, type ValidDoc } from "../src/documents.js";
import type { LintFinding, LintRule } from "../src/findings.js";
import { loadSchemas } from "../src/schemas.js";
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

/** For each refusal of a transform test's inputs, the lint rule that predicts it. */
export const RULE_OF_REFUSAL: ReadonlyMap<string, LintRule> = new Map([
  ["transform-test.missing-inputs", "missing-input"],
  ["transform-test.unused-inputs", "unused-input"],
  ["transform-test.duplicate-input-table", "duplicate-input"],
]);

/**
 * The rules of RULE_OF_REFUSAL in the order Metabase checks a transform test's
 * inputs, and stops at the first refusal: missing, unused, then duplicate
 * inputs.
 */
export const TEST_RULE_ORDER: readonly LintRule[] = [
  "missing-input",
  "unused-input",
  "duplicate-input",
];

/**
 * Refusals that say nothing of the inputs: Metabase refuses a transform that
 * is not a query transform before it checks them, and SQL it cannot parse
 * either before them, the transform's, or after them, an expectation's.
 */
const APART_FROM_INPUTS = new Set([
  "transform-test.unsupported-transform",
  "transform-test.unparseable-source",
]);

/**
 * Refusals Metabase makes after the inputs pass: a table the transform's or an
 * expectation's SQL reads remains once Metabase replaces the test's tables.
 */
const AFTER_INPUTS = new Set(["transform-test.unremapped-reference"]);

const TEST_RULES = new Set(TEST_RULE_ORDER);

/** Metabase's refusal of a transform test. */
export type TestRefusal = {
  /** The error code, such as `transform-test.missing-inputs`. */
  readonly code: string;
  /** Metabase's message, or null when it sent none. */
  readonly message: string | null;
};

/** The refusal as a line of output names it: its code, then its message. */
export function describeRefusal(refusal: TestRefusal): string {
  const message =
    refusal.message === null ? "" : ` (${JSON.stringify(refusal.message)})`;
  return `${refusal.code}${message}`;
}

/** How Metabase's answer to a transform test and the lint's findings on it compare. */
export type TestComparison =
  | { verdict: "agrees" }
  | { verdict: "differs"; difference: string }
  /** Metabase's answer says nothing of what the lint compares. */
  | { verdict: "compared-nothing"; reason: string };

/** Where each input rule's message names its tables. */
const TABLES_IN_MESSAGE: ReadonlyMap<LintRule, RegExp> = new Map([
  ["missing-input", /^no input for (.+), which transform /],
  ["unused-input", /^input (.+) is not read by transform /],
  ["duplicate-input", /^inputs stand in for the same table: (.+)$/],
]);

/**
 * The tables the lint's `findings` of `rule` name, each in lower case and
 * once, as Metabase's refusals label a table: a table with no schema by its
 * name alone.
 */
function tablesOfFindings(
  rule: LintRule,
  findings: readonly LintFinding[],
): string[] {
  const pattern = TABLES_IN_MESSAGE.get(rule);
  const tables = findings.flatMap((f) => {
    const named = f.rule === rule ? pattern?.exec(f.message)?.[1] : undefined;
    return named === undefined ? [] : named.split(", ");
  });
  return [
    ...new Set(
      tables.map((t) => t.replace(/ \(no schema\)$/, "").toLowerCase()),
    ),
  ].sort();
}

/**
 * Compares Metabase's answer to a transform test with the lint's errors on the
 * test's inputs. `refusal` is Metabase's refusal, or null when Metabase
 * accepts the test, and `tables` the tables the refusal lists, or null when it
 * lists none. Metabase stops at its first refusal (TEST_RULE_ORDER), so a
 * refusal proves that the checks before it passed, and says nothing of the
 * checks after it. A refusal of the inputs agrees when the lint reports that
 * refusal's rule, for the tables the refusal lists, and no input rule
 * Metabase checks earlier. A refusal after the inputs agrees when the lint
 * reports no input error. A refusal apart from the inputs compares nothing.
 */
export function compareTest(
  refusal: TestRefusal | null,
  tables: readonly string[] | null,
  findings: readonly LintFinding[],
): TestComparison {
  const errorRules = new Set(
    findings
      .filter((f) => f.severity === "error" && TEST_RULES.has(f.rule))
      .map((f) => f.rule),
  );
  const differs = (difference: string): TestComparison => ({
    verdict: "differs",
    difference,
  });
  if (refusal === null) {
    return errorRules.size === 0
      ? { verdict: "agrees" }
      : differs(
          `Metabase accepts it; the lint reports ${[...errorRules].join(", ")}`,
        );
  }
  if (APART_FROM_INPUTS.has(refusal.code)) {
    return {
      verdict: "compared-nothing",
      reason: `Metabase refuses it with ${describeRefusal(refusal)}, which says nothing of its inputs`,
    };
  }
  if (AFTER_INPUTS.has(refusal.code)) {
    return errorRules.size === 0
      ? { verdict: "agrees" }
      : differs(
          `Metabase refuses it with ${describeRefusal(refusal)}, so it passed the input checks; the lint reports ${[...errorRules].join(", ")}`,
        );
  }
  const rule = RULE_OF_REFUSAL.get(refusal.code);
  if (rule === undefined) {
    return differs(
      `Metabase refuses it with ${describeRefusal(refusal)}, which no error rule predicts`,
    );
  }
  const earlier = TEST_RULE_ORDER.slice(
    0,
    TEST_RULE_ORDER.indexOf(rule),
  ).filter((r) => errorRules.has(r));
  if (earlier.length > 0) {
    return differs(
      `Metabase refuses it with ${describeRefusal(refusal)}, so it passed the checks before ${rule}; the lint reports ${earlier.join(", ")}`,
    );
  }
  if (!errorRules.has(rule)) {
    return differs(
      `Metabase refuses it with ${describeRefusal(refusal)}; the lint reports no ${rule}`,
    );
  }
  if (tables === null) {
    return { verdict: "agrees" };
  }
  const listed = [...new Set(tables.map((t) => t.toLowerCase()))].sort();
  const reported = tablesOfFindings(rule, findings);
  return listed.join("\n") === reported.join("\n")
    ? { verdict: "agrees" }
    : differs(
        `Metabase refuses it with ${describeRefusal(refusal)} for ${tables.join(", ")}; the lint reports ${rule} for ${reported.join(", ")}`,
      );
}

/**
 * For each of Metabase's refusals of a transform it is asked to save, by the
 * message it answers with, the lint rule that predicts it. The messages are
 * Metabase's English ones; Metabase translates them into the user's locale,
 * so on another locale every refusal reads as one no rule predicts.
 */
export const RULE_OF_TRANSFORM_REFUSAL: ReadonlyMap<string, LintRule> = new Map(
  [
    ["A target schema is required for this database.", "missing-target-schema"],
    [
      "Incremental transform with a native query requires a table variable. Please add a table variable to the query and update the checkpoint field.",
      "missing-incremental-table-tag",
    ],
    ["The target database cannot be found.", "missing-target-database"],
  ],
);

/**
 * The rules of RULE_OF_TRANSFORM_REFUSAL in the order Metabase checks a
 * transform it is asked to save, stopping at the first refusal: that the
 * target database exists, then that the target names a schema where the
 * database has schemas, then that an incremental native query has a table
 * variable.
 */
export const TRANSFORM_RULE_ORDER: readonly LintRule[] = [
  "missing-target-database",
  "missing-target-schema",
  "missing-incremental-table-tag",
];

/**
 * The rule of TRANSFORM_RULE_ORDER whose refusal a finding of each rule
 * predicts. A blank target schema predicts the refusal of no schema: a probe
 * sends no schema for a blank one, which Metabase's endpoint schema refuses
 * before its own check.
 */
const SAVE_RULE_OF: ReadonlyMap<LintRule, LintRule> = new Map([
  ...TRANSFORM_RULE_ORDER.map((rule) => [rule, rule] as const),
  ["blank-target-schema", "missing-target-schema"],
]);

/**
 * Compares Metabase's answer to saving a transform with the lint's findings
 * of the rules SAVE_RULE_OF maps on it, at any severity:
 * `missing-target-schema` is a warning, since a pull accepts what the API
 * refuses. `refusal` is the message Metabase refuses it with, or null when
 * Metabase accepts it. Metabase stops at its first refusal
 * (TRANSFORM_RULE_ORDER), so a refusal proves that the checks before it
 * passed, and says nothing of the checks after it. A refusal agrees when the
 * lint reports that refusal's rule and no rule Metabase checks earlier.
 * Returns null when the two agree, else the difference.
 */
export function transformVerdictDiffers(
  refusal: string | null,
  findings: readonly LintFinding[],
): string | null {
  const saveRules = new Set(
    findings.flatMap((f) => {
      const rule = SAVE_RULE_OF.get(f.rule);
      return rule === undefined ? [] : [rule];
    }),
  );
  if (refusal === null) {
    return saveRules.size === 0
      ? null
      : `Metabase accepts it; the lint reports ${[...saveRules].join(", ")}`;
  }
  const rule = RULE_OF_TRANSFORM_REFUSAL.get(refusal);
  if (rule === undefined) {
    return `Metabase refuses it with ${JSON.stringify(refusal)}, which no lint rule predicts`;
  }
  const earlier = TRANSFORM_RULE_ORDER.slice(
    0,
    TRANSFORM_RULE_ORDER.indexOf(rule),
  ).filter((r) => saveRules.has(r));
  if (earlier.length > 0) {
    return `Metabase refuses it with ${JSON.stringify(refusal)}, so it passed the checks before ${rule}; the lint reports ${earlier.join(", ")}`;
  }
  return saveRules.has(rule)
    ? null
    : `Metabase refuses it with ${JSON.stringify(refusal)}; the lint reports no ${rule}`;
}

/**
 * Each transform of `folder` that `mutated` changes, as both folders hold it,
 * matched by entity id, and whether the change is only to what a probe
 * carries: the target's type, schema and database, and the source's
 * incremental strategy.
 */
export function changedTransforms(
  folder: string,
  mutated: string,
): {
  clean: ValidDoc<"Transform">;
  mutated: ValidDoc<"Transform">;
  carried: boolean;
}[] {
  const transformsOf = (dir: string) =>
    validDocsOf(loadDocs(dir, loadSchemas()).docs, "Transform");
  const clean = new Map(transformsOf(folder).map((d) => [d.body.entity_id, d]));
  return transformsOf(mutated).flatMap((doc) => {
    const before = clean.get(doc.body.entity_id);
    return before !== undefined &&
      JSON.stringify(before.body) !== JSON.stringify(doc.body)
      ? [
          {
            clean: before,
            mutated: doc,
            carried:
              JSON.stringify(uncarried(before)) ===
              JSON.stringify(uncarried(doc)),
          },
        ]
      : [];
  });
}

/**
 * The transform's body without what a probe carries from its file: the
 * target's type, schema and database, and the source's incremental strategy.
 */
function uncarried(doc: ValidDoc<"Transform">): Record<string, unknown> {
  const {
    type: _type,
    schema: _schema,
    database: _database,
    ...target
  } = doc.body.target;
  const source: Record<string, unknown> = { ...doc.body.source };
  delete source["source-incremental-strategy"];
  return { ...doc.body, target, source };
}
