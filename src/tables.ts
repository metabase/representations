import type { TableName } from "./input-match.js";

export type TableKey = {
  database: string | null;
  schema: string | null;
  name: string;
};

/** `value` in upper case; null stays null. */
export function upper(value: string | null): string | null {
  return value === null ? null : value.toUpperCase();
}

/**
 * Whether two table names can denote the same table: parts compare in upper
 * case, and a missing schema or database matches any.
 */
export function sameTable(a: TableKey, b: TableKey): boolean {
  const part = (x: string | null, y: string | null) =>
    x === null || y === null || upper(x) === upper(y);
  return (
    upper(a.name) === upper(b.name) &&
    part(a.schema, b.schema) &&
    part(a.database, b.database)
  );
}

/** The table as messages name it: `schema.name`, or `name` without a schema. */
export function tableLabel(table: TableName): string {
  return table.schema === null ? table.name : `${table.schema}.${table.name}`;
}
