const MAX_SNIPPET_DEPTH = 8;

/**
 * Pastes each `{{snippet: name}}` in, as Metabase does, and then the snippets
 * the pasted text uses. Null when a snippet is missing, or when snippets remain
 * after nine rounds, as with a snippet that uses itself. Callers omit `depth`.
 */
export function expandSnippets(
  sql: string,
  snippets: ReadonlyMap<string, string>,
  depth = 0,
): string | null {
  let missing = false;
  const expanded = sql.replace(
    /\{\{\s*snippet:\s*([^}]*?)\s*\}\}/gi,
    (_, name: string) => {
      const content = snippets.get(name);
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
