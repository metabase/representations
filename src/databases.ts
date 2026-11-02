/**
 * A database's engine, Metabase's driver name, such as `postgres` or
 * `bigquery-cloud-sdk`, from the settings file. Null when the settings file
 * does not name it.
 */
export type EngineOf = (database: string | null) => string | null;

/** The engine of each database, as `settings` gives it by database name. */
export function createEngineOf(
  settings: Readonly<Record<string, string>>,
): EngineOf {
  const engines = new Map<string, string>(Object.entries(settings));
  return (database) =>
    database === null ? null : (engines.get(database) ?? null);
}
