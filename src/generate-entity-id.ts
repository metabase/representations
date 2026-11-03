import { nanoid } from "nanoid";

/** A new 21-character entity id. */
export function generateEntityId(): string {
  return nanoid();
}
