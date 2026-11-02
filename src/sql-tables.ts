import type { EngineOf } from "./databases.js";
import { nativeQueriesAreSql } from "./engines.js";
import { stripLargeLiteralLists } from "./literal-lists.js";
import {
  type NativePart,
  parseNativeSql,
  snippetNameOf,
} from "./native-sql.js";
import {
  cacheBySql,
  dialectOf,
  isParseError,
  isParseFailure,
  type SqlParser,
  type Unread,
} from "./sql-parser.js";
import { fold, type TableName } from "./tables.js";
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
 * `[[ … ]]` keeps its text, unless a tag in the clause, outside the optional
 * clauses it holds, is not in `valuedTags`: Metabase leaves such a clause out,
 * and decides each inner clause on its own tags. Adds the name of each tag
 * the SQL keeps to `kept`.
 */
function replaceTemplateTags(
  parts: readonly NativePart[],
  valuedTags: ReadonlySet<string>,
  kept: string[],
): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "tag":
          kept.push(part.name.trim());
          return ` ${tagPlaceholder(part.name.trim())} `;
        case "optional":
          return part.parts.every(
            (inner) =>
              inner.type !== "tag" || valuedTags.has(inner.name.trim()),
          )
            ? ` ${replaceTemplateTags(part.parts, valuedTags, kept)} `
            : " ";
      }
    })
    .join("");
}

/**
 * The names of the template tags native SQL keeps when Metabase compiles it
 * with the tags `valuedTags` names given a value: each tag outside the
 * optional clauses Metabase leaves out (`prepareSql`). Empty when Metabase
 * cannot parse its template tags.
 */
export function keptTagNames(
  sql: string,
  valuedTags: ReadonlySet<string>,
): string[] {
  const parsed = parseNativeSql(sql);
  if (parsed.status === "unread") {
    return [];
  }
  const kept: string[] = [];
  replaceTemplateTags(parsed.parts, valuedTags, kept);
  return [...new Set(kept)];
}

/** Whether `name`, a table or column SQLGlot read, is the word a template tag became. */
export function isTagPlaceholder(name: string): boolean {
  return TAG_PLACEHOLDER.test(name);
}

/** The name of the template tag a placeholder stands for; null for any other name. */
function tagNameOfPlaceholder(name: string): string | null {
  const hex = TAG_PLACEHOLDER.exec(name)?.[1];
  return hex === undefined ? null : Buffer.from(hex, "hex").toString("utf8");
}

/** The template tag a placeholder stands for, written `{{name}}`; null for any other name. */
function tagOfPlaceholder(name: string): string | null {
  const tag = tagNameOfPlaceholder(name);
  return tag === null ? null : `{{${tag}}}`;
}

const PARSE_FAILURE = "SQLGlot could not parse it: ";

/** `unread`, its reason prefixed when SQLGlot could not parse the SQL. */
function parseFailure(unread: Unread): Unread {
  return isParseFailure(unread)
    ? { ...unread, reason: `${PARSE_FAILURE}${unread.reason}` }
    : unread;
}

/**
 * Whether a reader of this module refused SQL because SQLGlot raised a
 * ParseError on it (`isParseError`), the only failure Metabase takes as SQL
 * it cannot parse.
 */
export function isSqlParseError(unread: Unread): boolean {
  return (
    unread.reason.startsWith(PARSE_FAILURE) &&
    isParseError({
      ...unread,
      reason: unread.reason.slice(PARSE_FAILURE.length),
    })
  );
}

/** Why the lint does not read a native query of `engine`. */
const notSql = (engine: string): Unread => ({
  status: "unread",
  reason: `native queries on ${engine} are not SQL; the lint does not read them`,
});

/**
 * SQL of a database whose engine is `engine`, as the lint parses it: the
 * SQLGlot dialect of the engine (`dialectOf`), and the SQL. For a native
 * query, `valuedTags` names its template tags with a value, as
 * `valuedTagNames` gives them; the SQL then has each optional clause Metabase
 * keeps pasted in, and each template tag a placeholder word
 * (`isTagPlaceholder`), with tags and clauses as Metabase parses them
 * (`parseNativeSql`), so those inside a SQL comment are text. Without
 * `valuedTags`, the SQL is as written, as Metabase runs a transform test's
 * SQL. Unread when the engine's native queries are not SQL
 * (`nativeQueriesAreSql`); for a native query, also when Metabase cannot parse
 * its template tags, or when a snippet with no value is left in what Metabase
 * keeps: expand snippets first. A snippet left after that has no snippet tag.
 */
export function prepareSql(
  sql: string,
  engine: string | null,
  valuedTags?: ReadonlySet<string>,
): { status: "prepared"; sql: string; dialect: string | null } | Unread {
  if (engine !== null && !nativeQueriesAreSql(engine)) {
    return notSql(engine);
  }
  if (valuedTags === undefined) {
    return { status: "prepared", sql, dialect: dialectOf(engine) };
  }
  const parsed = parseNativeSql(sql);
  if (parsed.status === "unread") {
    return parsed;
  }
  const kept: string[] = [];
  const replaced = replaceTemplateTags(parsed.parts, valuedTags, kept);
  // A tag with a value is substituted whatever its name; Metabase takes a
  // tag by its template tag's type.
  const snippet = kept.find(
    (name) => snippetNameOf(name) !== null && !valuedTags.has(name),
  );
  if (snippet !== undefined) {
    return {
      status: "unread",
      reason: `the query uses {{${snippet}}}, which no snippet tag defines, so the lint cannot paste it`,
    };
  }
  return { status: "prepared", sql: replaced, dialect: dialectOf(engine) };
}

/**
 * The tables SQL reads, and, for a native query, `tags`: the names of the
 * template tags it reads as a table, with or without a schema, each once,
 * sorted; absent when there are none.
 */
export type SqlTables =
  | { status: "read"; tables: TableName[]; tags?: string[] }
  | Unread;

/**
 * The tables SQL reads, in the database `database`. `valuedTags` names the
 * template tags with a value, as `valuedTagNames` gives them, for a native
 * query Metabase compiles; without it, the SQL is read as written
 * (`prepareSql`).
 */
export type SqlTableReader = (
  sql: string,
  database: string | null,
  valuedTags?: ReadonlySet<string>,
) => SqlTables;

/**
 * Returns a reader of the tables native SQL reads, as Metabase reads them
 * with `parser`: each table once, sorted. It parses the SQL as `prepareSql`
 * gives it for the database's engine, with its large literal lists stripped
 * (`stripLargeLiteralLists`). A placeholder read as a table is among the
 * `tags`, since the tag's own definition names its card or table. An
 * unqualified one is not among the tables. One after a schema is also among
 * them, named as the tag is written, `schema.{{name}}`, since the reader does
 * not know the tag's type: it is a table only for a tag that is not a
 * `table` tag, which matches no input or table. Metabase writes a `table`
 * tag as its table's qualified name, schema included, so a caller that knows
 * the tag is a `table` tag drops that name. Refuses (`unread`) what
 * `prepareSql` refuses, and SQL SQLGlot cannot parse. Each distinct SQL, in
 * each dialect, is parsed once.
 */
export function createSqlTableReader(
  parser: SqlParser,
  engineOf: EngineOf,
): SqlTableReader {
  const parse = cacheBySql((sql, dialect) =>
    parser.referencedTables(stripLargeLiteralLists(sql), dialect),
  );
  return (sql, database, valuedTags) => {
    const prepared = prepareSql(sql, engineOf(database), valuedTags);
    if (prepared.status === "unread") {
      return prepared;
    }
    const result = parse(prepared.sql, prepared.dialect);
    if (result.status === "unread") {
      return parseFailure(result);
    }
    const tags = [
      ...new Set(
        result.tables.flatMap((t) => tagNameOfPlaceholder(t.name) ?? []),
      ),
    ].sort();
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
      ...(tags.length > 0 ? { tags } : {}),
    };
  };
}

/**
 * Why SQL in the database `database` does not parse, as Metabase parses a
 * transform test's expectation: as `prepareSql` gives it, as written, in the
 * dialect of the database's engine, with no large literal list stripped
 * (Metabase parses it first in `replace_names`, which strips none). Null when
 * it parses. Reasons are those of `SqlTableReader`, so `isSqlParseError`
 * reads them.
 */
export type SqlParseCheck = (
  sql: string,
  database: string | null,
) => Unread | null;

/** Returns a `SqlParseCheck` that parses with `parser`; each distinct SQL, in each dialect, is parsed once. */
export function createSqlParseCheck(
  parser: SqlParser,
  engineOf: EngineOf,
): SqlParseCheck {
  const parse = cacheBySql((sql, dialect) =>
    parser.referencedTables(sql, dialect),
  );
  return (sql, database) => {
    const prepared = prepareSql(sql, engineOf(database));
    if (prepared.status === "unread") {
      return prepared;
    }
    const result = parse(prepared.sql, prepared.dialect);
    return result.status === "unread" ? parseFailure(result) : null;
  };
}
