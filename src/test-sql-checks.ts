import {
  displayName,
  type Doc,
  isQuerySource,
  queryDatabaseOf,
} from "./documents.js";
import type { Report } from "./findings.js";
import { inputCovers } from "./input-match.js";
import { createSourceFinder } from "./query-sources.js";
import { createSnippetFinder, expandNative, type Transform } from "./reads.js";
import type { Schemas } from "./schemas.js";
import type { SqlColumnReader } from "./sql-columns.js";
import type {
  ReplacedTableKey,
  TableReplacement,
  Unread,
} from "./sql-parser.js";
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
import type { TestedTransform } from "./test-checks.js";
import { nativeOnlyStage } from "./transform-checks.js";

/** What the checks of a transform test's SQL read. */
export type TestSqlChecks = {
  docs: readonly Doc[];
  byEntityId: ReadonlyMap<string, readonly Doc[]>;
  transforms: readonly Transform[];
  /** Each test of a query transform, with that transform. */
  tested: readonly TestedTransform[];
  defaultSchemaOf: DefaultSchemaOf;
  schemas: Schemas;
  readSql: SqlTableReader;
  columns: SqlColumnReader;
};

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

/**
 * Warns that the column rules could not read the columns of a query in
 * `doc`. `query` names the query and what its columns do, as "this
 * transform reads or returns".
 */
export type ReportUnreadColumns = (
  doc: Doc,
  query: string,
  unread: Unread,
) => void;

/** The subject of a transform's query in a `ReportUnreadColumns` warning. */
const TRANSFORM_COLUMNS = "this transform reads or returns";

/**
 * Returns a `ReportUnreadColumns` that reports each query once, as a
 * reads-not-checked warning, however many rules and tests read it.
 */
function createUnreadColumnsReport(report: Report): ReportUnreadColumns {
  const reported = new Map<Doc, Set<string>>();
  return (doc, query, { reason }) => {
    const queries = reported.get(doc) ?? new Set<string>();
    if (queries.has(query)) {
      return;
    }
    reported.set(doc, queries.add(query));
    report(
      "reads-not-checked",
      doc,
      `could not find the columns ${query}: ${reason}`,
    );
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

/**
 * Warns on each `sql` input of a test whose SQL reads a table. Metabase runs
 * an input's SQL on the source database as written, so the test reads live
 * data. SQL the parser cannot read is a reads-not-checked warning.
 */
export function reportLiveSqlInputs(
  checks: TestSqlChecks,
  report: Report,
): void {
  for (const { test, transform } of checks.tested) {
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
 * Passes `unread` to `reportUnread` for `transform`'s query when the
 * transform's tables were read: otherwise its tables are already reported
 * as unread.
 */
function reportUnreadTransformColumns(
  transform: Transform,
  unread: Unread,
  reportUnread: ReportUnreadColumns,
): void {
  if (transform.reads.status === "read") {
    reportUnread(transform.doc, TRANSFORM_COLUMNS, unread);
  }
}

/**
 * The columns a transform's query reads: the column of each field id in it,
 * and each column of its native SQL that `columns.readColumns` places in one
 * table. Native SQL whose columns cannot be read goes to `reportUnread`.
 */
function readColumnsOf(
  transform: Transform,
  query: TransformQuery,
  columns: SqlColumnReader,
  reportUnread: ReportUnreadColumns,
): ColumnKey[] {
  return [
    ...query.fields,
    ...query.natives.flatMap(({ sql, database, valuedTags }) => {
      const result = columns.readColumns(sql, database, valuedTags);
      if (result.status === "unread") {
        reportUnreadTransformColumns(transform, result, reportUnread);
        return [];
      }
      return result.columns;
    }),
  ];
}

/**
 * Warns on each column a test's transform reads from the table of one of its
 * `rows` inputs that the input does not declare: Metabase runs the transform
 * on the input, and the SQL fails. Columns compare ignoring case. A column
 * the parser cannot place in one table gives no finding. SQL whose tables
 * were read but whose columns cannot be goes to `reportUnread`.
 */
export function reportMissingReadColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of checks.tested) {
    const database = queryDatabaseOf(transform.doc);
    const defaultSchema = checks.defaultSchemaOf(database);
    const read = readColumnsOf(
      transform,
      queryOf(transform),
      checks.columns,
      reportUnread,
    );
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
 * SQL whose columns cannot be read goes to `reportUnread`.
 */
function returnedNamesOf(
  transform: Transform,
  query: TransformQuery,
  columns: SqlColumnReader,
  reportUnread: ReportUnreadColumns,
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
  if (result.status === "unread") {
    reportUnreadTransformColumns(transform, result, reportUnread);
    return null;
  }
  return result.names;
}

/**
 * Warns on each column of a test's `rows` input that stands in for another
 * transform's target (`sameTable`) when that transform does not return the
 * column. Only a transform whose query is one native stage, with a name for
 * each column it returns, is compared. Names compare ignoring case. SQL
 * whose tables were read but whose columns cannot be goes to
 * `reportUnread`.
 */
export function reportUpstreamColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of checks.tested) {
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
          upstream.target === null ||
          !sameTable(table, upstream.target, checks.defaultSchemaOf)
        ) {
          continue;
        }
        const names = returnedNamesOf(
          upstream,
          queryOf(upstream),
          checks.columns,
          reportUnread,
        );
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
 * qualifier lacks. SQL whose tables were read but whose columns cannot be
 * goes to `reportUnread`.
 */
export function reportQualifiedColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
  const queryOf = createQueryReader(checks);
  for (const { test, transform } of checks.tested) {
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
      names: readonly string[],
      subject: string,
      related: string[],
    ) => {
      for (const qualifier of uniqueFolded(names)) {
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
      const result = checks.columns.danglingQualifiers(
        native.sql,
        native.database,
        replacements,
        native.valuedTags,
      );
      if (result.status === "unread") {
        reportUnreadTransformColumns(transform, result, reportUnread);
      } else {
        reportQualifiers(
          result.names,
          `transform ${displayName(transform.doc)}`,
          [transform.doc.file],
        );
      }
    }
    for (const expectation of test.body.expectations) {
      if (!("sql" in expectation)) {
        continue;
      }
      const result = checks.columns.danglingQualifiers(
        expectation.sql,
        database,
        replacements,
      );
      if (result.status === "read") {
        reportQualifiers(result.names, `expectation ${expectation.name}`, []);
      } else if (checks.readSql(expectation.sql, database).status === "read") {
        reportUnread(test, `expectation ${expectation.name} reads`, result);
      }
    }
  }
}

/**
 * Runs every check of a transform test's SQL. A query whose columns cannot
 * be read is reported once, however many rules read it.
 */
export function reportTestSql(checks: TestSqlChecks, report: Report): void {
  const reportUnread = createUnreadColumnsReport(report);
  reportMissingReadColumns(checks, report, reportUnread);
  reportUpstreamColumns(checks, report, reportUnread);
  reportQualifiedColumns(checks, report, reportUnread);
  reportLiveSqlInputs(checks, report);
}
