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
