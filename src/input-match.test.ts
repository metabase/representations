import { describe, expect, it } from "bun:test";

import { inputCovers, inputsCollide } from "./input-match.js";

const t = (schema: string | null, name: string) => ({ schema, name });

describe("inputCovers", () => {
  it.each([
    [
      "both unqualified",
      t(null, "ORDERS"),
      t(null, "orders"),
      undefined,
      "match",
    ],
    [
      "both in one schema",
      t("PUBLIC", "ORDERS"),
      t("public", "ORDERS"),
      undefined,
      "match",
    ],
    [
      "an unqualified read, an input in the default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      "match",
    ],
    [
      "an unqualified read, an input in another schema",
      t(null, "ORDERS"),
      t("OTHER", "ORDERS"),
      "public",
      "no-match",
    ],
    [
      "an unqualified read, an input in a schema, the default unknown",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      undefined,
      "undecided",
    ],
    [
      "an unqualified read, a database with no default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      null,
      "no-match",
    ],
    [
      "a qualified read, an unqualified input",
      t("PUBLIC", "ORDERS"),
      t(null, "ORDERS"),
      "public",
      "no-match",
    ],
    [
      "a qualified read, an unqualified input, the default unknown",
      t("PUBLIC", "ORDERS"),
      t(null, "ORDERS"),
      undefined,
      "no-match",
    ],
    ["two schemas", t("A", "ORDERS"), t("B", "ORDERS"), "a", "no-match"],
    ["two names", t(null, "ORDERS"), t(null, "PEOPLE"), undefined, "no-match"],
  ] as const)("%s", (_, read, input, defaultSchema, expected) => {
    expect(inputCovers(read, input, defaultSchema)).toBe(expected);
  });
});

describe("inputsCollide", () => {
  it.each([
    [
      "one table, in two cases",
      t(null, "ORDERS"),
      t(null, "orders"),
      undefined,
      "match",
    ],
    [
      "one schema, in two cases",
      t("PUBLIC", "ORDERS"),
      t("public", "orders"),
      undefined,
      "match",
    ],
    [
      "unqualified and in the default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      "match",
    ],
    [
      "unqualified and in another schema",
      t(null, "ORDERS"),
      t("RAW", "ORDERS"),
      "public",
      "no-match",
    ],
    [
      "unqualified and qualified, the default unknown",
      t("PUBLIC", "ORDERS"),
      t(null, "ORDERS"),
      undefined,
      "undecided",
    ],
    [
      "unqualified and qualified, a database with no default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      null,
      "no-match",
    ],
    [
      "two schemas, one the default",
      t("PUBLIC", "ORDERS"),
      t("RAW", "ORDERS"),
      "public",
      "no-match",
    ],
    [
      "two schemas, the default unknown",
      t("PUBLIC", "ORDERS"),
      t("RAW", "ORDERS"),
      undefined,
      "no-match",
    ],
    [
      "a dot in the schema, and one in the name",
      t("a.b", "c"),
      t("a", "b.c"),
      undefined,
      "no-match",
    ],
    ["two names", t(null, "ORDERS"), t(null, "PEOPLE"), undefined, "no-match"],
  ] as const)("%s", (_, a, b, defaultSchema, expected) => {
    expect(inputsCollide(a, b, defaultSchema)).toBe(expected);
    expect(inputsCollide(b, a, defaultSchema)).toBe(expected);
  });
});
