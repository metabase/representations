import type { EngineOf } from "./databases.js";
import { nativeQueriesAreSql } from "./engines.js";
import {
  dialectOf,
  type ParsedTables,
  type SqlParser,
  type Unread,
} from "./sql-parser.js";
import { fold, type TableName } from "./tables.js";
import { templateTagsOf } from "./values.js";

const TAG_PLACEHOLDER = "__metabase_template_tag__";

const ALWAYS_VALUED_TAG_TYPES = new Set(["card", "snippet", "table"]);

/**
 * The names of the template tags that have a value when Metabase compiles the
 * query with no parameters: card, snippet and table tags, and tags with a
 * default. A default of false counts only for a dimension or temporal-unit
 * tag, as in Metabase. Takes the native stage's `template-tags`, a list or
 * the legacy map; anything else names no tag.
 */
export function valuedTagNames(templateTags: unknown): Set<string> {
  const names = new Set<string>();
  for (const tag of templateTagsOf(templateTags)) {
    if (typeof tag.name !== "string") {
      continue;
    }
    const filter = tag.type === "dimension" || tag.type === "temporal-unit";
    if (
      (typeof tag.type === "string" && ALWAYS_VALUED_TAG_TYPES.has(tag.type)) ||
      (tag.default !== undefined &&
        tag.default !== null &&
        (filter || tag.default !== false))
    ) {
      names.add(tag.name);
    }
  }
  return names;
}

const TAG = /\{\{\s*([^}]*?)\s*\}\}/g;

/**
 * The SQL with each template tag as one word. Each optional clause `[[ … ]]`
 * keeps its text, unless `valuedTags` is given and a tag in the clause is not
 * in it: Metabase leaves such a clause out.
 */
function replaceTemplateTags(
  sql: string,
  valuedTags: ReadonlySet<string> | undefined,
): string {
  return sql
    .replace(/\[\[([\s\S]*?)\]\]/g, (_, clause: string) =>
      valuedTags === undefined ||
      [...clause.matchAll(TAG)].every(([, name]) => valuedTags.has(name))
        ? ` ${clause} `
        : " ",
    )
    .replace(TAG, ` ${TAG_PLACEHOLDER} `);
}

/** Whether `name`, a table or column SQLGlot read, is the word a template tag became. */
export function isTagPlaceholder(name: string): boolean {
  return name === TAG_PLACEHOLDER;
}

/**
 * A native query of a database whose engine is `engine`, as the lint parses
 * it: the SQLGlot dialect of the engine (`dialectOf`), and the SQL with each
 * optional clause Metabase keeps pasted in (`valuedTags`, as
 * `valuedTagNames` gives them; every clause without it) and each template
 * tag a placeholder word (`isTagPlaceholder`). Unread when the engine's
 * native queries are not SQL (`nativeQueriesAreSql`), or when a snippet is left in
 * the SQL: expand snippets first.
 */
export function prepareSql(
  sql: string,
  engine: string | null,
  valuedTags?: ReadonlySet<string>,
): { status: "prepared"; sql: string; dialect: string | null } | Unread {
  if (engine !== null && !nativeQueriesAreSql(engine)) {
    return {
      status: "unread",
      reason: `native queries on ${engine} are not SQL; the lint does not read them`,
    };
  }
  if (/\{\{\s*snippet:/i.test(sql)) {
    return { status: "unread", reason: "the query has a snippet" };
  }
  return {
    status: "prepared",
    sql: replaceTemplateTags(sql, valuedTags),
    dialect: dialectOf(engine),
  };
}

/** `tables` without repeats, keeping the first of each: two repeat when their schema and name are equal ignoring case. */
function uniqueNames(tables: readonly TableName[]): TableName[] {
  const seen = new Set<string>();
  return tables.filter(({ schema, name }) => {
    const key = JSON.stringify([fold(schema), fold(name)]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The tables native SQL reads, in the database `database`. `valuedTags` names
 * the template tags with a value, as `valuedTagNames` gives them, for a query
 * Metabase compiles; without it, the text of every optional clause is read.
 */
export type SqlTableReader = (
  sql: string,
  database: string | null,
  valuedTags?: ReadonlySet<string>,
) => ParsedTables;

/**
 * Returns a reader of the tables native SQL reads, as Metabase reads them
 * with `parser`: each table once, sorted. It parses the SQL as `prepareSql`
 * gives it for the database's engine; a placeholder read as a table reads
 * nothing, since the tag's own definition names its card or table. Refuses
 * (`unread`) what `prepareSql` refuses, and SQL SQLGlot cannot parse. Each
 * distinct SQL, in each dialect, is parsed once.
 */
export function createSqlTableReader(
  parser: SqlParser,
  engineOf: EngineOf,
): SqlTableReader {
  const parsed = new Map<string, ParsedTables>();
  const parse = (sql: string, dialect: string | null): ParsedTables => {
    const key = JSON.stringify([dialect, sql]);
    let result = parsed.get(key);
    if (result === undefined) {
      result = parser.referencedTables(sql, dialect);
      parsed.set(key, result);
    }
    return result;
  };
  return (sql, database, valuedTags) => {
    const prepared = prepareSql(sql, engineOf(database), valuedTags);
    if (prepared.status === "unread") {
      return prepared;
    }
    const result = parse(prepared.sql, prepared.dialect);
    if (result.status === "unread") {
      return {
        status: "unread",
        reason: `SQLGlot could not parse it: ${result.reason}`,
      };
    }
    return {
      status: "read",
      tables: uniqueNames(
        result.tables.filter(
          (t) => t.schema !== null || !isTagPlaceholder(t.name),
        ),
      ),
    };
  };
}
