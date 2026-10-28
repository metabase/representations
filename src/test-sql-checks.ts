import {
  displayName,
  type Doc,
  isQuerySource,
  queryDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers } from "./input-match.js";
import { createSourceFinder } from "./query-sources.js";
import {
  createSnippetFinder,
  expandNative,
  type QueryTransform,
  type Transform,
} from "./reads.js";
import type { Schemas } from "./schemas.js";
import type { SqlColumnReader } from "./sql-columns.js";
import type { ReplacedTableKey, TableReplacement } from "./sql-parser.js";
import type { SqlTableReader } from "./sql-tables.js";
import {
  type ColumnKey,
  type DefaultSchemaOf,
  fold,
  sameTable,
  type TableKey,
  tableLabel,
  type TableName,
} from "./tables.js";
import { queryTransformOf } from "./test-checks.js";
import { nativeOnlyStage } from "./transform-checks.js";

/** What the checks of a transform test's SQL read. */
export type TestSqlChecks = {
  docs: readonly Doc[];
  byEntityId: ReadonlyMap<string, readonly Doc[]>;
  transforms: readonly Transform[];
  defaultSchemaOf: DefaultSchemaOf;
  schemas: Schemas;
  readSql: SqlTableReader;
  columns: SqlColumnReader;
};

type TestDoc = ValidDoc<"TransformTest">;

/** A native query of a transform, its snippets pasted in. */
type NativeQuery = {
  sql: string;
  database: string | null;
  valuedTags: ReadonlySet<string>;
};

/** What a query transform's query names, as the checks read it. */
type TransformQuery = {
  /** Its native queries whose snippets could be pasted in. */
  natives: NativeQuery[];
  /** The column of each field id in it. */
  fields: ColumnKey[];
  /** Whether it is one native stage. */
  nativeOnly: boolean;
};

/** Returns the lookup of a query transform's `TransformQuery`, each read once. */
function createQueryReader(
  checks: TestSqlChecks,
): (transform: Transform) => TransformQuery {
  const findSources = createSourceFinder(checks.schemas);
  const findSnippet = createSnippetFinder(checks.docs, checks.byEntityId);
  const memo = new Map<Transform, TransformQuery>();
  return (transform) => {
    let query = memo.get(transform);
    if (query === undefined) {
      const { source } = transform.doc.body;
      const { natives, fields } = findSources(transform.doc.body, "Transform");
      query = {
        natives: natives.flatMap((native) => {
          const expanded = expandNative(native, findSnippet);
          return expanded.status === "expanded"
            ? [{ ...native, sql: expanded.sql }]
            : [];
        }),
        fields,
        nativeOnly: isQuerySource(source) && nativeOnlyStage(source) !== null,
      };
      memo.set(transform, query);
    }
    return query;
  };
}

/** The table a test input stands in for. */
const inputTableOf = (table: {
  schema?: string | null;
  name: string;
}): TableName => ({ schema: table.schema ?? null, name: table.name });

/** `names` without repeats ignoring case (`fold`), sorted the same way. */
function uniqueFolded(names: readonly string[]): string[] {
  const byFold = new Map(names.map((name) => [fold(name), name]));
  return [...byFold.keys()].sort().map((key) => byFold.get(key) ?? key);
}

/** Each schema-valid transform test whose transform is a query transform, with that transform. */
function testedTransforms(
  checks: TestSqlChecks,
): { test: TestDoc; transform: QueryTransform }[] {
  const transformOfDoc = new Map<Doc, Transform>(
    checks.transforms.map((t) => [t.doc, t]),
  );
  return validDocsOf(checks.docs, "TransformTest").flatMap((test) => {
    const transform = queryTransformOf(test, checks.byEntityId, transformOfDoc);
    return transform === null ? [] : [{ test, transform }];
  });
}

/**
 * Warns on each `sql` input of a test whose SQL reads a table. Metabase runs
 * an input's SQL on the source database as written, so the test reads live
 * data. SQL the parser cannot read is a reads-not-checked warning.
 */
export function reportLiveSqlInputs(
  checks: TestSqlChecks,
  report: Report,
): void {
  for (const { test, transform } of testedTransforms(checks)) {
    for (const input of test.body.inputs) {
      if (input.format !== "sql") {
        continue;
      }
      const result = checks.readSql(input.sql, queryDatabaseOf(transform.doc));
      const inputTable = tableLabel(inputTableOf(input.table));
      if (result.status === "unread") {
        report(
          "reads-not-checked",
          test,
          `could not find the tables input ${inputTable} reads: ${result.reason}`,
        );
      } else if (result.tables.length > 0) {
        report(
          "live-sql-input",
          test,
          `input ${inputTable} reads ${result.tables.map(tableLabel).join(", ")}; Metabase runs an input's SQL on the database as written, so the test depends on live data`,
        );
      }
    }
  }
}

/**
 * The columns a transform's query reads: the column of each field id in it,
 * and each column of its native SQL that `columns.readColumns` places in one
 * table.
 */
function readColumnsOf(
  query: TransformQuery,
  columns: SqlColumnReader,
): ColumnKey[] {
  return [
    ...query.fields,
    ...query.natives.flatMap(({ sql, database, valuedTags }) => {
      const result = columns.readColumns(sql, database, valuedTags);
      return result.status === "read" ? result.columns : [];
    }),
  ];
}

/**
 * Warns on each column a test's transform reads from the table of one of its
 * `rows` inputs that the input does not declare: Metabase runs the transform
 * on the input, and the SQL fails. Columns compare ignoring case. A column of
 * SQL the parser cannot read, or cannot place in one table, gives no
 * finding.
 */
export function reportMissingReadColumns(
  checks: TestSqlChecks,
  report: Report,
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of testedTransforms(checks)) {
    const database = queryDatabaseOf(transform.doc);
    const defaultSchema = checks.defaultSchemaOf(database);
    const read = readColumnsOf(queryOf(transform), checks.columns);
    for (const input of test.body.inputs) {
      if (input.format !== "rows") {
        continue;
      }
      const declared = new Set(input.columns.map((c) => fold(c.name)));
      const inputTable = inputTableOf(input.table);
      const missing = read.filter(
        ({ table, column }) =>
          (table.database === null ||
            fold(table.database) === fold(database)) &&
          inputCovers(table, inputTable, defaultSchema) &&
          !declared.has(fold(column)),
      );
      for (const column of uniqueFolded(missing.map((c) => c.column))) {
        report(
          "input-missing-read-column",
          test,
          `input ${tableLabel(inputTable)} has no column ${column}, which transform ${displayName(transform.doc)} reads`,
          [transform.doc.file],
        );
      }
    }
  }
}

/**
 * The names of the columns a transform returns, when its query is one native
 * stage whose every column `columns.returnedNames` names; null otherwise.
 */
function returnedNamesOf(
  query: TransformQuery,
  columns: SqlColumnReader,
): string[] | null {
  const [native] = query.natives;
  if (!query.nativeOnly || native === undefined) {
    return null;
  }
  const result = columns.returnedNames(
    native.sql,
    native.database,
    native.valuedTags,
  );
  return result.status === "read" ? result.names : null;
}

/**
 * Warns on each column of a test's `rows` input that stands in for another
 * transform's target (`sameTable`) when that transform does not return the
 * column. Only a transform whose query is one native stage, with a name for
 * each column it returns, is compared. Names compare ignoring case.
 */
export function reportUpstreamColumns(
  checks: TestSqlChecks,
  report: Report,
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of testedTransforms(checks)) {
    for (const input of test.body.inputs) {
      if (input.format !== "rows") {
        continue;
      }
      const table: TableKey = {
        database: queryDatabaseOf(transform.doc),
        ...inputTableOf(input.table),
        nullSchema: "default",
      };
      for (const upstream of checks.transforms) {
        if (
          upstream === transform ||
          !sameTable(table, upstream.target, checks.defaultSchemaOf)
        ) {
          continue;
        }
        const names = returnedNamesOf(queryOf(upstream), checks.columns);
        if (names === null) {
          continue;
        }
        const returned = new Set(names.map(fold));
        for (const { name } of input.columns) {
          if (!returned.has(fold(name))) {
            report(
              "upstream-column-mismatch",
              test,
              `input ${tableLabel(table)} has column ${name}, which transform ${displayName(upstream.doc)} does not return; it returns ${names.join(", ")}`,
              [upstream.doc.file],
            );
          }
        }
      }
    }
  }
}

/**
 * The ways a query can name `table`, as Metabase's `table-keys` gives them:
 * qualified, and unqualified when its schema is none or the default.
 */
function tableKeys(
  table: TableName,
  defaultSchema: string | null,
): ReplacedTableKey[] {
  return [
    ...(table.schema === null
      ? []
      : [{ schema: table.schema, table: table.name }]),
    ...(table.schema === null || fold(table.schema) === fold(defaultSchema)
      ? [{ table: table.name }]
      : []),
  ];
}

/**
 * The replacements of a test run, as Metabase's `table-replacements` builds
 * them: every way a query names each of `tables`, to a stand-in table of its
 * own.
 */
function standInReplacements(
  tables: readonly TableName[],
  defaultSchema: string | null,
): TableReplacement[] {
  return tables.flatMap((table, i) =>
    tableKeys(table, defaultSchema).map(
      (key): TableReplacement => [
        key,
        { db: null, schema: null, table: `mb_test_${i}` },
      ],
    ),
  );
}

/**
 * Warns on each qualifier of a column that names no table or alias once the
 * test's tables (its inputs and the transform's target) are replaced, in the
 * SQL of a test's transform or of one of its expectations: Metabase refuses
 * such a test as an `unremapped-reference`. Such a qualifier is usually the
 * bare name of a replaced table whose reference carries a schema the
 * qualifier lacks. SQL the parser cannot read gives no finding.
 */
export function reportQualifiedColumns(
  checks: TestSqlChecks,
  report: Report,
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of testedTransforms(checks)) {
    const database = queryDatabaseOf(transform.doc);
    const replaced = [
      ...test.body.inputs.map(({ table }) => inputTableOf(table)),
      transform.target,
    ];
    const replacements = standInReplacements(
      replaced,
      checks.defaultSchemaOf(database),
    );
    const reportQualifiers = (
      result: ReturnType<SqlColumnReader["danglingQualifiers"]>,
      subject: string,
      related: string[],
    ) => {
      if (result.status === "unread") {
        return;
      }
      for (const qualifier of uniqueFolded(result.names)) {
        const table = replaced.find((t) => fold(t.name) === fold(qualifier));
        report(
          "table-qualified-column",
          test,
          table === undefined
            ? `${subject} qualifies a column by ${qualifier}, which names no table or alias in its query. Metabase refuses the test. Qualify each column by the alias of a table the query reads`
            : `${subject} qualifies a column by ${qualifier}, the name of ${tableLabel(table)}, which this test replaces. Metabase refuses the test. Alias the table and qualify its columns by the alias`,
          related,
        );
      }
    };
    for (const native of queryOf(transform).natives) {
      reportQualifiers(
        checks.columns.danglingQualifiers(
          native.sql,
          native.database,
          replacements,
          native.valuedTags,
        ),
        `transform ${displayName(transform.doc)}`,
        [transform.doc.file],
      );
    }
    for (const expectation of test.body.expectations) {
      if ("sql" in expectation) {
        reportQualifiers(
          checks.columns.danglingQualifiers(
            expectation.sql,
            database,
            replacements,
          ),
          `expectation ${expectation.name}`,
          [],
        );
      }
    }
  }
}

/** Runs every check of a transform test's SQL. */
export function reportTestSql(checks: TestSqlChecks, report: Report): void {
  reportMissingReadColumns(checks, report);
  reportUpstreamColumns(checks, report);
  reportQualifiedColumns(checks, report);
  reportLiveSqlInputs(checks, report);
}
