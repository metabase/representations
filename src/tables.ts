import { stringOrNull } from "./values.js";

/** A table as a query names it: its schema, if the name is qualified, and its name. */
export type TableName = {
  schema: string | null;
  name: string;
};

/**
 * What a null schema in a table's name means: `"default"`, an unqualified
 * name, as in SQL, which resolves to the database's default schema; `"none"`,
 * the table with no schema, as in an MBQL reference or a table file.
 */
export type NullSchema = "default" | "none";

/** A table in a database; `database` is null when the document does not say which. */
export type TableKey = TableName & {
  database: string | null;
  nullSchema: NullSchema;
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
 * - schemas must be equal once each is resolved: an unqualified name
 *   (`nullSchema` `"default"`) to the default schema of the names' database
 *   (`defaultSchemaOf`), and a name with no schema (`"none"`) to none.
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
  const schemaOf = (table: TableKey): string | null =>
    table.schema ??
    (table.nullSchema === "default"
      ? defaultSchemaOf(a.database ?? b.database)
      : null);
  return fold(schemaOf(a)) === fold(schemaOf(b));
}

/**
 * `tables` without repeats, keeping the first of each: two keys repeat when
 * their database, schema and name are equal ignoring case (`fold`), and, when
 * their schema is null, so is what it means (`nullSchema`).
 */
export function uniqueTables(tables: readonly TableKey[]): TableKey[] {
  const seen = new Set<string>();
  return tables.filter((t) => {
    const key = JSON.stringify([
      ...[t.database, t.schema, t.name].map(fold),
      t.schema === null ? t.nullSchema : null,
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The table a `[database, schema, table, ...]` reference names (a table id or
 * a field id), or null when `ref` is not one. A null schema is the table with
 * no schema, as Metabase imports the reference.
 */
export function tableOfRef(ref: unknown): TableKey | null {
  return Array.isArray(ref) && typeof ref[2] === "string"
    ? {
        database: stringOrNull(ref[0]),
        schema: stringOrNull(ref[1]),
        name: ref[2],
        nullSchema: "none",
      }
    : null;
}

/** A column of a table. */
export type ColumnKey = { table: TableKey; column: string };

/**
 * The column a `[database, schema, table, field, ...]` field reference names
 * (its first part, for a JSON-unfolded field), or null when `ref` is not one.
 */
export function columnOfRef(ref: unknown): ColumnKey | null {
  const table = tableOfRef(ref);
  return table !== null && Array.isArray(ref) && typeof ref[3] === "string"
    ? { table, column: ref[3] }
    : null;
}

/** The table as messages name it: `schema.name`, or `name` without a schema. */
export function tableLabel(table: TableName): string {
  return table.schema === null ? table.name : `${table.schema}.${table.name}`;
}
