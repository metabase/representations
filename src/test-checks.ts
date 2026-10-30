import {
  displayName,
  type Doc,
  holderOf,
  queryDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers, isStandIn, standInReplacements } from "./input-match.js";
import {
  isQueryTransform,
  type QueryTransform,
  type Transform,
} from "./reads.js";
import type { RewrittenTableReader } from "./sql-tables.js";
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
    caseMatters: false,
  }));
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
  const folder = test.file.slice(0, test.file.lastIndexOf("/"));
  const beside = transforms.find((t) => t.file === `${folder}.yaml`);
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
 * Each schema-valid test whose transform_id names (`holderOf`) a schema-valid
 * query transform, with that transform, in file order.
 */
export function testedTransformsOf(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
): TestedTransform[] {
  return validDocsOf(docs, "TransformTest").flatMap((test) => {
    const holder = holderOf(byEntityId, test.body.transform_id);
    const transform = holder === null ? undefined : transformOfDoc.get(holder);
    return transform !== undefined && isQueryTransform(transform)
      ? [{ test, transform }]
      : [];
  });
}

/**
 * Reports each schema-valid test whose transform_id (`holderOf`) names
 * nothing, names a file that is not a Transform, or names a transform that is
 * not a query transform. A test of a Transform that fails its schema gets no
 * finding here.
 */
export function reportTransformIds(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  transformOfDoc: ReadonlyMap<Doc, Transform>,
  report: Report,
): void {
  for (const test of validDocsOf(docs, "TransformTest")) {
    const transformId = test.body.transform_id;
    const holder = holderOf(byEntityId, transformId);
    if (holder === null) {
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
    } else if (holder.model !== "Transform") {
      report(
        "wrong-type-transform-id",
        test,
        `transform_id ${transformId} names a ${holder.model}, not a Transform`,
        (byEntityId.get(transformId) ?? []).map((h) => h.file),
      );
    } else {
      const transform = transformOfDoc.get(holder);
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
 * that match no read and the reads with no input.
 */
export function reportTestFindings(
  tested: readonly TestedTransform[],
  checkKnown: TableCheck,
  defaultSchemaOf: DefaultSchemaOf,
  readRewritten: RewrittenTableReader,
  report: Report,
): void {
  for (const { test, transform } of tested) {
    const defaultSchema = defaultSchemaOf(queryDatabaseOf(transform.doc));
    const inputs = testInputs(test, transform);
    reportDuplicateInputs(test, inputs, defaultSchemaOf, report);
    reportExpectationReads(
      test,
      transform,
      inputs,
      defaultSchema,
      readRewritten,
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
 * Reports each table an expectation's SQL still reads once Metabase's rewrite
 * replaces the transform's target and the test's inputs with stand-ins
 * (`standInReplacements`); an expectation may read only those. SQL
 * `readRewritten` cannot read gives a reads-not-checked warning.
 */
function reportExpectationReads(
  test: TestDoc,
  transform: QueryTransform,
  inputs: readonly TableKey[],
  defaultSchema: string | null,
  readRewritten: RewrittenTableReader,
  report: Report,
): void {
  const replacements = standInReplacements(
    [...inputs, transform.target],
    defaultSchema,
  );
  for (const expectation of test.body.expectations) {
    if (!("sql" in expectation)) {
      continue;
    }
    const name = expectation.name;
    const result = readRewritten(
      expectation.sql,
      queryDatabaseOf(transform.doc),
      replacements,
    );
    if (result.status === "unread") {
      report(
        "reads-not-checked",
        test,
        `could not find the tables expectation ${name} reads: ${result.reason}`,
      );
      continue;
    }
    for (const table of result.tables) {
      if (!isStandIn(table)) {
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
