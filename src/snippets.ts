import {
  type NativePart,
  parseNativeSql,
  snippetNameOf,
} from "./native-sql.js";
import type { Unread } from "./sql-parser.js";
import { templateTagsOf } from "./values.js";

// Metabase's limits, `src/metabase/driver/sql/parameters/substitute.clj`.
const MAX_SNIPPET_PASTES = 10_000;
const MAX_EXPANDED_SQL_LENGTH = 10_000_000;

/**
 * The entity id of each snippet a native stage's template tags name, by the
 * snippet name its SQL uses: `{{snippet: name}}`. Metabase pastes a snippet by
 * this id, so a renamed snippet keeps its place.
 */
export function snippetIdsOf(templateTags: unknown): Map<string, string> {
  const ids = new Map<string, string>();
  for (const tag of templateTagsOf(templateTags)) {
    const name = typeof tag.name === "string" ? tag.name : "";
    const match = /^\s*snippet:\s*(.*?)\s*$/.exec(name);
    if (
      tag.type === "snippet" &&
      match !== null &&
      typeof tag["snippet-id"] === "string"
    ) {
      ids.set(match[1], tag["snippet-id"]);
    }
  }
  return ids;
}

/** A snippet's content, or why it cannot be pasted. */
export type SnippetLookup = { content: string } | { unusable: string };

/** SQL with its snippets pasted in, or why they could not be. */
export type ExpandedSql =
  | { status: "expanded"; sql: string }
  | { status: "unread"; reason: string };

const tooLong: Unread = {
  status: "unread",
  reason: `the query is longer than ${MAX_EXPANDED_SQL_LENGTH} characters with its snippets pasted, the most Metabase runs`,
};

/** Text built from pieces, with its length so far. */
class Pieces {
  private readonly pieces: string[] = [];
  length = 0;

  add(piece: string): void {
    this.pieces.push(piece);
    this.length += piece.length;
  }

  join(): string {
    return this.pieces.join("");
  }
}

/**
 * Pastes each `{{snippet: name}}` in, with the content `snippets` gives for
 * the name, and the snippets that content uses, depth first. A snippet tag is
 * one Metabase parses (`parseNativeSql`): one inside a SQL comment is text.
 * Unread at the first snippet `snippets` cannot give, at template tags
 * Metabase cannot parse, at a snippet that uses itself through any chain of
 * snippets, past 10,000 pastes, or when the pasted SQL passes 10,000,000
 * characters: Metabase refuses to run the last four.
 */
export function expandSnippets(
  sql: string,
  snippets: (name: string) => SnippetLookup,
): ExpandedSql {
  let pastes = 0;
  // The snippets being pasted, outermost first.
  const using = new Set<string>();
  // The SQL of `parts`, each snippet pasted, appended to `out`; or why not.
  const render = (parts: readonly NativePart[], out: Pieces): Unread | null => {
    for (const part of parts) {
      if (part.type === "text") {
        out.add(part.text);
      } else if (part.type === "optional") {
        out.add("[[");
        const failed = render(part.parts, out);
        if (failed !== null) {
          return failed;
        }
        out.add("]]");
      } else {
        const name = snippetNameOf(part.name);
        if (name === null) {
          out.add(`{{${part.name}}}`);
          continue;
        }
        const pasted = paste(name);
        if (pasted.status === "unread") {
          return pasted;
        }
        out.add(pasted.sql);
        if (out.length > MAX_EXPANDED_SQL_LENGTH) {
          return tooLong;
        }
      }
    }
    return null;
  };
  const paste = (name: string): ExpandedSql => {
    if (using.has(name)) {
      return {
        status: "unread",
        reason: `snippets use each other in a cycle: ${[...using, name].join(" -> ")}`,
      };
    }
    pastes += 1;
    if (pastes > MAX_SNIPPET_PASTES) {
      return {
        status: "unread",
        reason: `the query uses more than ${MAX_SNIPPET_PASTES} snippets, the most Metabase pastes`,
      };
    }
    const snippet = snippets(name);
    if ("unusable" in snippet) {
      return { status: "unread", reason: snippet.unusable };
    }
    using.add(name);
    const pasted = expand(snippet.content);
    using.delete(name);
    return pasted;
  };
  const expand = (text: string): ExpandedSql => {
    const parsed = parseNativeSql(text);
    if (parsed.status === "unread") {
      return parsed;
    }
    const out = new Pieces();
    const failed = render(parsed.parts, out);
    if (failed !== null) {
      return failed;
    }
    const expanded = out.join();
    return expanded.length > MAX_EXPANDED_SQL_LENGTH
      ? tooLong
      : { status: "expanded", sql: expanded };
  };
  return expand(sql);
}
