import { stringOrNull } from "./values.js";

/** A table as a query names it: its schema, if the name is qualified, and its name. */
export type TableName = {
  schema: string | null;
  name: string;
};

/** A table in a database; `database` is null when the document does not say which. */
export type TableKey = TableName & {
  database: string | null;
};

/**
 * The schema an unqualified table name resolves to in each database, by its
 * name: a string, or null when the database has none.
 */
export type DefaultSchemaOf = (database: string | null) => string | null;

/** An identifier as Metabase compares it: in lower case. Null stays null. */
export function fold(identifier: string): string;
export function fold(identifier: string | null): string | null;
export function fold(identifier: string | null): string | null {
  return identifier === null ? null : identifier.toLowerCase();
}

/**
 * Whether two table names can denote the same table. Each part compares
 * ignoring case (`fold`):
 *
 * - names must be equal;
 * - databases must be equal when both are known; a missing one matches any;
 * - schemas must be equal when both are known. When one name is unqualified,
 *   it resolves to the default schema of the names' database
 *   (`defaultSchemaOf`), and matches only if the other schema is that
 *   default.
 */
export function sameTable(
  a: TableKey,
  b: TableKey,
  defaultSchemaOf: DefaultSchemaOf,
): boolean {
  if (fold(a.name) !== fold(b.name)) {
    return false;
  }
  if (
    a.database !== null &&
    b.database !== null &&
    fold(a.database) !== fold(b.database)
  ) {
    return false;
  }
  if (a.schema === null || b.schema === null) {
    const qualified = a.schema ?? b.schema;
    if (qualified === null) {
      return true;
    }
    return fold(qualified) === fold(defaultSchemaOf(a.database ?? b.database));
  }
  return fold(a.schema) === fold(b.schema);
}

/**
 * `tables` without repeats, keeping the first of each: two keys repeat when
 * their database, schema and name are equal ignoring case (`fold`).
 */
export function uniqueTables(tables: readonly TableKey[]): TableKey[] {
  const seen = new Set<string>();
  return tables.filter((t) => {
    const key = JSON.stringify([t.database, t.schema, t.name].map(fold));
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The table a `[database, schema, table, ...]` reference names (a table id or
 * a field id), or null when `ref` is not one.
 */
export function tableOfRef(ref: unknown): TableKey | null {
  return Array.isArray(ref) && typeof ref[2] === "string"
    ? {
        database: stringOrNull(ref[0]),
        schema: stringOrNull(ref[1]),
        name: ref[2],
      }
    : null;
}

/** The table as messages name it: `schema.name`, or `name` without a schema. */
export function tableLabel(table: TableName): string {
  return table.schema === null ? table.name : `${table.schema}.${table.name}`;
}
