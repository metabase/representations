import {
  type Doc,
  type RowsData,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { tableLabel } from "./tables.js";
import type { NonStringKey, YamlPath } from "./yaml.js";

/**
 * What the first row of `data` that does not carry exactly the declared
 * columns gets wrong: Metabase's rows-match-columns message, prefixed with
 * the row's number, and the row's keys SnakeYAML reads as no string, which
 * Metabase refuses with its own row-schema error; null when every row does. Names
 * compare case-sensitively, as in Metabase. `nonStringKeysOf` gives a row's
 * keys that Metabase reads as no string, by the row's index: Metabase
 * refuses a row with one.
 */
function rowsColumnsMismatch(
  data: RowsData,
  nonStringKeysOf: (row: number) => readonly NonStringKey[],
): string | null {
  const declared = new Set(data.columns.map((c) => c.name));
  const stringKeysOf = (row: number): Set<string> => {
    const unshadowed = new Set(
      nonStringKeysOf(row).flatMap((k) => (k.shadowed ? [] : [k.source])),
    );
    return new Set(
      Object.keys(data.rows[row]).filter((key) => !unshadowed.has(key)),
    );
  };
  const index = data.rows.findIndex((_, row) => {
    const keys = stringKeysOf(row);
    return (
      nonStringKeysOf(row).length > 0 ||
      keys.size !== declared.size ||
      ![...keys].every((k) => declared.has(k))
    );
  });
  if (index === -1) {
    return null;
  }
  const keys = stringKeysOf(index);
  const quoted = (names: readonly string[]) =>
    [...names]
      .sort()
      .map((n) => JSON.stringify(n))
      .join(", ");
  const missing = [...declared].filter((name) => !keys.has(name));
  const extra = [...keys].filter((name) => !declared.has(name));
  const nonString = nonStringKeysOf(index).map((k) => k.source);
  return [
    `row ${index + 1}: every row must carry exactly the declared columns`,
    ...(missing.length > 0 ? [`missing ${quoted(missing)}`] : []),
    ...(extra.length > 0 ? [`not declared: ${quoted(extra)}`] : []),
    ...(nonString.length > 0
      ? [
          `keys YAML reads as no string: ${quoted(nonString)}; quote them, as '${nonString[0]}':`,
        ]
      : []),
  ].join("; ");
}

type TestDoc = ValidDoc<"TransformTest">;

/**
 * The test's `rows` inputs and its `equals` expectations in rows format, each
 * with how messages name it and where it is in the test.
 */
function rowsDataOf(
  test: TestDoc,
): { label: string; data: RowsData; path: YamlPath }[] {
  return [
    ...test.body.inputs.flatMap((input, i) =>
      input.format === "rows"
        ? [
            {
              label: `input ${tableLabel({ schema: input.table.schema ?? null, name: input.table.name })}`,
              data: input,
              path: ["inputs", i],
            },
          ]
        : [],
    ),
    ...test.body.expectations.flatMap((expectation, i) =>
      expectation.type === "equals" && expectation.format === "rows"
        ? [
            {
              label: `expectation ${expectation.name}`,
              data: expectation,
              path: ["expectations", i],
            },
          ]
        : [],
    ),
  ];
}

/** Whether `a` and `b` name the same place. */
const samePath = (a: YamlPath, b: YamlPath): boolean =>
  a.length === b.length && a.every((step, i) => step === b[i]);

/**
 * Reports each `rows` input and each `equals` expectation in rows format
 * whose rows do not all carry exactly the declared columns, by string keys.
 * Metabase refuses such a test on every insert, an import included.
 */
export function reportRowsColumns(docs: readonly Doc[], report: Report): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    for (const { label, data, path } of rowsDataOf(test)) {
      const mismatch = rowsColumnsMismatch(data, (row) =>
        test.nonStringKeys.filter((k) =>
          samePath(k.path, [...path, "rows", row]),
        ),
      );
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
