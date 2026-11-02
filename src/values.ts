/** `value` when it is a string, else null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Whether `value` is a string or null. */
export const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * Whether `value` is an array, narrowed to `readonly unknown[]`:
 * `Array.isArray` alone narrows `unknown` to `any[]`, whose items then pass
 * as any type.
 */
export const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

/** Whether `value` is an array of strings. */
export const isStringArray = (value: unknown): value is string[] =>
  isUnknownArray(value) && value.every((item) => typeof item === "string");

/**
 * A reference token of a JSON pointer as the key it names: `~1` is `/`, and
 * `~0` is `~`.
 */
export const unescapePointer = (token: string): string =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

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

/** Control and format characters, and the line and paragraph separators. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * `text` with each control (Cc) or format (Cf) character, line separator and
 * paragraph separator written as its JSON escape, `\uXXXX` per UTF-16 unit,
 * so that it cannot act on a terminal or a CI log; every other character is
 * kept. A JSON text keeps its value.
 */
export const escapeUnprintable = (text: string): string =>
  text.replace(UNPRINTABLE, (ch) =>
    ch
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );

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
