/** `value` when it is a string, else null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Whether `value` is a plain object: not null and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The template tags of a native stage's `template-tags`, a list or the legacy
 * map by name; anything else, and any entry that is not a map, gives none.
 */
export function templateTagsOf(value: unknown): Record<string, unknown>[] {
  const entries: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];
  return entries.filter(isRecord);
}

/** The message of a thrown `Error`, or any other thrown value as text. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** `items` without repeats, keeping the first of each: two repeat when `key` gives them the same string. */
export function uniqueBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}
