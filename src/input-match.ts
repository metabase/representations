export type TableName = {
  schema: string | null;
  name: string;
};

/**
 * `"undecided"` when the answer depends on a default schema the caller does
 * not know.
 */
export type Match = "match" | "no-match" | "undecided";

/**
 * The schema an unqualified table name resolves to in a database: a string, or
 * null when the database has none. `undefined` means unknown.
 */
export type DefaultSchema = string | null | undefined;

const fold = (identifier: string | null): string | null =>
  identifier === null ? null : identifier.toLowerCase();

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
 * The names a query can use for a table, as Metabase rewrites them: qualified
 * when it has a schema, and unqualified when it has none or sits in the default
 * schema. Folded to lower case. With an unknown default schema, a qualified
 * table gets no unqualified name.
 */
export function tableKeys(
  table: TableName,
  defaultSchema: DefaultSchema,
): string[] {
  const name = table.name.toLowerCase();
  const keys: string[] = [];
  if (table.schema !== null) {
    keys.push(`${table.schema.toLowerCase()}.${name}`);
  }
  if (
    table.schema === null ||
    (defaultSchema !== undefined && fold(table.schema) === fold(defaultSchema))
  ) {
    keys.push(name);
  }
  return keys;
}
