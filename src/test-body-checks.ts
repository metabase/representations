import {
  type Doc,
  type RowsData,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { tableLabel } from "./tables.js";

/**
 * What the first row of `data` that does not carry exactly the declared
 * columns gets wrong, in Metabase's words; null when every row does. Names
 * compare case-sensitively, as in Metabase.
 */
function rowsColumnsMismatch(data: RowsData): string | null {
  const declared = new Set(data.columns.map((c) => c.name));
  const index = data.rows.findIndex((row) => {
    const keys = Object.keys(row);
    return keys.length !== declared.size || !keys.every((k) => declared.has(k));
  });
  if (index === -1) {
    return null;
  }
  const keys = new Set(Object.keys(data.rows[index]));
  const quoted = (names: readonly string[]) =>
    [...names]
      .sort()
      .map((n) => JSON.stringify(n))
      .join(", ");
  const missing = [...declared].filter((name) => !keys.has(name));
  const extra = [...keys].filter((name) => !declared.has(name));
  return [
    `row ${index + 1}: every row must carry exactly the declared columns`,
    ...(missing.length > 0 ? [`missing ${quoted(missing)}`] : []),
    ...(extra.length > 0 ? [`not declared: ${quoted(extra)}`] : []),
  ].join("; ");
}

type TestDoc = ValidDoc<"TransformTest">;

/** The test's `rows` inputs and its `equals` expectations in rows format, each with how messages name it. */
function rowsDataOf(test: TestDoc): { label: string; data: RowsData }[] {
  return [
    ...test.body.inputs.flatMap((input) =>
      input.format === "rows"
        ? [
            {
              label: `input ${tableLabel({ schema: input.table.schema ?? null, name: input.table.name })}`,
              data: input,
            },
          ]
        : [],
    ),
    ...test.body.expectations.flatMap((expectation) =>
      expectation.type === "equals" && expectation.format === "rows"
        ? [{ label: `expectation ${expectation.name}`, data: expectation }]
        : [],
    ),
  ];
}

/**
 * Reports each `rows` input and each `equals` expectation in rows format
 * whose rows do not all carry exactly the declared columns. Metabase refuses
 * such a test on every insert, an import included.
 */
export function reportRowsColumns(docs: readonly Doc[], report: Report): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    for (const { label, data } of rowsDataOf(test)) {
      const mismatch = rowsColumnsMismatch(data);
      if (mismatch !== null) {
        report("row-columns-mismatch", test, `${label}, ${mismatch}`);
      }
    }
  }
}

/**
 * Reports each name that more than one expectation of a test holds, once per
 * name. Metabase refuses such a test on every insert; names compare
 * case-sensitively, as in Metabase.
 */
export function reportExpectationNames(
  docs: readonly Doc[],
  report: Report,
): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    const counts = new Map<string, number>();
    for (const { name } of test.body.expectations) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      if (count > 1) {
        report(
          "duplicate-expectation-name",
          test,
          `expectation name ${JSON.stringify(name)} is held by ${count} expectations; names must be unique within a test`,
        );
      }
    }
  }
}

/**
 * Warns on each test with no expectations. Metabase accepts it, and a run
 * passes once the transform's output builds from the inputs.
 */
export function reportEmptyExpectations(
  docs: readonly Doc[],
  report: Report,
): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    if (test.body.expectations.length === 0) {
      report(
        "no-expectations",
        test,
        "the test has no expectations; it passes whenever the transform runs on its inputs",
      );
    }
  }
}
