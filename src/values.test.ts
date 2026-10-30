import { describe, expect, it } from "bun:test";

import { errorMessage, isRecord, uniqueBy } from "./values.js";

describe("isRecord", () => {
  it("accepts a plain object, and one with no prototype", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("refuses null, an array, a Date, a Map and a class instance", () => {
    class Point {
      x = 1;
    }
    for (const value of [null, [], new Date(), new Map(), new Point(), "s"]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

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
