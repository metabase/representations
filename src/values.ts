/** `value` when it is a string, else null. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Whether `value` is a plain object: not null and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message of a thrown `Error`, or any other thrown value as text. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
