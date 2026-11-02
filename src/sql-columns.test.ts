import { beforeAll, describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { createSqlColumnReader, type SqlColumnReader } from "./sql-columns.js";
import { loadSqlParser, type SqlParser, type Unread } from "./sql-parser.js";

const engineOf: EngineOf = (database) =>
  database === "Warehouse" ? "postgres" : database === "Docs" ? "mongo" : null;

let columns: SqlColumnReader;
let sharedParser: SqlParser;

beforeAll(async () => {
  sharedParser = await loadSqlParser();
  columns = createSqlColumnReader(sharedParser, engineOf);
}, 60_000);

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
      "no names for SELECT * over a CTE whose alias names its columns",
      "WITH c(x, y) AS (SELECT a, b FROM t) SELECT * FROM c",
      null,
    ],
    [
      "no names for a table's columns by table.*",
      "SELECT o.*, p.name FROM orders o JOIN people p ON o.uid = p.id",
      null,
    ],
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

describe("an engine whose native queries are not SQL", () => {
  it("is not read", () => {
    const unread: Unread = {
      status: "unread",
      reason:
        "native queries on mongo are not SQL; the lint does not read them",
    };
    const query = '[{"$match": {}}]';
    expect(columns.returnedNames(query, "Docs")).toEqual(unread);
  });
});
