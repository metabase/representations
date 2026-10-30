import type { EngineOf } from "./databases.js";
import { engineFacts } from "./engines.js";
import { CONFIG_FILE, LintSetupError } from "./settings.js";
import { type DefaultSchemaOf, fold, type TableKey } from "./tables.js";

/**
 * The schema an unqualified table name resolves to, by database name, as
 * Metabase's driver reports it; null for a database with no schemas.
 */
export type DefaultSchemas = Readonly<Record<string, string | null>>;

/** A table's name, and what a null schema in it means. */
type SchemaName = Pick<TableKey, "schema" | "name" | "nullSchema">;

/** A database whose default schema the lint needs, and why. */
export type DefaultSchemaWanted = { database: string; reason: string };

/** The lint needs default schemas that neither the settings nor the engine give. */
export class MissingDefaultSchemasError extends LintSetupError {
  override name = "MissingDefaultSchemasError";
  readonly databases: readonly DefaultSchemaWanted[];

  constructor(databases: readonly DefaultSchemaWanted[]) {
    super(
      [
        `The default schema of ${databases.length} database(s) is unknown: the schema an unqualified table name resolves to.`,
        `Give it in ${CONFIG_FILE} at the root of the folder, as {"defaultSchemas": {"<database>": "<schema>"}} (null for a database with no schemas), or with --default-schema "<database>=<schema>".`,
        ...databases.map(({ database, reason }) => `  ${database}: ${reason}`),
      ].join("\n"),
    );
    this.databases = databases;
  }
}

/**
 * Why a database whose tables the lint names by `names` needs its default
 * schema: an unqualified name, or one table name in two schemas among the
 * tables of one transform test in `testTables`, which the test's rewrite
 * compares by the default schema. Null when no comparison of these names
 * depends on the default schema. A name with no schema by an MBQL reference
 * (`nullSchema` `"none"`) never does.
 */
export function defaultSchemaNeed(
  names: readonly SchemaName[],
  testTables: readonly (readonly SchemaName[])[],
): string | null {
  const unqualified = names.find(
    (n) => n.schema === null && n.nullSchema === "default",
  );
  if (unqualified !== undefined) {
    return `names ${unqualified.name} without a schema`;
  }
  for (const tables of testTables) {
    const qualified = tables.filter((n) => n.schema !== null);
    for (const a of qualified) {
      const b = qualified.find(
        (n) =>
          fold(n.name) === fold(a.name) && fold(n.schema) !== fold(a.schema),
      );
      if (b !== undefined) {
        return `names ${a.name} in schemas ${a.schema} and ${b.schema}`;
      }
    }
  }
  return null;
}

/** `tables` by database, skipping a table with no database. */
function byDatabase(
  tables: readonly TableKey[],
): Map<string, Omit<TableKey, "database">[]> {
  const grouped = new Map<string, Omit<TableKey, "database">[]>();
  for (const { database, ...name } of tables) {
    if (database !== null) {
      grouped.set(database, [...(grouped.get(database) ?? []), name]);
    }
  }
  return grouped;
}

/**
 * The default schema of each database, from `given`, or else from its engine
 * for an engine whose default Metabase fixes. Throws a
 * `MissingDefaultSchemasError` naming each database that needs a default
 * schema (`defaultSchemaNeed` of the `names` and `testTables` in it) and has
 * none. Any other database, and a name with no database, gets null: by
 * `defaultSchemaNeed`, no comparison of its names depends on the value.
 */
export function resolveDefaultSchemas({
  names,
  testTables,
  given,
  engineOf,
}: {
  names: readonly TableKey[];
  /** For each transform test, the tables its rewrite compares. */
  testTables: readonly (readonly TableKey[])[];
  given: DefaultSchemas;
  engineOf: EngineOf;
}): DefaultSchemaOf {
  const known = (database: string): string | null | undefined => {
    if (Object.hasOwn(given, database)) {
      return given[database];
    }
    return engineFacts(engineOf(database))?.nullDefaultSchema === true
      ? null
      : undefined;
  };
  const testsByDatabase = testTables.map(byDatabase);
  const wanted = [...byDatabase(names)].flatMap(([database, inDatabase]) => {
    const reason =
      known(database) === undefined
        ? defaultSchemaNeed(
            inDatabase,
            testsByDatabase.flatMap((test) => {
              const inTest = test.get(database);
              return inTest === undefined ? [] : [inTest];
            }),
          )
        : null;
    return reason === null ? [] : [{ database, reason }];
  });
  if (wanted.length > 0) {
    throw new MissingDefaultSchemasError(
      wanted.sort((a, b) =>
        a.database < b.database ? -1 : a.database > b.database ? 1 : 0,
      ),
    );
  }
  return (database) => (database === null ? null : (known(database) ?? null));
}
