import { describe, expect, it } from "bun:test";

import { type Doc, indexByEntityId } from "./documents.js";
import type { LintRule } from "./findings.js";
import {
  reportCollectionNamespaces,
  reportIncrementalTags,
  reportMissingTargetDatabases,
} from "./transform-checks.js";

type Recorded = {
  rule: LintRule;
  file: string;
  message: string;
  related: string[];
};

const TRANSFORM_FILE = "collections/transforms/orders_by_day.yaml";
const COLLECTION_ID = "Xq3wB0z1aT5mJk8Lr2PdN";
const COLLECTION_FILE = "collections/Xq3wB0z1aT5mJk8Lr2PdN_etl/etl.yaml";

/** A schema-valid transform with `body`'s fields over a minimal native transform. */
function transformDoc(body: Record<string, unknown>): Doc {
  return {
    file: TRANSFORM_FILE,
    model: "Transform",
    schemaError: null,
    nonStringKeys: [],
    body: {
      name: "Orders by day",
      entity_id: "OrdersByDay0000000001",
      creator_id: "admin@example.com",
      source_database_id: "Warehouse",
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: "Warehouse",
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: "SELECT * FROM public.orders",
            },
          ],
        },
      },
      target: { type: "table", schema: "analytics", name: "orders_by_day" },
      "serdes/meta": [{ model: "Transform" }],
      ...body,
    },
  };
}

function collectionDoc(namespace: string | null | undefined): Doc {
  return {
    file: COLLECTION_FILE,
    model: "Collection",
    schemaError: null,
    nonStringKeys: [],
    body: {
      name: "ETL",
      entity_id: COLLECTION_ID,
      ...(namespace === undefined ? {} : { namespace }),
      "serdes/meta": [{ model: "Collection" }],
    },
  };
}

function collectionFindings(docs: readonly Doc[]): Recorded[] {
  const recorded: Recorded[] = [];
  reportCollectionNamespaces(
    docs,
    indexByEntityId(docs),
    (rule, doc, message, related = []) =>
      recorded.push({ rule, file: doc.file, message, related }),
  );
  return recorded;
}

describe("reportCollectionNamespaces", () => {
  const inCollection = transformDoc({ collection_id: COLLECTION_ID });

  it("reports a transform whose collection is not in the transforms namespace", () => {
    expect(
      collectionFindings([inCollection, collectionDoc("data-apps")]),
    ).toEqual([
      {
        rule: "transform-collection",
        file: TRANSFORM_FILE,
        message:
          "collection ETL is in the data-apps namespace; Metabase puts a transform only in a collection of the transforms namespace",
        related: [COLLECTION_FILE],
      },
    ]);
  });

  it("counts a collection with no namespace, or a null one, as the default namespace", () => {
    const message =
      "collection ETL is in the default namespace; Metabase puts a transform only in a collection of the transforms namespace";
    for (const namespace of [null, undefined]) {
      expect(
        collectionFindings([inCollection, collectionDoc(namespace)]).map(
          (r) => r.message,
        ),
      ).toEqual([message]);
    }
  });

  it("reports a transform whose collection is not in the folder", () => {
    expect(collectionFindings([inCollection])).toEqual([
      {
        rule: "transform-collection",
        file: TRANSFORM_FILE,
        message: `collection ${COLLECTION_ID} is not in the folder; a transform's collection must be in the repository`,
        related: [],
      },
    ]);
  });

  it("reports a transform whose collection_id names a file of another model", () => {
    const card: Doc = {
      file: "collections/main/card.yaml",
      model: "Card",
      schemaError: null,
      nonStringKeys: [],
      body: { name: "A card", entity_id: COLLECTION_ID },
    };
    expect(collectionFindings([inCollection, card])).toEqual([
      {
        rule: "transform-collection",
        file: TRANSFORM_FILE,
        message: `collection_id ${COLLECTION_ID} names a Card, not a Collection`,
        related: [card.file],
      },
    ]);
  });

  it("accepts a collection in the transforms namespace", () => {
    expect(
      collectionFindings([inCollection, collectionDoc("transforms")]),
    ).toEqual([]);
  });

  it("accepts a transform in the root collection, null or absent", () => {
    expect(
      collectionFindings([
        transformDoc({ collection_id: null }),
        transformDoc({}),
        collectionDoc(null),
      ]),
    ).toEqual([]);
  });
});

describe("reportIncrementalTags", () => {
  const EVENTS_TAG = {
    type: "table",
    name: "events",
    id: "6f1d1f43-3c4b-4d47-9a51-4f3b0a1e3c11",
    "table-id": ["Warehouse", "public", "events"],
  };
  const USERS_TAG = {
    type: "table",
    name: "users",
    id: "0b6a3f0e-1f0e-4f86-8d55-5a1d4c2b7e22",
    "table-id": ["Warehouse", "public", "users"],
  };
  const TEXT_TAG = {
    type: "text",
    name: "since",
    id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c33",
  };

  /** A native transform with `templateTags`, writing an incremental target unless `targetType` says otherwise. */
  const incremental = ({
    templateTags,
    checkpointField,
    targetType = "table-incremental",
    stages,
  }: {
    templateTags: readonly Record<string, unknown>[];
    checkpointField?: unknown;
    targetType?: string;
    stages?: readonly Record<string, unknown>[];
  }): Doc =>
    transformDoc({
      source: {
        type: "query",
        "source-incremental-strategy": {
          type: "checkpoint",
          ...(checkpointField === undefined
            ? {}
            : { "checkpoint-filter-field-id": checkpointField }),
        },
        query: {
          "lib/type": "mbql/query",
          database: "Warehouse",
          stages: stages ?? [
            {
              "lib/type": "mbql.stage/native",
              native: "SELECT * FROM {{events}}",
              "template-tags": templateTags,
            },
          ],
        },
      },
      target: { type: targetType, schema: "analytics", name: "events_daily" },
    });

  const CREATED_AT = ["Warehouse", "public", "events", "created_at"];

  const incrementalFindings = (doc: Doc): Recorded[] => {
    const recorded: Recorded[] = [];
    reportIncrementalTags(
      [doc],
      () => null,
      (rule, d, message, related = []) =>
        recorded.push({ rule, file: d.file, message, related }),
    );
    return recorded;
  };

  it("reports an incremental native transform with no table template tag", () => {
    expect(
      incrementalFindings(
        incremental({ templateTags: [TEXT_TAG], checkpointField: CREATED_AT }),
      ),
    ).toEqual([
      {
        rule: "missing-incremental-table-tag",
        file: TRANSFORM_FILE,
        message:
          "the incremental native query has no table template tag for Metabase to put its range filter in",
        related: [],
      },
    ]);
  });

  it("reports an incremental native transform whose table tags all name another table than the checkpoint field's", () => {
    expect(
      incrementalFindings(
        incremental({ templateTags: [USERS_TAG], checkpointField: CREATED_AT }),
      ).map((r) => r.message),
    ).toEqual([
      "no table template tag names public.events, the table of the checkpoint field, for Metabase to put the incremental range filter in",
    ]);
  });

  it("accepts a table tag that names the checkpoint field's table", () => {
    expect(
      incrementalFindings(
        incremental({
          templateTags: [USERS_TAG, EVENTS_TAG],
          checkpointField: CREATED_AT,
        }),
      ),
    ).toEqual([]);
  });

  it("accepts any table tag when the checkpoint field is not a field reference or is not set", () => {
    for (const checkpointField of [42, undefined]) {
      expect(
        incrementalFindings(
          incremental({ templateTags: [USERS_TAG], checkpointField }),
        ),
      ).toEqual([]);
    }
  });

  it("accepts the legacy template-tags map", () => {
    expect(
      incrementalFindings(
        incremental({
          templateTags: [],
          checkpointField: CREATED_AT,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: "SELECT * FROM {{events}}",
              "template-tags": { events: EVENTS_TAG },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not check a target that is not incremental, or a query that is not native only", () => {
    const native = {
      "lib/type": "mbql.stage/native",
      native: "SELECT * FROM public.events",
    };
    const mbql = {
      "lib/type": "mbql.stage/mbql",
      "source-table": ["Warehouse", "public", "events"],
    };
    for (const doc of [
      incremental({ templateTags: [], targetType: "table" }),
      incremental({ templateTags: [], stages: [mbql] }),
      incremental({ templateTags: [], stages: [native, mbql] }),
    ]) {
      expect(incrementalFindings(doc)).toEqual([]);
    }
  });
});

describe("reportMissingTargetDatabases", () => {
  const PYTHON_SOURCE = {
    type: "python",
    "source-tables": [],
    body: "def transform():\n    return None",
  };

  const targetDatabaseFindings = (doc: Doc): Recorded[] => {
    const recorded: Recorded[] = [];
    reportMissingTargetDatabases(
      [doc],
      (rule, { file }, message, related = []) =>
        recorded.push({ rule, file, message, related }),
    );
    return recorded;
  };

  it("reports a Python transform whose target names no database, whatever its source_database_id", () => {
    expect(
      targetDatabaseFindings(transformDoc({ source: PYTHON_SOURCE })),
    ).toEqual([
      {
        rule: "missing-target-database",
        file: TRANSFORM_FILE,
        message:
          "the target names no database, which Metabase requires unless the source is a query",
        related: [],
      },
    ]);
  });

  it("accepts a Python transform whose target names a database", () => {
    expect(
      targetDatabaseFindings(
        transformDoc({
          source: PYTHON_SOURCE,
          target: {
            type: "table",
            database: "Warehouse",
            schema: "analytics",
            name: "orders_by_day",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a query transform whose target names no database: it writes to its query's database", () => {
    expect(targetDatabaseFindings(transformDoc({}))).toEqual([]);
  });

  it("skips a transform that fails its schema", () => {
    expect(
      targetDatabaseFindings({
        ...transformDoc({ source: PYTHON_SOURCE }),
        schemaError: { path: "/name", message: "must be string" },
      }),
    ).toEqual([]);
  });
});
