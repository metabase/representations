export type SqlTable = {
  schema: string | null;
  name: string;
};

export type SqlTablesResult =
  | { status: "read"; tables: SqlTable[] }
  | { status: "unread"; reason: string };

type Token =
  | { kind: "word"; text: string }
  | { kind: "quoted"; text: string }
  | { kind: "punct"; text: string };

const QUERY_KEYWORDS = new Set(["SELECT", "WITH", "VALUES"]);

// A word that ends a table reference where an alias could stand.
const CLAUSE_KEYWORDS = new Set([
  "ON",
  "USING",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "LATERAL",
  "WINDOW",
  "QUALIFY",
  "FETCH",
]);

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ");
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
      tokens.push({ kind: "quoted", text: backtick });
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

function closingParen(tokens: Token[], open: number): number {
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

function cteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "WITH")) {
      continue;
    }
    let j = isWord(tokens[i + 1], "RECURSIVE") ? i + 2 : i + 1;
    while (isIdentifier(tokens[j])) {
      const name = tokens[j].text.toUpperCase();
      j++;
      if (isPunct(tokens[j], "(")) {
        j = closingParen(tokens, j) + 1;
      }
      if (!isWord(tokens[j], "AS")) {
        break;
      }
      names.add(name);
      j = closingParen(tokens, j + 1) + 1;
      if (!isPunct(tokens[j], ",")) {
        break;
      }
      j++;
    }
  }
  return names;
}

type TableRef = { table: SqlTable; next: number } | { table: null };

function readTableRef(tokens: Token[], start: number): TableRef {
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

function skipAlias(tokens: Token[], start: number): number {
  let i = start;
  if (isWord(tokens[i], "AS")) {
    i++;
  }
  const token = tokens[i];
  if (
    isIdentifier(token) &&
    !(token.kind === "word" && CLAUSE_KEYWORDS.has(token.text.toUpperCase()))
  ) {
    i++;
  }
  return i;
}

const TAG_PLACEHOLDER = "__metabase_template_tag__";

// Optional clauses `[[ … ]]` keep their text; a template tag becomes one word.
function replaceTemplateTags(sql: string): string {
  return sql
    .replace(/\[\[|\]\]/g, " ")
    .replace(/\{\{[^}]*\}\}/g, ` ${TAG_PLACEHOLDER} `);
}

/**
 * The tables a native query reads, from the names after `FROM` and `JOIN`.
 * Names in a CTE's `WITH` list are left out. A template tag reads nothing
 * here: the tag's own definition names its card or table. Refuses (`unread`)
 * a query with a snippet left in it (expand snippets first), a table
 * function, or a `FROM` followed by something other than a table, a tag or a
 * subquery.
 */
export function tablesReadBySql(sql: string): SqlTablesResult {
  if (/\{\{\s*snippet:/i.test(sql)) {
    return { status: "unread", reason: "the query has a snippet" };
  }
  const tokens = tokenize(stripCommentsAndStrings(replaceTemplateTags(sql)));
  const ctes = cteNames(tokens);
  const tables: SqlTable[] = [];
  const seen = new Set<string>();
  // One entry per open parenthesis: whether it opens a query.
  const frames: boolean[] = [];

  const add = (table: SqlTable) => {
    if (
      table.schema === null &&
      (table.name === TAG_PLACEHOLDER || ctes.has(table.name.toUpperCase()))
    ) {
      return;
    }
    const key = `${table.schema?.toUpperCase() ?? ""}.${table.name.toUpperCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      tables.push(table);
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isPunct(token, "(")) {
      const next = tokens[i + 1];
      frames.push(
        next?.kind === "word" && QUERY_KEYWORDS.has(next.text.toUpperCase()),
      );
      continue;
    }
    if (isPunct(token, ")")) {
      frames.pop();
      continue;
    }
    const inQuery = frames.length === 0 || frames[frames.length - 1];
    if (!inQuery || !(isWord(token, "FROM") || isWord(token, "JOIN"))) {
      continue;
    }
    let j = i + 1;
    for (;;) {
      if (isPunct(tokens[j], "(")) {
        break;
      }
      const ref = readTableRef(tokens, j);
      if (ref.table === null) {
        return {
          status: "unread",
          reason: `no table name after ${token.text.toUpperCase()}`,
        };
      }
      add(ref.table);
      j = skipAlias(tokens, ref.next);
      if (!isWord(token, "FROM") || !isPunct(tokens[j], ",")) {
        break;
      }
      j++;
    }
    i = j - 1;
  }
  return { status: "read", tables };
}
