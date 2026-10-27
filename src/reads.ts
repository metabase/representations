import { type Doc, sourceTypeOf } from "./documents.js";
import { createSourceFinder, type NativeSql } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { expandSnippets } from "./snippets.js";
import { type SqlTable, tablesReadBySql } from "./sql-tables.js";
import type { TableKey } from "./tables.js";
import { stringOrNull } from "./values.js";

/** The tables a document reads, in order, or why they could not be found. */
export type Reads =
  | { status: "read"; tables: TableKey[] }
  | { status: "unread"; reason: string };

/** A transform document with the table it writes and the tables it reads. */
export type Transform = {
  doc: Doc;
  target: TableKey | null;
  reads: Reads;
};

const SNIPPET_MODEL = "NativeQuerySnippet";

/**
 * The tables of native queries, in order, after pasting their snippets in;
 * unread at the first query with a missing snippet or SQL the scan cannot read.
 */
function nativeReads(
  natives: readonly NativeSql[],
  snippets: ReadonlyMap<string, string>,
): Reads {
  const tables: TableKey[] = [];
  for (const native of natives) {
    const sql = expandSnippets(native.sql, snippets);
    if (sql === null) {
      return {
        status: "unread",
        reason: "a snippet it uses is not in the folder",
      };
    }
    const result = tablesReadBySql(sql);
    if (result.status === "unread") {
      return result;
    }
    tables.push(
      ...result.tables.map((t: SqlTable) => ({
        database: native.database,
        ...t,
      })),
    );
  }
  return { status: "read", tables };
}

function pythonReads(body: Record<string, any>): Reads {
  const database = stringOrNull(body.source_database_id);
  const tables: TableKey[] = (body.source["source-tables"] ?? []).map(
    (t: Record<string, any>) =>
      Array.isArray(t.table_id)
        ? {
            database: t.table_id[0],
            schema: t.table_id[1],
            name: t.table_id[2],
          }
        : {
            database: stringOrNull(t.database_id) ?? database,
            schema: stringOrNull(t.schema),
            name: String(t.table),
          },
  );
  return { status: "read", tables };
}

/**
 * Returns a function giving the tables an entity reads: those its schema
 * types as tables, those its native SQL names, and the tables of each card,
 * metric, measure or segment it uses, followed to their own files.
 */
export function createReader(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
) {
  const findSources = createSourceFinder(loadSchemas());
  const snippets = new Map(
    docs
      .filter((d) => d.model === SNIPPET_MODEL)
      .map((d) => [String(d.body.name), String(d.body.content)]),
  );
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
    if (sourceTypeOf(doc) === "python") {
      return pythonReads(doc.body);
    }
    const sources = findSources(doc.body, doc.model ?? "");
    const tables: TableKey[] = [...sources.tables];
    const native = nativeReads(sources.natives, snippets);
    if (native.status === "unread") {
      return native;
    }
    tables.push(...native.tables);
    const inner = new Set([...visiting, doc]);
    for (const id of sources.entities) {
      const source = byEntityId.get(id)?.[0];
      if (source === undefined) {
        return {
          status: "unread",
          reason: `source ${id} is not in the folder`,
        };
      }
      if (source.model === SNIPPET_MODEL) {
        continue;
      }
      const reads = readsOf(source, inner);
      if (reads.status === "unread") {
        return {
          status: "unread",
          reason: `through ${source.file}: ${reads.reason}`,
        };
      }
      tables.push(...reads.tables);
    }
    const reads: Reads = { status: "read", tables };
    memo.set(doc, reads);
    return reads;
  };

  return (doc: Doc) => readsOf(doc, new Set());
}

/**
 * The transform in `doc`. Its target is in the transform's source database
 * unless the target names one, and null when the target has no string name.
 */
export function transformOf(doc: Doc, readsOf: (doc: Doc) => Reads): Transform {
  const database = stringOrNull(doc.body.source_database_id);
  const target = doc.body.target;
  return {
    doc,
    target:
      typeof target?.name === "string"
        ? {
            database: stringOrNull(target.database) ?? database,
            schema: stringOrNull(target.schema),
            name: target.name,
          }
        : null,
    reads: readsOf(doc),
  };
}
