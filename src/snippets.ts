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

/**
 * Pastes each `{{snippet: name}}` in, with the content `snippets` gives for
 * the name, and then the snippets the pasted text uses. Null when a snippet is
 * missing, or when snippets remain after nine rounds, as with a snippet that
 * uses itself. Callers omit `depth`.
 */
export function expandSnippets(
  sql: string,
  snippets: (name: string) => string | undefined,
  depth = 0,
): string | null {
  let missing = false;
  const expanded = sql.replace(
    /\{\{\s*snippet:\s*([^}]*?)\s*\}\}/gi,
    (_, name: string) => {
      const content = snippets(name);
      if (content === undefined) {
        missing = true;
        return "";
      }
      return content;
    },
  );
  if (missing) {
    return null;
  }
  if (/\{\{\s*snippet:/i.test(expanded)) {
    return depth < MAX_SNIPPET_DEPTH
      ? expandSnippets(expanded, snippets, depth + 1)
      : null;
  }
  return expanded;
}
