import type { EngineOf } from "./databases.js";
import {
  cacheBySql,
  type FieldReferences,
  type FieldSpec,
  type QueryShape,
  type SqlParser,
  type TableReplacement,
  type Unread,
} from "./sql-parser.js";
import { isTagPlaceholder, prepareSql } from "./sql-tables.js";
import { type ColumnKey, fold, type TableName } from "./tables.js";

/**
 * How a query names a column it reads: in quotes, without, as Metabase
 * compiles an MBQL field (`compiled`), or unknown when the SQL names it both
 * ways.
 */
export type ColumnQuoting = "quoted" | "unquoted" | "compiled" | "unknown";

/** A column a query reads, and how it names it. */
export type ReadColumn = ColumnKey & { quoting: ColumnQuoting };

/**
 * The columns of native SQL in the database `database`, as Metabase's
 * `field_references` reads them. Each function parses the SQL as
 * `prepareSql` gives it for the database's engine, with `valuedTags`, and is
 * unread when `prepareSql` refuses it or SQLGlot cannot read it.
 */
export type SqlColumnReader = {
  /**
   * The columns the SQL reads from tables: each column whose only possible
   * source is one table, through any CTEs and subqueries between. A column
   * that may come from several tables or scopes, and `*`, give none. So does
   * a column of a table whose alias names its columns (`t AS s(x, y)`), a
   * name that is also a SELECT-list alias (a lateral alias, as Redshift
   * allows) or an `ARRAY JOIN` alias, and a system column or niladic keyword
   * of the engine, such as Postgres `xmin` or `current_user`.
   */
  readColumns(
    sql: string,
    database: string | null,
    valuedTags?: ReadonlySet<string>,
  ): { status: "read"; columns: ReadColumn[] } | Unread;
  /**
   * The names of the columns the outermost SELECT returns, in order: each
   * one's alias, or else its column's name. Null when one has neither, or
   * when the SELECT returns `*` or `table.*`.
   */
  returnedNames(
    sql: string,
    database: string | null,
    valuedTags?: ReadonlySet<string>,
  ): { status: "read"; names: string[] | null } | Unread;
  /**
   * The names that qualify a column but name no table or alias in its scope,
   * once `replacements` replace the SQL's tables (`replace_names`), as
   * Metabase's transform tests find them.
   */
  danglingQualifiers(
    sql: string,
    database: string | null,
    replacements: readonly TableReplacement[],
    valuedTags?: ReadonlySet<string>,
  ): { status: "read"; names: string[] } | Unread;
};

/** The one table a used field can come from, or null. */
function soleTable(field: FieldSpec): TableName | null {
  if (field.type !== "single_column" || field.sourceColumns.length !== 1) {
    return null;
  }
  const [scope] = field.sourceColumns;
  return scope.length === 1 && scope[0].type === "all_columns"
    ? scope[0].table
    : null;
}

const POSTGRES_IMPLICIT_COLUMNS = [
  "ctid",
  "xmin",
  "xmax",
  "cmin",
  "cmax",
  "tableoid",
  "current_user",
  "session_user",
  "current_role",
  "user",
];

/**
 * The names an engine reads as a system column or a niladic keyword, not as
 * a column of the table, by engine.
 */
const IMPLICIT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  postgres: POSTGRES_IMPLICIT_COLUMNS,
  redshift: [...POSTGRES_IMPLICIT_COLUMNS, "sysdate"],
};

/**
 * Whether a column `field_references` reads from `table` names no column of
 * it, by `shape` and the engine's `implicit` names.
 */
function isNotTableColumn(
  column: string,
  table: TableName,
  shape: QueryShape,
  implicit: readonly string[],
): boolean {
  const name = fold(column);
  return (
    implicit.includes(name) ||
    [...shape.selectAliases, ...shape.arrayJoinAliases].some(
      (alias) => fold(alias) === name,
    ) ||
    shape.columnAliasedTables.some(
      (t) =>
        fold(t.name) === fold(table.name) &&
        (t.schema === null ||
          table.schema === null ||
          fold(t.schema) === fold(table.schema)),
    )
  );
}

/** How `shape`'s statement names `column`. */
function quotingOf(column: string, shape: QueryShape): ColumnQuoting {
  const quoted = shape.quotedColumns.includes(column);
  const unquoted = shape.unquotedColumns.includes(column);
  return quoted === unquoted ? "unknown" : quoted ? "quoted" : "unquoted";
}

/** The name a returned field gets, or null when it has none. */
function returnedName(field: FieldSpec): string | null {
  switch (field.type) {
    case "single_column":
      return field.alias ?? field.column;
    case "custom_field":
    case "composite_field":
      return field.alias;
    case "all_columns":
    case "unknown_columns":
      return null;
  }
}

/** Returns a `SqlColumnReader` that parses with `parser`; each distinct SQL, in each dialect, is read once. */
export function createSqlColumnReader(
  parser: SqlParser,
  engineOf: EngineOf,
): SqlColumnReader {
  const fieldReferences = cacheBySql((sql, dialect) =>
    parser.fieldReferences(sql, dialect),
  );
  const queryShape = cacheBySql((sql, dialect) =>
    parser.queryShape(sql, dialect),
  );

  const referencesOf = <T>(
    sql: string,
    database: string | null,
    valuedTags: ReadonlySet<string> | undefined,
    read: (references: FieldReferences, shape: QueryShape) => T,
  ): T | Unread => {
    const prepared = prepareSql(sql, engineOf(database), valuedTags);
    if (prepared.status === "unread") {
      return prepared;
    }
    const result = fieldReferences(prepared.sql, prepared.dialect);
    if (result.status !== "read") {
      return result;
    }
    const shape = queryShape(prepared.sql, prepared.dialect);
    return shape.status === "read"
      ? read(result.references, shape.shape)
      : shape;
  };

  return {
    readColumns: (sql, database, valuedTags) =>
      referencesOf(sql, database, valuedTags, ({ usedFields }, shape) => ({
        status: "read",
        columns: usedFields.flatMap((field) => {
          const table = soleTable(field);
          const engine = engineOf(database);
          const implicit =
            engine !== null && Object.hasOwn(IMPLICIT_COLUMNS, engine)
              ? IMPLICIT_COLUMNS[engine]
              : [];
          return table !== null &&
            field.type === "single_column" &&
            !isTagPlaceholder(field.column) &&
            !isNotTableColumn(field.column, table, shape, implicit)
            ? [
                {
                  table: {
                    database,
                    ...table,
                    nullSchema: "default",
                    caseMatters: false,
                  },
                  column: field.column,
                  quoting: quotingOf(field.column, shape),
                },
              ]
            : [];
        }),
      })),

    returnedNames: (sql, database, valuedTags) =>
      referencesOf(sql, database, valuedTags, ({ returnedFields }, shape) => {
        const names = returnedFields.map(returnedName);
        return {
          status: "read",
          names:
            !shape.returnsStar &&
            names.every(
              (name): name is string =>
                name !== null && !isTagPlaceholder(name),
            )
              ? names
              : null,
        };
      }),

    danglingQualifiers: (sql, database, replacements, valuedTags) => {
      const prepared = prepareSql(sql, engineOf(database), valuedTags);
      if (prepared.status === "unread") {
        return prepared;
      }
      const replaced = parser.replaceNames(
        prepared.sql,
        replacements,
        prepared.dialect,
      );
      if (replaced.status === "unread") {
        return replaced;
      }
      const result = fieldReferences(replaced.sql, prepared.dialect);
      return result.status === "read"
        ? { status: "read", names: result.references.missingTableAliases }
        : result;
    },
  };
}
