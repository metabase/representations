import { describe, expect, it } from "bun:test";

import { inputCovers, tableKeys } from "./input-match.js";

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

describe("tableKeys", () => {
  it.each([
    ["an unqualified table", t(null, "ORDERS"), undefined, ["orders"]],
    [
      "a table in the default schema",
      t("PUBLIC", "ORDERS"),
      "public",
      ["public.orders", "orders"],
    ],
    ["a table in another schema", t("RAW", "ORDERS"), "public", ["raw.orders"]],
    [
      "a qualified table, the default unknown",
      t("PUBLIC", "ORDERS"),
      undefined,
      ["public.orders"],
    ],
  ] as const)("%s", (_, table, defaultSchema, expected) => {
    expect(tableKeys(table, defaultSchema)).toEqual([...expected]);
  });
});
