import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import { dialectOf, loadSqlParser, type SqlParser } from "./sql-parser.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

describe("dialectOf", () => {
  it.each([
    ["postgres", "postgres"],
    ["sqlserver", "tsql"],
    ["bigquery-cloud-sdk", "bigquery"],
    ["starburst", "trino"],
    ["h2", null],
    ["vertica", null],
    ["oracle", "oracle"],
    [null, null],
  ] as const)(
    "maps engine %p to SQLGlot dialect %p, as Metabase does",
    (engine, dialect) => {
      expect(dialectOf(engine)).toBe(dialect);
    },
  );
});

describe("the vendored sources", () => {
  it("hold the SQLGlot wheel that sources.json names, with its hash", () => {
    const { sqlglot } = readVendorSources();
    expect(sqlglot.wheel).toBe(`sqlglot-${sqlglot.version}-py3-none-any.whl`);
    expect(
      createHash("sha256")
        .update(readFileSync(resolve(VENDOR_DIR, sqlglot.wheel)))
        .digest("hex"),
    ).toBe(sqlglot.sha256);
  });
});

describe("loadSqlParser", () => {
  let parser: SqlParser;

  beforeAll(async () => {
    parser = await loadSqlParser();
  }, 60_000);

  it("loads one parser per process", async () => {
    expect(await loadSqlParser()).toBe(parser);
  });

  it("reads the tables Metabase's referenced_tables reads, without the catalog", () => {
    expect(
      parser.referencedTables(
        "SELECT * FROM public.orders o JOIN customers c ON c.id = o.customer_id",
        "postgres",
      ),
    ).toEqual({
      status: "read",
      tables: [
        { schema: null, name: "customers" },
        { schema: "public", name: "orders" },
      ],
    });
    expect(
      parser.referencedTables("SELECT * FROM `proj.ds.orders`", "bigquery"),
    ).toEqual({ status: "read", tables: [{ schema: "ds", name: "orders" }] });
  });

  it("parses in SQLGlot's default dialect when given none", () => {
    // In the default dialect a backtick is not a quote, so this fails to parse.
    expect(
      parser.referencedTables("SELECT * FROM `proj.ds.orders`", null).status,
    ).toBe("unread");
    expect(parser.referencedTables("SELECT * FROM ORDERS", null)).toEqual({
      status: "read",
      tables: [{ schema: null, name: "ORDERS" }],
    });
  });

  it("reports a parse error, a recursion error or an unknown dialect as unread, with the error", () => {
    const unread = (sql: string, dialect: string | null) => {
      const result = parser.referencedTables(sql, dialect);
      return result.status === "unread" ? result.reason : null;
    };
    expect(unread("SELECT * FROM", "postgres")).toStartWith("ParseError: ");
    expect(
      unread(`SELECT ${"(".repeat(60)}1${")".repeat(60)}`, null),
    ).toStartWith("RecursionError: ");
    expect(unread("SELECT 1", "no-such-dialect")).not.toBeNull();
  });

  it("reads the fields Metabase's field_references reads: used, returned, and errors", () => {
    expect(
      parser.fieldReferences(
        "SELECT o.id, count(*) AS n FROM orders o WHERE ghost.x = 1 GROUP BY o.id",
        "postgres",
      ),
    ).toEqual({
      status: "read",
      references: {
        usedFields: [
          {
            type: "single_column",
            column: "id",
            alias: null,
            sourceColumns: [
              [
                {
                  type: "all_columns",
                  table: { schema: null, name: "orders" },
                },
              ],
            ],
          },
        ],
        returnedFields: [
          {
            type: "single_column",
            column: "id",
            alias: null,
            sourceColumns: [
              [
                {
                  type: "all_columns",
                  table: { schema: null, name: "orders" },
                },
              ],
            ],
          },
          { type: "custom_field", alias: "n" },
        ],
        missingTableAliases: ["ghost"],
      },
    });
  });

  it("reads SQL field_references cannot parse, or a union's columns, as SQLGlot leaves them", () => {
    expect(parser.fieldReferences("SELECT * FROM", "postgres")).toEqual({
      status: "unread",
      reason: "field_references could not parse it",
    });
    const union = parser.fieldReferences(
      "SELECT a FROM t UNION ALL SELECT b FROM u",
      null,
    );
    expect(
      union.status === "read" ? union.references.returnedFields : null,
    ).toEqual([{ type: "composite_field", alias: "a" }]);
  });

  it("replaces table names as Metabase's replace_names does", () => {
    expect(
      parser.replaceNames(
        "SELECT orders.id FROM analytics.orders JOIN people p ON 1 = 1",
        [
          [
            { schema: "analytics", table: "orders" },
            { db: null, schema: null, table: "mb_test_1" },
          ],
          [{ table: "people" }, { db: null, schema: null, table: "mb_test_2" }],
        ],
        "postgres",
      ),
    ).toEqual({
      status: "read",
      sql: "SELECT orders.id FROM mb_test_1 JOIN mb_test_2 AS p ON 1 = 1",
    });
    expect(parser.replaceNames("SELECT * FROM", [], "postgres").status).toBe(
      "unread",
    );
  });

  it("gives the first line of SQLGlot's error, not the SQL it quotes with terminal escapes", () => {
    expect(parser.referencedTables("SELECT * FROM a b c", "postgres")).toEqual({
      status: "unread",
      reason:
        "ParseError: Invalid expression / Unexpected token. Line 1, Col: 19.",
    });
  });
});
