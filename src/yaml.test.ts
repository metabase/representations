import { describe, expect, it } from "bun:test";

import { readYaml, YamlReadError } from "./yaml.js";

/** The value of the document in `text`. */
const valueOf = (text: string): unknown => readYaml(text).value;

/** The value of `v` in the document `v: <plain>`. */
const plain = (text: string): unknown =>
  (valueOf(`v: ${text}\n`) as Record<string, unknown>).v;

// Each expected value is SnakeYAML 2.3's reading, with the loader options
// clj-yaml 1.0.29 and Metabase's `metabase.util.yaml` give it.
describe("readYaml", () => {
  it.each([
    ["NO", false],
    ["yes", true],
    ["on", true],
    ["Off", false],
    ["TRUE", true],
    ["017", 15],
    ["1:30", 90],
    ["-1:30", -90],
    ["190:20:30", 685230],
    ["1:30.5", 90.5],
    ["0b101", 5],
    ["0x1F", 31],
    ["1_000", 1000],
    ["+12", 12],
    ["1e3", 1000],
    [".5", 0.5],
    ["1.", 1],
    [".inf", Infinity],
    ["-.inf", -Infinity],
    ["~", null],
    ["Null", null],
    ["", null],
  ])("reads the plain value %p as %p", (text, value) => {
    expect(plain(text)).toEqual(value);
  });

  it.each([
    ["y", "the 1.1 spec's y and n are not booleans in SnakeYAML"],
    ["n", "the 1.1 spec's y and n are not booleans in SnakeYAML"],
    ["tRUE", "a boolean has one of three cases"],
    ["nULL", "null has one of three cases"],
    ["08", "an octal must have octal digits"],
    ["0o17", "0o is YAML 1.2's octal prefix"],
    ["1:70", "a base-60 digit is below 60"],
    ["e1", "an exponent needs a mantissa"],
    ["2024-1-5", "a date alone has two-digit months and days"],
  ])("reads the plain value %p as a string: %s", (text) => {
    expect(plain(text)).toBe(text);
  });

  it("reads NaN", () => {
    expect(plain(".NaN")).toBeNaN();
  });

  it("reads a negative zero integer as zero, and a negative zero float as -0", () => {
    expect(Object.is(plain("-0"), 0)).toBe(true);
    expect(Object.is(plain("-0.0"), -0)).toBe(true);
  });

  it.each([
    ["2002-12-14"],
    ["2001-12-14t21:59:43.10-05:00"],
    ["2001-12-14 21:59:43.10 -5"],
    ["2024-1-5 1:20:30"],
    ["2024-13-01"],
    ["1500-01-01"],
  ])("reads the plain value %p as a timestamp", (text) => {
    expect(plain(text)).toBeInstanceOf(Date);
  });

  it("reads a quoted value as a string", () => {
    expect(valueOf("a: 'NO'\nb: \"017\"\n")).toEqual({ a: "NO", b: "017" });
  });

  it("merges `<<` keys, the mapping's own keys and earlier sources first", () => {
    expect(
      valueOf(
        "base: &b {a: 1, b: 2}\nm:\n  <<: *b\n  b: 3\nm2:\n  <<: [*b, {b: 5, c: 4}]\n",
      ),
    ).toEqual({
      base: { a: 1, b: 2 },
      m: { a: 1, b: 3 },
      m2: { a: 1, b: 2, c: 4 },
    });
  });

  it("names a key SnakeYAML reads as no string by its text, and lists where it is", () => {
    // SnakeYAML's keys: 1, true, null, false, 15 and a list.
    expect(
      readYaml(
        "1: a\nyes: b\n~: c\nm:\n  - NO: d\n    017: e\n    s: f\n? [x]\n: g\n",
      ),
    ).toEqual({
      value: {
        "1": "a",
        yes: "b",
        "~": "c",
        m: [{ NO: "d", "017": "e", s: "f" }],
        "[x]": "g",
      },
      nonStringKeys: [
        { path: [], source: "1", shadowed: false },
        { path: [], source: "yes", shadowed: false },
        { path: [], source: "~", shadowed: false },
        { path: ["m", 0], source: "NO", shadowed: false },
        { path: ["m", 0], source: "017", shadowed: false },
        { path: [], source: "[x]", shadowed: false },
      ],
      duplicateKeys: [],
    });
  });

  it.each([["1: a\n'1': b\n"], ["'1': b\n1: a\n"]])(
    "keeps the string key's value in %p, where SnakeYAML reads two keys",
    (text) => {
      expect(readYaml(text)).toEqual({
        value: { "1": "b" },
        nonStringKeys: [{ path: [], source: "1", shadowed: true }],
        duplicateKeys: [],
      });
    },
  );

  it("lists a non-string key once over the merged map, at the merging map's path", () => {
    expect(readYaml("m: {<<: {'1': p}, 1: q}\n")).toEqual({
      value: { m: { "1": "p" } },
      nonStringKeys: [{ path: ["m"], source: "1", shadowed: true }],
      duplicateKeys: [],
    });
    expect(readYaml("m: {<<: {1: x}, 1: y}\n")).toEqual({
      value: { m: { "1": "y" } },
      nonStringKeys: [{ path: ["m"], source: "1", shadowed: false }],
      duplicateKeys: [],
    });
    expect(readYaml("m:\n  <<: {1: x}\n  s: y\n").nonStringKeys).toEqual([
      { path: ["m"], source: "1", shadowed: false },
    ]);
  });

  it("lists a non-string key at each place an alias puts its map", () => {
    expect(
      readYaml("a: &r {1: x}\nrows:\n  - *r\nm:\n  <<: *r\n").nonStringKeys,
    ).toEqual([
      { path: ["a"], source: "1", shadowed: false },
      { path: ["rows", 0], source: "1", shadowed: false },
      { path: ["m"], source: "1", shadowed: false },
    ]);
  });

  it("reads an alias used as a key as the value it names", () => {
    expect(readYaml("k: &k name\n*k : v\n")).toEqual({
      value: { k: "name", name: "v" },
      nonStringKeys: [],
      duplicateKeys: [],
    });
    expect(readYaml("k: &k 1\n*k : v\n").nonStringKeys).toEqual([
      { path: [], source: "1", shadowed: false },
    ]);
  });

  it("checks an inline merge source as part of the document", () => {
    expect(() => readYaml('m:\n  <<: {a: "x\\/y"}\n')).toThrow(
      "the escape \\/ is not YAML 1.1 (2:11)",
    );
  });

  it.each([
    ["a scalar", "m:\n  <<: 1\n", "(2:7)"],
    ["a scalar in a list", "m:\n  <<: [{x: 1}, 3]\n", "(2:16)"],
  ])("refuses %s as a merge source, at its position", (_, text, position) => {
    expect(() => readYaml(text)).toThrow(YamlReadError);
    expect(() => readYaml(text)).toThrow(
      `expected a mapping or list of mappings for merging ${position}`,
    );
  });

  it.each([
    ["a duplicate key", "a: 1\nb: 2\na: 3\n", { a: 3, b: 2 }, "a", 3],
    [
      "two keys SnakeYAML reads as true",
      "yes: 1\ntrue: 2\n",
      { true: 2 },
      "true",
      2,
    ],
    ["two keys SnakeYAML reads as 1", "01: a\n1: b\n", { "1": "b" }, "1", 2],
    [
      "two keys SnakeYAML reads as 1.0",
      "1.0: a\n1.00: b\n",
      { "1.00": "b" },
      "1.00",
      2,
    ],
    [
      "two keys SnakeYAML reads as NaN",
      ".nan: a\n.nan: b\n",
      { ".nan": "b" },
      ".nan",
      2,
    ],
  ])(
    "reads %s with the last value, and lists where the key is written again",
    (_, text, value, source, line) => {
      const read = readYaml(text);
      expect(read.value).toEqual(value);
      expect(read.duplicateKeys).toEqual([{ source, line, column: 1 }]);
    },
  );

  it("lists a key written three times twice, in a nested map, and keeps a merge source's key apart", () => {
    const read = readYaml("m:\n  <<: {k: 0}\n  k: 1\n  k: 2\n  k: 3\n");
    expect(read.value).toEqual({ m: { k: 3 } });
    expect(read.duplicateKeys).toEqual([
      { source: "k", line: 4, column: 3 },
      { source: "k", line: 5, column: 3 },
    ]);
  });

  it("keeps SnakeYAML's types under a %YAML 1.2 directive", () => {
    expect(valueOf("%YAML 1.2\n---\na: yes\n")).toEqual({ a: true });
    expect(valueOf("%YAML 1.3\n---\na: yes\n")).toEqual({ a: true });
  });

  it.each([
    ["an unknown tag", "a: !foo x\n", "Unresolved tag: !foo (1:4)"],
    ["a float with no digits", "a: ._\n", "._ is not a float (1:4)"],
    [
      "<< as a value",
      "a: <<\n",
      "<< is a merge key and cannot be a value (1:4)",
    ],
    [
      "<< as a list item",
      "- <<\n",
      "<< is a merge key and cannot be a value (1:3)",
    ],
    ["the escape \\/", 'a: "x\\/y"\n', "the escape \\/ is not YAML 1.1 (1:4)"],
    [
      "the escape \\<TAB>",
      'a: "x\\\ty"\n',
      "the escape \\<TAB> is not YAML 1.1 (1:4)",
    ],
    [
      "a %YAML 2.0 directive",
      "%YAML 2.0\n---\na: 1\n",
      "found incompatible YAML document (version 1.* is required) (1:7)",
    ],
    [
      "a second document",
      "a: 1\n---\nb: 2\n",
      "Source contains multiple documents; please use YAML.parseAllDocuments() (2:1)",
    ],
    [
      "51 aliases to a list",
      `a: &x [1]\n${Array.from({ length: 51 }, (_, i) => `k${i}: *x\n`).join("")}`,
      "the document has more than 50 aliases to a map or list (52:6)",
    ],
  ])("refuses %s", (_, text, message) => {
    expect(() => readYaml(text)).toThrow(YamlReadError);
    expect(() => readYaml(text)).toThrow(message);
  });

  it.each([
    ["an integer and a float", "1: a\n1.0: b\n", { "1": "a", "1.0": "b" }],
    [
      "zero and negative zero floats",
      "0.0: a\n-0.0: b\n",
      { "0.0": "a", "-0.0": "b" },
    ],
  ])("reads %s as two keys, as SnakeYAML does", (_, text, value) => {
    expect(valueOf(text)).toEqual(value);
  });

  it("accepts 50 aliases to a list, and any number to a scalar", () => {
    const aliases = (n: number) =>
      Array.from({ length: n }, (_, i) => `k${i}: *x\n`).join("");
    expect(() => readYaml(`a: &x [1]\n${aliases(50)}`)).not.toThrow();
    expect(() => readYaml(`a: &x 1\n${aliases(100)}`)).not.toThrow();
  });

  it("refuses a document whose aliases expand to more than 3145728 nodes", () => {
    // Level i is a list of two aliases to level i - 1, so the document's
    // aliases expand to about 2^(n+2) nodes.
    const nested = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `l${i + 1}: &l${i + 1} [*l${i}, *l${i}]\n`,
      )
        .join("")
        .replace(/^/, "l0: &l0 {1: x}\n");
    expect(() => readYaml(nested(19))).not.toThrow();
    expect(() => readYaml(nested(20))).toThrow(
      /^the document's aliases expand to more than 3145728 nodes/,
    );
  });

  it("refuses a document whose content passes 3145728 code points, and accepts one that ends there", () => {
    // "é" is one code point but two UTF-16 units.
    const document = (codePoints: number) => `a: ${"é".repeat(codePoints - 3)}`;
    expect(() => readYaml(document(3_145_728))).not.toThrow();
    expect(() => readYaml(document(3_145_729))).toThrow(
      "the document exceeds the limit of 3145728 code points (1:1)",
    );
  });

  it("does not count a byte order mark toward the code-point limit", () => {
    const document = (codePoints: number) =>
      `\uFEFFa: ${"x".repeat(codePoints - 3)}`;
    expect(() => readYaml(document(3_145_728))).not.toThrow();
    expect(() => readYaml(document(3_145_729))).toThrow(
      "the document exceeds the limit of 3145728 code points (1:1)",
    );
  });

  // SnakeYAML checks the limit where its scanner stands after each token: a
  // plain scalar's scan takes in the spaces and line breaks after it.
  const LIMIT = 3_145_728;
  it.each([
    [
      "ends before a comment",
      `a: ${"x".repeat(LIMIT - 4)}\n# ${"x".repeat(10)}`,
    ],
    ["ends on a flow list", `a: [${"x".repeat(LIMIT - 6)}]\n  \n`],
    ["starts after a comment", `#\na: ${"x".repeat(LIMIT - 5)}`],
  ])("accepts a document whose content %s at the limit", (_, text) => {
    expect(() => readYaml(text)).not.toThrow();
  });

  it.each([
    ["is followed by line breaks", `a: ${"x".repeat(LIMIT - 4)}\n  \n`],
    ["starts after a comment", `#\na: ${"x".repeat(LIMIT - 4)}`],
  ])("refuses a plain scalar that %s past the limit", (_, text) => {
    expect(() => readYaml(text)).toThrow(
      "the document exceeds the limit of 3145728 code points (1:1)",
    );
  });
});
