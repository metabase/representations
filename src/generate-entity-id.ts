import { nanoid } from "nanoid";

/** A new random entity id: a 21-character NanoID. */
export function generateEntityId(): string {
  return nanoid();
}
