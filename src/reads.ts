import {
  asValid,
  type Doc,
  isPythonSource,
  type PythonSource,
  type ValidDoc,
} from "./documents.js";
import { createSourceFinder, type NativeSql } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { expandSnippets } from "./snippets.js";
import { tablesReadBySql } from "./sql-tables.js";
import { type TableKey, uniqueTables } from "./tables.js";

/**
 * The tables a document reads, in order and each once, or why they could not
 * be found.
 */
export type Reads =
  | { status: "read"; tables: TableKey[] }
  | { status: "unread"; reason: string };

/** The tables a document reads. */
export type ReadsOf = (doc: Doc) => Reads;

/** A transform document with the table it writes and the tables it reads. */
export type Transform = {
  doc: ValidDoc<"Transform">;
  target: TableKey;
  reads: Reads;
};

const SNIPPET_MODEL = "NativeQuerySnippet";

/**
 * The tables of native queries, in order, after pasting their snippets in;
 * unread at the first query with a missing snippet or SQL the scan cannot read.
 * A snippet a query's template tag names is found by its entity id, and any
 * other by its name.
 */
function nativeReads(
  natives: readonly NativeSql[],
  snippetById: (id: string) => string | undefined,
  snippetByName: ReadonlyMap<string, string>,
): Reads {
  const tables: TableKey[] = [];
  for (const native of natives) {
    const sql = expandSnippets(native.sql, (name) => {
      const id = native.snippetIds.get(name);
      return id === undefined ? snippetByName.get(name) : snippetById(id);
    });
    if (sql === null) {
      return {
        status: "unread",
        reason: "a snippet it uses is not in the folder",
      };
    }
    const result = tablesReadBySql(sql, native.valuedTags);
    if (result.status === "unread") {
      return result;
    }
    tables.push(
      ...result.tables.map((t) => ({
        database: native.database,
        ...t,
      })),
    );
  }
  return { status: "read", tables };
}

function pythonReads(source: PythonSource): Reads {
  const tables: TableKey[] = [];
  for (const t of source["source-tables"]) {
    if (t.table_id !== undefined) {
      const [database, schema, name] = t.table_id;
      tables.push({ database, schema, name });
    } else if (t.table !== undefined) {
      tables.push({
        database: t.database_id,
        schema: t.schema ?? null,
        name: t.table,
      });
    } else {
      // The schema requires neither `table` nor `table_id`.
      return {
        status: "unread",
        reason: `source table ${t.alias} names no table`,
      };
    }
  }
  return { status: "read", tables: uniqueTables(tables) };
}

/**
 * Returns a function giving the tables an entity reads: those its schema
 * types as tables, those its native SQL names, and the tables of each card,
 * metric, measure or segment it uses, followed to their own files.
 */
export function createReader(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
): ReadsOf {
  const findSources = createSourceFinder(loadSchemas());
  const snippetDocs = docs.filter((d) => d.model === SNIPPET_MODEL);
  const snippetByName = new Map(
    snippetDocs.map((d) => [String(d.body.name), String(d.body.content)]),
  );
  const snippetById = (id: string) => {
    const doc = byEntityId.get(id)?.find((d) => d.model === SNIPPET_MODEL);
    return doc === undefined ? undefined : String(doc.body.content);
  };
  const memo = new Map<Doc, Reads>();

  const readsOf = (doc: Doc, visiting: Set<Doc>): Reads => {
    const known = memo.get(doc);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(doc)) {
      return {
        status: "unread",
        reason: `${doc.file} uses itself as a source`,
      };
    }
    const source = asValid(doc, "Transform")?.body.source;
    if (source !== undefined && isPythonSource(source)) {
      return pythonReads(source);
    }
    const sources = findSources(doc.body, doc.model ?? "");
    const tables: TableKey[] = [...sources.tables];
    const native = nativeReads(sources.natives, snippetById, snippetByName);
    if (native.status === "unread") {
      return native;
    }
    tables.push(...native.tables);
    const inner = new Set([...visiting, doc]);
    for (const id of sources.entities) {
      const sourceDoc = byEntityId.get(id)?.[0];
      if (sourceDoc === undefined) {
        return {
          status: "unread",
          reason: `source ${id} is not in the folder`,
        };
      }
      if (sourceDoc.model === SNIPPET_MODEL) {
        continue;
      }
      const sourceReads = readsOf(sourceDoc, inner);
      if (sourceReads.status === "unread") {
        return {
          status: "unread",
          reason: `through ${sourceDoc.file}: ${sourceReads.reason}`,
        };
      }
      tables.push(...sourceReads.tables);
    }
    const reads: Reads = { status: "read", tables: uniqueTables(tables) };
    memo.set(doc, reads);
    return reads;
  };

  return (doc: Doc) => readsOf(doc, new Set());
}

/**
 * The transform in `doc`. Its target is in the transform's source database
 * unless the target names one.
 */
export function transformOf(
  doc: ValidDoc<"Transform">,
  readsOf: ReadsOf,
): Transform {
  const { target, source_database_id } = doc.body;
  return {
    doc,
    target: {
      database: target.database ?? source_database_id,
      schema: target.schema ?? null,
      name: target.name,
    },
    reads: readsOf(doc),
  };
}
