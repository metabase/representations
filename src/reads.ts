import {
  asValid,
  type Doc,
  holderOf,
  isPythonSource,
  type PythonSource,
  targetDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import { createSourceFinder, type NativeSql } from "./query-sources.js";
import type { Schemas } from "./schemas.js";
import {
  type ExpandedSql,
  expandSnippets,
  type SnippetLookup,
} from "./snippets.js";
import type { SqlTableReader } from "./sql-tables.js";
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
 * The snippet a query uses by `name`: by `id`, its template tag's
 * `snippet-id`, when the tag gives one, and else by its name.
 */
export type FindSnippet = (
  name: string,
  id: string | undefined,
) => SnippetLookup;

/** The SQL of a native query with its snippets pasted in (`expandSnippets`). */
export function expandNative(
  native: NativeSql,
  findSnippet: FindSnippet,
): ExpandedSql {
  return expandSnippets(native.sql, (name) =>
    findSnippet(name, native.snippetIds.get(name)),
  );
}

/**
 * The tables of native queries, in order, after pasting their snippets in;
 * unread at the first query with a snippet that cannot be pasted or SQL
 * `readSql` cannot read.
 */
function nativeReads(
  natives: readonly NativeSql[],
  findSnippet: FindSnippet,
  readSql: SqlTableReader,
): Reads {
  const tables: TableKey[] = [];
  for (const native of natives) {
    const expanded = expandNative(native, findSnippet);
    if (expanded.status === "unread") {
      return expanded;
    }
    const result = readSql(expanded.sql, native.database, native.valuedTags);
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
 * Returns the lookup of the snippets a query uses among `docs`: a snippet
 * named by id is the first file holding that id (`holderOf`); one named by
 * name is the schema-valid snippet of that name. Says why a snippet cannot
 * be pasted: absent, failing its schema, or of another model.
 */
export function createSnippetFinder(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
): FindSnippet {
  const snippetByName = new Map(
    validDocsOf(docs, SNIPPET_MODEL).map((d) => [d.body.name, d.body.content]),
  );
  const invalidSnippets = docs.filter(
    (d) => d.model === SNIPPET_MODEL && asValid(d, SNIPPET_MODEL) === null,
  );
  const failsSchema = (name: string, doc: Doc) =>
    `snippet ${name} is in ${doc.file}, which fails its schema`;
  return (name, id) => {
    if (id !== undefined) {
      const doc = holderOf(byEntityId, id);
      if (doc === null) {
        return { unusable: `snippet ${name} (${id}) is not in the folder` };
      }
      const valid = asValid(doc, SNIPPET_MODEL);
      if (valid !== null) {
        return { content: valid.body.content };
      }
      return {
        unusable:
          doc.model === SNIPPET_MODEL
            ? failsSchema(name, doc)
            : `snippet ${name} (${id}) names a ${doc.model ?? "file with no model"}, not a snippet`,
      };
    }
    const content = snippetByName.get(name);
    if (content !== undefined) {
      return { content };
    }
    const invalid = invalidSnippets.find((d) => d.body.name === name);
    return {
      unusable:
        invalid === undefined
          ? `snippet ${name} is not in the folder`
          : failsSchema(name, invalid),
    };
  };
}

/**
 * Returns a function giving the tables an entity reads: those its schema
 * types as tables, those its native SQL names (`readSql`), and the tables of
 * each card, metric, measure or segment it uses, followed to their own files.
 */
export function createReader(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  schemas: Schemas,
  readSql: SqlTableReader,
): ReadsOf {
  const findSources = createSourceFinder(schemas);
  const findSnippet = createSnippetFinder(docs, byEntityId);
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
    const native = nativeReads(sources.natives, findSnippet, readSql);
    if (native.status === "unread") {
      return native;
    }
    tables.push(...native.tables);
    const inner = new Set([...visiting, doc]);
    for (const id of sources.entities) {
      const sourceDoc = holderOf(byEntityId, id);
      if (sourceDoc === null) {
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
  const { target } = doc.body;
  return {
    doc,
    target: {
      database: targetDatabaseOf(doc),
      schema: target.schema ?? null,
      name: target.name,
    },
    reads: readsOf(doc),
  };
}
