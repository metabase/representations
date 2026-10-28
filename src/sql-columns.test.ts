import { beforeAll, describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { createSqlColumnReader, type SqlColumnReader } from "./sql-columns.js";
import {
  loadSqlParser,
  type TableReplacement,
  type Unread,
} from "./sql-parser.js";

const engineOf: EngineOf = (database) =>
  database === "Warehouse" ? "postgres" : database === "Docs" ? "mongo" : null;

let columns: SqlColumnReader;

beforeAll(async () => {
  columns = createSqlColumnReader(await loadSqlParser(), engineOf);
}, 60_000);

const column = (schema: string | null, table: string, name: string) => ({
  table: {
    database: "Warehouse",
    schema,
    name: table,
    nullSchema: "default" as const,
  },
  column: name,
});

describe("readColumns", () => {
  it.each([
    [
      "a column qualified by its table's alias, in every clause",
      "SELECT o.id, sum(o.total - o.discount) AS net FROM public.orders o WHERE o.status = 'paid' GROUP BY o.id",
      [
        column("public", "orders", "discount"),
        column("public", "orders", "id"),
        column("public", "orders", "status"),
        column("public", "orders", "total"),
      ],
    ],
    [
      "an unqualified column of the only table its scope reads",
      "SELECT id FROM orders",
      [column(null, "orders", "id")],
    ],
    [
      "the column of a real table a CTE passes on, under the CTE's alias",
      "WITH c AS (SELECT total AS t FROM orders) SELECT c.t FROM c",
      [column(null, "orders", "total")],
    ],
    [
      "no unqualified column of a scope that reads two tables",
      "SELECT id FROM orders o JOIN people p ON o.user_id = p.id",
      [column(null, "orders", "user_id"), column(null, "people", "id")],
    ],
    [
      "no unqualified column a correlated subquery may take from either scope",
      "SELECT id FROM people WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = id)",
      [column(null, "people", "id")],
    ],
    [
      "no select alias that an ORDER BY names",
      "SELECT x AS y FROM t ORDER BY y",
      [column(null, "t", "x")],
    ],
    ["no column of SELECT *", "SELECT * FROM orders", []],
  ])("reads %s", (_, sql, expected) => {
    const result = columns.readColumns(sql, "Warehouse");
    expect(
      result.status === "read"
        ? [...result.columns].sort((a, b) =>
            `${a.table.name}.${a.column}`.localeCompare(
              `${b.table.name}.${b.column}`,
            ),
          )
        : result,
    ).toEqual(expected);
  });

  it("reads no column a template tag became", () => {
    expect(
      columns.readColumns("SELECT {{x}} FROM orders", "Warehouse"),
    ).toEqual({ status: "read", columns: [] });
  });

  it("refuses SQL it cannot parse, and a snippet left in it", () => {
    expect(columns.readColumns("SELECT FROM WHERE", "Warehouse").status).toBe(
      "unread",
    );
    expect(
      columns.readColumns("SELECT * FROM a WHERE {{snippet: f}}", "Warehouse"),
    ).toEqual({ status: "unread", reason: "the query has a snippet" });
  });
});

describe("returnedNames", () => {
  it.each([
    [
      "each column's alias, or its name",
      "SELECT p.category, count(*) AS n, sum(o.total) AS revenue FROM orders o JOIN products p ON o.product_id = p.id GROUP BY p.category",
      ["category", "n", "revenue"],
    ],
    [
      "a union's columns by its first query's names",
      "SELECT a FROM t UNION ALL SELECT b AS c FROM u",
      ["a"],
    ],
    ["no names for SELECT *", "SELECT *, 1 AS one FROM orders", null],
    [
      "no names for an expression with no alias",
      "SELECT id + 1 FROM orders",
      null,
    ],
    [
      "no names for a template tag with no alias",
      "SELECT {{x}} FROM orders",
      null,
    ],
  ])("gives %s", (_, sql, names) => {
    expect(columns.returnedNames(sql, "Warehouse")).toEqual({
      status: "read",
      names,
    });
  });
});

describe("danglingQualifiers", () => {
  const replacing = (schema: string | null, table: string): TableReplacement =>
    [
      schema === null ? { table } : { schema, table },
      { db: null, schema: null, table: "mb_test_1" },
    ] as const;

  it("names a qualifier that names no table once its table is replaced", () => {
    expect(
      columns.danglingQualifiers(
        "SELECT orders.id FROM analytics.orders",
        "Warehouse",
        [replacing("analytics", "orders")],
      ),
    ).toEqual({ status: "read", names: ["orders"] });
  });

  it("names none when replace_names follows the qualifier, or an alias qualifies the column", () => {
    for (const sql of [
      "SELECT orders.id FROM orders",
      "SELECT o.id FROM analytics.orders o",
    ]) {
      expect(
        columns.danglingQualifiers(sql, "Warehouse", [
          replacing("analytics", "orders"),
          replacing(null, "orders"),
        ]),
      ).toEqual({ status: "read", names: [] });
    }
  });
});

describe("an engine whose native queries are not SQL", () => {
  it("is read by no function", () => {
    const unread: Unread = {
      status: "unread",
      reason:
        "native queries on mongo are not SQL; the lint does not read them",
    };
    const query = '[{"$match": {}}]';
    expect(columns.readColumns(query, "Docs")).toEqual(unread);
    expect(columns.returnedNames(query, "Docs")).toEqual(unread);
    expect(columns.danglingQualifiers(query, "Docs", [])).toEqual(unread);
  });
});
