import { describe, expect, it } from "bun:test";

import { createSourceFinder } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import type { TableKey } from "./tables.js";

const findSources = createSourceFinder(loadSchemas());

const DB = "Sample Database";
const field = (table: string, name: string, options: object = {}) => [
  "field",
  options,
  [DB, null, table, name],
];

function transform(stages: object[]) {
  return {
    name: "T",
    entity_id: "TTTTTTTTTTTTTTTTTTTTT",
    creator_id: "a@example.com",
    source_database_id: DB,
    source: {
      type: "query",
      query: { "lib/type": "mbql/query", database: DB, stages },
    },
    target: { database: DB, type: "table", schema: "T", name: "t" },
    "serdes/meta": [{ model: "Transform" }],
  };
}

const mbql = (stage: object) => ({ "lib/type": "mbql.stage/mbql", ...stage });

describe("createSourceFinder", () => {
  it("finds a stage's source table", () => {
    const sources = findSources(
      transform([mbql({ "source-table": [DB, null, "ORDERS"] })]),
      "Transform",
    );
    expect(sources.tables).toEqual([
      { database: DB, schema: null, name: "ORDERS", nullSchema: "none" },
    ]);
  });

  it("keeps a schema named null apart from no schema, and a table once in any case", () => {
    const sources = findSources(
      transform([
        mbql({
          "source-table": [DB, "null", "ORDERS"],
          joins: [
            {
              alias: "Orders",
              stages: [mbql({ "source-table": [DB, null, "ORDERS"] })],
              conditions: [
                [
                  "=",
                  {},
                  field("orders", "ID"),
                  field("ORDERS", "ID", { "join-alias": "Orders" }),
                ],
              ],
            },
          ],
        }),
      ]),
      "Transform",
    );
    expect(sources.tables).toEqual([
      { database: DB, schema: "null", name: "ORDERS", nullSchema: "none" },
      { database: DB, schema: null, name: "ORDERS", nullSchema: "none" },
    ]);
  });

  it("finds the column of each field id in a query, a foreign key's too", () => {
    const sources = findSources(
      transform([
        mbql({
          "source-table": [DB, null, "ORDERS"],
          aggregation: [["sum", {}, field("ORDERS", "TOTAL")]],
          breakout: [
            field("PRODUCTS", "CATEGORY", {
              "source-field": [DB, null, "ORDERS", "PRODUCT_ID"],
            }),
          ],
        }),
      ]),
      "Transform",
    );
    const orders: TableKey = {
      database: DB,
      schema: null,
      name: "ORDERS",
      nullSchema: "none",
    };
    expect(sources.fields).toEqual([
      { table: orders, column: "TOTAL" },
      { table: orders, column: "PRODUCT_ID" },
      {
        table: {
          database: DB,
          schema: null,
          name: "PRODUCTS",
          nullSchema: "none",
        },
        column: "CATEGORY",
      },
    ]);
  });

  it("finds a joined table and the tables of the fields in its conditions", () => {
    const sources = findSources(
      transform([
        mbql({
          "source-table": [DB, null, "ORDERS"],
          joins: [
            {
              alias: "People",
              stages: [mbql({ "source-table": [DB, null, "PEOPLE"] })],
              conditions: [
                [
                  "=",
                  {},
                  field("ORDERS", "USER_ID"),
                  field("PEOPLE", "ID", { "join-alias": "People" }),
                ],
              ],
            },
          ],
        }),
      ]),
      "Transform",
    );
    expect(sources.tables.map((t) => t.name).sort()).toEqual([
      "ORDERS",
      "PEOPLE",
    ]);
  });

  it("finds the table an implicit join reaches through a foreign key", () => {
    const sources = findSources(
      transform([
        mbql({
          "source-table": [DB, null, "ORDERS"],
          breakout: [
            field("PRODUCTS", "CATEGORY", {
              "source-field": [DB, null, "ORDERS", "PRODUCT_ID"],
            }),
          ],
        }),
      ]),
      "Transform",
    );
    expect(sources.tables.map((t) => t.name).sort()).toEqual([
      "ORDERS",
      "PRODUCTS",
    ]);
  });

  it("finds a source card", () => {
    const sources = findSources(
      transform([mbql({ "source-card": "CCCCCCCCCCCCCCCCCCCCC" })]),
      "Transform",
    );
    expect(sources.entities).toEqual(["CCCCCCCCCCCCCCCCCCCCC"]);
  });

  it("finds metric, measure and segment references", () => {
    const sources = findSources(
      transform([
        mbql({
          "source-table": [DB, null, "ORDERS"],
          aggregation: [
            ["metric", {}, "MMMMMMMMMMMMMMMMMMMMM"],
            ["measure", {}, "EEEEEEEEEEEEEEEEEEEEE"],
          ],
          filters: [["segment", {}, "SSSSSSSSSSSSSSSSSSSSS"]],
        }),
      ]),
      "Transform",
    );
    expect(sources.entities.sort()).toEqual([
      "EEEEEEEEEEEEEEEEEEEEE",
      "MMMMMMMMMMMMMMMMMMMMM",
      "SSSSSSSSSSSSSSSSSSSSS",
    ]);
  });

  it("returns a native stage's SQL with the query's database", () => {
    const sources = findSources(
      transform([
        { "lib/type": "mbql.stage/native", native: "SELECT * FROM ORDERS" },
      ]),
      "Transform",
    );
    expect(sources.natives).toEqual([
      {
        sql: "SELECT * FROM ORDERS",
        database: DB,
        valuedTags: new Set(),
        snippetIds: new Map(),
      },
    ]);
  });

  it("returns the names of a native stage's tags that have a value", () => {
    const sources = findSources(
      transform([
        {
          "lib/type": "mbql.stage/native",
          native: "SELECT * FROM ORDERS [[WHERE STATE = {{state}}]]",
          "template-tags": [
            {
              type: "text",
              name: "state",
              id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
              default: "CA",
            },
          ],
        },
      ]),
      "Transform",
    );
    expect(sources.natives.map((n) => [...n.valuedTags])).toEqual([["state"]]);
  });

  it("finds the card, snippet and table of a native stage's template tags", () => {
    const tag = (type: string, extra: object) => ({
      type,
      name: type,
      id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
      ...extra,
    });
    const sources = findSources(
      transform([
        {
          "lib/type": "mbql.stage/native",
          native: "SELECT 1",
          "template-tags": [
            tag("card", { "card-id": "CCCCCCCCCCCCCCCCCCCCC" }),
            tag("snippet", {
              "snippet-name": "s",
              "snippet-id": "NNNNNNNNNNNNNNNNNNNNN",
            }),
            tag("table", { "table-id": [DB, "PUBLIC", "PEOPLE"] }),
          ],
        },
      ]),
      "Transform",
    );
    expect(sources.entities.sort()).toEqual([
      "CCCCCCCCCCCCCCCCCCCCC",
      "NNNNNNNNNNNNNNNNNNNNN",
    ]);
    expect(sources.tables).toEqual([
      { database: DB, schema: "PUBLIC", name: "PEOPLE", nullSchema: "none" },
    ]);
  });

  it("ignores entity ids outside the query, such as a collection", () => {
    const doc = {
      ...transform([mbql({ "source-table": [DB, null, "ORDERS"] })]),
      collection_id: "LLLLLLLLLLLLLLLLLLLLL",
    };
    expect(findSources(doc, "Transform").entities).toEqual([]);
  });
});
