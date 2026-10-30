import { isJavaWhitespace } from "./values.js";

// A port of Metabase's `strip-large-literal-lists`
// (`src/metabase/sql_parsing/core.clj`), which Metabase runs on SQL before
// `referenced_tables` and `field_references`, and not before `replace_names`.

const STRIP_THRESHOLD = 100;

/** A VALUES, IN or ARRAY keyword and its opening delimiter, as Java's regex reads it. */
const LITERAL_LIST_KEYWORD =
  /\b(?:VALUES[ \t\n\v\f\r]*\(|IN[ \t\n\v\f\r]*\(|ARRAY[ \t\n\v\f\r]*\[)/gi;

const isDigit = (ch: string): boolean => /^\p{Nd}$/u.test(ch);

function skipWhitespace(sql: string, pos: number): number {
  let p = pos;
  while (p < sql.length && isJavaWhitespace(sql[p])) {
    p += 1;
  }
  return p;
}

/** Past the string literal opening at `pos`; a doubled quote is an escape. */
function skipStringLiteral(sql: string, pos: number): number {
  const quote = sql[pos];
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Past the `)` matching the `(` at `pos`, skipping string literals. */
function skipBalancedParens(sql: string, pos: number): number {
  let depth = 0;
  let p = pos;
  while (p < sql.length) {
    const ch = sql[p];
    if (ch === "'" || ch === '"') {
      p = skipStringLiteral(sql, p);
    } else if (ch === "(") {
      depth += 1;
      p += 1;
    } else if (ch === ")") {
      if (depth === 1) {
        return p + 1;
      }
      depth -= 1;
      p += 1;
    } else {
      p += 1;
    }
  }
  return p;
}

/** The number of top-level comma-separated items in a tuple's content. */
function countTopLevelItems(content: string): number {
  let depth = 0;
  let items = 1;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "'" || ch === '"') {
      i = skipStringLiteral(content, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      items += 1;
    }
    i += 1;
  }
  return items;
}

/** After the first tuple, the count of tuples, and the position after the last. */
function countAndSkipTuples(sql: string, start: number): [number, number] {
  let pos = start;
  let count = 1;
  for (;;) {
    pos = skipWhitespace(sql, pos);
    if (pos >= sql.length || sql[pos] !== ",") {
      return [count, pos];
    }
    pos = skipWhitespace(sql, pos + 1);
    if (pos >= sql.length || sql[pos] !== "(") {
      return [count, pos];
    }
    pos = skipBalancedParens(sql, pos);
    count += 1;
  }
}

/** The keyword of a match such as `VALUES (`. */
function keywordOf(match: string): string {
  return match.trimEnd().replace(/[([]$/, "").trimEnd();
}

type Strip = [replacement: string | null, resume: number];

function stripValuesAt(sql: string, start: number, end: number): Strip {
  const parenStart = end - 1;
  const firstEnd = skipBalancedParens(sql, parenStart);
  const [tuples, endPos] = countAndSkipTuples(sql, firstEnd);
  if (tuples > STRIP_THRESHOLD && firstEnd > parenStart + 1) {
    const columns = countTopLevelItems(sql.slice(parenStart + 1, firstEnd - 1));
    return [
      `${keywordOf(sql.slice(start, end))} (${Array(columns).fill("NULL").join(", ")})`,
      endPos,
    ];
  }
  return [null, end];
}

/**
 * The commas of a list of only numbers, single-quoted strings, signs and
 * balanced parens, opening at `open`, and the position after it; null for
 * any other list.
 */
function simpleListEnd(sql: string, open: number): [number, number] | null {
  const close = sql[open] === "[" ? "]" : ")";
  let depth = 1;
  let commas = 0;
  let i = open + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === close && depth === 1) {
      return [commas, i + 1];
    }
    if (ch === "'") {
      i = skipStringLiteral(sql, i);
      continue;
    }
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      if (depth <= 1) {
        return null;
      }
      depth -= 1;
    } else if (ch === ",") {
      commas += 1;
    } else if (
      !isDigit(ch) &&
      !isJavaWhitespace(ch) &&
      ch !== "." &&
      ch !== "-" &&
      ch !== "+"
    ) {
      return null;
    }
    i += 1;
  }
  return null;
}

function stripListAt(sql: string, start: number, end: number): Strip {
  const open = end - 1;
  const list = simpleListEnd(sql, open);
  if (list !== null && list[0] >= STRIP_THRESHOLD) {
    return [
      `${keywordOf(sql.slice(start, end))}${sql[open] === "[" ? "[NULL]" : " (NULL)"}`,
      list[1],
    ];
  }
  return [null, end];
}

/**
 * `sql` with each large literal list replaced, as Metabase replaces it before
 * it reads tables and columns: a VALUES clause of more than 100 tuples by one
 * tuple of NULLs, and an IN list or ARRAY literal of only literals with at
 * least 100 commas by `IN (NULL)` or `ARRAY[NULL]`. Text in comments and
 * string literals is not skipped, as in Metabase.
 */
export function stripLargeLiteralLists(sql: string): string {
  const pieces: string[] = [];
  let copied = 0;
  let from = 0;
  let stripped = false;
  for (;;) {
    LITERAL_LIST_KEYWORD.lastIndex = from;
    const match = LITERAL_LIST_KEYWORD.exec(sql);
    if (match === null) {
      break;
    }
    const start = match.index;
    const end = start + match[0].length;
    const [replacement, resume] =
      sql[start] === "V" || sql[start] === "v"
        ? stripValuesAt(sql, start, end)
        : stripListAt(sql, start, end);
    if (replacement !== null) {
      pieces.push(sql.slice(copied, start), replacement);
      copied = resume;
      stripped = true;
    }
    from = resume;
  }
  if (!stripped) {
    return sql;
  }
  pieces.push(sql.slice(copied));
  return pieces.join("");
}
