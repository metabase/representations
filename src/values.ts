/** `value` when it is a string, else null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Whether `value` is an array, narrowed to `readonly unknown[]`:
 * `Array.isArray` alone narrows `unknown` to `any[]`, whose items then pass
 * as any type.
 */
export const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/**
 * Whether `value` is a plain object, such as a YAML map reads as: one whose
 * prototype is `Object.prototype` or null. An array, a `Date`, a `Map` or a
 * class instance is not.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The message of a thrown `Error`, or any other thrown value as text. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Java's `Character.isWhitespace`: a space, line or paragraph separator other
 * than a no-break space, a tab, a line feed, a vertical tab, a form feed, a
 * carriage return, or U+001C to U+001F.
 */
const JAVA_WHITESPACE =
  /^[\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]$/;

/** Whether `ch`, one UTF-16 unit, is whitespace by Java's `Character.isWhitespace`. */
export const isJavaWhitespace = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return (code >= 0x1c && code <= 0x1f) || JAVA_WHITESPACE.test(ch);
};

/** Whether `text` is empty or all whitespace, as Clojure's `str/blank?` reads it (`isJavaWhitespace`). */
export const isJavaBlank = (text: string): boolean =>
  [...text].every(isJavaWhitespace);
