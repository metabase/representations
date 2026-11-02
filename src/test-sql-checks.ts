import type { EngineOf } from "./databases.js";
import {
  displayName,
  type Doc,
  isQuerySource,
  queryDatabaseOf,
} from "./documents.js";
import { FOLDS_ALL_IDENTIFIERS } from "./engines.js";
import type { Report } from "./findings.js";
import {
  inputCovers,
  isStandIn,
  replacesQuoted,
  standInReplacements,
} from "./input-match.js";
import type { SourceFinder } from "./query-sources.js";
import { createSnippetFinder, expandNative, type Transform } from "./reads.js";
import type {
  ColumnQuoting,
  ReadColumn,
  SqlColumnReader,
} from "./sql-columns.js";
import type { Unread } from "./sql-parser.js";
import type { RewrittenTableReader, SqlTableReader } from "./sql-tables.js";
import {
  type ColumnKey,
  type DefaultSchemaOf,
  fold,
  sameTable,
  sqlTable,
  type TableKey,
  tableLabel,
  type TableName,
} from "./tables.js";
import { type TestedTransform, testInputs } from "./test-checks.js";
import { nativeOnlyStage } from "./transform-checks.js";

/** What the checks of a transform test's SQL read. */
export type TestSqlChecks = {
  transforms: readonly Transform[];
  /** Each test of a query transform, with that transform. */
  tested: readonly TestedTransform[];
  defaultSchemaOf: DefaultSchemaOf;
  engineOf: EngineOf;
  /** The query of each transform in `transforms`. */
  queryOf: QueryReader;
  readSql: SqlTableReader;
  readRewritten: RewrittenTableReader;
  columns: SqlColumnReader;
};

/** A native query of a transform, its snippets pasted in. */
type NativeQuery = {
  sql: string;
  database: string | null;
  valuedTags: ReadonlySet<string>;
};

/** What a query transform's query names, as the checks read it. */
export type TransformQuery = {
  /** Its native queries whose snippets could be pasted in. */
  natives: NativeQuery[];
  /** The column of each field id in it. */
  fields: ColumnKey[];
  /** Whether it is one native stage. */
  nativeOnly: boolean;
};

/** A query transform's `TransformQuery`. */
export type QueryReader = (transform: Transform) => TransformQuery;

/**
 * Returns the `QueryReader` of the transforms among `docs`, each read once;
 * their snippets are those among `docs`.
 */
export function createQueryReader(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  findSources: SourceFinder,
): QueryReader {
  const findSnippet = createSnippetFinder(docs, byEntityId);
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
): ReadColumn[] {
  return [
    ...query.fields.map(
      (field): ReadColumn => ({
        ...field,
        quoting: "compiled",
      }),
    ),
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

const lowerAscii = (name: string) =>
  name.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** How each engine with a fixed rule names an unquoted identifier. */
const UNQUOTED_CASE: Readonly<Record<string, (name: string) => string>> = {
  postgres: lowerAscii,
  redshift: lowerAscii,
  snowflake: (name) => name.toUpperCase(),
  h2: (name) => name.toUpperCase(),
  clickhouse: (name) => name,
};

/**
 * Returns the name the warehouse of `engine` gives a column, or null when
 * the lint cannot tell. Metabase creates a `rows` input's columns, and
 * compiles an MBQL field, in quotes, so as written; H2's quoting upper-cases
 * them. A quoted name in SQL is as written, and an unquoted one is in the
 * engine's case; ClickHouse keeps it as written. Redshift folds every name,
 * quoted or not.
 */
function createWarehouseName(
  engine: string | null,
): ((name: string, quoting: ColumnQuoting) => string | null) | null {
  if (engine === null || !Object.hasOwn(UNQUOTED_CASE, engine)) {
    return null;
  }
  const unquoted = UNQUOTED_CASE[engine];
  if (FOLDS_ALL_IDENTIFIERS.has(engine)) {
    return (name) => unquoted(name);
  }
  return (name, quoting) => {
    switch (quoting) {
      // Metabase names a rows input's columns with `h2x/identifier`, quoted
      // (`transform_testing/compile.clj` `compile-input :rows`, `rows-query`);
      // its `:h2` dialect upper-cases each quoted name (`honey_sql_2.clj`).
      case "compiled":
        return engine === "h2" ? name.toUpperCase() : name;
      case "quoted":
        return name;
      case "unquoted":
        return unquoted(name);
      case "unknown":
        return null;
    }
  };
}

/**
 * Warns on each column a test's transform reads from the table of one of its
 * `rows` inputs that the input does not declare: Metabase runs the transform
 * on the input, and the SQL fails. On Postgres, Redshift, Snowflake, H2 and
 * ClickHouse, names compare as the warehouse names them
 * (`createWarehouseName`): an unquoted `total` does not read a declared
 * `Total` on Postgres. On another engine, or for a column the SQL names both quoted and unquoted, names
 * compare ignoring case. A column the parser cannot place in one table gives
 * no finding. SQL whose tables were read but whose columns cannot be goes to
 * `reportUnread`.
 */
export function reportMissingReadColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
  for (const { test, transform } of checks.tested) {
    const database = queryDatabaseOf(transform.doc);
    const defaultSchema = checks.defaultSchemaOf(database);
    const engine = checks.engineOf(database);
    const warehouseName = createWarehouseName(engine);
    const read = readColumnsOf(
      transform,
      checks.queryOf(transform),
      checks.columns,
      reportUnread,
    );
    for (const input of test.body.inputs) {
      if (input.format !== "rows") {
        continue;
      }
      const declaredNames = input.columns.map((c) => c.name);
      const folded = new Set(declaredNames.map(fold));
      const exact =
        warehouseName === null
          ? null
          : new Set(
              declaredNames.map((name) => warehouseName(name, "compiled")),
            );
      const isDeclared = ({ column, quoting }: ReadColumn): boolean => {
        const name = warehouseName?.(column, quoting) ?? null;
        return exact === null || name === null
          ? folded.has(fold(column))
          : exact.has(name);
      };
      const inputTable = inputTableOf(input.table);
      const missing = read.filter(
        (column) =>
          (column.table.database === null ||
            column.table.database === database) &&
          inputCovers(column.table, inputTable, defaultSchema) &&
          !isDeclared(column),
      );
      for (const column of uniqueFolded(missing.map((c) => c.column))) {
        const sameButCase = declaredNames.find(
          (name) => fold(name) === fold(column),
        );
        const readColumn = missing.find((c) => fold(c.column) === fold(column));
        const transformName = displayName(transform.doc);
        report(
          "input-missing-read-column",
          test,
          (sameButCase !== undefined &&
            readColumn !== undefined &&
            warehouseName !== null &&
            caseMismatchMessage({
              engine,
              warehouseName,
              transformName,
              input: tableLabel(inputTable),
              read: readColumn,
              declared: sameButCase,
            })) ||
            `input ${tableLabel(inputTable)} has no column ${column}, which transform ${transformName} reads`,
          [transform.doc.file],
        );
      }
    }
  }
}

/** Why the warehouse of each engine in `UNQUOTED_CASE` reads an unquoted name in its case. */
const UNQUOTED_READS: Readonly<Record<string, string>> = {
  postgres: "Postgres reads an unquoted name in lower case",
  snowflake: "Snowflake reads an unquoted name in upper case",
  h2: "H2 reads an unquoted name in upper case",
  clickhouse: "ClickHouse compares names with case",
};

/**
 * The message of a column a transform reads that an input declares in
 * another case: the name the warehouse reads and the name of the input's
 * column, why they differ, and how to make them agree. Null when
 * `warehouseName` cannot name the read column.
 */
function caseMismatchMessage({
  engine,
  warehouseName,
  transformName,
  input,
  read,
  declared,
}: {
  engine: string | null;
  warehouseName: (name: string, quoting: ColumnQuoting) => string | null;
  transformName: string;
  input: string;
  read: ReadColumn;
  declared: string;
}): string | null {
  const readAs = warehouseName(read.column, read.quoting);
  const declaredAs = warehouseName(declared, "compiled");
  if (readAs === null || declaredAs === null) {
    return null;
  }
  const readReason =
    read.quoting === "compiled"
      ? "Metabase quotes an MBQL field's name, so the warehouse reads it as written"
      : read.quoting === "quoted"
        ? "the SQL quotes the name, so the warehouse reads it as written"
        : engine !== null && Object.hasOwn(UNQUOTED_READS, engine)
          ? UNQUOTED_READS[engine]
          : null;
  if (readReason === null) {
    return null;
  }
  const createReason =
    declaredAs === declared
      ? "Metabase creates the input's columns as declared"
      : `Metabase creates the input's column as ${declaredAs}`;
  const fixes = [
    ...(warehouseName(readAs, "compiled") === readAs
      ? [`declare the column as ${readAs}`]
      : []),
    ...(read.quoting === "compiled"
      ? []
      : engine === "clickhouse"
        ? [`write it as ${declaredAs} in the SQL`]
        : [`write it as "${declaredAs}" in the SQL`]),
  ];
  const fix = fixes.join(", or ");
  return `transform ${transformName} reads the column ${readAs} from input ${input}, which declares ${declared}: ${readReason}, and ${createReason}. ${fix.charAt(0).toUpperCase()}${fix.slice(1)}`;
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
          !sameTable(table, upstream.target, checks.defaultSchemaOf)
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
 * Reports each qualifier of a column that names no table or alias once the
 * test's tables (its inputs and the transform's target) are replaced, in the
 * SQL of a test's transform or of one of its expectations: Metabase refuses
 * such a test as an `unremapped-reference`. In an expectation, which Metabase
 * checks as written, it is an error; in the transform, whose template tags
 * the lint reads as placeholders, a warning. Such a qualifier is usually the
 * bare name of a replaced table whose reference carries a schema the
 * qualifier lacks. SQL whose tables were read but whose columns cannot be
 * goes to `reportUnread`.
 */
export function reportQualifiedColumns(
  checks: TestSqlChecks,
  report: Report,
  reportUnread: ReportUnreadColumns = createUnreadColumnsReport(report),
): void {
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
      rule: "table-qualified-column" | "expectation-qualified-column",
      names: readonly string[],
      subject: string,
      related: string[],
    ) => {
      const refusal =
        rule === "table-qualified-column"
          ? "Metabase refuses the test if the qualifier still names no table once the template tags have values"
          : "Metabase refuses the test";
      for (const qualifier of uniqueFolded(names)) {
        const table = replaced.find((t) => fold(t.name) === fold(qualifier));
        report(
          rule,
          test,
          table === undefined
            ? `${subject} qualifies a column by ${qualifier}, which names no table or alias in its query. ${refusal}. Qualify each column by the alias of a table the query reads`
            : `${subject} qualifies a column by ${qualifier}, the name of ${tableLabel(table)}, which this test replaces. ${refusal}. Alias the table and qualify its columns by the alias`,
          related,
        );
      }
    };
    for (const native of checks.queryOf(transform).natives) {
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
          "table-qualified-column",
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
        reportQualifiers(
          "expectation-qualified-column",
          result.names,
          `expectation ${expectation.name}`,
          [],
        );
      } else if (checks.readSql(expectation.sql, database).status === "read") {
        reportUnread(test, `expectation ${expectation.name} reads`, result);
      }
    }
  }
}

/**
 * Reports each table a test's transform reads that an input covers ignoring
 * case (`inputCovers`) but that Metabase's rewrite (`standInReplacements`)
 * leaves real, because the query quotes a part of its name in another case:
 * Metabase refuses the test. The tables of the transform's native SQL are
 * read after the rewrite; an MBQL reference, which Metabase compiles with
 * every part quoted, must match an input exactly (`replacesQuoted`). A
 * transform whose tables were not read gets no finding.
 */
export function reportUnreplacedReads(
  checks: TestSqlChecks,
  report: Report,
): void {
  for (const { test, transform } of checks.tested) {
    if (transform.reads.status !== "read") {
      continue;
    }
    const defaultSchema = checks.defaultSchemaOf(
      queryDatabaseOf(transform.doc),
    );
    const inputs = testInputs(test, transform);
    const replacements = standInReplacements(
      [...inputs, transform.target],
      defaultSchema,
    );
    const transformName = displayName(transform.doc);
    const reported = new Set<string>();
    const reportRead = (read: TableKey, mbql: boolean) => {
      const input = inputs.find((i) => inputCovers(read, i, defaultSchema));
      const label = tableLabel(read);
      if (input === undefined || reported.has(label)) {
        return;
      }
      reported.add(label);
      report(
        "missing-input",
        test,
        mbql
          ? `no input for ${label}, which transform ${transformName} reads: Metabase quotes each table name of an MBQL query, and replaces a quoted name only in its exact case, so input ${tableLabel(input)} does not stand in for it. Name the input ${label}`
          : `no input for ${label}, which transform ${transformName} reads: Metabase replaces a quoted name only in its exact case, so input ${tableLabel(input)} does not stand in for it. Name the input ${label}, or write the name in the SQL as the input does`,
        [transform.doc.file],
      );
    };
    for (const { sql, database, valuedTags } of checks.queryOf(transform)
      .natives) {
      const result = checks.readRewritten(
        sql,
        database,
        replacements,
        valuedTags,
      );
      if (result.status === "unread") {
        continue;
      }
      for (const table of result.tables) {
        if (!isStandIn(table)) {
          reportRead(sqlTable(database, table), false);
        }
      }
    }
    for (const read of transform.reads.tables) {
      if (read.caseMatters && !replacesQuoted(read, inputs, defaultSchema)) {
        reportRead(read, true);
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
  reportUnreplacedReads(checks, report);
}
