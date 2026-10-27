import {
  displayName,
  type Doc,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers, tableKeys } from "./input-match.js";
import type { Transform } from "./reads.js";
import { tablesReadBySql } from "./sql-tables.js";
import {
  type DefaultSchema,
  type DefaultSchemaOf,
  tableLabel,
  type TableKey,
} from "./tables.js";

type TestDoc = ValidDoc<"TransformTest">;

/** Reports on `doc` when `table`, which it names, is unknown. */
export type TableCheck = (doc: Doc, table: TableKey) => void;

/** The tables a test supplies inputs for, in the database of the transform it tests. */
function testInputs(test: TestDoc, transform: Transform): TableKey[] {
  return test.body.inputs.map(({ table }) => ({
    database: transform.doc.body.source_database_id,
    schema: table.schema ?? null,
    name: table.name,
  }));
}

/**
 * For each valid transform test: an error when its transform_id names nothing
 * or names no Transform; otherwise, when its transform's sources were read,
 * the mismatches between those sources and the test's inputs.
 */
export function reportTestFindings(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transforms: readonly Transform[],
  checkKnown: TableCheck,
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const transformsById = new Map(
    transforms.map((t) => [t.doc.body.entity_id, t]),
  );
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transformId = test.body.transform_id;
    const holders = byEntityId.get(transformId) ?? [];
    if (holders.length === 0) {
      report(
        "dangling-transform-id",
        "error",
        test,
        `transform_id ${transformId} matches no entity`,
      );
      continue;
    }
    if (!holders.some((h) => h.model === "Transform")) {
      report(
        "wrong-type-transform-id",
        "error",
        test,
        `transform_id ${transformId} names a ${holders[0].model ?? "file with no model"}, not a Transform`,
        holders.map((h) => h.file),
      );
      continue;
    }
    const transform = transformsById.get(transformId);
    if (transform === undefined) {
      continue;
    }
    if (transform.doc.body.source.type !== "query") {
      report(
        "untestable-transform",
        "error",
        test,
        `transform ${displayName(transform.doc)} is not a query transform; Metabase tests only query transforms`,
        [transform.doc.file],
      );
      continue;
    }
    const defaultSchema = defaultSchemaOf(
      transform.doc.body.source_database_id,
    );
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, defaultSchema, report);
    reportExpectationReads(test, transform, inputs, defaultSchema, report);
    if (transform.reads.status !== "read") {
      continue;
    }
    reportInputMismatches(
      test,
      transform,
      transform.reads.tables,
      checkKnown,
      defaultSchema,
      report,
    );
  }
}

/**
 * Reports a test whose inputs a query cannot tell apart: the same table twice,
 * ignoring case, or once unqualified and once in the default schema.
 */
function reportDuplicateInputs(
  test: TestDoc,
  inputs: readonly TableKey[],
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const counts = new Map<string, number>();
  for (const key of inputs.flatMap((i) => tableKeys(i, defaultSchema))) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colliding = inputs.filter((i) =>
    tableKeys(i, defaultSchema).some((key) => (counts.get(key) ?? 0) > 1),
  );
  if (colliding.length > 0) {
    report(
      "duplicate-input",
      "error",
      test,
      `inputs stand in for the same table: ${colliding.map(tableLabel).join(", ")}`,
    );
  }
}

/**
 * Reports each table an expectation's SQL reads that is neither the
 * transform's target nor one of the test's inputs; an expectation may read
 * only those. SQL the scan cannot read gives a reads-not-checked warning.
 */
function reportExpectationReads(
  test: TestDoc,
  transform: Transform,
  inputs: readonly TableKey[],
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const allowed = [...inputs, transform.target];
  const keys = new Set(allowed.flatMap((t) => tableKeys(t, defaultSchema)));
  for (const expectation of test.body.expectations) {
    if (expectation.sql === undefined) {
      continue;
    }
    const name = expectation.name;
    const result = tablesReadBySql(expectation.sql);
    if (result.status === "unread") {
      report(
        "reads-not-checked",
        "warning",
        test,
        `could not find the tables expectation ${name} reads: ${result.reason}`,
      );
      continue;
    }
    for (const table of result.tables) {
      const key = tableKeys(table, defaultSchema)[0];
      if (keys.has(key)) {
        continue;
      }
      const undecided =
        table.schema === null &&
        allowed.some(
          (t) => t.schema !== null && t.name.toLowerCase() === key,
        ) &&
        defaultSchema === undefined;
      report(
        undecided ? "input-match-undecided" : "expectation-reads-other-table",
        undecided ? "warning" : "error",
        test,
        undecided
          ? `expectation ${name} reads ${tableLabel(table)}, which is this test's table only if its schema is the default schema of ${transform.target.database ?? "its database"}; set it with --default-schema`
          : `expectation ${name} reads ${tableLabel(table)}, which is neither the transform's target nor an input of this test`,
        [transform.doc.file],
      );
    }
  }
}

/**
 * Matches the test's inputs to the tables the transform reads by Metabase's
 * rule (`inputCovers`). Reports each read with no input, each pair whose match
 * depends on an unknown default schema (counted as a match), then, input by
 * input, an unknown table and an input that covers no read.
 */
function reportInputMismatches(
  test: TestDoc,
  transform: Transform,
  reads: readonly TableKey[],
  checkKnown: TableCheck,
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const inputs = testInputs(test, transform);
  const transformName = displayName(transform.doc);
  const covers = (read: TableKey, input: TableKey) =>
    inputCovers(read, input, defaultSchema) !== "no-match";
  for (const read of reads) {
    const matches = inputs.map((input) =>
      inputCovers(read, input, defaultSchema),
    );
    if (matches.includes("match")) {
      continue;
    }
    const undecided = inputs.filter((_, i) => matches[i] === "undecided");
    for (const input of undecided) {
      report(
        "input-match-undecided",
        "warning",
        test,
        `input ${tableLabel(input)} stands in for ${tableLabel(read)}, which transform ${transformName} reads, only if ${input.schema} is the default schema of ${read.database ?? "its database"}; set it with --default-schema`,
        [transform.doc.file],
      );
    }
    if (undecided.length === 0) {
      report(
        "missing-input",
        "error",
        test,
        `no input for ${tableLabel(read)}, which transform ${transformName} reads`,
        [transform.doc.file],
      );
    }
  }
  for (const input of inputs) {
    checkKnown(test, input);
    if (!reads.some((read) => covers(read, input))) {
      report(
        "unused-input",
        "error",
        test,
        `input ${tableLabel(input)} is not read by transform ${transformName}`,
        [transform.doc.file],
      );
    }
  }
}
