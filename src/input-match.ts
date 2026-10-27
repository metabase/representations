import { type DefaultSchema, fold, type TableName } from "./tables.js";

/**
 * `"undecided"` when the answer depends on a default schema the caller does
 * not know.
 */
export type Match = "match" | "no-match" | "undecided";

/**
 * Whether a test input stands in for a table the transform reads, by Metabase's
 * rule: names equal, ignoring case, and either schemas equal, ignoring case, or
 * the read unqualified and the input in the default schema. An unqualified
 * input never covers a qualified read.
 */
export function inputCovers(
  read: TableName,
  input: TableName,
  defaultSchema: DefaultSchema,
): Match {
  if (fold(read.name) !== fold(input.name)) {
    return "no-match";
  }
  if (fold(read.schema) === fold(input.schema)) {
    return "match";
  }
  if (read.schema !== null) {
    return "no-match";
  }
  if (defaultSchema === undefined) {
    return "undecided";
  }
  return fold(input.schema) === fold(defaultSchema) ? "match" : "no-match";
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
  defaultSchema: DefaultSchema,
): Match {
  if (fold(read.name) !== fold(table.name)) {
    return "no-match";
  }
  if (fold(read.schema) === fold(table.schema) || table.schema === null) {
    return "match";
  }
  if (defaultSchema === undefined) {
    return "undecided";
  }
  return fold(table.schema) === fold(defaultSchema) ? "match" : "no-match";
}

/**
 * Whether a query could not tell two test inputs apart, by Metabase's rule:
 * names equal, ignoring case, and either schemas equal, ignoring case, or one
 * unqualified and the other in the default schema.
 */
export function inputsCollide(
  a: TableName,
  b: TableName,
  defaultSchema: DefaultSchema,
): Match {
  if (fold(a.name) !== fold(b.name)) {
    return "no-match";
  }
  if (fold(a.schema) === fold(b.schema)) {
    return "match";
  }
  const qualified = a.schema ?? b.schema;
  if (a.schema !== null && b.schema !== null) {
    return "no-match";
  }
  if (defaultSchema === undefined) {
    return "undecided";
  }
  return fold(qualified) === fold(defaultSchema) ? "match" : "no-match";
}
