import { describe, expect, it } from "bun:test";

import {
  errorMessage,
  isRecord,
  isStringArray,
  isStringOrNull,
  unescapePointer,
} from "./values.js";

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

describe("isStringOrNull and isStringArray", () => {
  it("accept only a string or null, and only an array of strings", () => {
    expect([null, "", "a", undefined, 1].map(isStringOrNull)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(
      [[], ["a"], ["a", null], "a", { 0: "a" }].map(isStringArray),
    ).toEqual([true, true, false, false, false]);
  });
});

describe("unescapePointer", () => {
  it("reads ~1 as / and ~0 as ~, so ~01 is ~1", () => {
    expect(unescapePointer("a~1b~0c~01")).toBe("a/b~c~1");
  });
});
