import { randomUUID } from "node:crypto";

/** A new v4 UUID. */
export function generateUuid(): string {
  return randomUUID();
}
