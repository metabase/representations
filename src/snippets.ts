import { templateTagsOf } from "./values.js";

const MAX_SNIPPET_DEPTH = 8;

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

/**
 * Pastes each `{{snippet: name}}` in, with the content `snippets` gives for
 * the name, and then the snippets the pasted text uses. Unread at the first
 * snippet `snippets` cannot give, or when snippets remain after
 * `MAX_SNIPPET_DEPTH + 1` rounds, as with a snippet that uses itself.
 * Callers omit `depth`.
 */
export function expandSnippets(
  sql: string,
  snippets: (name: string) => SnippetLookup,
  depth = 0,
): ExpandedSql {
  let unusable: string | null = null;
  const expanded = sql.replace(
    /\{\{\s*snippet:\s*([^}]*?)\s*\}\}/gi,
    (_, name: string) => {
      const snippet = snippets(name);
      if ("unusable" in snippet) {
        unusable ??= snippet.unusable;
        return "";
      }
      return snippet.content;
    },
  );
  if (unusable !== null) {
    return { status: "unread", reason: unusable };
  }
  if (!/\{\{\s*snippet:/i.test(expanded)) {
    return { status: "expanded", sql: expanded };
  }
  return depth < MAX_SNIPPET_DEPTH
    ? expandSnippets(expanded, snippets, depth + 1)
    : {
        status: "unread",
        reason: `snippets remain after ${MAX_SNIPPET_DEPTH + 1} rounds of pasting, as when a snippet uses itself`,
      };
}
