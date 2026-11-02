import { describe, expect, it } from "bun:test";

import { type Doc, indexByEntityId } from "./documents.js";
import {
  BUILT_IN_ENTITIES,
  entityRefsOf,
  reportEntityRefs,
} from "./entity-refs.js";
import type { LintRule } from "./findings.js";

const CARD_ID = "CardCardCardCardCard1";
const CARD_2 = "CardCardCardCardCard2";
const DASHBOARD_ID = "DashDashDashDashDash1";
const COLLECTION_ID = "CollCollCollCollColl1";
const TAB_ID = "TabTabTabTabTabTabTb1";
const SNIPPET_ID = "SnipSnipSnipSnipSnip1";
const SEGMENT_ID = "SegmSegmSegmSegmSegm1";
const MEASURE_ID = "MeasMeasMeasMeasMeas1";
const TAG_ID = "TagTagTagTagTagTagTg1";

/** The references as `[path, entityId, allowedModels]`, for short assertions. */
const refs = (model: string, body: Record<string, unknown>) =>
  entityRefsOf(model, body).map((r) => [
    r.path,
    r.entityId,
    r.allowedModels.join("|"),
  ]);

describe("entityRefsOf", () => {
  it("finds a card's collection, dashboard, document and query references", () => {
    expect(
      refs("Card", {
        collection_id: COLLECTION_ID,
        dashboard_id: DASHBOARD_ID,
        document_id: "DocDocDocDocDocDocDc1",
        dataset_query: {
          database: "Warehouse",
          stages: [
            {
              "source-card": CARD_2,
              joins: [{ stages: [{ "source-table": CARD_ID }] }],
              filters: [["segment", {}, SEGMENT_ID]],
              aggregation: [
                ["metric", {}, CARD_ID],
                ["sum", {}, ["measure", {}, MEASURE_ID]],
                ["count", {}, ["field", {}, ["Warehouse", "public", "t", "f"]]],
              ],
              "template-tags": {
                q: { type: "card", "card-id": CARD_2 },
                s: { type: "snippet", "snippet-id": SNIPPET_ID },
              },
            },
          ],
        },
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["dashboard_id", DASHBOARD_ID, "Dashboard"],
      ["document_id", "DocDocDocDocDocDocDc1", "Document"],
      ["dataset_query.stages[0].source-card", CARD_2, "Card"],
      [
        "dataset_query.stages[0].joins[0].stages[0].source-table",
        CARD_ID,
        "Card",
      ],
      ["dataset_query.stages[0].filters[0][2]", SEGMENT_ID, "Segment"],
      ["dataset_query.stages[0].aggregation[0][2]", CARD_ID, "Card"],
      ["dataset_query.stages[0].aggregation[1][2][2]", MEASURE_ID, "Measure"],
      ["dataset_query.stages[0].template-tags.q.card-id", CARD_2, "Card"],
      [
        "dataset_query.stages[0].template-tags.s.snippet-id",
        SNIPPET_ID,
        "NativeQuerySnippet",
      ],
    ]);
  });

  it("skips table, field and database references, and ids that are not portable", () => {
    expect(
      refs("Card", {
        collection_id: null,
        dataset_query: {
          database: "Warehouse",
          stages: [
            {
              "source-table": ["Warehouse", "public", "orders"],
              filters: [["segment", {}, 12]],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("finds a parameter's values source card and visualization settings targets", () => {
    expect(
      refs("Card", {
        parameters: [{ id: "p", values_source_config: { card_id: CARD_ID } }],
        visualization_settings: {
          click_behavior: {
            type: "link",
            linkType: "dashboard",
            targetId: DASHBOARD_ID,
            tabId: [DASHBOARD_ID, TAB_ID],
          },
          column_settings: {
            '["name","TOTAL"]': {
              click_behavior: {
                type: "link",
                linkType: "question",
                targetId: CARD_2,
              },
            },
            '["name","URL"]': {
              click_behavior: {
                type: "link",
                linkType: "url",
                linkTemplate: "x",
              },
            },
          },
        },
      }),
    ).toEqual([
      ["parameters[0].values_source_config.card_id", CARD_ID, "Card"],
      [
        "visualization_settings.click_behavior.targetId",
        DASHBOARD_ID,
        "Dashboard",
      ],
      ["visualization_settings.click_behavior.tabId", TAB_ID, "DashboardTab"],
      [
        'visualization_settings.column_settings["[\\"name\\",\\"TOTAL\\"]"].click_behavior.targetId',
        CARD_2,
        "Card",
      ],
    ]);
  });

  it("finds a dashboard's dashcard cards, actions, series, mappings, tabs, links and visualizer sources", () => {
    expect(
      refs("Dashboard", {
        collection_id: COLLECTION_ID,
        parameters: [{ values_source_config: { card_id: CARD_2 } }],
        tabs: [{ entity_id: TAB_ID }],
        dashcards: [
          {
            card_id: CARD_ID,
            action_id: "ActnActnActnActnActn1",
            dashboard_tab_id: [DASHBOARD_ID, TAB_ID],
            series: [{ card_id: CARD_2 }],
            parameter_mappings: [{ card_id: CARD_ID, parameter_id: "p" }],
            visualization_settings: {
              visualization: {
                columnValuesMapping: {
                  COLUMN_1: [{ sourceId: `card:${CARD_2}`, name: "x" }],
                  DIMENSION: [`$_card:${CARD_ID}_name`],
                },
              },
            },
          },
          {
            card_id: null,
            visualization_settings: {
              link: { entity: { model: "collection", id: COLLECTION_ID } },
            },
          },
          {
            card_id: null,
            visualization_settings: {
              link: {
                entity: { model: "table", id: ["Warehouse", "public", "t"] },
              },
            },
          },
        ],
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["parameters[0].values_source_config.card_id", CARD_2, "Card"],
      ["dashcards[0].card_id", CARD_ID, "Card"],
      ["dashcards[0].action_id", "ActnActnActnActnActn1", "Action"],
      ["dashcards[0].series[0].card_id", CARD_2, "Card"],
      ["dashcards[0].parameter_mappings[0].card_id", CARD_ID, "Card"],
      ["dashcards[0].dashboard_tab_id", TAB_ID, "DashboardTab"],
      [
        "dashcards[0].visualization_settings.visualization.columnValuesMapping.COLUMN_1[0].sourceId",
        CARD_2,
        "Card",
      ],
      [
        "dashcards[0].visualization_settings.visualization.columnValuesMapping.DIMENSION[0]",
        CARD_ID,
        "Card",
      ],
      [
        "dashcards[1].visualization_settings.link.entity.id",
        COLLECTION_ID,
        "Collection",
      ],
    ]);
  });

  it("finds a document's collection, embedded cards and smart links, but not table links", () => {
    expect(
      refs("Document", {
        collection_id: COLLECTION_ID,
        document: {
          type: "doc",
          content: [
            {
              type: "cardEmbed",
              attrs: { id: [{ model: "Card", id: CARD_ID }] },
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "smartLink",
                  attrs: {
                    model: "dashboard",
                    entityId: [{ model: "Dashboard", id: DASHBOARD_ID }],
                  },
                },
                {
                  type: "smartLink",
                  attrs: {
                    model: "table",
                    entityId: [
                      { model: "Database", id: "Warehouse" },
                      { model: "Table", id: "orders" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["document.content[0].attrs.id[0].id", CARD_ID, "Card"],
      [
        "document.content[1].content[0].attrs.entityId[0].id",
        DASHBOARD_ID,
        "Dashboard",
      ],
    ]);
  });

  it("finds the references of collections, snippets, data apps, timelines, tables and table settings", () => {
    expect(refs("Collection", { parent_id: COLLECTION_ID })).toEqual([
      ["parent_id", COLLECTION_ID, "Collection"],
    ]);
    expect(
      refs("NativeQuerySnippet", {
        collection_id: COLLECTION_ID,
        template_tags: {
          "snippet: x": { type: "snippet", "snippet-id": SNIPPET_ID },
        },
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      [
        'template_tags["snippet: x"].snippet-id',
        SNIPPET_ID,
        "NativeQuerySnippet",
      ],
    ]);
    expect(refs("DataApp", { collection: COLLECTION_ID })).toEqual([
      ["collection", COLLECTION_ID, "Collection"],
    ]);
    expect(refs("Timeline", { collection_id: COLLECTION_ID })).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
    ]);
    expect(refs("TableUserSettings", { collection_id: COLLECTION_ID })).toEqual(
      [["collection_id", COLLECTION_ID, "Collection"]],
    );
    expect(
      refs("Table", {
        collection_id: COLLECTION_ID,
        transform_id: "TrnsTrnsTrnsTrnsTrns1",
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["transform_id", "TrnsTrnsTrnsTrnsTrns1", "Transform"],
    ]);
  });

  it("finds an action's collection, model, query and parameter cards", () => {
    expect(
      refs("Action", {
        collection_id: COLLECTION_ID,
        model_id: CARD_ID,
        query: [
          {
            dataset_query: {
              stages: [{ "template-tags": { t: { "card-id": CARD_2 } } }],
            },
          },
        ],
        parameters: [{ values_source_config: { card_id: CARD_2 } }],
        parameter_mappings: [{ card_id: CARD_ID }],
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["model_id", CARD_ID, "Card"],
      [
        "query[0].dataset_query.stages[0].template-tags.t.card-id",
        CARD_2,
        "Card",
      ],
      ["parameters[0].values_source_config.card_id", CARD_2, "Card"],
      ["parameter_mappings[0].card_id", CARD_ID, "Card"],
    ]);
  });

  it("finds the references of metabots, segments, measures and AI contexts", () => {
    expect(
      refs("Metabot", {
        collection_id: COLLECTION_ID,
        prompts: [{ card_id: CARD_ID }],
      }),
    ).toEqual([
      ["collection_id", COLLECTION_ID, "Collection"],
      ["prompts[0].card_id", CARD_ID, "Card"],
    ]);
    expect(
      refs("Segment", {
        definition: { stages: [{ filters: [["segment", {}, SEGMENT_ID]] }] },
      }),
    ).toEqual([["definition.stages[0].filters[0][2]", SEGMENT_ID, "Segment"]]);
    expect(
      refs("Measure", {
        definition: {
          stages: [{ aggregation: [["measure", {}, MEASURE_ID]] }],
        },
      }),
    ).toEqual([
      ["definition.stages[0].aggregation[0][2]", MEASURE_ID, "Measure"],
    ]);
    expect(
      refs("OsiAiContext", { entity_type: "metric", entity_local_id: CARD_ID }),
    ).toEqual([["entity_local_id", CARD_ID, "Card"]]);
    expect(
      refs("OsiAiContext", {
        entity_type: "table",
        entity_local_id: ["Warehouse", "public", "t"],
      }),
    ).toEqual([]);
  });

  it("finds transform and job tags and a transform's query references, but not its collection", () => {
    expect(
      refs("Transform", {
        collection_id: COLLECTION_ID,
        tags: [{ tag_id: TAG_ID }],
        source: {
          type: "query",
          query: { stages: [{ "source-card": CARD_ID }] },
        },
      }),
    ).toEqual([
      ["tags[0].tag_id", TAG_ID, "TransformTag"],
      ["source.query.stages[0].source-card", CARD_ID, "Card"],
    ]);
    expect(refs("TransformJob", { job_tags: [{ tag_id: TAG_ID }] })).toEqual([
      ["job_tags[0].tag_id", TAG_ID, "TransformTag"],
    ]);
  });

  it("finds nothing for a transform test's transform or a model with no entity references", () => {
    expect(refs("TransformTest", { transform_id: CARD_ID })).toEqual([]);
    expect(refs("Glossary", { term: "x" })).toEqual([]);
  });
});

type Recorded = {
  rule: LintRule;
  file: string;
  message: string;
  related: string[];
};

function doc(file: string, model: string, body: Record<string, unknown>): Doc {
  return { file, model, body, schema: { status: "passed" }, nonStringKeys: [] };
}

function run(docs: Doc[]): Recorded[] {
  const recorded: Recorded[] = [];
  reportEntityRefs(
    docs,
    indexByEntityId(docs),
    (rule, subject, message, related = []) =>
      recorded.push({ rule, file: subject.file, message, related }),
  );
  return recorded;
}

describe("reportEntityRefs", () => {
  const collection = doc("collections/c.yaml", "Collection", {
    entity_id: COLLECTION_ID,
  });
  const dashboard = doc("collections/d.yaml", "Dashboard", {
    entity_id: DASHBOARD_ID,
    tabs: [{ entity_id: TAB_ID }],
  });

  it("reports nothing when every reference names a file of an allowed model", () => {
    const card = doc("collections/q.yaml", "Card", {
      entity_id: CARD_ID,
      collection_id: COLLECTION_ID,
      dashboard_id: DASHBOARD_ID,
    });
    const other = doc("collections/d2.yaml", "Dashboard", {
      entity_id: "DashDashDashDashDash2",
      dashcards: [
        { card_id: CARD_ID, dashboard_tab_id: [DASHBOARD_ID, TAB_ID] },
      ],
    });
    expect(run([collection, dashboard, card, other])).toEqual([]);
  });

  it("reports a reference no file holds as dangling", () => {
    const card = doc("collections/q.yaml", "Card", {
      entity_id: CARD_ID,
      collection_id: "MissingCollection0001",
    });
    expect(run([card])).toEqual([
      {
        rule: "dangling-entity-ref",
        file: "collections/q.yaml",
        message:
          "collection_id MissingCollection0001 matches no Collection in the folder; Metabase fails the import on a reference it cannot resolve, and a synced repository must hold everything its content uses",
        related: [],
      },
    ]);
  });

  it("reports a reference a file of another model holds as wrong-type, naming that file", () => {
    const card = doc("collections/q.yaml", "Card", {
      entity_id: CARD_ID,
      collection_id: DASHBOARD_ID,
    });
    const tabRef = doc("collections/d2.yaml", "Dashboard", {
      entity_id: "DashDashDashDashDash2",
      dashcards: [{ card_id: TAB_ID }],
    });
    expect(run([dashboard, card, tabRef])).toEqual([
      {
        rule: "wrong-type-entity-ref",
        file: "collections/q.yaml",
        message: `collection_id ${DASHBOARD_ID} names a Dashboard, not a Collection`,
        related: ["collections/d.yaml"],
      },
      {
        rule: "wrong-type-entity-ref",
        file: "collections/d2.yaml",
        message: `dashcards[0].card_id ${TAB_ID} names a DashboardTab, not a Card`,
        related: ["collections/d.yaml"],
      },
    ]);
  });

  it("allows the built-in transform tags and common.py with no file", () => {
    const tags = [...BUILT_IN_ENTITIES].filter(([, m]) => m === "TransformTag");
    expect(tags.length).toBe(4);
    const job = doc("transforms/transform_jobs/j.yaml", "TransformJob", {
      entity_id: "JobJobJobJobJobJobJb1",
      job_tags: tags.map(([id]) => ({ tag_id: id })),
    });
    expect(run([job])).toEqual([]);
    expect(BUILT_IN_ENTITIES.get("cWWH9qJPvHNB3rP2vLZrK")).toBe(
      "PythonLibrary",
    );
  });

  it("does not let a built-in id stand in for another model", () => {
    const card = doc("collections/q.yaml", "Card", {
      entity_id: CARD_ID,
      dashboard_id: "dUW7nvQHQBdA0Rx0gJckI",
    });
    expect(run([card]).map((r) => r.rule)).toEqual(["dangling-entity-ref"]);
  });
});
