import { stringOrNull, uniqueBy } from "./values.js";

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

/**
 * A table in a database; `database` is null when the document does not say
 * which. `caseMatters` is true for a name Metabase looks up exactly: an MBQL
 * or Python source reference, a table file, a transform target. It is false
 * for a name read from SQL, or a transform test's input, which Metabase's
 * transform-test validator compares ignoring case.
 */
export type TableKey = TableName & {
  database: string | null;
  nullSchema: NullSchema;
  caseMatters: boolean;
};

/**
 * The schema an unqualified table name resolves to in each database, by its
 * name: a string, or null when the database has none.
 */
export type DefaultSchemaOf = (database: string | null) => string | null;

/**
 * An identifier as Metabase's transform-test validator compares it, and as a
 * warehouse reads it unquoted on most engines: in lower case. Null stays null.
 */
export function fold(identifier: string): string;
export function fold(identifier: string | null): string | null;
export function fold(identifier: string | null): string | null {
  return identifier === null ? null : identifier.toLowerCase();
}

/**
 * Whether two table names can denote the same table. Schema and name compare
 * exactly when the case of both keys matters (`caseMatters`), as Metabase's
 * import looks them up, and else ignoring case (`fold`):
 *
 * - names must be equal;
 * - databases must be equal, exactly, when both are known; a missing one
 *   matches any;
 * - schemas must be equal once each is resolved: an unqualified name
 *   (`nullSchema` `"default"`) to the default schema of the names' database
 *   (`defaultSchemaOf`), and a name with no schema (`"none"`) to none.
 */
export function sameTable(
  a: TableKey,
  b: TableKey,
  defaultSchemaOf: DefaultSchemaOf,
): boolean {
  const compared =
    a.caseMatters && b.caseMatters
      ? (identifier: string | null) => identifier
      : fold;
  if (compared(a.name) !== compared(b.name)) {
    return false;
  }
  if (a.database !== null && b.database !== null && a.database !== b.database) {
    return false;
  }
  const schemaOf = (table: TableKey): string | null =>
    table.schema ??
    (table.nullSchema === "default"
      ? defaultSchemaOf(a.database ?? b.database)
      : null);
  return compared(schemaOf(a)) === compared(schemaOf(b));
}

/**
 * `tables` without repeats, keeping the first of each: two keys repeat when
 * their database is equal, their case matters for both or neither
 * (`caseMatters`), their schema and name are equal (ignoring case when it does
 * not matter), and, when their schema is null, so is what it means
 * (`nullSchema`).
 */
export function uniqueTables(tables: readonly TableKey[]): TableKey[] {
  return uniqueBy(tables, (t) =>
    JSON.stringify([
      t.database,
      t.caseMatters,
      ...[t.schema, t.name].map((part) => (t.caseMatters ? part : fold(part))),
      t.schema === null ? t.nullSchema : null,
    ]),
  );
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
        caseMatters: true,
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

/**
 * The table as messages name it: `schema.name`; `name` for an unqualified
 * name; `name (no schema)` for the table with no schema (`nullSchema`
 * `"none"`). A name without `nullSchema` is as written, so unqualified.
 */
export function tableLabel(
  table: TableName & Partial<Pick<TableKey, "nullSchema">>,
): string {
  if (table.schema !== null) {
    return `${table.schema}.${table.name}`;
  }
  return table.nullSchema === "none" ? `${table.name} (no schema)` : table.name;
}
