import { describe, expect, it } from "bun:test";

import {
  validateInstance,
  validatePortable,
  type JsonValue,
  type Validation,
} from "./index.js";

const ENTITY_ID = "cardcardcardcardcard1";
const COLLECTION_ID = "collectioncollection1";

const portableCard = {
  name: "Orders",
  entity_id: ENTITY_ID,
  display: "table",
  creator_id: "admin@example.com",
  collection_id: COLLECTION_ID,
  dataset_query: {
    "lib/type": "mbql/query",
    database: "Sample Database",
    stages: [
      {
        "lib/type": "mbql.stage/mbql",
        "source-table": ["Sample Database", "PUBLIC", "ORDERS"],
      },
    ],
  },
  visualization_settings: {},
  "serdes/meta": [{ model: "Card", id: ENTITY_ID }],
};

const instanceCard = {
  id: 1,
  name: "Orders",
  entity_id: ENTITY_ID,
  display: "table",
  creator_id: 2,
  collection_id: 3,
  dataset_query: {
    "lib/type": "mbql/query",
    database: 4,
    stages: [{ "lib/type": "mbql.stage/mbql", "source-table": 5 }],
  },
  visualization_settings: {},
};

describe("validatePortable", () => {
  it("accepts card with portable references", () => {
    expect<Validation<JsonValue>>(
      validatePortable("card", portableCard),
    ).toEqual({
      ok: true,
      value: portableCard,
    });
  });

  it("rejects instance ids, with JSON Pointer and keyword of each", () => {
    const validation = validatePortable("card", {
      ...portableCard,
      collection_id: 3,
      creator_id: 2,
    });

    expect(validation).toEqual({
      ok: false,
      issues: [
        { path: "/creator_id", keyword: "type", message: "must be string" },
        {
          path: "/collection_id",
          keyword: "type",
          message: "must be string,null",
        },
      ],
    });
  });

  it("rejects numeric field reference in query", () => {
    const validation = validatePortable("query", {
      ...portableCard.dataset_query,
      stages: [
        {
          "lib/type": "mbql.stage/mbql",
          "source-table": ["Sample Database", "PUBLIC", "ORDERS"],
          fields: [["field", {}, 12]],
        },
      ],
    });

    expect(validation.ok).toBe(false);
  });
});

describe("validateInstance", () => {
  it("accepts card with instance ids and no serdes/meta", () => {
    expect(validateInstance("card", instanceCard).ok).toBe(true);
  });

  it("rejects portable references", () => {
    const validation = validateInstance("card", {
      ...instanceCard,
      collection_id: COLLECTION_ID,
    });

    expect(validation).toMatchObject({
      ok: false,
      issues: [{ path: "/collection_id" }],
    });
  });

  it("accepts negative ids for new dashboard tab and card", () => {
    const validation = validateInstance("dashboard", {
      name: "Sales",
      entity_id: "dashboarddashboard001",
      creator_id: 2,
      tabs: [
        {
          id: -1,
          entity_id: "tabtabtabtabtabtab001",
          name: "Overview",
          position: 0,
        },
      ],
      dashcards: [
        {
          id: -2,
          entity_id: "dashcarddashcard00001",
          dashboard_tab_id: -1,
          row: 0,
          col: 0,
          size_x: 4,
          size_y: 4,
        },
      ],
    });

    expect(validation.ok).toBe(true);
  });
});
