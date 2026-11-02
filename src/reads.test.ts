import { beforeAll, describe, expect, it } from "bun:test";

import { type Doc, indexByEntityId } from "./documents.js";
import { createReader, createSnippetFinder } from "./reads.js";
import { createSourceFinder } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { loadSqlParser } from "./sql-parser.js";
import { createSqlTableReader, type SqlTableReader } from "./sql-tables.js";
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
    createSnippetFinder(indexByEntityId(docs))("filter", SNIPPET_ID);

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

// Metabase's answers, recorded on a live Metabase: the tables its transform
// test validator finds in the compiled SQL. A field tag's field is a column,
// which reads no table; a table tag's table is read only where the SQL keeps
// the tag.
describe("createReader on a native query's template tags", () => {
  const DB = "Warehouse";
  const field = (table: string, column: string) => [
    "field",
    {},
    [DB, "public", table, column],
  ];
  const TAGS: Record<string, object> = {
    u: {
      type: "temporal-unit",
      name: "u",
      dimension: field("products", "created_at"),
    },
    uv: {
      type: "temporal-unit",
      name: "u",
      dimension: field("products", "created_at"),
      default: "month",
    },
    d: {
      type: "dimension",
      name: "d",
      dimension: field("products", "category"),
      "widget-type": "string/=",
    },
    dv: {
      type: "dimension",
      name: "d",
      dimension: field("products", "category"),
      "widget-type": "string/=",
      default: ["Gizmo"],
    },
    t: { type: "table", name: "t", "table-id": [DB, "public", "products"] },
  };
  const SQL: Record<string, Record<string, string>> = {
    u: {
      outside: "SELECT count(*) AS n FROM orders GROUP BY {{u}}",
      optional: "SELECT count(*) AS n FROM orders [[GROUP BY {{u}}]]",
      nested:
        "SELECT count(*) AS n FROM orders [[WHERE total > {{a}} [[GROUP BY {{u}}]]]]",
      shared:
        "SELECT count(*) AS n FROM orders [[WHERE total > {{x}} GROUP BY {{u}}]]",
      unused: "SELECT count(*) AS n FROM orders",
    },
    d: {
      outside: "SELECT count(*) AS n FROM orders WHERE {{d}}",
      optional: "SELECT count(*) AS n FROM orders [[WHERE {{d}}]]",
      nested:
        "SELECT count(*) AS n FROM orders [[WHERE total > {{a}} [[AND {{d}}]]]]",
      shared:
        "SELECT count(*) AS n FROM orders [[WHERE {{d}} AND total > {{x}}]]",
      unused: "SELECT count(*) AS n FROM orders",
    },
    t: {
      outside: "SELECT count(*) AS n FROM orders o JOIN {{t}} p ON true",
      optional: "SELECT count(*) AS n FROM orders o [[JOIN {{t}} p ON true]]",
      nested:
        "SELECT count(*) AS n FROM orders o [[WHERE o.total > {{a}} [[AND EXISTS (SELECT 1 FROM {{t}})]]]]",
      shared:
        "SELECT count(*) AS n FROM orders o [[JOIN {{t}} p ON p.price > {{x}}]]",
      unused: "SELECT count(*) AS n FROM orders o",
    },
  };
  const orders = sqlTable(DB, { schema: null, name: "orders" });
  const products = exactTable(DB, { schema: "public", name: "products" });
  const KEPT = new Set(["outside", "optional", "nested"]);
  const cases = Object.keys(TAGS).flatMap((kind) =>
    Object.entries(SQL[kind.slice(0, 1)]).map(
      ([place, sql]) =>
        [
          `${kind}-${place}`,
          kind,
          sql,
          kind === "t" && KEPT.has(place) ? [orders, products] : [orders],
        ] as const,
    ),
  );

  let readSql: SqlTableReader;
  beforeAll(async () => {
    readSql = createSqlTableReader(await loadSqlParser(), () => "postgres");
  }, 60_000);

  const readsOf = (sql: string, tags: object[]) => {
    const transform = doc("collections/transforms/t.yaml", "Transform", {
      name: "T",
      entity_id: "TagTransform000000001",
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: sql,
              "template-tags": tags.map((tag, i) => ({
                id: `dd00000${i}-0000-0000-0000-000000000000`,
                ...tag,
              })),
            },
          ],
        },
      },
      target: { database: DB, type: "table", schema: "out", name: "t" },
    });
    return createReader(
      [transform],
      indexByEntityId([transform]),
      createSourceFinder(loadSchemas()),
      readSql,
    )(transform);
  };

  it.each(cases)("%s", (_, kind, sql, tables) => {
    const tags = [
      TAGS[kind],
      ...(sql.includes("{{a}}")
        ? [{ type: "number", name: "a", default: 0 }]
        : []),
      ...(sql.includes("{{x}}") ? [{ type: "number", name: "x" }] : []),
    ];
    expect(readsOf(sql, tags)).toEqual({ status: "read", tables });
  });

  it("reads a table tag's table after a schema in the SQL, and no table named as the tag", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o JOIN public.{{t}} p ON true",
        [TAGS.t],
      ),
    ).toEqual({ status: "read", tables: [orders, products] });
  });

  // Metabase substitutes no parameter in a stage with no template tags
  // (`parameters.clj`), and runs its SQL as written, brackets included.
  it("reads the SQL of a stage with no template tags as written, its optional clauses kept", () => {
    expect(
      readsOf("SELECT count(*) AS n FROM orders [[WHERE total > {{x}}]]", []),
    ).toEqual({
      status: "unread",
      reason: expect.stringMatching(/^SQLGlot could not parse it: ParseError/),
    });
    expect(
      readsOf("SELECT count(*) AS n FROM orders [[WHERE total > {{x}}]]", [
        { type: "number", name: "x" },
      ]),
    ).toEqual({ status: "read", tables: [orders] });
  });

  it("reads a stage with no template tags as written, where a [[ in a string is text", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o JOIN products p ON p.id = o.product_id WHERE p.category <> $$ [[ $$",
        [],
      ),
    ).toEqual({
      status: "read",
      tables: [orders, sqlTable(DB, { schema: null, name: "products" })],
    });
  });

  it("reads no table for a field tag on the table the SQL reads", () => {
    expect(
      readsOf("SELECT {{u}} AS m, count(*) AS n FROM orders GROUP BY 1", [
        {
          type: "temporal-unit",
          name: "u",
          dimension: field("orders", "created_at"),
          default: "month",
        },
      ]),
    ).toEqual({ status: "read", tables: [orders] });
  });
});

// Metabase's run: `substitute.clj` keeps an optional clause whose snippet it
// pastes, and takes a snippet with no template tag for a missing parameter,
// which drops its optional clause and else refuses the query.
describe("createReader on a native query's snippets", () => {
  const DB = "Warehouse";
  const JOIN_ID = "JoinSnippet0000000001";
  const join = doc("snippets/join.yaml", "NativeQuerySnippet", {
    name: "join",
    entity_id: JOIN_ID,
    content: "products p ON true",
  });
  const joinTag = {
    type: "snippet",
    name: "snippet: join",
    "snippet-name": "join",
    "snippet-id": JOIN_ID,
  };
  const orders = sqlTable(DB, { schema: null, name: "orders" });
  const products = sqlTable(DB, { schema: null, name: "products" });

  let readSql: SqlTableReader;
  beforeAll(async () => {
    readSql = createSqlTableReader(await loadSqlParser(), () => "postgres");
  }, 60_000);

  // `tags` null: the stage has no `template-tags` key.
  const readsOf = (sql: string, tags: object[] | null) => {
    const transform = doc("collections/transforms/t.yaml", "Transform", {
      name: "T",
      entity_id: "SnippetTransform00001",
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: sql,
              ...(tags === null
                ? {}
                : {
                    "template-tags": tags.map((tag, i) => ({
                      id: `ee00000${i}-0000-0000-0000-000000000000`,
                      ...tag,
                    })),
                  }),
            },
          ],
        },
      },
      target: { database: DB, type: "table", schema: "out", name: "t" },
    });
    const docs = [transform, join];
    return createReader(
      docs,
      indexByEntityId(docs),
      createSourceFinder(loadSchemas()),
      readSql,
    )(transform);
  };

  it("keeps an optional clause that holds only a snippet, and reads the snippet's tables", () => {
    expect(
      readsOf("SELECT count(*) AS n FROM orders o [[JOIN {{snippet: join}}]]", [
        joinTag,
      ]),
    ).toEqual({ status: "read", tables: [orders, products] });
  });

  it("keeps such a clause when the snippet holds an optional clause of its own", () => {
    const nested = doc("snippets/join.yaml", "NativeQuerySnippet", {
      name: "join",
      entity_id: JOIN_ID,
      content: "products p ON true [[AND p.price > {{a}}]]",
    });
    const transformSql =
      "SELECT count(*) AS n FROM orders o [[JOIN {{snippet: join}}]]";
    const transform = doc("collections/transforms/t.yaml", "Transform", {
      name: "T",
      entity_id: "SnippetTransform00001",
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: transformSql,
              "template-tags": [
                { id: "ee000000-0000-0000-0000-000000000000", ...joinTag },
                {
                  id: "ee000001-0000-0000-0000-000000000000",
                  type: "number",
                  name: "a",
                },
              ],
            },
          ],
        },
      },
      target: { database: DB, type: "table", schema: "out", name: "t" },
    });
    const docs = [transform, nested];
    expect(
      createReader(
        docs,
        indexByEntityId(docs),
        createSourceFinder(loadSchemas()),
        readSql,
      )(transform),
    ).toEqual({ status: "read", tables: [orders, products] });
  });

  const numberTag = { type: "number", name: "t" };
  const UNTAGGED =
    "the query uses {{snippet: join}}, which no snippet tag defines, so the lint cannot paste it";

  it("drops an optional clause whose snippet has no template tag, in a stage with another tag", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o [[JOIN {{snippet: join}}]] [[WHERE o.total > {{t}}]]",
        [numberTag],
      ),
    ).toEqual({ status: "read", tables: [orders] });
  });

  it("is unread when a snippet with no template tag is outside an optional clause, in a stage with another tag", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o JOIN {{snippet: join}} [[WHERE o.total > {{t}}]]",
        [numberTag],
      ),
    ).toEqual({ status: "unread", reason: UNTAGGED });
  });

  // Metabase substitutes no parameter in a stage with no template tags: it
  // runs the SQL as written, snippet references and brackets included.
  it.each([
    ["no template tags", null],
    ["an empty list of template tags", []],
  ])("is unread for a snippet reference in a stage with %s", (_, tags) => {
    for (const sql of [
      "SELECT count(*) AS n FROM orders o [[JOIN {{snippet: join}}]]",
      "SELECT count(*) AS n FROM orders o JOIN {{snippet: join}}",
    ]) {
      expect(readsOf(sql, tags)).toEqual({
        status: "unread",
        reason: expect.stringMatching(
          /^SQLGlot could not parse it: ParseError/,
        ),
      });
    }
  });
});

// Metabase compiles a card tag only where the SQL it runs keeps the tag.
describe("createReader on a native query's card tags", () => {
  const DB = "Warehouse";
  const CARD_ID = "TagCard00000000000001";
  const card = doc("collections/main/card.yaml", "Card", {
    name: "Card",
    entity_id: CARD_ID,
    type: "question",
    display: "table",
    dataset_query: {
      "lib/type": "mbql/query",
      database: DB,
      stages: [
        {
          "lib/type": "mbql.stage/mbql",
          "source-table": [DB, "public", "products"],
        },
      ],
    },
  });
  const cardTag = {
    id: "cc000000-0000-0000-0000-000000000000",
    type: "card",
    name: "#1-card",
    "card-id": CARD_ID,
  };
  const numberTag = {
    id: "cc000001-0000-0000-0000-000000000000",
    type: "number",
    name: "x",
  };
  const valuedTag = {
    id: "cc000002-0000-0000-0000-000000000000",
    type: "number",
    name: "y",
    default: 0,
  };
  const orders = sqlTable(DB, { schema: null, name: "orders" });
  const products = exactTable(DB, { schema: "public", name: "products" });

  let readSql: SqlTableReader;
  beforeAll(async () => {
    readSql = createSqlTableReader(await loadSqlParser(), () => "postgres");
  }, 60_000);

  const readsOf = (sql: string) => {
    const transform = doc("collections/transforms/t.yaml", "Transform", {
      name: "T",
      entity_id: "CardTagTransform00001",
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: sql,
              "template-tags": [cardTag, numberTag, valuedTag],
            },
          ],
        },
      },
      target: { database: DB, type: "table", schema: "out", name: "t" },
    });
    const docs = [transform, card];
    return createReader(
      docs,
      indexByEntityId(docs),
      createSourceFinder(loadSchemas()),
      readSql,
    )(transform);
  };

  it("reads the card of a card tag the SQL uses", () => {
    expect(
      readsOf("SELECT count(*) AS n FROM orders o JOIN {{#1-card}} c ON true"),
    ).toEqual({ status: "read", tables: [orders, products] });
  });

  it("reads no table of a card tag the SQL never uses", () => {
    expect(readsOf("SELECT count(*) AS n FROM orders o")).toEqual({
      status: "read",
      tables: [orders],
    });
  });

  it("reads the card of a card tag in an optional clause Metabase keeps", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o [[JOIN {{#1-card}} c ON c.total > {{y}}]]",
      ),
    ).toEqual({ status: "read", tables: [orders, products] });
  });

  it("reads no table of a card tag in an optional clause Metabase leaves out", () => {
    expect(
      readsOf(
        "SELECT count(*) AS n FROM orders o [[JOIN {{#1-card}} c ON c.total > {{x}}]]",
      ),
    ).toEqual({ status: "read", tables: [orders] });
  });
});
