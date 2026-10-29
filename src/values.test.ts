import { describe, expect, it } from "bun:test";

import { errorMessage, uniqueBy } from "./values.js";

describe("errorMessage", () => {
  it("gives an Error's message", () => {
    expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
  });

  it("gives any other thrown value as text", () => {
    expect(errorMessage("bad input")).toBe("bad input");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("uniqueBy", () => {
  it("keeps the first item of each key, in order", () => {
    const items = ["b1", "a1", "b2", "c1", "a2"];
    expect(uniqueBy(items, (item) => item[0])).toEqual(["b1", "a1", "c1"]);
  });
});
