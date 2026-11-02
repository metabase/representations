import {
  asValid,
  type Doc,
  isPythonSource,
  targetDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import { engineFacts } from "./engines.js";
import type { SourceFinder } from "./query-sources.js";
import { isRecord, stringOrNull, uniqueBy } from "./values.js";

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
  return uniqueBy(validDocsOf(docs, "Database"), ({ body }) => body.name);
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
    ...sources.fieldFilterTables.map((t) => t.database),
    ...sources.natives.map((n) => n.database),
  );
  return [...new Set(named.filter((d) => d !== null))];
}
