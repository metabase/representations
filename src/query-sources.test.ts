import { describe, expect, it } from "bun:test";

import { createSourceFinder } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { exactTable, type TableKey } from "./tables.js";

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
  it("walks a document once per model, and a copy of it again", () => {
    const doc = transform([mbql({ "source-table": [DB, null, "ORDERS"] })]);
    const first = findSources(doc, "Transform");
    expect(findSources(doc, "Transform")).toBe(first);
    expect(findSources(structuredClone(doc), "Transform")).not.toBe(first);
    expect(findSources(structuredClone(doc), "Transform")).toEqual(first);
    expect(findSources(doc, "Card")).not.toBe(first);
  });

  it("finds a stage's source table", () => {
    const sources = findSources(
      transform([mbql({ "source-table": [DB, null, "ORDERS"] })]),
      "Transform",
    );
    expect(sources.tables).toEqual([
      {
        database: DB,
        schema: null,
        name: "ORDERS",
        nullSchema: "none",
        caseMatters: true,
      },
    ]);
  });

  it("keeps a schema named null apart from no schema, and names that differ in case apart", () => {
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
      {
        database: DB,
        schema: "null",
        name: "ORDERS",
        nullSchema: "none",
        caseMatters: true,
      },
      {
        database: DB,
        schema: null,
        name: "ORDERS",
        nullSchema: "none",
        caseMatters: true,
      },
      {
        database: DB,
        schema: null,
        name: "orders",
        nullSchema: "none",
        caseMatters: true,
      },
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
      caseMatters: true,
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
          caseMatters: true,
        },
        column: "CATEGORY",
      },
    ]);
  });

  it("keeps the table of each field tag apart from the tables the query names, and the field of a dimension tag with no default out of the fields", () => {
    // Metabase writes a field tag's field as a column, which reads no table,
    // and a dimension tag with no value as `1 = 1`.
    const tag = (
      type: string,
      name: string,
      table: string,
      extra: object = {},
    ) => ({
      type,
      name,
      id: "bb000001-0000-0000-0000-000000000001",
      "display-name": name,
      dimension: field(table, "CREATED_AT"),
      "widget-type": "date/all-options",
      ...extra,
    });
    const sources = findSources(
      transform([
        {
          "lib/type": "mbql.stage/native",
          native: "SELECT {{u}} FROM ORDERS WHERE {{d}} AND {{v}} AND {{n}}",
          "template-tags": [
            tag("temporal-unit", "u", "ORDERS"),
            tag("dimension", "d", "PEOPLE"),
            tag("dimension", "v", "PRODUCTS", { default: "2024-01-01" }),
            tag("dimension", "n", "REVIEWS", { default: null }),
          ],
        },
      ]),
      "Transform",
    );
    const table = (name: string): TableKey => ({
      database: DB,
      schema: null,
      name,
      nullSchema: "none",
      caseMatters: true,
    });
    expect(sources.tables).toEqual([]);
    expect(sources.tagTables).toEqual([
      { tag: "u", type: "temporal-unit", table: table("ORDERS") },
      { tag: "d", type: "dimension", table: table("PEOPLE") },
      { tag: "v", type: "dimension", table: table("PRODUCTS") },
      { tag: "n", type: "dimension", table: table("REVIEWS") },
    ]);
    expect(sources.fields).toEqual([
      { table: table("ORDERS"), column: "CREATED_AT" },
      { table: table("PRODUCTS"), column: "CREATED_AT" },
    ]);
    expect(sources.unvaluedFilterTables).toEqual([
      table("PEOPLE"),
      table("REVIEWS"),
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
    expect(sources.entities).toEqual([
      { id: "CCCCCCCCCCCCCCCCCCCCC", model: "Card" },
    ]);
  });

  it("finds metric, measure and segment references, each with its model", () => {
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
    expect(sources.entities).toEqual([
      { id: "MMMMMMMMMMMMMMMMMMMMM", model: "Card" },
      { id: "EEEEEEEEEEEEEEEEEEEEE", model: "Measure" },
      { id: "SSSSSSSSSSSSSSSSSSSSS", model: "Segment" },
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
        tableTags: new Map(),
        cardTags: new Map(),
        hasTemplateTags: false,
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

  it("finds the card tag of a legacy template-tags map's tag named like an Object property", () => {
    const sources = findSources(
      transform([
        {
          "lib/type": "mbql.stage/native",
          native: "SELECT * FROM {{constructor}}",
          "template-tags": {
            constructor: {
              type: "card",
              name: "constructor",
              id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
              "card-id": "CCCCCCCCCCCCCCCCCCCCC",
            },
          },
        },
      ]),
      "Transform",
    );
    expect(sources.natives[0].cardTags).toEqual(
      new Map([["constructor", "CCCCCCCCCCCCCCCCCCCCC"]]),
    );
  });

  it("finds the card, snippet and table of a native stage's template tags, each entity with its model", () => {
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
    // A card tag's card is read only where the SQL keeps the tag.
    expect(sources.entities).toEqual([
      { id: "NNNNNNNNNNNNNNNNNNNNN", model: "NativeQuerySnippet" },
    ]);
    expect(sources.natives[0].cardTags).toEqual(
      new Map([["card", "CCCCCCCCCCCCCCCCCCCCC"]]),
    );
    const people = exactTable(DB, { schema: "PUBLIC", name: "PEOPLE" });
    expect(sources.tables).toEqual([]);
    expect(sources.tagTables).toEqual([
      { tag: "table", type: "table", table: people },
    ]);
    expect(sources.natives[0].tableTags).toEqual(new Map([["table", people]]));
  });

  it("ignores entity ids outside the query, such as a collection", () => {
    const doc = {
      ...transform([mbql({ "source-table": [DB, null, "ORDERS"] })]),
      collection_id: "LLLLLLLLLLLLLLLLLLLLL",
    };
    expect(findSources(doc, "Transform").entities).toEqual([]);
  });
});
