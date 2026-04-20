import { describe, expect, it } from "bun:test";

import { generateEntityId } from "./generate-entity-id.js";

describe("generateEntityId", () => {
  it("returns a 21-character string", () => {
    const id = generateEntityId();
    expect(typeof id).toBe("string");
    expect(id).toHaveLength(21);
  });

  it("uses the NanoID alphabet (A-Za-z0-9_-)", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateEntityId()).toMatch(/^[\w-]{21}$/);
    }
  });

  it("returns different values on subsequent calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateEntityId()));
    expect(ids.size).toBe(100);
  });
});
