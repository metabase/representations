import { fold, type TableName } from "./tables.js";

/**
 * Whether a test input stands in for a table the transform reads, by Metabase's
 * rule (`validator.clj` `table-match?`): names equal, ignoring case, and either
 * schemas equal, ignoring case, or the read with no schema and the input in
 * the default schema. An unqualified input never covers a qualified read. A
 * read with no schema by an MBQL reference counts as one with no schema in
 * SQL: Metabase compiles the reference to an unqualified name.
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
