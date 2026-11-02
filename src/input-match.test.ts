import { beforeAll, describe, expect, it } from "bun:test";

import {
  inputCovers,
  isStandIn,
  replacesQuoted,
  standInReplacements,
} from "./input-match.js";
import { loadSqlParser, type SqlParser } from "./sql-parser.js";

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

describe("replacesQuoted", () => {
  let parser: SqlParser;
  beforeAll(async () => {
    parser = await loadSqlParser();
  }, 60_000);

  it("agrees with Metabase's rewrite of a reference with every part quoted", () => {
    const schemas = [null, "public", "PUBLIC", "analytics"];
    const names = ["orders", "Orders"];
    const tables = schemas.flatMap((schema) =>
      names.map((name) => t(schema, name)),
    );
    for (const read of tables) {
      const sql = `SELECT * FROM ${read.schema === null ? "" : `"${read.schema}".`}"${read.name}"`;
      for (const input of tables) {
        const rewritten = parser.replaceNames(
          sql,
          standInReplacements([input], "public"),
          "postgres",
        );
        if (rewritten.status !== "read") {
          throw new Error(rewritten.reason);
        }
        const after = parser.referencedTables(rewritten.sql, "postgres");
        if (after.status !== "read") {
          throw new Error(after.reason);
        }
        expect({
          sql,
          input,
          replaced: replacesQuoted(read, [input], "public"),
        }).toEqual({ sql, input, replaced: after.tables.every(isStandIn) });
      }
    }
  });
});
