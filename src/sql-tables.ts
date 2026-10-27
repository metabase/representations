import { fold, type TableName } from "./tables.js";
import { templateTagsOf } from "./values.js";

export type SqlTablesResult =
  | { status: "read"; tables: TableName[] }
  | { status: "unread"; reason: string };

type Token =
  | { kind: "word"; text: string }
  | { kind: "quoted"; text: string }
  | { kind: "punct"; text: string };

const QUERY_KEYWORDS = new Set(["SELECT", "WITH", "VALUES"]);

// A word that ends a query's FROM clause, after which a comma separates no
// tables.
const FROM_CLAUSE_ENDS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "WINDOW",
  "QUALIFY",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "SELECT",
]);

// One pass, so that whichever starts first wins: `'--'` is a string, and
// `-- it's` a comment.
function stripCommentsAndStrings(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*|'(?:[^']|'')*'/g, (match) =>
    match.startsWith("'") ? " '' " : " ",
  );
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*)|('')|(\S)/g;
  for (const match of sql.matchAll(pattern)) {
    const [, doubleQuoted, backtick, bracketed, word, , punct] = match;
    if (doubleQuoted !== undefined) {
      tokens.push({ kind: "quoted", text: doubleQuoted.replace(/""/g, '"') });
    } else if (backtick !== undefined) {
      // BigQuery quotes a whole qualified name: `project.dataset.table`.
      backtick.split(".").forEach((part, i) => {
        if (i > 0) {
          tokens.push({ kind: "punct", text: "." });
        }
        tokens.push({ kind: "quoted", text: part });
      });
    } else if (bracketed !== undefined) {
      tokens.push({ kind: "quoted", text: bracketed });
    } else if (word !== undefined) {
      tokens.push({ kind: "word", text: word });
    } else if (punct !== undefined) {
      tokens.push({ kind: "punct", text: punct });
    } else {
      tokens.push({ kind: "punct", text: "''" });
    }
  }
  return tokens;
}

function isWord(token: Token | undefined, text: string): boolean {
  return token?.kind === "word" && token.text.toUpperCase() === text;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

function isIdentifier(token: Token | undefined): boolean {
  return token?.kind === "quoted" || token?.kind === "word";
}

function closingParen(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) {
      depth++;
    } else if (isPunct(tokens[i], ")")) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return tokens.length;
}

/** The index of the `)` closing the parenthesis the token at `start` sits in, or the end of the tokens. */
function enclosingClose(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) {
      depth++;
    } else if (isPunct(tokens[i], ")")) {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return tokens.length;
}

/** A CTE: its name, upper-cased, and token ranges, inclusive. */
type Cte = {
  name: string;
  /** The query of its `WITH`, where the name means the CTE. */
  scope: [number, number];
  /** Its own body, where the name means the real table unless the CTE is recursive. */
  body: [number, number];
  recursive: boolean;
};

function ctes(tokens: readonly Token[]): Cte[] {
  const found: Cte[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "WITH")) {
      continue;
    }
    const recursive = isWord(tokens[i + 1], "RECURSIVE");
    const scope: [number, number] = [i, enclosingClose(tokens, i)];
    let j = recursive ? i + 2 : i + 1;
    while (isIdentifier(tokens[j])) {
      const name = tokens[j].text.toUpperCase();
      j++;
      if (isPunct(tokens[j], "(")) {
        j = closingParen(tokens, j) + 1;
      }
      if (!isWord(tokens[j], "AS")) {
        break;
      }
      const close = closingParen(tokens, j + 1);
      found.push({ name, scope, body: [j + 1, close], recursive });
      j = close + 1;
      if (!isPunct(tokens[j], ",")) {
        break;
      }
      j++;
    }
  }
  return found;
}

const within = (at: number, [start, end]: [number, number]) =>
  start <= at && at <= end;

/** Whether an unqualified `name` at token `at` names a CTE rather than a table. */
function namesCte(all: readonly Cte[], name: string, at: number): boolean {
  const upper = name.toUpperCase();
  return all.some(
    (cte) =>
      cte.name === upper &&
      within(at, cte.scope) &&
      (cte.recursive || !within(at, cte.body)),
  );
}

/** A query or a parenthesis. */
type Frame = {
  /** Whether a FROM or JOIN in it starts a table: in a query or a join group. */
  readsTables: boolean;
  /** Whether the scan is in its FROM clause, where a comma starts a table. */
  inFrom: boolean;
};

function isQueryStart(token: Token | undefined): boolean {
  return token?.kind === "word" && QUERY_KEYWORDS.has(token.text.toUpperCase());
}

type TableRef = { table: TableName; next: number } | { table: null };

function readTableRef(tokens: readonly Token[], start: number): TableRef {
  const parts: string[] = [];
  let i = start;
  while (isIdentifier(tokens[i])) {
    parts.push(tokens[i].text);
    i++;
    if (!isPunct(tokens[i], ".")) {
      break;
    }
    i++;
  }
  if (parts.length === 0 || parts.length > 3 || isPunct(tokens[i], "(")) {
    return { table: null };
  }
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : null;
  return { table: { schema, name }, next: i };
}

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

/**
 * The tables a native query reads, from the names after `FROM` and `JOIN`.
 * An unqualified name that a CTE declares is left out within the query of its
 * `WITH`, except in that CTE's own body when it is not recursive. A template tag reads nothing
 * here: the tag's own definition names its card or table. Refuses (`unread`)
 * a query with a snippet left in it (expand snippets first), a table
 * function, or a `FROM` followed by something other than a table, a tag or a
 * subquery. `valuedTags` names the template tags with a value, as
 * `valuedTagNames` gives them, for a query Metabase compiles; without it, the
 * text of every optional clause is read.
 */
export function tablesReadBySql(
  sql: string,
  valuedTags?: ReadonlySet<string>,
): SqlTablesResult {
  if (/\{\{\s*snippet:/i.test(sql)) {
    return { status: "unread", reason: "the query has a snippet" };
  }
  const tokens = tokenize(
    stripCommentsAndStrings(replaceTemplateTags(sql, valuedTags)),
  );
  const allCtes = ctes(tokens);
  const tables: TableName[] = [];
  const seen = new Set<string>();
  // The query itself, then one entry per open parenthesis.
  const frames: Frame[] = [{ readsTables: true, inFrom: false }];

  const add = (table: TableName, at: number) => {
    if (
      table.schema === null &&
      (table.name === TAG_PLACEHOLDER || namesCte(allCtes, table.name, at))
    ) {
      return;
    }
    const key = JSON.stringify([fold(table.schema), fold(table.name)]);
    if (!seen.has(key)) {
      seen.add(key);
      tables.push(table);
    }
  };

  /**
   * Reads the table at `start`, after FROM, JOIN, a comma or the parenthesis
   * of a join group. Returns where the scan goes on, or null when no table,
   * subquery or join group is there. A parenthesis there opens a frame.
   */
  const readTable = (start: number): number | null => {
    let j = start;
    // Postgres's `FROM ONLY t` reads t without its child tables.
    if (isWord(tokens[j], "ONLY") && isIdentifier(tokens[j + 1])) {
      j++;
    }
    if (isPunct(tokens[j], "(")) {
      const query = isQueryStart(tokens[j + 1]);
      frames.push({ readsTables: true, inFrom: !query });
      // A join group, `(a JOIN b ON …)`, starts with a table.
      return query ? j + 1 : readTable(j + 1);
    }
    const ref = readTableRef(tokens, j);
    if (ref.table === null) {
      return null;
    }
    add(ref.table, j);
    return ref.next;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const frame = frames[frames.length - 1];
    if (isPunct(token, "(")) {
      frames.push({ readsTables: isQueryStart(tokens[i + 1]), inFrom: false });
      continue;
    }
    if (isPunct(token, ")")) {
      if (frames.length > 1) {
        frames.pop();
      }
      continue;
    }
    if (!frame.readsTables) {
      continue;
    }
    if (
      token.kind === "word" &&
      FROM_CLAUSE_ENDS.has(token.text.toUpperCase())
    ) {
      frame.inFrom = false;
      continue;
    }
    const startsTable =
      // `IS [NOT] DISTINCT FROM` compares two values.
      (isWord(token, "FROM") && !isWord(tokens[i - 1], "DISTINCT")) ||
      isWord(token, "JOIN") ||
      (isPunct(token, ",") && frame.inFrom);
    if (!startsTable) {
      continue;
    }
    if (isWord(token, "FROM")) {
      frame.inFrom = true;
    }
    const next = readTable(i + 1);
    if (next === null) {
      return {
        status: "unread",
        reason: `no table name after ${token.text.toUpperCase()}`,
      };
    }
    i = next - 1;
  }
  return { status: "read", tables };
}
