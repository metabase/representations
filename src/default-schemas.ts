import type { EngineOf } from "./databases.js";
import { engineFacts } from "./engines.js";
import { type DefaultSchemaOf, fold, type TableKey } from "./tables.js";

/**
 * The schema an unqualified table name resolves to, by database name, as
 * Metabase's driver reports it; null for a database with no schemas.
 */
export type DefaultSchemas = Readonly<Record<string, string | null>>;

/** A table's name, and what a null schema in it means. */
type SchemaName = Pick<TableKey, "schema" | "name" | "nullSchema">;

/** A table a file names. */
export type NamedTable = TableKey & { file: string };

/** The tables of one transform test, and the test's file. */
export type TestTables = { file: string; tables: readonly TableKey[] };

/**
 * A database whose default schema the lint needs and no source gives: each
 * file that needs it, sorted, and why the first needs it, as a sentence whose
 * subject is that file and which gives each table and schema name as a JSON
 * string.
 */
export type UnknownDefaultSchema = {
  database: string;
  files: string[];
  reason: string;
};

/**
 * Each file whose comparisons of `names` depend on its database's default
 * schema, once, with why: an unqualified name; or, among the tables of one
 * transform test in `testTables`, one table name in two schemas, or a name
 * with no schema by an MBQL reference (`nullSchema` `"none"`) and the same
 * table name in a schema, which the test matches by the default schema
 * (`inputCovers`). Empty when no comparison of these names depends on the
 * default schema. Outside a test, a name with no schema by an MBQL reference
 * never does.
 */
export function defaultSchemaNeeds(
  names: readonly (SchemaName & { file: string })[],
  testTables: readonly { file: string; tables: readonly SchemaName[] }[],
): { file: string; reason: string }[] {
  const needs = new Map<string, string>();
  const need = (file: string, reason: string) => {
    if (!needs.has(file)) {
      needs.set(file, reason);
    }
  };
  for (const n of names) {
    if (n.schema === null && n.nullSchema === "default") {
      need(
        n.file,
        `names ${JSON.stringify(n.name)} without a schema, so it resolves to the default schema`,
      );
    }
  }
  for (const { file, tables } of testTables) {
    const qualified = tables.filter((n) => n.schema !== null);
    const noSchema = tables.find(
      (n) =>
        n.schema === null &&
        n.nullSchema === "none" &&
        qualified.some((q) => fold(q.name) === fold(n.name)),
    );
    if (noSchema !== undefined) {
      need(
        file,
        `names ${JSON.stringify(noSchema.name)} with no schema and in a schema in one transform test, which only the default schema matches`,
      );
    }
    for (const a of qualified) {
      const b = qualified.find(
        (n) =>
          fold(n.name) === fold(a.name) && fold(n.schema) !== fold(a.schema),
      );
      if (b !== undefined) {
        need(
          file,
          `names ${JSON.stringify(a.name)} in schemas ${JSON.stringify(a.schema)} and ${JSON.stringify(b.schema)} in one transform test, which only the default schema tells apart`,
        );
      }
    }
  }
  return [...needs].map(([file, reason]) => ({ file, reason }));
}

/** `tables` by database, skipping a table with no database. */
function byDatabase<T extends { database: string | null }>(
  tables: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const table of tables) {
    if (table.database !== null) {
      grouped.set(table.database, [
        ...(grouped.get(table.database) ?? []),
        table,
      ]);
    }
  }
  return grouped;
}

/**
 * The default schema of each database, from `given`, or else from its engine
 * for an engine whose default Metabase fixes; and each database that needs a
 * default schema (`defaultSchemaNeeds` of the `names` and `testTables` in
 * it) and has none, sorted by name. Such a database, any other database, and
 * a name with no database, get null: a caller skips each comparison of such
 * a database's names that depends on it (`needsDefaultSchema`).
 */
export function resolveDefaultSchemas({
  names,
  testTables,
  given,
  engineOf,
}: {
  names: readonly NamedTable[];
  /** For each transform test, its tables. */
  testTables: readonly TestTables[];
  given: DefaultSchemas;
  engineOf: EngineOf;
}): { defaultSchemaOf: DefaultSchemaOf; unknown: UnknownDefaultSchema[] } {
  const known = (database: string): string | null | undefined => {
    if (Object.hasOwn(given, database)) {
      return given[database];
    }
    return engineFacts(engineOf(database))?.nullDefaultSchema === true
      ? null
      : undefined;
  };
  const testsByDatabase = testTables.map(({ file, tables }) => ({
    file,
    byDatabase: byDatabase(tables),
  }));
  const unknown = [...byDatabase(names)].flatMap(([database, inDatabase]) => {
    if (known(database) !== undefined) {
      return [];
    }
    const needs = defaultSchemaNeeds(
      inDatabase,
      testsByDatabase.flatMap((test) => {
        const tables = test.byDatabase.get(database);
        return tables === undefined ? [] : [{ file: test.file, tables }];
      }),
    );
    needs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return needs.length === 0
      ? []
      : [
          {
            database,
            files: needs.map((n) => n.file),
            reason: needs[0].reason,
          },
        ];
  });
  return {
    defaultSchemaOf: (database) =>
      database === null ? null : (known(database) ?? null),
    unknown: unknown.sort((a, b) =>
      a.database < b.database ? -1 : a.database > b.database ? 1 : 0,
    ),
  };
}
