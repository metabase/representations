import { describe, expect, it } from "bun:test";

import {
  describeThrown,
  errorMessage,
  escapeUnprintable,
  isRecord,
  isStringArray,
  isStringOrNull,
  unescapePointer,
  uniqueBy,
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

describe("uniqueBy", () => {
  it("keeps the first item of each key, in order", () => {
    const items = ["b1", "a1", "b2", "c1", "a2"];
    expect(uniqueBy(items, (item) => item[0])).toEqual(["b1", "a1", "c1"]);
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

describe("describeThrown", () => {
  // A line of the text that holds a control or format character, or starts
  // a workflow command.
  const unsafeLines = (text: string) =>
    text
      .split("\n")
      .filter(
        (line) =>
          /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line) || line.startsWith("::"),
      );
  const message = "a\n::error title=x::pwned\u001b";

  it("escapes the message whole and keeps the stack frames on their lines", () => {
    const text = describeThrown(new Error(message));
    expect(text.split("\n")[0]).toBe(
      "Error: a\\u000a::error title=x::pwned\\u001b",
    );
    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(unsafeLines(text)).toEqual([]);
  });

  // As for an error class that names itself after its stack is made.
  it("escapes the whole stack of an error whose stack starts with another name", () => {
    const thrown = new Error(message);
    expect(thrown.stack?.startsWith("Error: ")).toBe(true);
    thrown.name = "Renamed";
    const text = describeThrown(thrown);
    expect(text).toContain("a\\u000a::error title=x::pwned\\u001b");
    expect(unsafeLines(text)).toEqual([]);
  });

  it("escapes a thrown value that is not an error", () => {
    expect(describeThrown(message)).toBe(
      "a\\u000a::error title=x::pwned\\u001b",
    );
  });
});
