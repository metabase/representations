import { describe, expect, it } from "bun:test";

import { type Doc, indexByEntityId } from "./documents.js";
import { createReader, createSnippetFinder } from "./reads.js";
import { createSourceFinder } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { exactTable, sqlTable } from "./tables.js";

const SNIPPET_ID = "SnippetId000000000001";

function doc(file: string, model: string, body: Record<string, unknown>): Doc {
  return {
    file,
    model,
    schema: { status: "passed" },
    nonStringKeys: [],
    body: { entity_id: SNIPPET_ID, ...body, "serdes/meta": [{ model }] },
  };
}

const snippet = doc("snippets/filter.yaml", "NativeQuerySnippet", {
  name: "filter",
  content: "status = 'active'",
});

// Sorts before the snippet's file.
const transform = doc("collections/a_transform.yaml", "Transform", {
  name: "A transform",
});

describe("createSnippetFinder", () => {
  const find = (docs: readonly Doc[]) =>
    createSnippetFinder(docs, indexByEntityId(docs))("filter", SNIPPET_ID);

  it("finds a snippet by id where a file of another model shares the id", () => {
    expect(find([transform, snippet])).toEqual({
      content: "status = 'active'",
    });
  });

  it("names the other model when no snippet holds the id", () => {
    expect(find([transform])).toEqual({
      unusable: `snippet filter (${SNIPPET_ID}) names a Transform, not a snippet`,
    });
  });

  it("takes the last snippet file in path order of two with one id", () => {
    const later = doc("snippets/filter_copy.yaml", "NativeQuerySnippet", {
      name: "filter",
      content: "status = 'closed'",
    });
    expect(find([snippet, later])).toEqual({ content: "status = 'closed'" });
  });
});

describe("createReader", () => {
  const DB = "Warehouse";
  const CARD_ID = "SourceCard00000000001";
  const query = (stages: object[]) => ({
    "lib/type": "mbql/query",
    database: DB,
    stages,
  });
  const mbql = (stage: object) => ({ "lib/type": "mbql.stage/mbql", ...stage });
  const queryTransform = (stages: object[]) =>
    doc("collections/transforms/t.yaml", "Transform", {
      name: "T",
      entity_id: "QueryTransform0000001",
      source: { type: "query", query: query(stages) },
      target: { database: DB, type: "table", schema: "out", name: "t" },
    });
  const card = (stages: object[]) =>
    doc("collections/main/source.yaml", "Card", {
      name: "Source",
      entity_id: CARD_ID,
      type: "question",
      display: "table",
      dataset_query: query(stages),
    });
  const readerOf = (docs: readonly Doc[]) =>
    createReader(
      docs,
      indexByEntityId(docs),
      createSourceFinder(loadSchemas()),
      (sql) => ({
        status: "read",
        tables: sql.includes("FROM raw.events")
          ? [{ schema: "raw", name: "events" }]
          : [],
      }),
    );

  it("reads a native query's tables, a source table, and a source card's tables from the card's file", () => {
    const transform = queryTransform([
      {
        "lib/type": "mbql.stage/native",
        native: "SELECT * FROM raw.events",
      },
    ]);
    const source = card([mbql({ "source-table": [DB, "raw", "events"] })]);
    const user = queryTransform([mbql({ "source-card": CARD_ID })]);
    expect(readerOf([transform])(transform)).toEqual({
      status: "read",
      tables: [sqlTable(DB, { schema: "raw", name: "events" })],
    });
    expect(readerOf([source])(source)).toEqual({
      status: "read",
      tables: [exactTable(DB, { schema: "raw", name: "events" })],
    });
    expect(readerOf([user, source])(user)).toEqual({
      status: "read",
      tables: [exactTable(DB, { schema: "raw", name: "events" })],
    });
  });

  it("is unread when a source card is not in the folder, or reads itself", () => {
    const user = queryTransform([mbql({ "source-card": CARD_ID })]);
    expect(readerOf([user])(user)).toEqual({
      status: "unread",
      reason: `source Card ${CARD_ID} is not in the folder`,
    });
    const loop = card([mbql({ "source-card": CARD_ID })]);
    expect(readerOf([user, loop])(user)).toEqual({
      status: "unread",
      reason: `through ${loop.file}: ${loop.file} uses itself as a source`,
    });
  });

  it("reads a Python source table with a null table_id by its name", () => {
    const python = doc("collections/python.yaml", "Transform", {
      name: "Python",
      source: {
        type: "python",
        body: "def transform(up):\n    return up",
        "source-tables": [
          {
            alias: "up",
            database_id: "Warehouse",
            schema: "analytics",
            table: "upstream_out",
            table_id: null,
          },
        ],
      },
    });
    const readsOf = createReader(
      [python],
      indexByEntityId([python]),
      createSourceFinder(loadSchemas()),
      () => ({ status: "unread", reason: "no SQL" }),
    );
    expect(readsOf(python)).toEqual({
      status: "read",
      tables: [
        {
          database: "Warehouse",
          schema: "analytics",
          name: "upstream_out",
          nullSchema: "none",
          caseMatters: true,
        },
      ],
    });
  });
});
