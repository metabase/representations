import {
  createEngineOf,
  databaseDefaultSchemas,
  databasesOf,
  type EngineOf,
} from "./databases.js";
import {
  type DefaultSchemas,
  type NamedTable,
  resolveDefaultSchemas,
  type TestTables,
} from "./default-schemas.js";
import {
  displayName,
  type Doc,
  type DuplicatedKeys,
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
  reportUnknownEngines,
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
import { cyclePath, cycles, type Edge } from "./graph.js";
import { createSourceFinder, type SourceFinder } from "./query-sources.js";
import { engineFacts, FOLDS_ALL_IDENTIFIERS } from "./engines.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { loadSchemas } from "./schemas.js";
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
  exactTable,
  sameTable,
  sqlTable,
  tableLabel,
  type TableKey,
  type TableName,
  uniqueTables,
} from "./tables.js";
import {
  reportEmptyExpectations,
  reportExpectationNames,
  reportRowsColumns,
} from "./test-body-checks.js";
import {
  reportTestFindings,
  reportTransformIds,
  type TestedTransform,
  testedTransformsOf,
  testInputs,
} from "./test-checks.js";
import { createQueryReader, reportTestSql } from "./test-sql-checks.js";
import {
  reportCollectionNamespaces,
  reportEmptyNativeQueries,
  reportIncrementalTags,
  reportMissingTargetDatabases,
} from "./transform-checks.js";
import { isRecord, stringOrNull } from "./values.js";

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
  /**
   * The names of the databases the files name, sorted: Database and table
   * files, and the databases each file writes to or reads (`databasesOf`).
   * SQL is not read.
   */
  databases: string[];
};

/** The models whose files the schema rule checks against their schemas. */
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
 * Whether two table names are one table in the warehouse (`sameTable`). On an
 * engine that folds every name (`FOLDS_ALL_IDENTIFIERS`), names compare
 * ignoring case, also a target's, which Metabase creates in quotes as named.
 */
function sameWarehouseTable(
  a: TableKey,
  b: TableKey,
  defaultSchemaOf: DefaultSchemaOf,
  engineOf: EngineOf,
): boolean {
  const folds = FOLDS_ALL_IDENTIFIERS.has(
    engineOf(a.database ?? b.database) ?? "",
  );
  const inWarehouse = (table: TableKey): TableKey =>
    folds ? { ...table, caseMatters: false } : table;
  return sameTable(inWarehouse(a), inWarehouse(b), defaultSchemaOf);
}

/** A transform's read of another transform's target: that transform's index, and the table read. */
type ReadEdge = Edge & { read: TableKey };

/**
 * For each transform whose sources were read, by index: each transform whose
 * target it reads (`sameWarehouseTable`), with the first table it reads there.
 */
function readEdges(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  engineOf: EngineOf,
): Map<number, ReadEdge[]> {
  const edges = new Map<number, ReadEdge[]>();
  transforms.forEach((transform, i) => {
    if (transform.reads.status !== "read") {
      return;
    }
    const reads = transform.reads.tables;
    edges.set(
      i,
      transforms.flatMap(({ target }, to) => {
        const read =
          target === null
            ? undefined
            : reads.find((t) =>
                sameWarehouseTable(t, target, defaultSchemaOf, engineOf),
              );
        return read === undefined ? [] : [{ to, read }];
      }),
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

/**
 * A warning for each transform whose target another transform also writes
 * (`sameWarehouseTable`).
 */
function reportDuplicateTargets(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  engineOf: EngineOf,
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
        sameWarehouseTable(target, other.target, defaultSchemaOf, engineOf),
    );
    if (clashes.length > 0) {
      report(
        "duplicate-target",
        doc,
        `target ${tableLabel(target)} is also written by ${clashes.length} other transform(s); each run of one replaces the other's table`,
        clashes.map((c) => c.doc.file),
      );
    }
  }
}

/**
 * Reports each table a transform reads, or a Card's query names, and the
 * table of each field-filter tag of either, by a reference with a null schema
 * (`nullSchema` `"none"`) in a database whose engine has schemas. Metabase
 * imports such a reference as the table with no schema, and creates an
 * inactive table when none exists (`resolve/default.clj` `import-table-fk`),
 * so every query on it fails. A database whose engine is unknown gives no
 * finding, nor does one in `noSchemaDatabases`, nor a table that a table file
 * or a transform target with no schema names. A transform reports the tables
 * of the cards it reads too; a Card, only those its own query names.
 */
function reportNullSchemaReferences(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  findSources: SourceFinder,
  engineOf: EngineOf,
  noSchemaDatabases: ReadonlySet<string>,
  report: Report,
): void {
  const noSchemaTables = [
    ...validDocsOf(docs, "Table").map(tableOfFile),
    ...targetsOf(transforms),
  ].filter((t) => t.schema === null);
  const readers = [
    ...transforms.map(({ doc, reads }) => ({
      doc,
      tables: uniqueTables([
        ...(reads.status === "read" ? reads.tables : []),
        ...findSources(doc.body, doc.model).fieldFilterTables,
      ]),
    })),
    ...docs
      .filter((doc) => doc.model === "Card")
      .map((doc) => {
        const sources = findSources(doc.body, doc.model);
        return {
          doc,
          tables: uniqueTables([
            ...sources.tables,
            ...sources.fieldFilterTables,
          ]),
        };
      }),
  ];
  for (const { doc, tables } of readers) {
    for (const table of tables) {
      const engine = engineOf(table.database);
      if (
        table.schema === null &&
        table.nullSchema === "none" &&
        engineFacts(engine)?.schemas === true &&
        !(table.database !== null && noSchemaDatabases.has(table.database)) &&
        !noSchemaTables.some(
          (t) => t.database === table.database && t.name === table.name,
        )
      ) {
        report(
          "null-schema-reference",
          doc,
          `reads ${tableLabel(table)} in database ${table.database}, whose engine ${engine} has schemas: a null schema in a reference names a table with no schema, which Metabase does not find there, so every run fails. Name the table's schema, or, if the database has no schemas, give it a null default schema in .metabase-lint.json`,
        );
      }
    }
  }
}

/** The table a table file defines. */
function tableOfFile(doc: ValidDoc<"Table">): TableKey {
  return exactTable(doc.body.db_id, {
    schema: doc.body.schema ?? null,
    name: doc.body.name,
  });
}

/**
 * Reports each cycle among transforms, on its first member in file order. The
 * message follows one cycle from that member, each transform reading the
 * next one's target, and names the table each step reads.
 */
function reportCycles(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  engineOf: EngineOf,
  report: Report,
): void {
  const edges = readEdges(transforms, defaultSchemaOf, engineOf);
  for (const component of cycles(edges, transforms.length)) {
    const [first, ...rest] = component.map((i) => transforms[i]);
    const path = cyclePath(edges, component);
    const steps = path.map(({ to, read }, i) => {
      const from = i === 0 ? first : transforms[path[i - 1].to];
      return `${displayName(from.doc)} reads ${tableLabel(read)}, the target of ${displayName(transforms[to].doc)}`;
    });
    report(
      "transform-cycle",
      first.doc,
      `transforms read each other's targets: ${steps.join(" -> ")}. Remove one of these reads, or write one of these targets elsewhere`,
      rest.map((t) => t.doc.file),
    );
  }
}

/**
 * Warns on each file whose entity_id another file of its model also holds.
 * Remote sync keeps one, the last in path order (`lookUpEntity`), and drops
 * the others with no message. Files of different models may share an
 * entity_id: Metabase keeps each.
 */
function reportDuplicateEntityIds(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  report: Report,
): void {
  for (const [id, holders] of byEntityId) {
    for (const doc of holders) {
      const same = holders.filter((h) => h.model === doc.model);
      if (same.length > 1) {
        const kept = same[same.length - 1];
        report(
          "duplicate-entity-id",
          doc,
          `entity_id ${id} is also in ${same.length - 1} other ${doc.model} file(s); Metabase keeps only ${kept.file}, the last in path order, and drops the others without a message`,
          same.filter((h) => h !== doc).map((h) => h.file),
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

/**
 * Warns on each file that is not valid UTF-8. Remote sync decodes a file as
 * Java's `String` does, with no error.
 */
function reportInvalidUtf8(files: readonly string[], report: Report): void {
  for (const file of files) {
    report(
      "invalid-utf8",
      { file, model: null, body: {} },
      "the file is not valid UTF-8, and Metabase reads each invalid byte as U+FFFD; save the file as UTF-8",
    );
  }
}

/**
 * Warns on each key a document's map holds more than once. Metabase keeps the
 * last value with no message, so the others are lost.
 */
function reportDuplicateKeys(
  duplicatedKeys: readonly DuplicatedKeys[],
  report: Report,
): void {
  for (const { doc, keys } of duplicatedKeys) {
    for (const { source, line, column } of keys) {
      report(
        "duplicate-yaml-key",
        doc,
        `the key ${source} is written again at ${line}:${column} in the same map; Metabase keeps only the last value`,
      );
    }
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

/**
 * Whether `doc` is a transform whose source database was deleted: Metabase
 * exports it with a null `source_database_id` and marks its source
 * `serdes/unresolved`, and imports it, but cannot run it.
 */
function hasDeletedSourceDatabase(doc: Doc): boolean {
  const { source_database_id, source } = doc.body;
  return (
    doc.model === "Transform" &&
    source_database_id === null &&
    isRecord(source) &&
    source["serdes/unresolved"] === true
  );
}

/**
 * Reports each file of `LINTED_MODELS` that fails its schema; a transform
 * whose source database was deleted, by that cause.
 */
function reportSchemaMismatches(docs: readonly Doc[], report: Report): void {
  for (const doc of docs) {
    const { model, schema } = doc;
    if (schema.status !== "failed" || !LINTED_MODELS.has(model)) {
      continue;
    }
    report(
      "schema",
      doc,
      hasDeletedSourceDatabase(doc)
        ? "the transform's source database was deleted, so the transform cannot run: Metabase writes its source_database_id as null and marks its source serdes/unresolved. Point the transform at an existing database, or delete it"
        : `${model} does not match its schema: ${schema.error.path} ${schema.error.message}`,
    );
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
      createSourceFinder(schemas),
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

/** `LintResult.databases` for `docs`. */
function namedDatabases(
  docs: readonly Doc[],
  findSources: SourceFinder,
): string[] {
  const names = new Set<string>();
  for (const doc of docs) {
    databasesOf(doc, findSources).forEach((d) => names.add(d));
    const name =
      doc.model === "Database"
        ? doc.body.name
        : doc.model === "Table"
          ? doc.body.db_id
          : null;
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The schema-valid transforms among `docs`, in order, with their targets and reads. */
function transformsOf(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  findSources: SourceFinder,
  readSql: SqlTableReader,
): Transform[] {
  const readsOf = createReader(docs, byEntityId, findSources, readSql);
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
      ? result.tables.map((t) => sqlTable(database, t))
      : [];
  });
}

/**
 * For each test of a query transform, with the test's file, the tables its
 * rewrite compares by the default schema: the tables it replaces (its inputs
 * and the transform's target), and the tables named in SQL that the rewrite
 * maps to them (those its expectations read, and those the transform reads by
 * SQL).
 */
function testRewriteTables(
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): TestTables[] {
  return tested.map(({ test, transform }) => ({
    file: test.file,
    tables: [
      ...testInputs(test, transform),
      transform.target,
      ...expectationReads({ test, transform }, readSql),
      ...(transform.reads.status === "read"
        ? transform.reads.tables.filter((t) => t.nullSchema === "default")
        : []),
    ],
  }));
}

/** `tables`, each named by `file`. */
const namedBy = (file: string, tables: readonly TableKey[]): NamedTable[] =>
  tables.map((table) => ({ ...table, file }));

/**
 * Every table the checks compare, in its database, with the file that names
 * it: table files, transform targets and reads, and, for each test of a query
 * transform, its inputs and the tables its SQL expectations read.
 */
function comparedTables(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): NamedTable[] {
  return [
    ...validDocsOf(docs, "Table").map((doc) => ({
      ...tableOfFile(doc),
      file: doc.file,
    })),
    ...transforms.flatMap(({ doc, target, reads }) =>
      namedBy(doc.file, [
        ...(target === null ? [] : [target]),
        ...(reads.status === "read" ? reads.tables : []),
      ]),
    ),
    ...tested.flatMap(({ test, transform }) =>
      namedBy(test.file, [
        ...testInputs(test, transform),
        ...expectationReads({ test, transform }, readSql),
      ]),
    ),
  ];
}

/**
 * Checks the transforms, transform tests and tables in a folder of
 * representation files, and the references between them, for what Metabase
 * refuses or likely gets wrong. Reads only the files; needs no Metabase.
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
  const { docs, skipped, unreadable, duplicatedKeys, invalidUtf8 } = loadDocs(
    folder,
    schemas,
  );
  const engineOf = createEngineOf(docs, settings.engines);
  const byEntityId = indexByEntityId(docs);
  const files = docs.length + skipped.length + unreadable.length;
  const findSources = createSourceFinder(schemas);
  return withSqlParser((parser) => {
    const readSql = createSqlTableReader(parser, engineOf);
    const transforms = transformsOf(docs, byEntityId, findSources, readSql);
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
    reportInvalidUtf8(invalidUtf8, report);
    reportSkippedFiles(skipped, report);
    reportDuplicateKeys(duplicatedKeys, report);
    reportSchemaMismatches(docs, report);
    reportDuplicateEntityIds(byEntityId, report);

    reportUnreadSources(transforms, report);
    reportDuplicateTargets(transforms, defaultSchemaOf, engineOf, report);

    reportCycles(transforms, defaultSchemaOf, engineOf, report);
    reportCollectionNamespaces(docs, byEntityId, report);
    reportIncrementalTags(docs, defaultSchemaOf, report);
    reportMissingTargetDatabases(docs, report);
    reportMissingTargetSchemas(docs, engineOf, report);
    reportUnsupportedTransformEngines(docs, engineOf, report);
    reportUnknownEngines(docs, engineOf, findSources, report);
    reportEmptyNativeQueries(docs, findSources, report);

    // A null default schema that the user gives says the database has no
    // schemas, over what its engine allows.
    const noSchemaDatabases = new Set(
      Object.entries({ ...settings.defaultSchemas, ...defaultSchemas })
        .filter(([, schema]) => schema === null)
        .map(([database]) => database),
    );
    reportNullSchemaReferences(
      docs,
      transforms,
      findSources,
      engineOf,
      noSchemaDatabases,
      report,
    );

    reportTransformIds(docs, byEntityId, transformOfDoc, report);
    const readRewritten = createRewrittenTableReader(parser, engineOf);
    reportTestFindings(tested, defaultSchemaOf, readRewritten, report);
    reportRowsColumns(docs, report);
    reportExpectationNames(docs, report);
    reportEmptyExpectations(docs, report);
    reportUntestableEngines(tested, engineOf, report);
    reportTestSql(
      {
        transforms,
        tested,
        defaultSchemaOf,
        engineOf,
        queryOf: createQueryReader(docs, byEntityId, findSources),
        readSql,
        readRewritten,
        columns: createSqlColumnReader(parser, engineOf),
      },
      report,
    );
    return {
      files,
      findings: findings.sort(byRuleThenFile),
      databases: namedDatabases(docs, findSources),
    };
  });
}
