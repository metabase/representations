import { type Doc, validDocsOf } from "./documents.js";

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
  const fromFiles = new Set<string>();
  for (const { body } of validDocsOf(docs, "Database")) {
    if (!fromFiles.has(body.name)) {
      fromFiles.add(body.name);
      if (body.engine !== undefined) {
        engines.set(body.name, body.engine);
      }
    }
  }
  return (database) =>
    database === null ? null : (engines.get(database) ?? null);
}
