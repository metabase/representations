import { describe, expect, it } from "bun:test";

import {
  getInstanceEntity,
  getInstanceRefs,
  getPortableEntity,
  getPortableRefs,
  KIND_SPECS,
  portableKey,
  validateInstance,
  validatePortable,
  type FieldPath,
  type Conversion,
  type InstanceEntity,
  type InstanceRefs,
  type InstanceToPortable,
  type JsonObject,
  type JsonValue,
  type Kind,
  type PortableEntity,
  type PortableToInstance,
  type TablePath,
  REF_MODELS,
} from "./index.js";
import { isJsonArray, isJsonObject } from "./json.js";

const eid = (label: string) => label.padEnd(21, "0");

const DB = "Sample Database";
const ORDERS: TablePath = [DB, "PUBLIC", "ORDERS"];
const PRODUCTS: TablePath = [DB, "PUBLIC", "PRODUCTS"];
const ORDERS_TOTAL: FieldPath = [...ORDERS, "TOTAL"];
const ORDERS_PRODUCT_ID: FieldPath = [...ORDERS, "PRODUCT_ID"];
const PRODUCTS_ID: FieldPath = [...PRODUCTS, "ID"];
const PRODUCTS_CATEGORY: FieldPath = [...PRODUCTS, "CATEGORY"];
const ADMIN = "admin@example.com";
const COLLECTION = eid("collection");
const PARENT = eid("parent");
const CARD = eid("card");
const METRIC = eid("metric");
const DASHBOARD = eid("dashboard");
const TAB = eid("tab");
const DASHCARD = eid("dashcard");
const DOCUMENT = eid("document");
const SEGMENT = eid("segment");
const MEASURE = eid("measure");
const SNIPPET = eid("snippet");
const TRANSFORM = eid("transform");
const TAG = eid("tag");
const JOB = eid("job");
const TEST = eid("test");
const ACTION = eid("action");
const LIBRARY = eid("library");

const TO_PORTABLE: InstanceToPortable = {
  databases: { 1: DB },
  tables: { 10: ORDERS, 11: PRODUCTS },
  fields: {
    100: ORDERS_TOTAL,
    101: ORDERS_PRODUCT_ID,
    102: PRODUCTS_ID,
    103: PRODUCTS_CATEGORY,
  },
  users: { 2: ADMIN },
  collections: { 20: COLLECTION, 21: PARENT },
  cards: { 30: CARD, 31: METRIC },
  dashboards: { 40: DASHBOARD },
  dashboardTabs: { 41: TAB },
  dashboardCards: { 42: DASHCARD },
  documents: { 50: DOCUMENT },
  segments: { 60: SEGMENT },
  measures: { 61: MEASURE },
  snippets: { 62: SNIPPET },
  transforms: { 70: TRANSFORM },
  transformTags: { 71: TAG },
  transformJobs: { 72: JOB },
  transformTests: { 73: TEST },
  actions: { 80: ACTION },
  pythonLibraries: { 90: LIBRARY },
};

const TO_INSTANCE: PortableToInstance = Object.fromEntries(
  REF_MODELS.map((model) => [
    model,
    Object.fromEntries(
      Object.entries(TO_PORTABLE[model] ?? {}).map(([id, ref]) => [
        portableKey(ref),
        Number(id),
      ]),
    ),
  ]),
);

const meta = (model: string, id: string) => [{ model, id }];

const MBQL_QUERY: JsonObject = {
  "lib/type": "mbql/query",
  database: DB,
  stages: [
    {
      "lib/type": "mbql.stage/mbql",
      "source-table": ORDERS,
      joins: [
        {
          alias: "Products",
          stages: [{ "lib/type": "mbql.stage/mbql", "source-table": PRODUCTS }],
          conditions: [
            [
              "=",
              {},
              ["field", {}, ORDERS_PRODUCT_ID],
              ["field", { "join-alias": "Products" }, PRODUCTS_ID],
            ],
          ],
        },
      ],
      aggregation: [
        ["sum", {}, ["field", {}, ORDERS_TOTAL]],
        ["metric", {}, METRIC],
        ["measure", {}, MEASURE],
      ],
      breakout: [
        ["field", { "source-field": ORDERS_PRODUCT_ID }, PRODUCTS_CATEGORY],
      ],
      filters: [["segment", {}, SEGMENT]],
    },
    {
      "lib/type": "mbql.stage/mbql",
      fields: [["field", { "base-type": "type/Float" }, "sum"]],
    },
  ],
};

const MBQL_INSTANCE_QUERY: JsonObject = {
  "lib/type": "mbql/query",
  database: 1,
  stages: [
    {
      "lib/type": "mbql.stage/mbql",
      "source-table": 10,
      joins: [
        {
          alias: "Products",
          stages: [{ "lib/type": "mbql.stage/mbql", "source-table": 11 }],
          conditions: [
            [
              "=",
              {},
              ["field", {}, 101],
              ["field", { "join-alias": "Products" }, 102],
            ],
          ],
        },
      ],
      aggregation: [
        ["sum", {}, ["field", {}, 100]],
        ["metric", {}, 31],
        ["measure", {}, 61],
      ],
      breakout: [["field", { "source-field": 101 }, 103]],
      filters: [["segment", {}, 60]],
    },
    {
      "lib/type": "mbql.stage/mbql",
      fields: [["field", { "base-type": "type/Float" }, "sum"]],
    },
  ],
};

const NATIVE_QUERY: JsonObject = {
  "lib/type": "mbql/query",
  database: DB,
  stages: [
    {
      "lib/type": "mbql.stage/native",
      native:
        "SELECT * FROM {{#orders}} WHERE {{snippet: active}} AND {{category}}",
      "template-tags": [
        { type: "card", name: "#orders", id: "orders", "card-id": CARD },
        {
          type: "snippet",
          name: "snippet: active",
          id: "active",
          "snippet-name": "active",
          "snippet-id": SNIPPET,
        },
        {
          type: "table",
          name: "products",
          id: "products",
          "table-id": PRODUCTS,
        },
        {
          type: "dimension",
          name: "category",
          id: "category",
          "widget-type": "string/=",
          dimension: ["field", {}, PRODUCTS_CATEGORY],
        },
      ],
    },
  ],
};

const CARD_FIXTURE: JsonObject = {
  name: "Orders by category",
  entity_id: CARD,
  display: "bar",
  creator_id: ADMIN,
  collection_id: COLLECTION,
  dashboard_id: DASHBOARD,
  dataset_query: MBQL_QUERY,
  parameters: [
    {
      id: "category",
      name: "Category",
      slug: "category",
      type: "string/=",
      values_source_type: "card",
      values_source_config: {
        card_id: METRIC,
        value_field: ["field", PRODUCTS_CATEGORY, null],
      },
    },
  ],
  result_metadata: [
    {
      name: "TOTAL",
      id: ORDERS_TOTAL,
      table_id: ORDERS,
      field_ref: ["field", ORDERS_TOTAL, null],
    },
  ],
  visualization_settings: {
    column_settings: {
      [JSON.stringify(["ref", ["field", ORDERS_TOTAL, null]])]: {
        currency: "USD",
        click_behavior: {
          type: "link",
          linkType: "question",
          targetId: METRIC,
          parameterMapping: {
            [JSON.stringify(["dimension", ["field", PRODUCTS_CATEGORY, null]])]:
              {
                id: JSON.stringify([
                  "dimension",
                  ["field", PRODUCTS_CATEGORY, null],
                ]),
                source: { id: "CATEGORY", name: "Category", type: "column" },
                target: {
                  id: JSON.stringify([
                    "dimension",
                    ["field", PRODUCTS_CATEGORY, null],
                  ]),
                  type: "dimension",
                  dimension: ["dimension", ["field", PRODUCTS_CATEGORY, null]],
                },
              },
          },
        },
      },
      '["name","sum"]': { decimals: 2 },
    },
    click_behavior: {
      type: "link",
      linkType: "dashboard",
      targetId: DASHBOARD,
      tabId: [DASHBOARD, TAB],
    },
    "table.columns": [
      { name: "TOTAL", fieldRef: ["field", ORDERS_TOTAL, null], enabled: true },
    ],
  },
  "serdes/meta": meta("Card", CARD),
};

const DASHBOARD_FIXTURE: JsonObject = {
  name: "Sales",
  entity_id: DASHBOARD,
  creator_id: ADMIN,
  collection_id: COLLECTION,
  parameters: [
    { id: "category", name: "Category", slug: "category", type: "string/=" },
  ],
  tabs: [{ entity_id: TAB, name: "Overview", position: 0 }],
  dashcards: [
    {
      entity_id: DASHCARD,
      card_id: CARD,
      action_id: ACTION,
      dashboard_tab_id: [DASHBOARD, TAB],
      row: 0,
      col: 0,
      size_x: 12,
      size_y: 6,
      parameter_mappings: [
        {
          card_id: CARD,
          parameter_id: "category",
          target: ["dimension", ["field", PRODUCTS_CATEGORY, null]],
        },
      ],
      series: [{ card_id: METRIC, position: 0 }],
      visualization_settings: {
        link: { entity: { id: ORDERS, model: "table" } },
        visualization: {
          columnValuesMapping: {
            COLUMN_1: [{ sourceId: `card:${METRIC}`, name: "COUNT" }],
            DIMENSION: [`$_card:${METRIC}_name`],
          },
        },
      },
    },
  ],
  "serdes/meta": meta("Dashboard", DASHBOARD),
};

const DOCUMENT_FIXTURE: JsonObject = {
  name: "Notes",
  entity_id: DOCUMENT,
  creator_id: ADMIN,
  collection_id: COLLECTION,
  content_type: "application/json+vnd.prose-mirror",
  document: {
    type: "doc",
    content: [
      { type: "cardEmbed", attrs: { id: meta("Card", CARD), name: null } },
      {
        type: "paragraph",
        content: [
          {
            type: "smartLink",
            attrs: {
              model: "dashboard",
              entityId: meta("Dashboard", DASHBOARD),
            },
          },
          {
            type: "smartLink",
            attrs: {
              model: "table",
              entityId: [
                { model: "Database", id: DB },
                { model: "Schema", id: "PUBLIC" },
                { model: "Table", id: "ORDERS" },
              ],
            },
          },
        ],
      },
    ],
  },
  "serdes/meta": meta("Document", DOCUMENT),
};

const SEGMENT_FIXTURE: JsonObject = {
  name: "Big orders",
  entity_id: SEGMENT,
  creator_id: ADMIN,
  table_id: ORDERS,
  definition: {
    "lib/type": "mbql/query",
    database: DB,
    stages: [
      {
        "lib/type": "mbql.stage/mbql",
        "source-table": ORDERS,
        filters: [[">", {}, ["field", {}, ORDERS_TOTAL], 100]],
      },
    ],
  },
  "serdes/meta": meta("Segment", SEGMENT),
};

const SNIPPET_FIXTURE: JsonObject = {
  name: "active",
  entity_id: SNIPPET,
  creator_id: ADMIN,
  content: "active = true AND {{#orders}}",
  collection_id: COLLECTION,
  template_tags: {
    "#orders": {
      type: "card",
      name: "#orders",
      id: "orders",
      "card-id": CARD,
    },
  },
  "serdes/meta": meta("NativeQuerySnippet", SNIPPET),
};

const TRANSFORM_FIXTURE: JsonObject = {
  name: "Order totals",
  entity_id: TRANSFORM,
  creator_id: ADMIN,
  source_database_id: DB,
  source: {
    type: "query",
    query: MBQL_QUERY,
    "source-incremental-strategy": {
      type: "checkpoint",
      "checkpoint-filter-field-id": ORDERS_TOTAL,
    },
  },
  target: {
    type: "table",
    database: DB,
    schema: "PUBLIC",
    name: "order_totals",
  },
  collection_id: COLLECTION,
  owner_user_id: ADMIN,
  tags: [{ entity_id: eid("tagLink"), tag_id: TAG, position: 0 }],
  "serdes/meta": meta("Transform", TRANSFORM),
};

const FIXTURES: [Kind, JsonObject][] = [
  ["query", MBQL_QUERY],
  ["query", NATIVE_QUERY],
  ["card", CARD_FIXTURE],
  ["dashboard", DASHBOARD_FIXTURE],
  ["document", DOCUMENT_FIXTURE],
  [
    "collection",
    {
      name: "Sales",
      entity_id: COLLECTION,
      parent_id: PARENT,
      personal_owner_id: ADMIN,
      "serdes/meta": meta("Collection", COLLECTION),
    },
  ],
  ["segment", SEGMENT_FIXTURE],
  [
    "measure",
    {
      name: "Revenue",
      entity_id: MEASURE,
      creator_id: ADMIN,
      table_id: ORDERS,
      definition: {
        "lib/type": "mbql/query",
        database: DB,
        stages: [
          {
            "lib/type": "mbql.stage/mbql",
            "source-table": ORDERS,
            aggregation: [["sum", {}, ["field", {}, ORDERS_TOTAL]]],
          },
        ],
      },
      "serdes/meta": meta("Measure", MEASURE),
    },
  ],
  ["snippet", SNIPPET_FIXTURE],
  ["transform", TRANSFORM_FIXTURE],
  [
    "transform",
    {
      name: "Python totals",
      entity_id: TRANSFORM,
      creator_id: ADMIN,
      source_database_id: DB,
      source: {
        type: "python",
        body: "def transform(orders): return orders",
        "source-tables": [
          { alias: "orders", database_id: DB, table_id: ORDERS },
        ],
        "source-database": DB,
      },
      target: { type: "table", database: DB, name: "python_totals" },
      "serdes/meta": meta("Transform", TRANSFORM),
    },
  ],
  [
    "transformTag",
    { entity_id: TAG, name: "daily", "serdes/meta": meta("TransformTag", TAG) },
  ],
  [
    "transformJob",
    {
      entity_id: JOB,
      name: "Daily",
      schedule: "0 0 0 * * ? *",
      job_tags: [{ entity_id: eid("jobTag"), tag_id: TAG, position: 0 }],
      "serdes/meta": meta("TransformJob", JOB),
    },
  ],
  [
    "transformTest",
    {
      name: "Totals add up",
      entity_id: TEST,
      transform_id: TRANSFORM,
      creator_id: ADMIN,
      inputs: [],
      expectations: [],
      "serdes/meta": meta("TransformTest", TEST),
    },
  ],
  [
    "action",
    {
      name: "Discount",
      entity_id: ACTION,
      type: "query",
      collection_id: COLLECTION,
      creator_id: ADMIN,
      query: [{ database_id: DB, dataset_query: NATIVE_QUERY }],
      "serdes/meta": meta("Action", ACTION),
    },
  ],
  [
    "action",
    {
      name: "Update order",
      entity_id: ACTION,
      type: "implicit",
      implicit: [{ kind: "row/update", table_id: ORDERS }],
      "serdes/meta": meta("Action", ACTION),
    },
  ],
  [
    "pythonLibrary",
    {
      entity_id: LIBRARY,
      path: "shared.py",
      source: "def helper(): pass",
      "serdes/meta": meta("PythonLibrary", LIBRARY),
    },
  ],
];

function serdesMetaModel(fixture: JsonObject): JsonValue {
  const meta = fixture["serdes/meta"];
  const last = isJsonArray(meta) ? meta[meta.length - 1] : null;
  return isJsonObject(last) ? last.model : null;
}

function validPortable<K extends Kind>(
  kind: K,
  value: unknown,
): PortableEntity<K> {
  const validation = validatePortable(kind, value);
  if (!validation.ok) {
    throw new Error(`invalid ${kind}: ${JSON.stringify(validation.issues)}`);
  }
  return validation.value;
}

function validInstance<K extends Kind>(
  kind: K,
  value: unknown,
): InstanceEntity<K> {
  const validation = validateInstance(kind, value);
  if (!validation.ok) {
    throw new Error(`invalid ${kind}: ${JSON.stringify(validation.issues)}`);
  }
  return validation.value;
}

function toInstance<K extends Kind>(
  kind: K,
  value: unknown,
): InstanceEntity<K> {
  const conversion = getInstanceEntity(
    kind,
    validPortable(kind, value),
    TO_INSTANCE,
  );
  if (!conversion.ok) {
    throw new Error(`unresolved: ${JSON.stringify(conversion.unresolved)}`);
  }
  return conversion.value;
}

describe("every kind", () => {
  it.each(
    FIXTURES.map(
      ([kind, fixture]) =>
        [kind, String(fixture.name ?? fixture.path ?? kind), fixture] as const,
    ),
  )(
    "converts %s (%s) to valid instance entity and back unchanged",
    (kind, _name, fixture) => {
      const instance = toInstance(kind, fixture);

      const validation = validateInstance(kind, instance);
      expect(validation.ok ? [] : validation.issues).toEqual([]);
      expect(getPortableEntity(kind, instance, TO_PORTABLE)).toEqual({
        ok: true,
        value: validPortable(kind, fixture),
      });
    },
  );
});

describe("KIND_SPECS", () => {
  it.each(
    FIXTURES.map(
      ([kind, fixture]) =>
        [kind, String(fixture.name ?? fixture.path ?? kind), fixture] as const,
    ),
  )(
    "names own ref model and serdes model of %s (%s)",
    (kind, _name, fixture) => {
      const { refModel, serdesModel } = KIND_SPECS[kind];
      const refs = getPortableRefs(kind, validPortable(kind, fixture));

      expect<JsonValue | undefined>(
        refModel === null ? undefined : refs[refModel]?.[0],
      ).toBe(fixture.entity_id);
      expect(serdesMetaModel(fixture)).toBe(serdesModel);
    },
  );
});

describe("getPortableRefs", () => {
  it("collects each reference of card once, own entity id first", () => {
    expect(
      getPortableRefs("card", validPortable("card", CARD_FIXTURE)),
    ).toEqual({
      databases: [DB],
      tables: [ORDERS, PRODUCTS],
      fields: [ORDERS_PRODUCT_ID, PRODUCTS_ID, ORDERS_TOTAL, PRODUCTS_CATEGORY],
      users: [ADMIN],
      collections: [COLLECTION],
      cards: [CARD, METRIC],
      dashboards: [DASHBOARD],
      dashboardTabs: [TAB],
      segments: [SEGMENT],
      measures: [MEASURE],
    });
  });

  it("collects template tag references of native query", () => {
    const refs = getPortableRefs("query", validPortable("query", NATIVE_QUERY));

    expect([refs.cards, refs.snippets, refs.tables, refs.fields]).toEqual([
      [CARD],
      [SNIPPET],
      [PRODUCTS],
      [PRODUCTS_CATEGORY],
    ]);
  });
});

describe("getInstanceEntity", () => {
  it("replaces each reference in query with its instance id", () => {
    expect<JsonValue>(toInstance("query", MBQL_QUERY)).toEqual(
      MBQL_INSTANCE_QUERY,
    );
  });

  it("gives entity its instance id and keeps its entity id", () => {
    const instance = toInstance("card", CARD_FIXTURE);

    expect(Object.keys(instance).slice(0, 2)).toEqual(["id", "name"]);
    expect([instance.id, instance.entity_id]).toEqual([30, CARD]);
  });

  it("replaces references in card settings, parameters and metadata", () => {
    const instance = toInstance("card", CARD_FIXTURE);

    expect(instance).toMatchObject({
      collection_id: 20,
      dashboard_id: 40,
      creator_id: 2,
      parameters: [
        {
          values_source_config: {
            card_id: 31,
            value_field: ["field", 103, null],
          },
        },
      ],
      result_metadata: [
        { id: 100, table_id: 10, field_ref: ["field", 100, null] },
      ],
      visualization_settings: {
        column_settings: {
          '["ref",["field",100,null]]': {
            currency: "USD",
            click_behavior: {
              targetId: 31,
              parameterMapping: {
                '["dimension",["field",103,null]]': {
                  id: '["dimension",["field",103,null]]',
                  target: { dimension: ["dimension", ["field", 103, null]] },
                },
              },
            },
          },
          '["name","sum"]': { decimals: 2 },
        },
        click_behavior: { targetId: 40, tabId: 41 },
        "table.columns": [{ fieldRef: ["field", 100, null] }],
      },
    });
  });

  it("replaces references on dashboard tabs and cards", () => {
    expect(toInstance("dashboard", DASHBOARD_FIXTURE)).toMatchObject({
      id: 40,
      tabs: [{ id: 41, entity_id: TAB }],
      dashcards: [
        {
          id: 42,
          card_id: 30,
          dashboard_tab_id: 41,
          parameter_mappings: [
            { card_id: 30, target: ["dimension", ["field", 103, null]] },
          ],
          series: [{ card_id: 31 }],
          visualization_settings: {
            link: { entity: { id: 10, model: "table" } },
            visualization: {
              columnValuesMapping: {
                COLUMN_1: [{ sourceId: "card:31" }],
                DIMENSION: ["$_card:31_name"],
              },
            },
          },
        },
      ],
    });
  });

  it("replaces card, dashboard and table paths in document", () => {
    expect(toInstance("document", DOCUMENT_FIXTURE).document).toEqual({
      type: "doc",
      content: [
        { type: "cardEmbed", attrs: { id: 30, name: null } },
        {
          type: "paragraph",
          content: [
            { type: "smartLink", attrs: { model: "dashboard", entityId: 40 } },
            { type: "smartLink", attrs: { model: "table", entityId: 10 } },
          ],
        },
      ],
    });
  });

  it("reports each reference it cannot resolve", () => {
    const conversion = getInstanceEntity(
      "card",
      validPortable("card", CARD_FIXTURE),
      {
        ...TO_INSTANCE,
        tables: {},
        segments: {},
      },
    );

    expect(conversion).toEqual({
      ok: false,
      unresolved: { tables: [ORDERS, PRODUCTS], segments: [SEGMENT] },
    });
  });

  it("resolves own id from entity id, not from input id", () => {
    const instance = toInstance("collection", {
      id: 9000,
      name: "Sales",
      entity_id: COLLECTION,
      "serdes/meta": meta("Collection", COLLECTION),
    });

    expect(instance.id).toBe(20);
  });

  it("resolves only references in ids map, not inherited keys", () => {
    const query = { ...NATIVE_QUERY, database: "constructor" };

    expect(
      getInstanceEntity("query", validPortable("query", query), TO_INSTANCE),
    ).toMatchObject({ ok: false, unresolved: { databases: ["constructor"] } });
  });

  it("leaves column name lists in visualization settings alone", () => {
    const settings = {
      "graph.dimensions": ["metric", "region"],
      "graph.metrics": ["segment", "sum"],
    };
    const instance = toInstance("card", {
      ...CARD_FIXTURE,
      visualization_settings: settings,
    });

    expect(instance.visualization_settings).toEqual(settings);
  });

  it("replaces card references in snippet template tags", () => {
    expect(toInstance("snippet", SNIPPET_FIXTURE)).toMatchObject({
      template_tags: { "#orders": { "card-id": 30 } },
    });
  });

  it("replaces transform owner and checkpoint field", () => {
    expect(toInstance("transform", TRANSFORM_FIXTURE)).toMatchObject({
      owner_user_id: 2,
      source: {
        "source-incremental-strategy": { "checkpoint-filter-field-id": 100 },
      },
    });
  });

  it("does not change its input", () => {
    const input = structuredClone(CARD_FIXTURE);

    toInstance("card", input);

    expect(input).toEqual(CARD_FIXTURE);
  });
});

describe("getInstanceRefs", () => {
  it("collects each instance id of dashboard once, without own id", () => {
    const refs = getInstanceRefs(
      "dashboard",
      toInstance("dashboard", DASHBOARD_FIXTURE),
    );

    expect(refs).toEqual({
      users: [2],
      collections: [20],
      cards: [30, 31],
      actions: [80],
      tables: [10],
      fields: [103],
      dashboardTabs: [41],
    });
  });
});

describe("getPortableEntity", () => {
  it("rebuilds dashboard card tab reference from dashboard entity id", () => {
    const back = getPortableEntity(
      "dashboard",
      toInstance("dashboard", DASHBOARD_FIXTURE),
      TO_PORTABLE,
    );

    expect(back).toMatchObject({
      ok: true,
      value: { dashcards: [{ dashboard_tab_id: [DASHBOARD, TAB] }] },
    });
  });

  it("drops instance id and adds missing serdes/meta", () => {
    const { "serdes/meta": _meta, ...instance } = toInstance("collection", {
      name: "Sales",
      entity_id: COLLECTION,
      "serdes/meta": meta("Collection", COLLECTION),
    });

    expect<Conversion<JsonValue, InstanceRefs>>(
      getPortableEntity(
        "collection",
        validInstance("collection", instance),
        TO_PORTABLE,
      ),
    ).toEqual({
      ok: true,
      value: {
        name: "Sales",
        entity_id: COLLECTION,
        "serdes/meta": meta("Collection", COLLECTION),
      },
    });
  });

  it("copies paths out of refs map", () => {
    const conversion = getPortableEntity(
      "segment",
      toInstance("segment", SEGMENT_FIXTURE),
      TO_PORTABLE,
    );

    expect(conversion.ok && conversion.value.table_id).toEqual(ORDERS);
    expect(conversion.ok && conversion.value.table_id).not.toBe(
      TO_PORTABLE.tables?.[10],
    );
  });

  it("reports each instance id it cannot resolve", () => {
    const instance = toInstance("card", CARD_FIXTURE);

    expect(
      getPortableEntity("card", instance, { ...TO_PORTABLE, fields: {} }),
    ).toMatchObject({
      ok: false,
      unresolved: { fields: [101, 102, 100, 103] },
    });
  });
});
