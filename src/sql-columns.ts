import type { EngineOf } from "./databases.js";
import {
  cacheBySql,
  type FieldReferences,
  type FieldSpec,
  type QueryShape,
  type SqlParser,
  type Unread,
} from "./sql-parser.js";
import { stripLargeLiteralLists } from "./literal-lists.js";
import { isTagPlaceholder, prepareSql } from "./sql-tables.js";

/**
 * The columns of SQL in the database `database`, as Metabase's
 * `field_references` reads them. It parses the SQL as
 * `prepareSql` gives it for the database's engine, with `valuedTags` for a
 * native query and as written without, and is unread when `prepareSql`
 * refuses it or SQLGlot cannot read it.
 */
export type SqlColumnReader = {
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
};

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
  // Metabase strips large literal lists before field_references.
  const fieldReferences = cacheBySql((sql, dialect) =>
    parser.fieldReferences(stripLargeLiteralLists(sql), dialect),
  );
  const queryShape = cacheBySql((sql, dialect) =>
    parser.queryShape(stripLargeLiteralLists(sql), dialect),
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
  };
}
