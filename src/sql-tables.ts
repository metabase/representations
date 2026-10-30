import type { EngineOf } from "./databases.js";
import { nativeQueriesAreSql } from "./engines.js";
import {
  type NativePart,
  parseNativeSql,
  snippetNameOf,
  tagNames,
} from "./native-sql.js";
import {
  cacheBySql,
  dialectOf,
  type ParsedTables,
  type SqlParser,
  type TableReplacement,
  type Unread,
} from "./sql-parser.js";
import { fold } from "./tables.js";
import { templateTagsOf, uniqueBy } from "./values.js";

const TAG_PLACEHOLDER = /^__metabase_template_tag_([0-9a-f]*)__$/i;

/** The word that stands for the template tag `{{name}}`: the name in hex, so that any name makes one identifier. */
function tagPlaceholder(name: string): string {
  return `__metabase_template_tag_${Buffer.from(name, "utf8").toString("hex")}__`;
}

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

/**
 * The SQL of `parts` with each template tag as one word. Each optional clause
 * `[[ … ]]` keeps its text, unless `valuedTags` is given and a tag in the
 * clause is not in it: Metabase leaves such a clause out.
 */
function replaceTemplateTags(
  parts: readonly NativePart[],
  valuedTags: ReadonlySet<string> | undefined,
): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "tag":
          return ` ${tagPlaceholder(part.name.trim())} `;
        case "optional":
          return valuedTags === undefined ||
            tagNames(part.parts).every((name) => valuedTags.has(name.trim()))
            ? ` ${replaceTemplateTags(part.parts, valuedTags)} `
            : " ";
      }
    })
    .join("");
}

/** Whether `name`, a table or column SQLGlot read, is the word a template tag became. */
export function isTagPlaceholder(name: string): boolean {
  return TAG_PLACEHOLDER.test(name);
}

/** The template tag a placeholder stands for, written `{{name}}`; null for any other name. */
function tagOfPlaceholder(name: string): string | null {
  const hex = TAG_PLACEHOLDER.exec(name)?.[1];
  return hex === undefined
    ? null
    : `{{${Buffer.from(hex, "hex").toString("utf8")}}}`;
}

/** Why the lint does not read a native query of `engine`. */
const notSql = (engine: string): Unread => ({
  status: "unread",
  reason: `native queries on ${engine} are not SQL; the lint does not read them`,
});

/**
 * A native query of a database whose engine is `engine`, as the lint parses
 * it: the SQLGlot dialect of the engine (`dialectOf`), and the SQL with each
 * optional clause Metabase keeps pasted in (`valuedTags`, as
 * `valuedTagNames` gives them; every clause without it) and each template
 * tag a placeholder word (`isTagPlaceholder`); tags and clauses as Metabase
 * parses them (`parseNativeSql`), so those inside a SQL comment are text.
 * Unread when the engine's native queries are not SQL (`nativeQueriesAreSql`),
 * when Metabase cannot parse the template tags, or when a snippet is left in
 * the SQL: expand snippets first.
 */
export function prepareSql(
  sql: string,
  engine: string | null,
  valuedTags?: ReadonlySet<string>,
): { status: "prepared"; sql: string; dialect: string | null } | Unread {
  if (engine !== null && !nativeQueriesAreSql(engine)) {
    return notSql(engine);
  }
  const parsed = parseNativeSql(sql);
  if (parsed.status === "unread") {
    return parsed;
  }
  if (tagNames(parsed.parts).some((name) => snippetNameOf(name) !== null)) {
    return { status: "unread", reason: "the query has a snippet" };
  }
  return {
    status: "prepared",
    sql: replaceTemplateTags(parsed.parts, valuedTags),
    dialect: dialectOf(engine),
  };
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
 * gives it for the database's engine. An unqualified placeholder read as a
 * table reads nothing, since the tag's own definition names its card or
 * table. A placeholder after a schema is a table named as the tag is
 * written, `schema.{{name}}`, which matches no input or table file. Refuses
 * (`unread`) what `prepareSql` refuses, and SQL SQLGlot cannot parse. Each
 * distinct SQL, in each dialect, is parsed once.
 */
export function createSqlTableReader(
  parser: SqlParser,
  engineOf: EngineOf,
): SqlTableReader {
  const parse = cacheBySql((sql, dialect) =>
    parser.referencedTables(sql, dialect),
  );
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
      tables: uniqueBy(
        result.tables.flatMap((t) => {
          const tag = tagOfPlaceholder(t.name);
          if (tag === null) {
            return [t];
          }
          return t.schema === null ? [] : [{ schema: t.schema, name: tag }];
        }),
        ({ schema, name }) => JSON.stringify([fold(schema), fold(name)]),
      ),
    };
  };
}

/**
 * The tables SQL reads once `replacements` replace the tables they name, in
 * the database `database`: Metabase's `replace_names`, then
 * `referenced_tables`, on the SQL as written, in the dialect of the
 * database's engine. A quoted name matches a replacement only in its own
 * case. Unread when the engine's native queries are not SQL, or SQLGlot
 * cannot parse the SQL.
 */
export type RewrittenTableReader = (
  sql: string,
  database: string | null,
  replacements: readonly TableReplacement[],
) => ParsedTables;

/** Returns a `RewrittenTableReader` that parses with `parser`. */
export function createRewrittenTableReader(
  parser: SqlParser,
  engineOf: EngineOf,
): RewrittenTableReader {
  return (sql, database, replacements) => {
    const engine = engineOf(database);
    if (engine !== null && !nativeQueriesAreSql(engine)) {
      return notSql(engine);
    }
    const dialect = dialectOf(engine);
    const replaced = parser.replaceNames(sql, replacements, dialect);
    const result =
      replaced.status === "read"
        ? parser.referencedTables(replaced.sql, dialect)
        : replaced;
    return result.status === "read"
      ? result
      : {
          status: "unread",
          reason: `SQLGlot could not parse it: ${result.reason}`,
        };
  };
}
