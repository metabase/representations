import { fold, type TableName } from "./tables.js";

/**
 * Whether a test input stands in for a table the transform reads, by Metabase's
 * rule: names equal, ignoring case, and either schemas equal, ignoring case, or
 * the read unqualified and the input in the default schema. An unqualified
 * input never covers a qualified read.
 */
export function inputCovers(
  read: TableName,
  input: TableName,
  defaultSchema: string | null,
): boolean {
  if (fold(read.name) !== fold(input.name)) {
    return false;
  }
  if (fold(read.schema) === fold(input.schema)) {
    return true;
  }
  return read.schema === null && fold(input.schema) === fold(defaultSchema);
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

/**
 * Whether a query could not tell two test inputs apart, by Metabase's rule:
 * names equal, ignoring case, and either schemas equal, ignoring case, or one
 * unqualified and the other in the default schema.
 */
export function inputsCollide(
  a: TableName,
  b: TableName,
  defaultSchema: string | null,
): boolean {
  if (fold(a.name) !== fold(b.name)) {
    return false;
  }
  if (fold(a.schema) === fold(b.schema)) {
    return true;
  }
  if (a.schema !== null && b.schema !== null) {
    return false;
  }
  return fold(a.schema ?? b.schema) === fold(defaultSchema);
}
