import type { ReplacedTableKey, TableReplacement } from "./sql-parser.js";
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
  read: Pick<TableKey, "schema" | "name" | "nullSchema">,
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

const STAND_IN_PREFIX = "__lint_stand_in_";

/**
 * The ways a query can name `table`, as Metabase's `table-keys` gives them:
 * qualified, and unqualified when its schema is none or the default.
 */
function tableKeys(
  table: TableName,
  defaultSchema: string | null,
): ReplacedTableKey[] {
  return [
    ...(table.schema === null
      ? []
      : [{ schema: table.schema, table: table.name }]),
    ...(table.schema === null || fold(table.schema) === fold(defaultSchema)
      ? [{ table: table.name }]
      : []),
  ];
}

/**
 * The replacements of a transform test run, as Metabase's
 * `table-replacements` builds them: every way a query names each of
 * `tables`, to a stand-in table of its own (`isStandIn`).
 */
export function standInReplacements(
  tables: readonly TableName[],
  defaultSchema: string | null,
): TableReplacement[] {
  return tables.flatMap((table, i) =>
    tableKeys(table, defaultSchema).map(
      (key): TableReplacement => [
        key,
        { db: null, schema: null, table: `${STAND_IN_PREFIX}${i}__` },
      ],
    ),
  );
}

/** Whether `table` is one of the stand-ins of `standInReplacements`. */
export function isStandIn(table: TableName): boolean {
  return (
    table.schema === null &&
    new RegExp(`^${STAND_IN_PREFIX}[0-9]+__$`).test(table.name)
  );
}
