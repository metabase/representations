import type { EngineOf } from "./databases.js";
import {
  displayName,
  type Doc,
  lookUpEntity,
  queryDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers } from "./input-match.js";
import {
  isQueryTransform,
  type QueryTransform,
  type Transform,
} from "./reads.js";
import {
  isSqlParseError,
  isSqlTokenError,
  type SqlParseCheck,
  type SqlTableReader,
} from "./sql-tables.js";
import {
  type DefaultSchemaOf,
  sameTable,
  sqlTable,
  tableLabel,
  type TableKey,
} from "./tables.js";

type TestDoc = ValidDoc<"TransformTest">;

/**
 * The answer to a comparison of table names: "unknown" when it depends on
 * the default schema of a database whose default schema no source gives.
 */
export type Answer = boolean | "unknown";

/** The comparisons of table names the checks of transform tests make. */
export type TableComparisons = {
  /** Whether two names are one table (`sameTable`). */
  sameTable(a: TableKey, b: TableKey): Answer;
  /** Whether a test input stands in for a table its transform reads (`inputCovers`). */
  inputCovers(read: TableKey, input: TableKey): Answer;
};

/**
 * The answer of `holds` in `database` under its default schema; for a
 * database in `unknown`, the one answer it gives under every default schema
 * that can change it, or "unknown" when they differ. Only a schema of the
 * names compared, no schema, or another schema can change it.
 */
function answerIn(
  database: string | null,
  schemas: readonly (string | null)[],
  defaultSchemaOf: DefaultSchemaOf,
  unknown: ReadonlySet<string>,
  holds: (defaultSchema: string | null) => boolean,
): Answer {
  if (database === null || !unknown.has(database)) {
    return holds(defaultSchemaOf(database));
  }
  // A name no schema has: a NUL is in no identifier.
  const other = "\u0000";
  const answers = new Set([...schemas, null, other].map(holds));
  return answers.size === 1 ? holds(other) : "unknown";
}

/**
 * The `TableComparisons` of names whose default schema `defaultSchemaOf`
 * gives, but in each database of `unknown`, whose default schema no source
 * gives: there a comparison that depends on it is "unknown".
 */
export function createTableComparisons(
  defaultSchemaOf: DefaultSchemaOf,
  unknown: ReadonlySet<string>,
): TableComparisons {
  return {
    sameTable: (a, b) =>
      answerIn(
        a.database ?? b.database,
        [a.schema, b.schema],
        defaultSchemaOf,
        unknown,
        (schema) => sameTable(a, b, () => schema),
      ),
    inputCovers: (read, input) =>
      answerIn(
        input.database ?? read.database,
        [read.schema, input.schema],
        defaultSchemaOf,
        unknown,
        (schema) => inputCovers(read, input, schema),
      ),
  };
}

/**
 * Whether no table of `tables` is `table` for certain, and none might be:
 * each answer of `compare` is false.
 */
const noneMatches = (
  tables: readonly TableKey[],
  compare: (other: TableKey) => Answer,
): boolean => tables.every((other) => compare(other) === false);

/** The tables a test supplies inputs for, in the database its transform runs on. */
export function testInputs(
  test: TestDoc,
  transform: QueryTransform,
): TableKey[] {
  const database = queryDatabaseOf(transform.doc);
  return test.body.inputs.map(({ table }) =>
    sqlTable(database, { schema: table.schema ?? null, name: table.name }),
  );
}

/**
 * The transform a test with a dangling transform_id likely tests: the one
 * whose file sits beside the test's folder, as remote sync writes a test
 * (`<transform>/<test>.yaml` beside `<transform>.yaml`), or else the one whose
 * name starts the test's name before its first colon. Null when neither
 * finds one.
 */
function likelyTransformOf(
  test: TestDoc,
  docs: readonly Doc[],
): ValidDoc<"Transform"> | null {
  const transforms = validDocsOf(docs, "Transform");
  const slash = test.file.lastIndexOf("/");
  const beside =
    slash === -1
      ? undefined
      : transforms.find((t) => t.file === `${test.file.slice(0, slash)}.yaml`);
  if (beside !== undefined) {
    return beside;
  }
  const colon = test.body.name.indexOf(":");
  const named =
    colon === -1
      ? []
      : transforms.filter(
          (t) => t.body.name === test.body.name.slice(0, colon).trim(),
        );
  return named.length === 1 ? named[0] : null;
}

/** A schema-valid transform test, with the query transform it tests. */
export type TestedTransform = { test: TestDoc; transform: QueryTransform };

/**
 * Each schema-valid test whose transform_id names (`lookUpEntity`) a schema-valid
 * query transform, with that transform, in file order.
 */
export function testedTransformsOf(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
): TestedTransform[] {
  return validDocsOf(docs, "TransformTest").flatMap((test) => {
    const found = lookUpEntity(byEntityId, test.body.transform_id, "Transform");
    const transform =
      found.status === "found" ? transformOfDoc.get(found.doc) : undefined;
    return transform !== undefined && isQueryTransform(transform)
      ? [{ test, transform }]
      : [];
  });
}

/**
 * Reports each schema-valid test whose transform_id (`lookUpEntity`) names no
 * Transform, or a transform that is not a query transform. When a file of
 * another model holds the id, the finding names that file. A test of a
 * Transform that fails its schema gets no finding here.
 */
export function reportTransformIds(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
  report: Report,
): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transformId = test.body.transform_id;
    const found = lookUpEntity(byEntityId, transformId, "Transform");
    if (found.status === "other-model") {
      report(
        "wrong-type-transform-id",
        test,
        `transform_id ${transformId} names a ${found.doc.model}, not a Transform`,
        (byEntityId.get(transformId) ?? []).map((h) => h.file),
      );
    } else if (found.status === "missing") {
      const likely = likelyTransformOf(test, docs);
      report(
        "dangling-transform-id",
        test,
        `transform_id ${transformId} matches no entity${
          likely === null
            ? ""
            : `; the test likely tests ${displayName(likely)}, whose entity_id is ${String(likely.body.entity_id)}`
        }`,
        likely === null ? [] : [likely.file],
      );
    } else {
      const transform = transformOfDoc.get(found.doc);
      if (transform !== undefined && !isQueryTransform(transform)) {
        report(
          "untestable-transform",
          test,
          `transform ${displayName(transform.doc)} is not a query transform; Metabase tests only query transforms`,
          [transform.doc.file],
        );
      }
    }
  }
}

/**
 * For each test of a query transform: its duplicate inputs, the tables its
 * expectations read, and, when the transform's sources were read, the inputs
 * that match no read and the reads with no input. A comparison whose answer
 * is "unknown" (`TableComparisons`) gives no finding.
 */
export function reportTestFindings(
  tested: readonly TestedTransform[],
  compare: TableComparisons,
  readSql: SqlTableReader,
  report: Report,
): void {
  for (const { test, transform } of tested) {
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, compare, report);
    reportExpectationReads(test, transform, inputs, compare, readSql, report);
    if (transform.reads.status !== "read") {
      continue;
    }
    reportInputMismatches(
      test,
      transform,
      inputs,
      transform.reads.tables,
      compare,
      report,
    );
  }
}

/** Reports a test whose inputs a query cannot tell apart (`sameTable`). */
function reportDuplicateInputs(
  test: TestDoc,
  inputs: readonly TableKey[],
  compare: TableComparisons,
  report: Report,
): void {
  const colliding = new Set<TableKey>();
  inputs.forEach((a, i) => {
    for (const b of inputs.slice(i + 1)) {
      if (compare.sameTable(a, b) === true) {
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
 * For each test of a query transform, its expectations' SQL, which `checkSql`
 * parses as written, as Metabase does. SQL on which SQLGlot raises a
 * ParseError or a TokenError (`isSqlParseError`, `isSqlTokenError`) in the
 * dialect of an engine the settings give is an error (`unparseable-test-sql`):
 * Metabase refuses the test. SQL `readSql`
 * cannot read otherwise gives a reads-not-checked warning. The transform's
 * own unread SQL is reported on the transform only.
 */
export function reportTestSqlParses(
  tested: readonly TestedTransform[],
  engineOf: EngineOf,
  readSql: SqlTableReader,
  checkSql: SqlParseCheck,
  report: Report,
): void {
  for (const { test, transform } of tested) {
    const database = queryDatabaseOf(transform.doc);
    const engine = engineOf(database);
    for (const expectation of test.body.expectations) {
      if (!("sql" in expectation)) {
        continue;
      }
      // Metabase parses an expectation as written, with no large literal
      // list stripped; the tables are read with them stripped.
      const unparsed = checkSql(expectation.sql, database);
      const result = readSql(expectation.sql, database);
      if (
        engine !== null &&
        unparsed !== null &&
        (isSqlParseError(unparsed) || isSqlTokenError(unparsed))
      ) {
        report(
          "unparseable-test-sql",
          test,
          `could not parse the SQL of expectation ${expectation.name} as Metabase parses it for engine ${engine}, so Metabase refuses the test: ${unparsed.reason}`,
        );
      } else if (result.status === "unread") {
        report(
          "reads-not-checked",
          test,
          `could not find the tables expectation ${expectation.name} reads: ${result.reason}`,
        );
      }
    }
  }
}

/**
 * Reports each table an expectation's SQL reads that is neither the
 * transform's target nor one of the test's inputs (`sameTable`). SQL
 * `readSql` cannot read gets no finding here (`reportTestSqlParses`).
 */
function reportExpectationReads(
  test: TestDoc,
  transform: QueryTransform,
  inputs: readonly TableKey[],
  compare: TableComparisons,
  readSql: SqlTableReader,
  report: Report,
): void {
  const database = queryDatabaseOf(transform.doc);
  const allowed = [...inputs, transform.target];
  for (const expectation of test.body.expectations) {
    if (!("sql" in expectation)) {
      continue;
    }
    const name = expectation.name;
    const result = readSql(expectation.sql, database);
    if (result.status === "unread") {
      continue;
    }
    for (const table of result.tables) {
      const read = sqlTable(database, table);
      if (noneMatches(allowed, (t) => compare.sameTable(read, t))) {
        report(
          "expectation-reads-other-table",
          test,
          `expectation ${name} reads ${tableLabel(read)}, which is neither the transform's target nor an input of this test`,
          [transform.doc.file],
        );
      }
    }
  }
}

/**
 * Matches the test's inputs to the tables the transform reads by Metabase's
 * rule (`inputCovers`). Reports each read with no input, then each input
 * that covers no read.
 */
function reportInputMismatches(
  test: TestDoc,
  transform: Transform,
  inputs: readonly TableKey[],
  reads: readonly TableKey[],
  compare: TableComparisons,
  report: Report,
): void {
  const transformName = displayName(transform.doc);
  for (const read of reads) {
    if (noneMatches(inputs, (input) => compare.inputCovers(read, input))) {
      report(
        "missing-input",
        test,
        `no input for ${tableLabel(read)}, which transform ${transformName} reads`,
        [transform.doc.file],
      );
    }
  }
  for (const input of inputs) {
    if (noneMatches(reads, (read) => compare.inputCovers(read, input))) {
      report(
        "unused-input",
        test,
        `input ${tableLabel(input)} is not read by transform ${transformName}`,
        [transform.doc.file],
      );
    }
  }
}
