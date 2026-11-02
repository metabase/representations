import {
  asValid,
  type Doc,
  isPythonSource,
  targetDatabaseOf,
} from "./documents.js";
import type { SourceFinder } from "./query-sources.js";
import { isRecord, stringOrNull } from "./values.js";

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

/** The database a Card's query runs on, or null when it names none. */
function cardDatabaseOf(card: Doc): string | null {
  const query = card.body.dataset_query;
  return isRecord(query) ? stringOrNull(query.database) : null;
}

/**
 * The databases `doc` writes to or reads, each once: a schema-valid
 * transform's target database (`targetDatabaseOf`) and its Python source
 * tables' databases, a Card's query's database, and the databases of the
 * tables and native queries any document names.
 */
export function databasesOf(doc: Doc, findSources: SourceFinder): string[] {
  const named: (string | null)[] = [];
  const transform = asValid(doc, "Transform");
  if (transform !== null) {
    named.push(targetDatabaseOf(transform));
    const { source } = transform.body;
    if (isPythonSource(source)) {
      for (const table of source["source-tables"]) {
        named.push(table.table_id?.[0] ?? table.database_id);
      }
    }
  } else if (doc.model === "Card") {
    named.push(cardDatabaseOf(doc));
  }
  const sources = findSources(doc.body, doc.model);
  named.push(
    ...sources.tables.map((t) => t.database),
    ...sources.tagTables.map((t) => t.table.database),
    ...sources.natives.map((n) => n.database),
  );
  return [...new Set(named.filter((d) => d !== null))];
}
