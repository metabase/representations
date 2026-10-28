import { describe, expect, it } from "bun:test";

import { inputCovers } from "./input-match.js";

const t = (schema: string | null, name: string) => ({ schema, name });

/** A table a query reads by an unqualified or qualified SQL name. */
const sql = (schema: string | null, name: string) => ({
  schema,
  name,
  nullSchema: "default" as const,
});

/** A table a query reads by an MBQL reference, `[database, schema, table]`. */
const mbql = (schema: string | null, name: string) => ({
  schema,
  name,
  nullSchema: "none" as const,
});

describe("inputCovers", () => {
  it.each([
    [
      "both unqualified",
      sql(null, "ORDERS"),
      t(null, "orders"),
      "public",
      true,
    ],
    [
      "both in one schema",
      sql("PUBLIC", "ORDERS"),
      t("public", "ORDERS"),
      "other",
      true,
    ],
    [
      "an unqualified read, an input in the default schema",
      sql(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      true,
    ],
    [
      "an unqualified read, an input in another schema",
      sql(null, "ORDERS"),
      t("OTHER", "ORDERS"),
      "public",
      false,
    ],
    [
      "an unqualified read, a database with no default schema",
      sql(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      null,
      false,
    ],
    [
      "a qualified read, an unqualified input",
      sql("PUBLIC", "ORDERS"),
      t(null, "ORDERS"),
      "public",
      false,
    ],
    [
      "an MBQL read with no schema, an input in the default schema",
      mbql(null, "ORDERS"),
      t("PUBLIC", "ORDERS"),
      "public",
      false,
    ],
    [
      "an MBQL read with no schema, an unqualified input",
      mbql(null, "ORDERS"),
      t(null, "ORDERS"),
      "public",
      true,
    ],
    [
      "an MBQL read in the default schema, an input there",
      mbql("PUBLIC", "ORDERS"),
      t("public", "ORDERS"),
      "public",
      true,
    ],
    ["two schemas", sql("A", "ORDERS"), t("B", "ORDERS"), "a", false],
    ["two names", sql(null, "ORDERS"), t(null, "PEOPLE"), "public", false],
  ] as const)("%s", (_, read, input, defaultSchema, expected) => {
    expect(inputCovers(read, input, defaultSchema)).toBe(expected);
  });
});
