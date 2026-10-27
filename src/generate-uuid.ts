import { randomUUID } from "node:crypto";

/** A new random version 4 UUID. */
export function generateUuid(): string {
  return randomUUID();
}
