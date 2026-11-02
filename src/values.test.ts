import { describe, expect, it } from "bun:test";

import {
  errorMessage,
  escapeUnprintable,
  isRecord,
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

describe("unescapePointer", () => {
  it("reads ~1 as / and ~0 as ~, so ~01 is ~1", () => {
    expect(unescapePointer("a~1b~0c~01")).toBe("a/b~c~1");
  });
});

describe("escapeUnprintable", () => {
  it.each([
    [
      "C0",
      "a\u001b[31m\u0007\r\t\nb",
      "a\\u001b[31m\\u0007\\u000d\\u0009\\u000ab",
    ],
    ["DEL and C1", "\u007f\u0085\u009b", "\\u007f\\u0085\\u009b"],
    ["line and paragraph separators", "\u2028\u2029", "\\u2028\\u2029"],
    [
      "format characters",
      "\u202e\u200b\ufeff\u{e0001}",
      "\\u202e\\u200b\\ufeff\\udb40\\udc01",
    ],
    ["other characters", 'é中😀\\ "', 'é中😀\\ "'],
  ])("writes %s as JSON escapes", (_, text, escaped) => {
    expect(escapeUnprintable(text)).toBe(escaped);
  });

  it("keeps the value of a JSON text", () => {
    const value = { "k\u009b": "\u2028\u202e\n\u{e0001}" };
    expect(JSON.parse(escapeUnprintable(JSON.stringify(value)))).toEqual(value);
  });
});
