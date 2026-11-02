import type { Unread } from "./sql-parser.js";

/**
 * Native SQL as Metabase parses its template tags (`metabase.lib.parse`):
 * text, each `{{tag}}` by its name as written, and each optional clause
 * `[[ … ]]` by its parts.
 */
export type NativePart =
  | { type: "text"; text: string }
  | { type: "tag"; name: string }
  | { type: "optional"; parts: NativePart[] };

type Token =
  | "block-comment-begin"
  | "block-comment-end"
  | "line-comment-begin"
  | "newline"
  | "optional-begin"
  | "optional-end"
  | "param-begin"
  | "param-end"
  | "single-quote";

type Lexeme = string | { token: Token; text: string };

/**
 * The tokens of Metabase's `tokenize`, which splits the text by each token in
 * turn: `/*` before `*\/`, so `*\/*` holds a `/*`; `{{` only as the last two
 * of a run of braces.
 */
function tokenize(sql: string): Lexeme[] {
  const lexemes: Lexeme[] = [];
  let start = 0;
  const push = (i: number, token: Token, text: string) => {
    if (i > start) {
      lexemes.push(sql.slice(start, i));
    }
    lexemes.push({ token, text });
    start = i + text.length;
  };
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    const next = sql[i + 2];
    let token: Token | null = null;
    if (two === "/*") {
      token = "block-comment-begin";
    } else if (two === "*/" && next !== "*") {
      token = "block-comment-end";
    } else if (two === "--") {
      token = "line-comment-begin";
    } else if (two === "[[") {
      token = "optional-begin";
    } else if (two === "]]") {
      token = "optional-end";
    } else if (two === "{{" && next !== "{") {
      token = "param-begin";
    } else if (two === "}}") {
      token = "param-end";
    }
    if (token !== null) {
      push(i, token, two);
      i += 2;
    } else if (sql[i] === "\n") {
      push(i, "newline", "\n");
      i += 1;
    } else if (sql[i] === "'") {
      push(i, "single-quote", "'");
      i += 1;
    } else {
      i += 1;
    }
  }
  if (start < sql.length) {
    lexemes.push(sql.slice(start));
  }
  return lexemes;
}

/** A template-tag syntax error, which Metabase refuses the query for. */
class TagSyntaxError extends Error {}

type Parsed = { parts: NativePart[]; next: number };

/** `parts` with adjacent texts joined. */
function joinTexts(parts: readonly NativePart[]): NativePart[] {
  const joined: NativePart[] = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (part.type === "text" && last?.type === "text") {
      joined[joined.length - 1] = { type: "text", text: last.text + part.text };
    } else {
      joined.push(part);
    }
  }
  return joined;
}

/** The tag of `{{ … }}`'s parts, as Metabase's `param` reads them. */
function tagOf(parts: readonly NativePart[]): NativePart {
  const [only, ...more] = joinTexts(parts);
  if (more.length > 0 || only?.type !== "text") {
    throw new TagSyntaxError("Invalid '{{...}}' clause: expected a param name");
  }
  if (only.text.trim() === "") {
    throw new TagSyntaxError("'{{...}}' clauses cannot be empty.");
  }
  return { type: "tag", name: only.text };
}

/** The optional clause of `[[ … ]]`'s parts, as Metabase's `optional` reads them. */
function optionalOf(parts: readonly NativePart[]): NativePart {
  if (!parts.some((p) => p.type === "tag")) {
    throw new TagSyntaxError(
      "[[...]] clauses must contain at least one '{{...}}' clause.",
    );
  }
  return { type: "optional", parts: joinTexts(parts) };
}

/** Metabase's `parse-tokens*`, from the lexeme at `from`. */
function parseLexemes(
  lexemes: readonly Lexeme[],
  from: number,
  optionalLevel: number,
  paramLevel: number,
  startInString: boolean,
  commentMode: Token | null,
): Parsed {
  const parts: NativePart[] = [];
  const text = (t: string) => parts.push({ type: "text", text: t });
  let inString = startInString;
  let i = from;
  // A clause opened at `begin`: its parts, or its opening text when it fails
  // to parse inside a string literal.
  const clause = (
    begin: { text: string },
    levels: [number, number],
    read: (inner: NativePart[]) => NativePart,
  ) => {
    try {
      const inner = parseLexemes(
        lexemes,
        i + 1,
        levels[0],
        levels[1],
        inString,
        commentMode,
      );
      parts.push(read(inner.parts));
      i = inner.next;
      // eslint-disable-next-line no-restricted-syntax -- parses template tags only; never reads SQL
    } catch (e) {
      if (!(inString && e instanceof TagSyntaxError)) {
        throw e;
      }
      text(begin.text);
      i += 1;
    }
  };
  while (i < lexemes.length) {
    const lexeme = lexemes[i];
    if (typeof lexeme === "string") {
      text(lexeme);
      i += 1;
      continue;
    }
    switch (lexeme.token) {
      case "optional-begin":
        if (commentMode !== null) {
          text(lexeme.text);
          i += 1;
        } else {
          clause(lexeme, [optionalLevel + 1, paramLevel], optionalOf);
        }
        break;
      case "param-begin":
        if (commentMode !== null) {
          text(lexeme.text);
          i += 1;
        } else {
          clause(lexeme, [optionalLevel, paramLevel + 1], tagOf);
        }
        break;
      case "line-comment-begin":
      case "block-comment-begin":
        if (
          commentMode !== null ||
          optionalLevel > 0 ||
          paramLevel > 0 ||
          inString
        ) {
          text(lexeme.text);
          i += 1;
        } else {
          const comment = parseLexemes(
            lexemes,
            i + 1,
            optionalLevel,
            paramLevel,
            inString,
            lexeme.token,
          );
          text(lexeme.text);
          parts.push(...comment.parts);
          i = comment.next;
        }
        break;
      case "block-comment-end":
      case "newline":
        text(lexeme.text);
        i += 1;
        if (
          (lexeme.token === "block-comment-end" &&
            commentMode === "block-comment-begin") ||
          (lexeme.token === "newline" && commentMode === "line-comment-begin")
        ) {
          return { parts, next: i };
        }
        break;
      case "optional-end":
      case "param-end":
        if (
          lexeme.token === "optional-end" ? optionalLevel > 0 : paramLevel > 0
        ) {
          return { parts, next: i + 1 };
        }
        text(lexeme.text);
        i += 1;
        break;
      case "single-quote":
        text(lexeme.text);
        inString = !inString;
        i += 1;
        break;
    }
  }
  if (optionalLevel > 0 || paramLevel > 0) {
    throw new TagSyntaxError(
      "Invalid query: found '[[' or '{{' with no matching ']]' or '}}'",
    );
  }
  return { parts, next: i };
}

/**
 * The template tags and optional clauses of native SQL, as Metabase parses
 * them before it runs the query. `[[`, `{{` and their ends inside a `--` or
 * `/* *\/` comment are text. Inside a string literal they are a tag or a
 * clause when one parses, and text otherwise. Unread, with Metabase's message,
 * when Metabase refuses the query: an unmatched `[[` or `{{`, an empty or
 * nested tag, or an optional clause with no tag.
 */
export function parseNativeSql(
  sql: string,
): { status: "parsed"; parts: NativePart[] } | Unread {
  try {
    return {
      status: "parsed",
      parts: joinTexts(parseLexemes(tokenize(sql), 0, 0, 0, false, null).parts),
    };
    // eslint-disable-next-line no-restricted-syntax -- parses template tags only; never reads SQL
  } catch (e) {
    if (e instanceof TagSyntaxError) {
      return {
        status: "unread",
        reason: `Metabase cannot parse its template tags: ${e.message}`,
      };
    }
    throw e;
  }
}

/** The names of the tags in `parts`, at any depth. */
export function tagNames(parts: readonly NativePart[]): string[] {
  return parts.flatMap((part) =>
    part.type === "tag"
      ? [part.name]
      : part.type === "optional"
        ? tagNames(part.parts)
        : [],
  );
}

/**
 * The snippet a tag's name uses, as Metabase reads `snippet: name`; null
 * when the tag is not a snippet.
 */
export function snippetNameOf(tagName: string): string | null {
  const match = /^\s*snippet:\s*([^}]*[^}\s])\s*$/.exec(tagName);
  return match === null ? null : match[1];
}
