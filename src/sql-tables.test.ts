import { describe, expect, it } from "bun:test";

import { tablesReadBySql } from "./sql-tables.js";

describe("tablesReadBySql", () => {
  it.each([
    [
      "a bare table",
      "SELECT * FROM ORDERS",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a schema-qualified table",
      "SELECT * FROM TRANSFORMS.product_revenue_report",
      [{ schema: "TRANSFORMS", name: "product_revenue_report" }],
    ],
    [
      "a catalog-qualified table, keeping schema and name",
      "SELECT * FROM db.PUBLIC.ORDERS",
      [{ schema: "PUBLIC", name: "ORDERS" }],
    ],
    [
      "quoted identifiers",
      'SELECT * FROM "PUBLIC"."ORDERS"',
      [{ schema: "PUBLIC", name: "ORDERS" }],
    ],
    [
      "a join with aliases",
      "SELECT * FROM ORDERS o JOIN PRODUCTS AS p ON o.PRODUCT_ID = p.ID",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PRODUCTS" },
      ],
    ],
    [
      "a comma list",
      "SELECT * FROM ORDERS o, PRODUCTS p WHERE o.PRODUCT_ID = p.ID",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PRODUCTS" },
      ],
    ],
    [
      "a table read twice, once",
      "SELECT * FROM ORDERS a JOIN orders b ON a.ID = b.ID",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a subquery",
      "SELECT * FROM (SELECT * FROM ORDERS) o JOIN PEOPLE p ON o.USER_ID = p.ID",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "a CTE, leaving out its name",
      "WITH recent AS (SELECT * FROM ORDERS), big (id) AS (SELECT ID FROM recent) SELECT * FROM big",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "FROM inside a function call, ignored",
      "SELECT EXTRACT(YEAR FROM CREATED_AT), TRIM(BOTH ' ' FROM NAME) FROM ORDERS",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "comments and string literals, ignored",
      "SELECT 'FROM fake' AS x -- FROM nope\n/* JOIN nada */ FROM ORDERS",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a quoted schema holding a dot, apart from a quoted name holding one",
      'SELECT * FROM "a.b".c JOIN "a"."b.c" ON 1 = 1',
      [
        { schema: "a.b", name: "c" },
        { schema: "a", name: "b.c" },
      ],
    ],
    [
      "an empty quoted schema, apart from no schema",
      'SELECT * FROM "".c JOIN c ON 1 = 1',
      [
        { schema: "", name: "c" },
        { schema: null, name: "c" },
      ],
    ],
    ["no FROM", "SELECT 1", []],
    [
      "a variable in an optional clause",
      "SELECT * FROM ORDERS WHERE TRUE [[AND TOTAL > {{min_total}}]]",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a card reference, as no table",
      "SELECT * FROM {{#12-orders}} o JOIN PEOPLE p ON o.USER_ID = p.ID",
      [{ schema: null, name: "PEOPLE" }],
    ],
  ])("reads %s", (_, sql, tables) => {
    expect(tablesReadBySql(sql)).toEqual({ status: "read", tables });
  });

  it.each([
    ["a snippet", "SELECT * FROM {{snippet: orders}}"],
    ["a table function", "SELECT * FROM generate_series(1, 3)"],
    ["a FROM with no table", "SELECT * FROM"],
  ])("refuses %s", (_, sql) => {
    expect(tablesReadBySql(sql).status).toBe("unread");
  });
});
