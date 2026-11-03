/** A JSON string, number, boolean or null. */
export type JsonPrimitive = string | number | boolean | null;
/** A JSON array. */
export type JsonArray = JsonValue[];
/** A JSON object, such as a parsed YAML map. */
export type JsonObject = { [key: string]: JsonValue };
/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}
