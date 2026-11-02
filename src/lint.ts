import { createEngineOf, databasesOf, type EngineOf } from "./databases.js";
import {
  type DefaultSchemas,
  type NamedTable,
  resolveDefaultSchemas,
  type TestTables,
  type UnknownDefaultSchema,
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
import { engineFacts } from "./engines.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { loadSchemas } from "./schemas.js";
import { CONFIG_FILE, readSettingsFile } from "./settings.js";
import { withSqlParser } from "./sql-parser.js";
import {
  createSqlParseCheck,
  createSqlTableReader,
  type SqlTableReader,
} from "./sql-tables.js";
import {
  needsDefaultSchema,
  sameTable,
  sqlTable,
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
  createTableComparisons,
  reportTestFindings,
  reportTestSqlParses,
  reportTransformIds,
  type TestedTransform,
  testedTransformsOf,
  testInputs,
} from "./test-checks.js";
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
   * The names of the databases the files write to or read, sorted
   * (`databasesOf`).
   * SQL is not read.
   */
  databases: string[];
};

/** The models whose files the schema rule checks against their schemas. */
const LINTED_MODELS = new Set([
  "Transform",
  "TransformTest",
  "NativeQuerySnippet",
]);

function entityOf({ model, body }: FindingSubject): LintEntity {
  return {
    model,
    entity_id: stringOrNull(body.entity_id),
    name: stringOrNull(body.name),
  };
}

/** Whether two table names are one table, as the transform checks compare them. */
type SameTable = (a: TableKey, b: TableKey) => boolean;

/** A transform's read of another transform's target: that transform's index, and the table read. */
type ReadEdge = Edge & { read: TableKey };

/**
 * For each transform whose sources were read, by index: each transform whose
 * target it reads (`same`), with the first table it reads there.
 */
function readEdges(
  transforms: readonly Transform[],
  same: SameTable,
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
          target === null ? undefined : reads.find((t) => same(t, target));
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
 * (`same`).
 */
function reportDuplicateTargets(
  transforms: readonly Transform[],
  same: SameTable,
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
        same(target, other.target),
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

/**
 * Reports each table a Card's query names by a reference with a null schema
 * (`nullSchema` `"none"`) in a database whose engine has schemas. Metabase
 * imports such a reference as the table with no schema, and creates an
 * inactive stub table when none exists (`resolve/default.clj`
 * `import-table-fk`), and refuses a signed-in user's query that reads an
 * inactive table. A database whose engine is unknown
 * gives no finding, nor does one in `noSchemaDatabases`, nor a table that a
 * transform target with no schema names. A Card is reported only for the
 * tables its own query names, each once.
 */
function reportNullSchemaReferences(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  findSources: SourceFinder,
  engineOf: EngineOf,
  noSchemaDatabases: ReadonlySet<string>,
  report: Report,
): void {
  const noSchemaTables = targetsOf(transforms).filter((t) => t.schema === null);
  const missing = (table: TableKey) =>
    table.schema === null &&
    table.nullSchema === "none" &&
    engineFacts(engineOf(table.database))?.schemas === true &&
    !(table.database !== null && noSchemaDatabases.has(table.database)) &&
    !noSchemaTables.some(
      (t) => t.database === table.database && t.name === table.name,
    );
  for (const doc of docs.filter((d) => d.model === "Card")) {
    for (const table of findSources(doc.body, doc.model).tables) {
      if (missing(table)) {
        report(
          "null-schema-reference",
          doc,
          `reads ${table.name} with a null schema in ${table.database}, which has schemas; name the table's schema`,
        );
      }
    }
  }
}

/**
 * Reports each cycle among transforms, on its first member in file order. The
 * message follows one cycle from that member, each transform reading the
 * next one's target, and names the table each step reads.
 */
function reportCycles(
  transforms: readonly Transform[],
  same: SameTable,
  report: Report,
): void {
  const edges = readEdges(transforms, same);
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
      "the file is not valid UTF-8, and Metabase reads each invalid byte sequence as U+FFFD; save the file as UTF-8",
    );
  }
}

/**
 * Warns on each key a document's map holds more than once. Metabase keeps one
 * value with no message, so the others are lost.
 */
function reportDuplicateKeys(
  duplicatedKeys: readonly DuplicatedKeys[],
  report: Report,
): void {
  for (const { doc, keys } of duplicatedKeys) {
    for (const { source, line, column, keeps } of keys) {
      report(
        "duplicate-yaml-key",
        doc,
        keeps === "last"
          ? `the key ${source} is written again at ${line}:${column} in the same map; Metabase keeps only the last value`
          : `the key ${source} is written again at ${line}:${column} in a merge source written after <<:; Metabase keeps only the first value`,
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
 * Warns once on each database in `unknown`, on its first file, with its other
 * files as related files.
 */
function reportUnknownDefaultSchemas(
  unknown: readonly UnknownDefaultSchema[],
  docs: readonly Doc[],
  report: Report,
): void {
  for (const { database, files, reason } of unknown) {
    const [first, ...rest] = files;
    const doc = docs.find((d) => d.file === first);
    if (doc === undefined) {
      continue;
    }
    const others =
      rest.length === 0
        ? ""
        : ` and ${rest.length} other file${rest.length === 1 ? "" : "s"}`;
    report(
      "missing-default-schema",
      doc,
      `the default schema of database ${JSON.stringify(database)} is unknown, and this file ${reason}. The lint skipped the comparisons that depend on it, in this file${others}. Give the default schema in ${CONFIG_FILE}, as {"defaultSchemas": {"<database>": "<schema>"}} (null for a database with no schemas)`,
      rest,
    );
  }
}

/**
 * Warns on each Database file. A pull creates a database connection from it,
 * which remote sync never syncs or removes.
 */
function reportDatabaseFiles(docs: readonly Doc[], report: Report): void {
  for (const doc of docs) {
    if (doc.model === "Database") {
      report(
        "database-file",
        doc,
        `a pull creates a database connection from this file, which remote sync never syncs or removes. Remove the file, and give the database's engine and default schema in ${CONFIG_FILE}`,
      );
    }
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
  const engineOf = createEngineOf(readSettingsFile(folder).engines);
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
 * For each test of a query transform, with the test's file, the tables it
 * compares: its inputs, the transform's target, the tables its expectations
 * read, and the tables the transform reads, which the test matches to its
 * inputs.
 */
function testTablesOf(
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): TestTables[] {
  return tested.map(({ test, transform }) => ({
    file: test.file,
    tables: [
      ...testInputs(test, transform),
      transform.target,
      ...expectationReads({ test, transform }, readSql),
      ...(transform.reads.status === "read" ? transform.reads.tables : []),
    ],
  }));
}

/** `tables`, each named by `file`. */
const namedBy = (file: string, tables: readonly TableKey[]): NamedTable[] =>
  tables.map((table) => ({ ...table, file }));

/**
 * Every table the checks compare, in its database, with the file that names
 * it: transform targets and reads, and, for each test of a query transform,
 * its inputs and the tables its SQL expectations read.
 */
function comparedTables(
  transforms: readonly Transform[],
  tested: readonly TestedTransform[],
  readSql: SqlTableReader,
): NamedTable[] {
  return [
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
 * Checks the transforms and transform tests in a folder of
 * representation files, and the references between them, for what Metabase
 * refuses or likely gets wrong. Reads only the files; needs no Metabase.
 * Findings are grouped by rule, in the order of `LINT_RULES`, then by file.
 * Native SQL is parsed by Metabase's own code, loaded once per process, the
 * first time a check reads SQL (`withSqlParser`).
 *
 * A database's default schema comes from `defaultSchemas`, the settings file
 * or its engine, each over the next (`resolveDefaultSchemas`). When none gives
 * one that a file's names need, the lint warns, and skips each comparison
 * of names that depends on it (`needsDefaultSchema`).
 *
 * Rejects with a `LintSetupError` before any check when the settings file is
 * invalid, and when the SQL parser cannot start.
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
  const engineOf = createEngineOf(settings.engines);
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
    const databases = namedDatabases(docs, findSources);
    const { defaultSchemaOf, unknown } = resolveDefaultSchemas({
      names: comparedTables(transforms, tested, readSql),
      testTables: testTablesOf(tested, readSql),
      given: {
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
    reportDatabaseFiles(docs, report);
    reportDuplicateKeys(duplicatedKeys, report);
    reportSchemaMismatches(docs, report);
    reportDuplicateEntityIds(byEntityId, report);

    reportUnknownDefaultSchemas(unknown, docs, report);
    // A comparison that depends on a default schema no source gives is
    // skipped.
    const unknownDatabases = new Set(unknown.map((u) => u.database));
    const same: SameTable = (a, b) => {
      const database = a.database ?? b.database;
      return (
        !(
          database !== null &&
          unknownDatabases.has(database) &&
          needsDefaultSchema(a, b)
        ) && sameTable(a, b, defaultSchemaOf)
      );
    };

    reportUnreadSources(transforms, report);
    reportDuplicateTargets(transforms, same, report);

    reportCycles(transforms, same, report);
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
    reportTestFindings(
      tested,
      createTableComparisons(defaultSchemaOf, unknownDatabases),
      readSql,
      report,
    );
    reportTestSqlParses(
      tested,
      engineOf,
      readSql,
      createSqlParseCheck(parser, engineOf),
      report,
    );
    reportRowsColumns(docs, report);
    reportExpectationNames(docs, report);
    reportEmptyExpectations(docs, report);
    reportUntestableEngines(tested, engineOf, report);
    return {
      files,
      findings: findings.sort(byRuleThenFile),
      databases,
    };
  });
}
