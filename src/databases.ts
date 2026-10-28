import { type Doc, validDocsOf, type ValidDoc } from "./documents.js";
import { engineFacts } from "./engines.js";

/**
 * A database's engine as its Database file names it, such as `postgres` or
 * `bigquery-cloud-sdk`: Metabase's driver name. Null when neither a
 * schema-valid Database file nor the settings file names it.
 */
export type EngineOf = (database: string | null) => string | null;

/**
 * The engine of each database: the one its schema-valid Database file among
 * `docs` names, or else the one `settings` gives by database name. When two
 * files name one database, the first in path order counts.
 */
export function createEngineOf(
  docs: readonly Doc[],
  settings: Readonly<Record<string, string>>,
): EngineOf {
  const engines = new Map<string, string>(Object.entries(settings));
  for (const { body } of databaseFiles(docs)) {
    if (body.engine !== undefined) {
      engines.set(body.name, body.engine);
    }
  }
  return (database) =>
    database === null ? null : (engines.get(database) ?? null);
}

/**
 * The default schema each schema-valid Database file among `docs` gives, by
 * database name: Metabase's `default_schema`, null for a database whose
 * unqualified names resolve to no schema. A file gives none when it has no
 * `default_schema`, or when it has null and `engineOf` names an engine with
 * schemas: there null can mean a connection with no current schema, or a
 * database not synced since Metabase began storing the value.
 */
export function databaseDefaultSchemas(
  docs: readonly Doc[],
  engineOf: EngineOf,
): Readonly<Record<string, string | null>> {
  return Object.fromEntries(
    databaseFiles(docs).flatMap(({ body: { name, default_schema } }) =>
      default_schema === undefined ||
      (default_schema === null && engineFacts(engineOf(name))?.schemas === true)
        ? []
        : [[name, default_schema]],
    ),
  );
}

/**
 * The schema-valid Database files among `docs`, one per database: when two
 * name one database, the first in path order.
 */
function databaseFiles(docs: readonly Doc[]): ValidDoc<"Database">[] {
  const seen = new Set<string>();
  return validDocsOf(docs, "Database").filter(({ body }) => {
    const first = !seen.has(body.name);
    seen.add(body.name);
    return first;
  });
}
