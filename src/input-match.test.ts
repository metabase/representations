import { describe, expect, it } from "bun:test";

import { inputCovers, inputsCollide } from "./input-match.js";

const t = (schema: string | null, name: string) => ({ schema, name });

describe("inputCovers", () => {
  it.each([
    ["both unqualified", t(null, "ORDERS"), t(null, "orders"), "public", true],
    [
      "both in one schema",
      t("PUBLIC", "ORDERS"),
      t("public", "ORDERS"),
      "other",
      true,
    ],
    [
      "an unqualified read, an input in the default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      true,
    ],
    [
      "an unqualified read, an input in another schema",
      t(null, "ORDERS"),
      t("OTHER", "ORDERS"),
      "public",
      false,
    ],
    [
      "an unqualified read, a database with no default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      null,
      false,
    ],
    [
      "a qualified read, an unqualified input",
      t("PUBLIC", "ORDERS"),
      t(null, "ORDERS"),
      "public",
      false,
    ],
    ["two schemas", t("A", "ORDERS"), t("B", "ORDERS"), "a", false],
    ["two names", t(null, "ORDERS"), t(null, "PEOPLE"), "public", false],
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
      "public",
      true,
    ],
    [
      "one schema, in two cases",
      t("PUBLIC", "ORDERS"),
      t("public", "orders"),
      "other",
      true,
    ],
    [
      "unqualified and in the default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      true,
    ],
    [
      "unqualified and in another schema",
      t(null, "ORDERS"),
      t("RAW", "ORDERS"),
      "public",
      false,
    ],
    [
      "unqualified and qualified, a database with no default schema",
      t(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      null,
      false,
    ],
    [
      "two schemas, one the default",
      t("PUBLIC", "ORDERS"),
      t("RAW", "ORDERS"),
      "public",
      false,
    ],
    [
      "a dot in the schema, and one in the name",
      t("a.b", "c"),
      t("a", "b.c"),
      "a",
      false,
    ],
    ["two names", t(null, "ORDERS"), t(null, "PEOPLE"), "public", false],
  ] as const)("%s", (_, a, b, defaultSchema, expected) => {
    expect(inputsCollide(a, b, defaultSchema)).toBe(expected);
    expect(inputsCollide(b, a, defaultSchema)).toBe(expected);
  });
});
