import { nanoid } from "nanoid";

export function generateEntityId(): string {
  return nanoid();
}
