import { beforeAll, describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { loadSqlParser, type SqlParser } from "./sql-parser.js";
import {
  createSqlTableReader,
  type SqlTableReader,
  valuedTagNames,
} from "./sql-tables.js";

const ENGINES: Readonly<Record<string, string>> = {
  Warehouse: "postgres",
  Lake: "bigquery-cloud-sdk",
  Docs: "mongo",
};
const engineOf: EngineOf = (database) =>
  database !== null && Object.hasOwn(ENGINES, database)
    ? ENGINES[database]
    : null;

let readSql: SqlTableReader;

beforeAll(async () => {
  readSql = createSqlTableReader(await loadSqlParser(), engineOf);
}, 60_000);

describe("a SQL table reader", () => {
  it.each([
    [
      "the tables Metabase reads, sorted, each once whatever its case",
      "SELECT * FROM PUBLIC.ORDERS o JOIN PEOPLE p ON o.USER_ID = p.ID JOIN people x ON x.ID = p.ID",
      [
        { schema: null, name: "PEOPLE" },
        { schema: "PUBLIC", name: "ORDERS" },
      ],
    ],
    [
      "a catalog-qualified table, keeping schema and name",
      "SELECT * FROM db.PUBLIC.ORDERS",
      [{ schema: "PUBLIC", name: "ORDERS" }],
    ],
    [
      "the real table a CTE of the same name reads, and not the CTE",
      "WITH orders AS (SELECT * FROM orders WHERE TOTAL > 0) SELECT * FROM orders",
      [{ schema: null, name: "orders" }],
    ],
    [
      "no table from a table function, as Metabase",
      "SELECT * FROM generate_series(1, 3)",
      [],
    ],
    [
      "the table a statement writes, as Metabase",
      "INSERT INTO audit SELECT * FROM ORDERS",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "audit" },
      ],
    ],
    [
      "a variable, as a value",
      "SELECT * FROM ORDERS WHERE TOTAL > {{min_total}} LIMIT {{n}}",
      [{ schema: null, name: "ORDERS" }],
    ],
    [
      "a card reference, as no table",
      "SELECT * FROM {{#12-orders}} o JOIN PEOPLE p ON o.USER_ID = p.ID",
      [{ schema: null, name: "PEOPLE" }],
    ],
    [
      "a template tag after a schema as a table, named as written",
      "SELECT * FROM PUBLIC.{{ t }} JOIN {{u}} ON 1 = 1",
      [{ schema: "PUBLIC", name: "{{t}}" }],
    ],
    [
      "the text of an optional clause whose tags have values",
      "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.STATE = {{state}}]]",
      [
        { schema: null, name: "ORDERS" },
        { schema: null, name: "PEOPLE" },
      ],
    ],
  ])("reads %s", (_, sql, tables) => {
    expect(readSql(sql, null, new Set(["state"]))).toEqual({
      status: "read",
      tables,
    });
  });

  it("strips a large literal list before parsing, as Metabase does", () => {
    const list = Array.from({ length: 150 }, (_, i) => String(i)).join(", ");
    // `1 2` does not parse, but Metabase strips the whole list first.
    expect(
      readSql(`SELECT * FROM t WHERE id IN (${list}, 1 2)`, "Warehouse"),
    ).toEqual({ status: "read", tables: [{ schema: null, name: "t" }] });
  });

  it("reads SQL that is not a native query as written, with no template tags", () => {
    expect(readSql("SELECT * FROM t WHERE x = '{{snippet: s}}'", null)).toEqual(
      { status: "read", tables: [{ schema: null, name: "t" }] },
    );
    expect(readSql("SELECT * FROM {{t}}", null)).toMatchObject({
      status: "unread",
    });
  });

  it("parses in the dialect of the database's engine", () => {
    const backticked = "SELECT * FROM `proj.ds.orders`";
    expect(readSql(backticked, "Lake")).toEqual({
      status: "read",
      tables: [{ schema: "ds", name: "orders" }],
    });
    expect(readSql(backticked, "Warehouse").status).toBe("unread");
  });

  it("refuses, without parsing, the native query of an engine whose queries are not SQL", () => {
    const parser: SqlParser = {
      referencedTables: () => {
        throw new Error("parsed");
      },
      fieldReferences: () => {
        throw new Error("parsed");
      },
      replaceNames: () => {
        throw new Error("parsed");
      },
      queryShape: () => {
        throw new Error("parsed");
      },
    };
    expect(
      createSqlTableReader(parser, engineOf)('[{"$match": {}}]', "Docs"),
    ).toEqual({
      status: "unread",
      reason:
        "native queries on mongo are not SQL; the lint does not read them",
    });
  });

  it("refuses a query with a snippet left in it, which SQLGlot would parse", () => {
    expect(
      readSql("SELECT * FROM a WHERE {{snippet: filters}}", null, new Set()),
    ).toEqual({ status: "unread", reason: "the query has a snippet" });
  });

  it("refuses SQL SQLGlot cannot parse, giving SQLGlot's error", () => {
    const result = readSql("SELECT * FROM a b c", "Warehouse");
    expect(result).toEqual({
      status: "unread",
      reason:
        "SQLGlot could not parse it: ParseError: Invalid expression / Unexpected token. Line 1, Col: 19.",
    });
  });
});

// Metabase compiles a transform with no parameter values: an optional clause
// stays only when every tag in it has a value of its own (a default, or a
// card, snippet or table).
describe("a SQL table reader with the tags that have values", () => {
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
      "drops an optional clause with one tag of two without a value",
      "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.STATE = {{ state }} AND p.CITY = {{city}}]]",
      ["state"],
      [{ schema: null, name: "ORDERS" }],
    ],
  ] as const)("%s", (_, sql, valued, tables) => {
    expect(readSql(sql, null, new Set(valued))).toEqual({
      status: "read",
      tables: [...tables],
    });
  });
});

// Metabase's parser (`metabase.lib.parse`) reads `[[`, `{{` and their ends
// inside a SQL comment as text, and inside a string literal as a tag or a
// clause only when one parses.
describe("a SQL table reader of template tags in comments and strings", () => {
  it("reads a FROM clause after a line comment that holds a lone [[", () => {
    expect(
      readSql(
        "-- arrays look like a[[1]\nSELECT * FROM people p JOIN orders o ON o.user_id = p.id [[AND o.x = {{x}}]]",
        null,
        new Set(),
      ),
    ).toEqual({
      status: "read",
      tables: [
        { schema: null, name: "orders" },
        { schema: null, name: "people" },
      ],
    });
  });

  it("reads SQL whose block comment holds an unmatched [[ before an optional clause", () => {
    expect(
      readSql(
        "SELECT * FROM people /* [[ old */ [[WHERE x = {{x}}]]",
        null,
        new Set(["x"]),
      ),
    ).toEqual({ status: "read", tables: [{ schema: null, name: "people" }] });
  });

  it("reads a snippet tag inside a comment as text", () => {
    expect(
      readSql("SELECT * FROM t -- {{snippet: gone}}", null, new Set()),
    ).toEqual({
      status: "read",
      tables: [{ schema: null, name: "t" }],
    });
    expect(
      readSql("SELECT * FROM t /* {{snippet: gone}} */", null, new Set()),
    ).toEqual({
      status: "read",
      tables: [{ schema: null, name: "t" }],
    });
  });

  it("reads an unmatched [[ in a string literal as text, and a tag there as a tag", () => {
    expect(
      readSql("SELECT * FROM t WHERE x = 'a[[b'", null, new Set()),
    ).toEqual({
      status: "read",
      tables: [{ schema: null, name: "t" }],
    });
    expect(
      readSql("SELECT * FROM t [[JOIN u ON u.x = '{{v}}']]", null, new Set()),
    ).toEqual({ status: "read", tables: [{ schema: null, name: "t" }] });
  });

  it("refuses what Metabase refuses: an unmatched [[ and an optional clause with no tag", () => {
    expect(readSql("SELECT * FROM t [[WHERE x = 1", null, new Set())).toEqual({
      status: "unread",
      reason:
        "Metabase cannot parse its template tags: Invalid query: found '[[' or '{{' with no matching ']]' or '}}'",
    });
    expect(
      readSql(
        "SELECT * FROM ORDERS o [[JOIN PEOPLE p ON p.ID = o.USER_ID]]",
        null,
        new Set(),
      ),
    ).toEqual({
      status: "unread",
      reason:
        "Metabase cannot parse its template tags: [[...]] clauses must contain at least one '{{...}}' clause.",
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
