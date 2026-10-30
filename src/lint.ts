import { createEngineOf, databaseDefaultSchemas } from "./databases.js";
import {
  type DefaultSchemas,
  resolveDefaultSchemas,
} from "./default-schemas.js";
import {
  displayName,
  type Doc,
  indexByEntityId,
  isQuerySource,
  loadDocs,
  queryDatabaseOf,
  type UnreadableFile,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import {
  reportMissingTargetSchemas,
  reportUnsupportedTransformEngines,
  reportUntestableEngines,
} from "./engine-checks.js";
import {
  type FindingSubject,
  LINT_RULE_SEVERITY,
  LINT_RULES,
  type LintEntity,
  type LintFinding,
  type LintFindingOf,
  type LintRule,
  type Report,
} from "./findings.js";
import { cyclePath, cycles } from "./graph.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { loadSchemas, type Schemas } from "./schemas.js";
import { readSettingsFile } from "./settings.js";
import { createSqlColumnReader } from "./sql-columns.js";
import { withSqlParser } from "./sql-parser.js";
import {
  createRewrittenTableReader,
  createSqlTableReader,
  type SqlTableReader,
} from "./sql-tables.js";
import {
  type DefaultSchemaOf,
  sameTable,
  tableLabel,
  type TableKey,
  type TableName,
} from "./tables.js";
import {
  reportEmptyExpectations,
  reportExpectationNames,
  reportRowsColumns,
} from "./test-body-checks.js";
import {
  reportTestFindings,
  reportTransformIds,
  type TableCheck,
  type TestedTransform,
  testedTransformsOf,
  testInputs,
} from "./test-checks.js";
import { reportTestSql } from "./test-sql-checks.js";
import {
  incrementalFilterTables,
  reportCollectionNamespaces,
  reportIncrementalTags,
  reportMissingTargetDatabases,
} from "./transform-checks.js";
import { stringOrNull } from "./values.js";

export type LintOptions = {
  folder: string;
  /**
   * Default schemas by database name. Each overrides the one `CONFIG_FILE`
   * in the folder gives for its database.
   */
  defaultSchemas?: DefaultSchemas;
};

export type LintResult = {
  files: number;
  findings: LintFinding[];
};

const LINTED_MODELS = new Set([
  "Transform",
  "TransformTest",
  "Table",
  "Database",
  "NativeQuerySnippet",
]);

function entityOf({ model, body }: FindingSubject): LintEntity {
  return {
    model,
    entity_id: stringOrNull(body.entity_id),
    name: stringOrNull(body.name),
  };
}

/**
 * For each transform whose sources were read, by index: the indexes of the
 * transforms whose target it reads.
 */
function readEdges(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
): Map<number, number[]> {
  const edges = new Map<number, number[]>();
  transforms.forEach((transform, i) => {
    if (transform.reads.status !== "read") {
      return;
    }
    const reads = transform.reads.tables;
    edges.set(
      i,
      transforms.flatMap(({ target }, j) =>
        target !== null &&
        reads.some((t) => sameTable(t, target, defaultSchemaOf))
          ? [j]
          : [],
      ),
    );
  });
  return edges;
}

/** The tables `transforms` write, skipping a transform with no target. */
function targetsOf(transforms: readonly Transform[]): TableKey[] {
  return transforms.flatMap((t) => (t.target === null ? [] : [t.target]));
}

/** A warning for each transform whose sources could not be read. */
function reportUnreadSources(
  transforms: readonly Transform[],
  report: Report,
): void {
  for (const transform of transforms) {
    if (transform.reads.status === "unread") {
      report(
        "reads-not-checked",
        transform.doc,
        `could not find the tables this transform reads: ${transform.reads.reason}`,
      );
    }
  }
}

/** A warning for each transform whose target another transform also writes (`sameTable`). */
function reportDuplicateTargets(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  for (const { doc, target } of transforms) {
    if (target === null) {
      continue;
    }
    const clashes = transforms.filter(
      (other) =>
        other.doc !== doc &&
        other.target !== null &&
        sameTable(target, other.target, defaultSchemaOf),
    );
    if (clashes.length > 0) {
      report(
        "duplicate-target",
        doc,
        `target ${tableLabel(target)} is also written by ${clashes.length} other transform(s)`,
        clashes.map((c) => c.doc.file),
      );
    }
  }
}

/** Runs the unknown-table check on every table each transform reads. */
function checkReadTablesKnown(
  transforms: readonly Transform[],
  checkKnown: TableCheck,
): void {
  for (const transform of transforms) {
    if (transform.reads.status === "read") {
      for (const table of transform.reads.tables) {
        checkKnown(transform.doc, table);
      }
    }
  }
}

/**
 * Warns on each table a transform reads by a reference with a null schema
 * (`nullSchema` `"none"`) in a database whose default schema is not null.
 * Metabase imports such a reference as the table with no schema, and creates
 * an inactive table when none exists, so every query on it fails. A database
 * whose default schema is unknown gives no finding, nor does a table that a
 * table file or a transform target with no schema names.
 */
function reportNullSchemaReferences(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const noSchemaTables = [
    ...validDocsOf(docs, "Table").map(tableOfFile),
    ...targetsOf(transforms),
  ].filter((t) => t.schema === null);
  for (const { doc, reads } of transforms) {
    if (reads.status !== "read") {
      continue;
    }
    for (const table of reads.tables) {
      const defaultSchema = defaultSchemaOf(table.database);
      if (
        table.schema === null &&
        table.nullSchema === "none" &&
        defaultSchema !== null &&
        !noSchemaTables.some(
          (t) => t.database === table.database && t.name === table.name,
        )
      ) {
        report(
          "null-schema-reference",
          doc,
          `reads ${tableLabel(table)} in database ${table.database}, whose default schema is ${defaultSchema}: a null schema in a reference names a table with no schema, which such a database likely lacks`,
        );
      }
    }
  }
}

/** The table a table file defines. */
function tableOfFile(doc: ValidDoc<"Table">): TableKey {
  return {
    database: doc.body.db_id,
    schema: doc.body.schema ?? null,
    name: doc.body.name,
    nullSchema: "none",
    caseMatters: true,
  };
}

/**
 * Returns a check that warns when a table, named by a document, is defined by
 * no table file and no transform target. It checks only tables of databases
 * that have at least one table file: a repo holds only some table files.
 */
function createUnknownTableCheck(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): TableCheck {
  const tableDocs = validDocsOf(docs, "Table");
  const tableFileDatabases = new Set<string | null>(
    tableDocs.map((d) => d.body.db_id),
  );
  const knownTables: TableKey[] = [
    ...tableDocs.map(tableOfFile),
    ...targetsOf(transforms),
  ];
  return (doc: Doc, table: TableKey) => {
    if (
      tableFileDatabases.has(table.database) &&
      !knownTables.some((k) => sameTable(k, table, defaultSchemaOf))
    ) {
      report(
        "unknown-table",
        doc,
        `table ${tableLabel(table)} is defined by no table file or transform target`,
      );
    }
  };
}

/**
 * Reports each cycle among transforms, on its first member in file order. The
 * message follows one cycle from that member, each transform reading the
 * next one's target.
 */
function reportCycles(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const edges = readEdges(transforms, defaultSchemaOf);
  for (const component of cycles(edges, transforms.length)) {
    const [first, ...rest] = component.map((i) => transforms[i]);
    report(
      "transform-cycle",
      first.doc,
      `transforms read each other's targets: ${cyclePath(edges, component)
        .map((i) => displayName(transforms[i].doc))
        .join(" → ")}`,
      rest.map((t) => t.doc.file),
    );
  }
}

/** Reports each file whose entity_id another file also holds. */
function reportDuplicateEntityIds(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  report: Report,
): void {
  for (const [id, holders] of byEntityId) {
    if (holders.length > 1) {
      for (const doc of holders) {
        report(
          "duplicate-entity-id",
          doc,
          `entity_id ${id} is also in ${holders.length - 1} other file(s)`,
          holders.filter((h) => h !== doc).map((h) => h.file),
        );
      }
    }
  }
}

/** Orders findings by rule, as listed in `LINT_RULES`, then by file. */
function byRuleThenFile(a: LintFinding, b: LintFinding): number {
  return (
    LINT_RULES.indexOf(a.rule) - LINT_RULES.indexOf(b.rule) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
}

/** Reports each file `loadDocs` could not read as an entity, as a schema error with no model. */
function reportUnreadableFiles(
  unreadable: readonly UnreadableFile[],
  report: Report,
): void {
  for (const { file, reason } of unreadable) {
    report("schema", { file, model: null, body: {} }, `the file ${reason}`);
  }
}

/** Warns on each file Metabase skips for having no `serdes/meta`. */
function reportSkippedFiles(skipped: readonly string[], report: Report): void {
  for (const file of skipped) {
    report(
      "skipped-by-metabase",
      { file, model: null, body: {} },
      "Metabase skips this file because it has no serdes/meta",
    );
  }
}

/** Reports each transform, transform test, table, Database or snippet file that fails its schema. */
function reportSchemaMismatches(docs: readonly Doc[], report: Report): void {
  for (const doc of docs) {
    const { model, schema } = doc;
    if (schema.status === "failed" && LINTED_MODELS.has(model)) {
      report(
        "schema",
        doc,
        `${model} does not match its schema: ${schema.error.path} ${schema.error.message}`,
      );
    }
  }
}

export type TransformReads = {
  file: string;
  entity_id: string | null;
  name: string | null;
  /** Whether the transform's source is a query, the only kind Metabase can test. */
  queryTransform: boolean;
  /** The tables the transform reads, or null when the lint could not read them. */
  tables: TableName[] | null;
};

/** The tables each schema-valid transform in the folder reads, as `lint` finds them. */
export async function transformReads({
  folder,
}: LintOptions): Promise<TransformReads[]> {
  const schemas = loadSchemas();
  const { docs } = loadDocs(folder, schemas);
  const engineOf = createEngineOf(docs, readSettingsFile(folder).engines);
  const byEntityId = indexByEntityId(docs);
  const transforms = await withSqlParser((parser) =>
    transformsOf(
      docs,
      byEntityId,
      schemas,
      createSqlTableReader(parser, engineOf),
    ),
  );
  return transforms.map(({ doc, reads }) => ({
    file: doc.file,
    entity_id: doc.body.entity_id,
    name: doc.body.name,
    queryTransform: isQuerySource(doc.body.source),
    tables:
      reads.status === "read"
        ? reads.tables.map(({ schema, name }) => ({ schema, name }))
        : null,
  }));
}

/** The schema-valid transforms among `docs`, in order, with their targets and reads. */
function transformsOf(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  schemas: Schemas,
  readSql: SqlTableReader,
): Transform[] {
  const readsOf = createReader(docs, byEntityId, schemas, readSql);
  return validDocsOf(docs, "Transform").map((doc) => transformOf(doc, readsOf));
}

/** A finding of `rule` on `subject`, at the rule's severity. */
function findingOf<R extends LintRule>(
  rule: R,
  subject: FindingSubject,
  message: string,
  related: string[],
): LintFindingOf<R> {
  return {
    rule,
    severity: LINT_RULE_SEVERITY[rule],
    file: subject.file,
    entity: entityOf(subject),
    message,
    related,
  };
}

/** A `Report` that appends each finding to `findings`. */
function createReport(findings: LintFinding[]): Report {
  return (rule, subject, message, related = []) =>
    // A finding of one rule is a LintFinding; TypeScript cannot tie the
    // generic rule to its member of the union.
    findings.push(findingOf(rule, subject, message, related) as LintFinding);
}

/** The tables the SQL of a test's expectations reads, in its transform's database. */
function expectationReads(
  { test, transform }: TestedTransform,
  readSql: SqlTableReader,
): TableKey[] {
  const database = queryDatabaseOf(transform.doc);
  return test.body.expectations.flatMap((expectation) => {
    const result =
      "sql" in expectation ? readSql(expectation.sql, database) : null;
    return result?.status === "read"
      ? result.tables.map(
          (t): TableKey => ({
            database,
            ...t,
            nullSchema: "default",
            caseMatters: false,
          }),
        )
      : [];
  });
}

/**
 * For each test of a query transform, the tables its rewrite compares by the
 * default schema: the tables it replaces (its inputs and the transform's
 * target), and the tables named in SQL that the rewrite maps to them (those its
 * expectations read, and those the transform reads by SQL).
 */
function testRewriteTables(
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): TableKey[][] {
  return tested.map(({ test, transform }) => [
    ...testInputs(test, transform),
    transform.target,
    ...expectationReads({ test, transform }, readSql),
    ...(transform.reads.status === "read"
      ? transform.reads.tables.filter((t) => t.nullSchema === "default")
      : []),
  ]);
}

/**
 * Every table the checks compare, in its database: table files, transform
 * targets and reads, the tables an incremental transform's range filter names,
 * and, for each test of a query transform, its inputs and the tables its SQL
 * expectations read.
 */
function comparedTables(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): TableKey[] {
  const testTables = tested.flatMap(({ test, transform }) => [
    ...testInputs(test, transform),
    ...expectationReads({ test, transform }, readSql),
  ]);
  const filterTables = validDocsOf(docs, "Transform").flatMap((transform) => {
    const filter = incrementalFilterTables(transform);
    return filter === null
      ? []
      : [...filter.tagTables, filter.checkpointTable].filter(
          (t): t is TableKey => t !== null,
        );
  });
  return [
    ...validDocsOf(docs, "Table").map(tableOfFile),
    ...targetsOf(transforms),
    ...transforms.flatMap((t) =>
      t.reads.status === "read" ? t.reads.tables : [],
    ),
    ...filterTables,
    ...testTables,
  ];
}

/**
 * Checks the references between transforms, tables and transform tests in a
 * folder of representation files. Reads only the files; needs no Metabase.
 * Findings are grouped by rule, in the order of `LINT_RULES`, then by file.
 * Native SQL is parsed by Metabase's own code, loaded once per process, the
 * first time a check reads SQL (`withSqlParser`).
 *
 * Rejects with a `LintSetupError` before any check when the settings file is
 * invalid, and a `MissingDefaultSchemasError` when a database needs a default
 * schema that neither `defaultSchemas`, the settings file, its Database file
 * nor its engine gives (`resolveDefaultSchemas`), each over the next.
 * Rejects with a `LintSetupError` when the SQL parser cannot start.
 */
export async function lint({
  folder,
  defaultSchemas = {},
}: LintOptions): Promise<LintResult> {
  const settings = readSettingsFile(folder);
  const schemas = loadSchemas();
  const { docs, skipped, unreadable } = loadDocs(folder, schemas);
  const engineOf = createEngineOf(docs, settings.engines);
  const byEntityId = indexByEntityId(docs);
  const files = docs.length + skipped.length + unreadable.length;
  return withSqlParser((parser) => {
    const readSql = createSqlTableReader(parser, engineOf);
    const transforms = transformsOf(docs, byEntityId, schemas, readSql);
    const transformOfDoc = new Map<Doc, Transform>(
      transforms.map((t) => [t.doc, t]),
    );
    const tested = testedTransformsOf(docs, byEntityId, transformOfDoc);
    const defaultSchemaOf = resolveDefaultSchemas({
      names: comparedTables(docs, transforms, tested, readSql),
      testTables: testRewriteTables(tested, readSql),
      given: {
        ...databaseDefaultSchemas(docs, engineOf),
        ...settings.defaultSchemas,
        ...defaultSchemas,
      },
      engineOf,
    });

    const findings: LintFinding[] = [];
    const report = createReport(findings);

    reportUnreadableFiles(unreadable, report);
    reportSkippedFiles(skipped, report);
    reportSchemaMismatches(docs, report);
    reportDuplicateEntityIds(byEntityId, report);

    reportUnreadSources(transforms, report);
    reportDuplicateTargets(transforms, defaultSchemaOf, report);

    reportCycles(transforms, defaultSchemaOf, report);
    reportCollectionNamespaces(docs, byEntityId, report);
    reportIncrementalTags(docs, defaultSchemaOf, report);
    reportMissingTargetDatabases(docs, report);
    reportMissingTargetSchemas(docs, engineOf, report);
    reportUnsupportedTransformEngines(docs, engineOf, report);

    const checkKnown = createUnknownTableCheck(
      docs,
      transforms,
      defaultSchemaOf,
      report,
    );
    checkReadTablesKnown(transforms, checkKnown);
    reportNullSchemaReferences(docs, transforms, defaultSchemaOf, report);

    reportTransformIds(docs, byEntityId, transformOfDoc, report);
    reportTestFindings(
      tested,
      checkKnown,
      defaultSchemaOf,
      createRewrittenTableReader(parser, engineOf),
      report,
    );
    reportRowsColumns(docs, report);
    reportExpectationNames(docs, report);
    reportEmptyExpectations(docs, report);
    reportUntestableEngines(tested, engineOf, report);
    reportTestSql(
      {
        docs,
        byEntityId,
        transforms,
        tested,
        defaultSchemaOf,
        engineOf,
        schemas,
        readSql,
        columns: createSqlColumnReader(parser, engineOf),
      },
      report,
    );
    return { files, findings: findings.sort(byRuleThenFile) };
  });
}
