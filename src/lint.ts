import {
  createEngineOf,
  databaseDefaultSchemas,
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
  targetDatabaseOf,
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
import { createSourceFinder, type SourceFinder } from "./query-sources.js";
import { engineFacts } from "./engines.js";
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
  type TestedTransform,
  testedTransformsOf,
  testInputs,
} from "./test-checks.js";
import { reportTestSql } from "./test-sql-checks.js";
import {
  reportCollectionNamespaces,
  reportEmptyNativeQueries,
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

/**
 * Reports each table a transform reads, or a Card's query names, by a
 * reference with a null schema (`nullSchema` `"none"`) in a database whose
 * engine has schemas. Metabase imports such a reference as the table with no
 * schema, and creates an inactive table when none exists
 * (`resolve/default.clj` `import-table-fk`), so every query on it fails. A
 * database whose engine is unknown gives no finding, nor does a table that a
 * table file or a transform target with no schema names. A transform reports
 * the tables of the cards it reads too; a Card, only those its own query
 * names.
 */
function reportNullSchemaReferences(
  docs: readonly Doc[],
  transforms: readonly Transform[],
  findSources: SourceFinder,
  engineOf: EngineOf,
  report: Report,
): void {
  const noSchemaTables = [
    ...validDocsOf(docs, "Table").map(tableOfFile),
    ...targetsOf(transforms),
  ].filter((t) => t.schema === null);
  const readers = [
    ...transforms.flatMap(({ doc, reads }) =>
      reads.status === "read" ? [{ doc, tables: reads.tables }] : [],
    ),
    ...docs
      .filter((doc) => doc.model === "Card")
      .map((doc) => ({ doc, tables: findSources(doc.body, doc.model).tables })),
  ];
  for (const { doc, tables } of readers) {
    for (const table of tables) {
      const engine = engineOf(table.database);
      if (
        table.schema === null &&
        table.nullSchema === "none" &&
        engineFacts(engine)?.schemas === true &&
        !noSchemaTables.some(
          (t) => t.database === table.database && t.name === table.name,
        )
      ) {
        report(
          "null-schema-reference",
          doc,
          `reads ${tableLabel(table)} in database ${table.database}, whose engine ${engine} has schemas: a null schema in a reference names a table with no schema, which Metabase does not find there, so every run fails. Name the table's schema`,
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
 * Reports each cycle among transforms, on its first member in file order. The
 * message follows one cycle from that member, each transform reading the
 * next one's target, and names the table each step reads.
 */
function reportCycles(
  transforms: readonly Transform[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  const edges = readEdges(transforms, defaultSchemaOf);
  const step = (from: Transform, to: Transform): string => {
    const read =
      from.reads.status === "read" && to.target !== null
        ? from.reads.tables.find(
            (t) =>
              to.target !== null && sameTable(t, to.target, defaultSchemaOf),
          )
        : undefined;
    return read === undefined
      ? `${displayName(from.doc)} reads the target of ${displayName(to.doc)}`
      : `${displayName(from.doc)} reads ${tableLabel(read)}, the target of ${displayName(to.doc)}`;
  };
  for (const component of cycles(edges, transforms.length)) {
    const [first, ...rest] = component.map((i) => transforms[i]);
    const path = cyclePath(edges, component).map((i) => transforms[i]);
    const steps = path.slice(1).map((to, i) => step(path[i], to));
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
 * Metabase loads both, the second over the first (`holderOf`): the last file
 * in path order stands and the others are lost, with no message. Files of
 * different models may share an entity_id: Metabase keeps each.
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
 * Warns on each key a document's map holds more than once. Metabase keeps the
 * last value with no message (`readYaml`), so the others are lost.
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

/**
 * The names of the databases the files in the folder name, sorted: Database
 * and table files, and the databases of queries, table references and
 * transform targets. SQL is not read.
 */
export function namedDatabases({ folder }: LintOptions): string[] {
  const schemas = loadSchemas();
  const { docs } = loadDocs(folder, schemas);
  const findSources = createSourceFinder(schemas);
  const names = new Set<string>();
  const add = (name: unknown) => {
    if (typeof name === "string") {
      names.add(name);
    }
  };
  for (const doc of docs) {
    const sources = findSources(doc.body, doc.model);
    sources.tables.forEach((t) => add(t.database));
    sources.natives.forEach((n) => add(n.database));
    if (doc.model === "Database") {
      add(doc.body.name);
    }
    if (doc.model === "Table") {
      add(doc.body.db_id);
    }
  }
  for (const transform of validDocsOf(docs, "Transform")) {
    add(targetDatabaseOf(transform));
  }
  return [...names].sort();
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
  const { docs, skipped, unreadable, duplicatedKeys } = loadDocs(
    folder,
    schemas,
  );
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
    const findSources = createSourceFinder(schemas);

    reportUnreadableFiles(unreadable, report);
    reportSkippedFiles(skipped, report);
    reportDuplicateKeys(duplicatedKeys, report);
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
    reportEmptyNativeQueries(docs, findSources, report);

    reportNullSchemaReferences(docs, transforms, findSources, engineOf, report);

    reportTransformIds(docs, byEntityId, transformOfDoc, report);
    reportTestFindings(
      tested,
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
