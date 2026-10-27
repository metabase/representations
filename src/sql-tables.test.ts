import { describe, expect, it } from "bun:test";

import { tablesReadBySql, valuedTagNames } from "./sql-tables.js";

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
      "the real table a CTE of the same name reads",
      "WITH orders AS (SELECT * FROM orders WHERE TOTAL > 0) SELECT * FROM orders",
      [{ schema: null, name: "orders" }],
    ],
    [
      "a table named like a CTE of a subquery, outside that subquery",
      "SELECT * FROM (WITH recent AS (SELECT * FROM ORDERS) SELECT * FROM recent) r JOIN recent x ON r.ID = x.ID",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "recent" },
      ],
    ],
    [
      "a recursive CTE reading itself, as no table",
      "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT * FROM n",
      [],
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
    [
      "IS DISTINCT FROM, as an operator",
      "SELECT * FROM ORDERS o WHERE o.TOTAL IS DISTINCT FROM o.SUBTOTAL OR o.TAX IS NOT DISTINCT FROM NULL",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "FROM ONLY and JOIN ONLY, leaving out ONLY",
      "SELECT * FROM ONLY PUBLIC.ORDERS o, ONLY PRODUCTS JOIN ONLY PEOPLE p ON o.USER_ID = p.ID",
      [
        { schema: "PUBLIC", name: "ORDERS" },
        { schema: null, name: "PRODUCTS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "a table after a subquery in a comma list",
      "SELECT * FROM (SELECT * FROM ORDERS) o, PEOPLE p WHERE o.USER_ID = p.ID",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "a table after a join in a comma list",
      "SELECT * FROM ORDERS o JOIN PEOPLE p ON o.USER_ID = p.ID, PRODUCTS",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
        { schema: null, name: "PRODUCTS" },
      ],
    ],
    [
      "a parenthesized join",
      "SELECT * FROM (ORDERS o JOIN PEOPLE p ON o.USER_ID = p.ID)",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "comment markers inside string literals, as text",
      "SELECT '--' AS a, '/*' AS b FROM ORDERS WHERE NOTE <> '*/'",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "quotes inside a comment, as comment text",
      "SELECT * -- it's\nFROM ORDERS",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a backtick-quoted name holding its qualifiers",
      "SELECT * FROM `project.dataset.ORDERS`",
      [{ schema: "dataset", name: "ORDERS" }],
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

// Metabase compiles a transform with no parameter values: an optional clause
// stays only when every tag in it has a value of its own (a default, or a
// card, snippet or table).
describe("tablesReadBySql with the tags that have values", () => {
  const JOIN_PEOPLE =
    "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.ID = o.USER_ID AND p.STATE = {{state}}]]";

  it.each([
    [
      "drops an optional clause whose tag has no value",
      JOIN_PEOPLE,
      [],
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "keeps an optional clause whose tag has a value",
      JOIN_PEOPLE,
      ["state"],
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "keeps an optional clause with no tag",
      "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.ID = o.USER_ID]]",
      [],
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
    [
      "drops an optional clause with one tag of two without a value",
      "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.STATE = {{ state }} AND p.CITY = {{city}}]]",
      ["state"],
      [{ schema: null, name: "ORDERS" }],
    ],
  ] as const)("%s", (_, sql, valued, tables) => {
    expect(tablesReadBySql(sql, new Set(valued))).toEqual({
      status: "read",
      tables: [...tables],
    });
  });
});

describe("valuedTagNames", () => {
  const tag = (type: string, name: string, extra: object = {}) => ({
    type,
    name,
    id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
    ...extra,
  });

  it("names the card, snippet and table tags, and the tags with a default", () => {
    expect(
      [
        ...valuedTagNames([
          tag("card", "#1-orders"),
          tag("snippet", "snippet: recent"),
          tag("table", "t"),
          tag("text", "with_default", { default: "CA" }),
          tag("text", "without_default"),
          tag("number", "null_default", { default: null }),
          tag("boolean", "false_default", { default: false }),
          tag("dimension", "dimension_false_default", { default: false }),
          tag("dimension", "dimension_without_default"),
        ]),
      ].sort(),
    ).toEqual([
      "#1-orders",
      "dimension_false_default",
      "snippet: recent",
      "t",
      "with_default",
    ]);
  });

  it("reads the legacy map of tags by name", () => {
    expect([
      ...valuedTagNames({
        a: tag("text", "a", { default: "x" }),
        b: tag("text", "b"),
      }),
    ]).toEqual(["a"]);
  });

  it("names nothing when there are no tags", () => {
    expect([...valuedTagNames(undefined)]).toEqual([]);
  });
});
