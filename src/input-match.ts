import { fold, type TableKey, type TableName } from "./tables.js";

/**
 * Whether a test input stands in for a table the transform reads, by Metabase's
 * rule: names equal, ignoring case, and either schemas equal, ignoring case, or
 * the read unqualified and the input in the default schema. An unqualified
 * input never covers a qualified read. A read with no schema by an MBQL
 * reference (`nullSchema` `"none"`) is not unqualified: no input in the default
 * schema covers it.
 */
export function inputCovers(
  read: Omit<TableKey, "database">,
  input: TableName,
  defaultSchema: string | null,
): boolean {
  if (fold(read.name) !== fold(input.name)) {
    return false;
  }
  if (fold(read.schema) === fold(input.schema)) {
    return true;
  }
  return (
    read.schema === null &&
    read.nullSchema === "default" &&
    fold(input.schema) === fold(defaultSchema)
  );
}

/**
 * Whether Metabase rewrites `read`, a table an expectation's SQL names, to the
 * stand-in for `table`, an input or the transform's target. A read is
 * rewritten by the key of its own schema and name, or else by `table`'s
 * unqualified key, which `table` has when it is unqualified or in the default
 * schema. So, unlike `inputCovers`, a qualified read is rewritten to an
 * unqualified table of its name.
 */
export function rewriteCovers(
  read: TableName,
  table: TableName,
  defaultSchema: string | null,
): boolean {
  if (fold(read.name) !== fold(table.name)) {
    return false;
  }
  return (
    fold(read.schema) === fold(table.schema) ||
    table.schema === null ||
    fold(table.schema) === fold(defaultSchema)
  );
}
