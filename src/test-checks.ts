import {
  displayName,
  type Doc,
  holderOf,
  isQuerySource,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers, inputsCollide, rewriteCovers } from "./input-match.js";
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
 * The query transform `test` tests: the file its transform_id names
 * (`holderOf`). Null after an error when that names nothing, names a file
 * that is not a Transform, or names a transform that is not a query
 * transform; null without one when the Transform fails its schema.
 */
function testedTransform(
  test: TestDoc,
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
  report: Report,
): Transform | null {
  const transformId = test.body.transform_id;
  const holder = holderOf(byEntityId, transformId);
  if (holder === null) {
    report(
      "dangling-transform-id",
      test,
      `transform_id ${transformId} matches no entity`,
    );
    return null;
  }
  if (holder.model !== "Transform") {
    report(
      "wrong-type-transform-id",
      test,
      `transform_id ${transformId} names a ${holder.model ?? "file with no model"}, not a Transform`,
      (byEntityId.get(transformId) ?? []).map((h) => h.file),
    );
    return null;
  }
  const transform = transformOfDoc.get(holder);
  if (transform === undefined) {
    return null;
  }
  if (!isQuerySource(transform.doc.body.source)) {
    report(
      "untestable-transform",
      test,
      `transform ${displayName(transform.doc)} is not a query transform; Metabase tests only query transforms`,
      [transform.doc.file],
    );
    return null;
  }
  return transform;
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
  const transformOfDoc = new Map<Doc, Transform>(
    transforms.map((t) => [t.doc, t]),
  );
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transform = testedTransform(test, byEntityId, transformOfDoc, report);
    if (transform === null) {
      continue;
    }
    const database = transform.doc.body.source_database_id;
    const defaultSchema = defaultSchemaOf(database);
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, database, defaultSchema, report);
    reportExpectationReads(test, transform, inputs, defaultSchema, report);
    if (transform.reads.status !== "read") {
      continue;
    }
    reportInputMismatches(
      test,
      transform,
      inputs,
      transform.reads.tables,
      checkKnown,
      defaultSchema,
      report,
    );
  }
}

/**
 * Reports a test whose inputs a query cannot tell apart (`inputsCollide`),
 * then each pair of inputs that collide only if an unknown default schema is
 * the qualified one's schema.
 */
function reportDuplicateInputs(
  test: TestDoc,
  inputs: readonly TableKey[],
  database: string,
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const colliding = new Set<TableKey>();
  const undecided: [TableKey, TableKey][] = [];
  inputs.forEach((a, i) => {
    for (const b of inputs.slice(i + 1)) {
      const match = inputsCollide(a, b, defaultSchema);
      if (match === "match") {
        colliding.add(a).add(b);
      } else if (match === "undecided") {
        undecided.push([a, b]);
      }
    }
  });
  if (colliding.size > 0) {
    report(
      "duplicate-input",
      test,
      `inputs stand in for the same table: ${inputs
        .filter((i) => colliding.has(i))
        .map(tableLabel)
        .join(", ")}`,
    );
  }
  for (const [a, b] of undecided) {
    report(
      "input-match-undecided",
      test,
      `inputs ${tableLabel(a)} and ${tableLabel(b)} stand in for the same table only if ${a.schema ?? b.schema} is the default schema of ${database}; set it with --default-schema`,
    );
  }
}

/**
 * Reports each table an expectation's SQL reads that Metabase would not
 * rewrite to the stand-in for the transform's target or for one of the test's
 * inputs (`rewriteCovers`); an expectation may read only those. A read whose
 * rewrite depends on an unknown default schema gets a warning. SQL the scan
 * cannot read gives a reads-not-checked warning.
 */
function reportExpectationReads(
  test: TestDoc,
  transform: Transform,
  inputs: readonly TableKey[],
  defaultSchema: DefaultSchema,
  report: Report,
): void {
  const allowed = [...inputs, transform.target];
  const database = transform.target.database ?? "its database";
  for (const expectation of test.body.expectations) {
    if (!("sql" in expectation)) {
      continue;
    }
    const name = expectation.name;
    const result = tablesReadBySql(expectation.sql);
    if (result.status === "unread") {
      report(
        "reads-not-checked",
        test,
        `could not find the tables expectation ${name} reads: ${result.reason}`,
      );
      continue;
    }
    for (const table of result.tables) {
      const matches = allowed.map((a) =>
        rewriteCovers(table, a, defaultSchema),
      );
      if (matches.includes("match")) {
        continue;
      }
      const undecided = allowed.find((_, i) => matches[i] === "undecided");
      if (undecided !== undefined) {
        report(
          "input-match-undecided",
          test,
          `expectation ${name} reads ${tableLabel(table)}, which is ${tableLabel(undecided)} only if ${undecided.schema} is the default schema of ${database}; set it with --default-schema`,
          [transform.doc.file],
        );
      } else {
        report(
          "expectation-reads-other-table",
          test,
          `expectation ${name} reads ${tableLabel(table)}, which is neither the transform's target nor an input of this test`,
          [transform.doc.file],
        );
      }
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
  inputs: readonly TableKey[],
  reads: readonly TableKey[],
  checkKnown: TableCheck,
  defaultSchema: DefaultSchema,
  report: Report,
): void {
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
        test,
        `input ${tableLabel(input)} stands in for ${tableLabel(read)}, which transform ${transformName} reads, only if ${input.schema} is the default schema of ${read.database ?? "its database"}; set it with --default-schema`,
        [transform.doc.file],
      );
    }
    if (undecided.length === 0) {
      report(
        "missing-input",
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
        test,
        `input ${tableLabel(input)} is not read by transform ${transformName}`,
        [transform.doc.file],
      );
    }
  }
}
