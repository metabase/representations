import type { EngineOf } from "./databases.js";
import {
  displayName,
  type Doc,
  isQuerySource,
  queryDatabaseOf,
} from "./documents.js";
import type { Report } from "./findings.js";
import type { SourceFinder } from "./query-sources.js";
import {
  compiledTags,
  createSnippetFinder,
  expandNative,
  type Transform,
} from "./reads.js";
import type { SqlColumnReader } from "./sql-columns.js";
import type { Unread } from "./sql-parser.js";
import type { SqlTableReader } from "./sql-tables.js";
import { fold, sqlTable, tableLabel, type TableName } from "./tables.js";
import type { TableComparisons, TestedTransform } from "./test-checks.js";
import { nativeOnlyStage } from "./transform-checks.js";

/** What the checks of a transform test's SQL read. */
export type TestSqlChecks = {
  transforms: readonly Transform[];
  /** Each test of a query transform, with that transform. */
  tested: readonly TestedTransform[];
  /** The comparisons of table names, "unknown" where a default schema no source gives decides them. */
  compare: TableComparisons;
  engineOf: EngineOf;
  /** The query of each transform in `transforms`. */
  queryOf: QueryReader;
  readSql: SqlTableReader;
  columns: SqlColumnReader;
};

/**
 * A native query of a transform, its snippets pasted in, and the template
 * tags Metabase gives a value (`compiledTags`): undefined for a stage with no
 * template tags, whose SQL Metabase runs as written.
 */
type NativeQuery = {
  sql: string;
  database: string | null;
  valuedTags: ReadonlySet<string> | undefined;
};

/** What a query transform's query names, as the checks read it. */
export type TransformQuery = {
  /** Its native queries whose snippets could be pasted in. */
  natives: NativeQuery[];
  /** Whether it is one native stage. */
  nativeOnly: boolean;
};

/** A query transform's `TransformQuery`. */
export type QueryReader = (transform: Transform) => TransformQuery;

/**
 * Returns the `QueryReader` of transforms, each read once; their snippets are
 * those among the documents of `byEntityId`.
 */
export function createQueryReader(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  findSources: SourceFinder,
): QueryReader {
  const findSnippet = createSnippetFinder(byEntityId);
  const memo = new Map<Transform, TransformQuery>();
  return (transform) => {
    let query = memo.get(transform);
    if (query === undefined) {
      const { source } = transform.doc.body;
      const { natives } = findSources(transform.doc.body, "Transform");
      query = {
        natives: natives.flatMap((native) => {
          const expanded = expandNative(native, findSnippet);
          return expanded.status === "expanded"
            ? [
                {
                  sql: expanded.sql,
                  database: native.database,
                  valuedTags: compiledTags(native),
                },
              ]
            : [];
        }),
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
type ReportUnreadColumns = (doc: Doc, query: string, unread: Unread) => void;

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
 * each column it returns, is compared, and only where the comparison of
 * table names does not depend on a default schema no source gives.
 * Names compare ignoring case. SQL whose tables were read but whose columns
 * cannot be goes to `reportUnread`.
 */
export function reportUpstreamColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
  for (const { test, transform } of checks.tested) {
    for (const input of test.body.inputs) {
      if (input.format !== "rows") {
        continue;
      }
      const table = sqlTable(
        queryDatabaseOf(transform.doc),
        inputTableOf(input.table),
      );
      for (const upstream of checks.transforms) {
        if (
          upstream === transform ||
          upstream.target === null ||
          checks.compare.sameTable(table, upstream.target) !== true
        ) {
          continue;
        }
        const names = returnedNamesOf(
          upstream,
          checks.queryOf(upstream),
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
 * Runs every check of a transform test's SQL. A query whose columns cannot
 * be read is reported once, however many rules read it.
 */
export function reportTestSql(checks: TestSqlChecks, report: Report): void {
  const reportUnread = createUnreadColumnsReport(report);
  reportUpstreamColumns(checks, report, reportUnread);
  reportLiveSqlInputs(checks, report);
}
