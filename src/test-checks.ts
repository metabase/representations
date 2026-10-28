import {
  displayName,
  type Doc,
  holderOf,
  queryDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers, rewriteCovers } from "./input-match.js";
import {
  isQueryTransform,
  type QueryTransform,
  type Transform,
} from "./reads.js";
import type { SqlTableReader } from "./sql-tables.js";
import {
  type DefaultSchemaOf,
  sameTable,
  tableLabel,
  type TableKey,
} from "./tables.js";

type TestDoc = ValidDoc<"TransformTest">;

/** Reports on `doc` when `table`, which it names, is unknown. */
export type TableCheck = (doc: Doc, table: TableKey) => void;

/** The tables a test supplies inputs for, in the database its transform runs on. */
export function testInputs(
  test: TestDoc,
  transform: QueryTransform,
): TableKey[] {
  return test.body.inputs.map(({ table }) => ({
    database: queryDatabaseOf(transform.doc),
    schema: table.schema ?? null,
    name: table.name,
    nullSchema: "default",
  }));
}

/**
 * The query transform `test` tests: the schema-valid Transform its
 * transform_id names (`holderOf`), when its source is a query. Null
 * otherwise; `reportTestFindings` reports why.
 */
export function queryTransformOf(
  test: TestDoc,
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
): QueryTransform | null {
  const holder = holderOf(byEntityId, test.body.transform_id);
  const transform = holder === null ? undefined : transformOfDoc.get(holder);
  return transform !== undefined && isQueryTransform(transform)
    ? transform
    : null;
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
): QueryTransform | null {
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
  if (!isQueryTransform(transform)) {
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
 * For each valid test of a query transform: its duplicate inputs, the tables
 * its expectations read, and, when the transform's sources were read, the
 * inputs that match no read and the reads with no input. A test whose
 * transform_id names nothing, no Transform, or no query transform gets the
 * matching error instead.
 */
export function reportTestFindings(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
  checkKnown: TableCheck,
  defaultSchemaOf: DefaultSchemaOf,
  readSql: SqlTableReader,
  report: Report,
): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transform = testedTransform(test, byEntityId, transformOfDoc, report);
    if (transform === null) {
      continue;
    }
    const defaultSchema = defaultSchemaOf(queryDatabaseOf(transform.doc));
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, defaultSchemaOf, report);
    reportExpectationReads(
      test,
      transform,
      inputs,
      defaultSchema,
      readSql,
      report,
    );
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

/** Reports a test whose inputs a query cannot tell apart (`sameTable`). */
function reportDuplicateInputs(
  test: TestDoc,
  inputs: readonly TableKey[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const colliding = new Set<TableKey>();
  inputs.forEach((a, i) => {
    for (const b of inputs.slice(i + 1)) {
      if (sameTable(a, b, defaultSchemaOf)) {
        colliding.add(a).add(b);
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
}

/**
 * Reports each table an expectation's SQL reads that Metabase would not
 * rewrite to the stand-in for the transform's target or for one of the test's
 * inputs (`rewriteCovers`); an expectation may read only those. SQL
 * `readSql` cannot read gives a reads-not-checked warning.
 */
function reportExpectationReads(
  test: TestDoc,
  transform: QueryTransform,
  inputs: readonly TableKey[],
  defaultSchema: string | null,
  readSql: SqlTableReader,
  report: Report,
): void {
  const allowed = [...inputs, transform.target];
  for (const expectation of test.body.expectations) {
    if (!("sql" in expectation)) {
      continue;
    }
    const name = expectation.name;
    const result = readSql(expectation.sql, queryDatabaseOf(transform.doc));
    if (result.status === "unread") {
      report(
        "reads-not-checked",
        test,
        `could not find the tables expectation ${name} reads: ${result.reason}`,
      );
      continue;
    }
    for (const table of result.tables) {
      if (!allowed.some((a) => rewriteCovers(table, a, defaultSchema))) {
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
 * rule (`inputCovers`). Reports each read with no input, then, input by
 * input, an unknown table and an input that covers no read.
 */
function reportInputMismatches(
  test: TestDoc,
  transform: Transform,
  inputs: readonly TableKey[],
  reads: readonly TableKey[],
  checkKnown: TableCheck,
  defaultSchema: string | null,
  report: Report,
): void {
  const transformName = displayName(transform.doc);
  const covers = (read: TableKey, input: TableKey) =>
    inputCovers(read, input, defaultSchema);
  for (const read of reads) {
    if (!inputs.some((input) => covers(read, input))) {
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
