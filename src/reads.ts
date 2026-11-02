import {
  asValid,
  type Doc,
  isPythonSource,
  lookUpEntity,
  isQueryTransformDoc,
  type PythonSource,
  type QueryTransformDoc,
  targetDatabaseOf,
  type ValidDoc,
} from "./documents.js";
import type { NativeSql, SourceFinder } from "./query-sources.js";
import {
  type ExpandedSql,
  expandSnippets,
  type SnippetLookup,
} from "./snippets.js";
import { keptTagNames, type SqlTableReader } from "./sql-tables.js";
import { uniqueBy } from "./values.js";
import {
  exactTable,
  sqlTable,
  type TableKey,
  targetTable,
  uniqueTables,
} from "./tables.js";

/**
 * The tables a document reads, in order and each once, or why they could not
 * be found.
 */
type Reads =
  | { status: "read"; tables: TableKey[] }
  | { status: "unread"; reason: string };

/** The tables a document reads. */
export type ReadsOf = (doc: Doc) => Reads;

/**
 * A transform document with the table it writes and the tables it reads. Its
 * target is null when the transform names no target database.
 */
export type Transform = {
  doc: ValidDoc<"Transform">;
  target: TableKey | null;
  reads: Reads;
};

/** A transform whose source is a query; its query's database holds its target. */
export type QueryTransform = Transform & {
  doc: QueryTransformDoc;
  target: TableKey;
};

/** Whether `transform`'s source is a query. */
export function isQueryTransform(
  transform: Transform,
): transform is QueryTransform {
  return isQueryTransformDoc(transform.doc) && transform.target !== null;
}

const SNIPPET_MODEL = "NativeQuerySnippet";

/**
 * The snippet a query uses by `name`, by `id`, its template tag's
 * `snippet-id`.
 */
export type FindSnippet = (name: string, id: string) => SnippetLookup;

/**
 * The SQL of a native query with its snippets pasted in (`expandSnippets`).
 * Metabase pastes a snippet by its template tag alone, so one that no tag
 * defines stays as written, a parameter with no value. In a stage with no
 * template tags, Metabase substitutes nothing and runs the SQL as written:
 * snippet references, template tags and optional clauses stay in it.
 */
export function expandNative(
  native: NativeSql,
  findSnippet: FindSnippet,
): ExpandedSql {
  if (!native.hasTemplateTags) {
    return { status: "expanded", sql: native.sql };
  }
  return expandSnippets(native.sql, (name) => {
    const id = native.snippetIds.get(name);
    return id === undefined ? null : findSnippet(name, id);
  });
}

/**
 * The template tags Metabase gives a value when it compiles `native` with no
 * parameters (`NativeSql.valuedTags`), as `SqlTableReader` takes them;
 * undefined for a stage with no template tags, whose SQL Metabase runs as
 * written.
 */
export function compiledTags(
  native: NativeSql,
): ReadonlySet<string> | undefined {
  return native.hasTemplateTags ? native.valuedTags : undefined;
}

/**
 * The tables of native queries, in order, after pasting their snippets in,
 * with the table of each `table` template tag the SQL reads as a table,
 * with or without a schema (`SqlTables.tags`), and the entity id of the card
 * of each `card` template tag the SQL keeps (`keptTagNames`); unread at
 * the first query with a snippet that cannot be pasted or SQL `readSql`
 * cannot read.
 */
function nativeReads(
  natives: readonly NativeSql[],
  findSnippet: FindSnippet,
  readSql: SqlTableReader,
): Reads | { status: "read"; tables: TableKey[]; cards: string[] } {
  const tables: TableKey[] = [];
  const cards: string[] = [];
  for (const native of natives) {
    const expanded = expandNative(native, findSnippet);
    if (expanded.status === "unread") {
      return expanded;
    }
    const result = readSql(expanded.sql, native.database, compiledTags(native));
    if (result.status === "unread") {
      return result;
    }
    const valuedTags = compiledTags(native);
    for (const tag of valuedTags === undefined
      ? []
      : keptTagNames(expanded.sql, valuedTags)) {
      const card = native.cardTags.get(tag);
      if (card !== undefined) {
        cards.push(card);
      }
    }
    // Metabase writes a `table` tag as its table's qualified name, also
    // after a schema in the SQL, so `schema.{{tag}}` names no other table.
    const tableTagNames = new Set(
      [...native.tableTags.keys()].map((tag) => `{{${tag}}}`),
    );
    tables.push(
      ...result.tables
        .filter((t) => !(t.schema !== null && tableTagNames.has(t.name)))
        .map((t) => sqlTable(native.database, t)),
    );
    for (const tag of result.tags ?? []) {
      const table = native.tableTags.get(tag);
      if (table !== undefined) {
        tables.push(table);
      }
    }
  }
  return { status: "read", tables, cards };
}

/**
 * The tables a Python transform's source tables name. Metabase looks each up
 * by its database, schema and name as given, so a null schema is the table
 * with no schema.
 */
function pythonReads(source: PythonSource): Reads {
  const tables: TableKey[] = [];
  for (const t of source["source-tables"]) {
    if (t.table_id !== undefined && t.table_id !== null) {
      const [database, schema, name] = t.table_id;
      tables.push(exactTable(database, { schema, name }));
    } else if (t.table !== undefined) {
      tables.push(
        exactTable(t.database_id, { schema: t.schema ?? null, name: t.table }),
      );
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
 * Returns the lookup of the snippets a query uses: the snippet file holding
 * the id among the documents of `byEntityId` (`lookUpEntity`). Says why a snippet cannot be pasted:
 * absent, failing its schema, or of another model.
 */
export function createSnippetFinder(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
): FindSnippet {
  return (name, id) => {
    const found = lookUpEntity(byEntityId, id, SNIPPET_MODEL);
    if (found.status === "missing") {
      return { unusable: `snippet ${name} (${id}) is not in the folder` };
    }
    if (found.status === "other-model") {
      return {
        unusable: `snippet ${name} (${id}) names a ${found.doc.model}, not a snippet`,
      };
    }
    const valid = asValid(found.doc, SNIPPET_MODEL);
    return valid === null
      ? {
          unusable: `snippet ${name} is in ${found.doc.file}, which fails its schema`,
        }
      : { content: valid.body.content };
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
  findSources: SourceFinder,
  readSql: SqlTableReader,
): ReadsOf {
  const findSnippet = createSnippetFinder(byEntityId);
  const memo = new Map<Doc, Reads>();

  const readsOf = (doc: Doc, visiting: Set<Doc>): Reads => {
    const known = memo.get(doc);
    if (known !== undefined) {
      return known;
    }
    const source = asValid(doc, "Transform")?.body.source;
    if (source !== undefined && isPythonSource(source)) {
      return pythonReads(source);
    }
    const sources = findSources(doc.body, doc.model);
    const tables: TableKey[] = [...sources.tables];
    const native = nativeReads(sources.natives, findSnippet, readSql);
    if (native.status === "unread") {
      return native;
    }
    tables.push(...native.tables);
    const inner = new Set([...visiting, doc]);
    const cardTags =
      "cards" in native
        ? native.cards.map((id) => ({ id, model: "Card" }))
        : [];
    for (const { id, model } of uniqueBy(
      [...sources.entities, ...cardTags],
      (e) => `${e.model} ${e.id}`,
    )) {
      // A snippet's SQL is pasted into the native query that uses it.
      if (model === SNIPPET_MODEL) {
        continue;
      }
      const found = lookUpEntity(byEntityId, id, model);
      if (found.status !== "found") {
        return {
          status: "unread",
          reason:
            found.status === "missing"
              ? `source ${model} ${id} is not in the folder`
              : `source ${model} ${id} names a ${found.doc.model}, not a ${model}`,
        };
      }
      const sourceDoc = found.doc;
      // Checked before the recursive call: there, the reason would gain a
      // "through" for a file the chain already names.
      if (inner.has(sourceDoc)) {
        return {
          status: "unread",
          reason: `${sourceDoc.file} uses itself as a source`,
        };
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
 * The transform in `doc`. Its target is in the database `targetDatabaseOf`
 * finds, and null when that finds none.
 */
export function transformOf(
  doc: ValidDoc<"Transform">,
  readsOf: ReadsOf,
): Transform {
  const { target } = doc.body;
  const database = targetDatabaseOf(doc);
  return {
    doc,
    target:
      database === null
        ? null
        : targetTable(database, {
            schema: target.schema ?? null,
            name: target.name,
          }),
    reads: readsOf(doc),
  };
}
