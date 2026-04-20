import { describe, expect, it } from "bun:test";

import { generateUuid } from "./generate-uuid.js";

const UUID_REGEX = /^[0-9a-f-]{36}$/i;

describe("generateUuid", () => {
  it("returns a UUID-shaped string", () => {
    const id = generateUuid();
    expect(typeof id).toBe("string");
    expect(id).toMatch(UUID_REGEX);
  });

  it("returns different values on subsequent calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateUuid()));
    expect(ids.size).toBe(100);
  });
});
