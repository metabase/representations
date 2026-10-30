import type { EngineOf } from "./databases.js";
import {
  cacheBySql,
  type FieldReferences,
  type FieldSpec,
  type SqlParser,
  type TableReplacement,
  type Unread,
} from "./sql-parser.js";
import { isTagPlaceholder, prepareSql } from "./sql-tables.js";
import type { ColumnKey, TableName } from "./tables.js";

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
   * that may come from several tables or scopes, and `*`, give none.
   */
  readColumns(
    sql: string,
    database: string | null,
    valuedTags?: ReadonlySet<string>,
  ): { status: "read"; columns: ColumnKey[] } | Unread;
  /**
   * The names of the columns the outermost SELECT returns, in order: each
   * one's alias, or else its column's name. Null when one has neither, or
   * when the SELECT returns `*`.
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

  const referencesOf = <T>(
    sql: string,
    database: string | null,
    valuedTags: ReadonlySet<string> | undefined,
    read: (references: FieldReferences) => T,
  ): T | Unread => {
    const prepared = prepareSql(sql, engineOf(database), valuedTags);
    if (prepared.status === "unread") {
      return prepared;
    }
    const result = fieldReferences(prepared.sql, prepared.dialect);
    return result.status === "read" ? read(result.references) : result;
  };

  return {
    readColumns: (sql, database, valuedTags) =>
      referencesOf(sql, database, valuedTags, ({ usedFields }) => ({
        status: "read",
        columns: usedFields.flatMap((field) => {
          const table = soleTable(field);
          return table !== null &&
            field.type === "single_column" &&
            !isTagPlaceholder(field.column)
            ? [
                {
                  table: {
                    database,
                    ...table,
                    nullSchema: "default",
                    caseMatters: false,
                  },
                  column: field.column,
                },
              ]
            : [];
        }),
      })),

    returnedNames: (sql, database, valuedTags) =>
      referencesOf(sql, database, valuedTags, ({ returnedFields }) => {
        const names = returnedFields.map(returnedName);
        return {
          status: "read",
          names: names.every(
            (name): name is string => name !== null && !isTagPlaceholder(name),
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
