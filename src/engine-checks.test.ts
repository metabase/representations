import { describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { type Doc, indexByEntityId, validDocsOf } from "./documents.js";
import {
  reportMissingTargetSchemas,
  type RequiredFeature,
  reportUnknownEngines,
  reportUnsupportedTransformEngines,
  reportUntestableEngines,
} from "./engine-checks.js";
import type { LintRule, Report } from "./findings.js";
import { createSourceFinder } from "./query-sources.js";
import { type Transform, transformOf } from "./reads.js";
import { loadSchemas } from "./schemas.js";
import { testedTransformsOf } from "./test-checks.js";

type Recorded = {
  rule: LintRule;
  file: string;
  message: string;
  related: string[];
};

const TRANSFORM_FILE = "collections/transforms/orders_by_day.yaml";
const TRANSFORM_ID = "OrdersByDay0000000001";
const TEST_FILE = "collections/transforms/orders_by_day/one_day.yaml";

const QUERY_SOURCE = {
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
};

/** `QUERY_SOURCE` with its query on `database`. */
const queryOn = (database: string) => ({
  ...QUERY_SOURCE,
  query: { ...QUERY_SOURCE.query, database },
});

const PYTHON_SOURCE = {
  type: "python",
  "source-tables": [],
  body: "def transform():\n    return None",
};

/** A schema-valid transform with `body`'s fields over a native transform on Warehouse. */
function transformDoc(body: Record<string, unknown>): Doc {
  return {
    file: TRANSFORM_FILE,
    model: "Transform",
    schema: { status: "passed" },
    nonStringKeys: [],
    body: {
      name: "Orders by day",
      entity_id: TRANSFORM_ID,
      creator_id: "admin@example.com",
      source_database_id: "Warehouse",
      source: QUERY_SOURCE,
      target: { type: "table", schema: "analytics", name: "orders_by_day" },
      "serdes/meta": [{ model: "Transform" }],
      ...body,
    },
  };
}

/** A schema-valid Python transform whose target names `database`. */
const pythonOn = (database: string): Doc =>
  transformDoc({
    source: PYTHON_SOURCE,
    target: { type: "table", schema: "s", name: "t", database },
  });

/** A schema-valid test of the transform `transformId` names. */
function testDoc(transformId: string): Doc {
  return {
    file: TEST_FILE,
    model: "TransformTest",
    schema: { status: "passed" },
    nonStringKeys: [],
    body: {
      name: "Orders by day: one day",
      entity_id: "OrdersByDayOneDay0001",
      transform_id: transformId,
      creator_id: "admin@example.com",
      inputs: [],
      expectations: [],
      "serdes/meta": [{ model: "TransformTest" }],
    },
  };
}

const enginesOf =
  (engines: Readonly<Record<string, string>>): EngineOf =>
  (database) =>
    database === null ? null : (engines[database] ?? null);

const recorder =
  (recorded: Recorded[]): Report =>
  (rule, { file }, message, related = []) =>
    recorded.push({ rule, file, message, related });

function targetSchemaFindings(
  docs: readonly Doc[],
  engines: Readonly<Record<string, string>>,
): Recorded[] {
  const recorded: Recorded[] = [];
  reportMissingTargetSchemas(docs, enginesOf(engines), recorder(recorded));
  return recorded;
}

function engineFindings(
  docs: readonly Doc[],
  engines: Readonly<Record<string, string>>,
): Recorded[] {
  const recorded: Recorded[] = [];
  reportUnsupportedTransformEngines(
    docs,
    enginesOf(engines),
    recorder(recorded),
  );
  return recorded;
}

function testEngineFindings(
  docs: readonly Doc[],
  engines: Readonly<Record<string, string>>,
): Recorded[] {
  const recorded: Recorded[] = [];
  // The check never reads a transform's tables.
  const transformOfDoc = new Map<Doc, Transform>(
    validDocsOf(docs, "Transform").map((doc) => [
      doc,
      transformOf(doc, () => ({ status: "read", tables: [] })),
    ]),
  );
  reportUntestableEngines(
    testedTransformsOf(docs, indexByEntityId(docs), transformOfDoc),
    enginesOf(engines),
    recorder(recorded),
  );
  return recorded;
}

describe("reportMissingTargetSchemas", () => {
  const withTarget = (target: Record<string, unknown>) =>
    transformDoc({
      target: { type: "table", name: "orders_by_day", ...target },
    });

  it("reports a target with no schema, a null one or a blank one on an engine with schemas", () => {
    const message =
      "the target names no schema; Metabase requires one for database Warehouse, whose engine postgres has schemas";
    for (const target of [{}, { schema: null }, { schema: " " }]) {
      expect(
        targetSchemaFindings([withTarget(target)], { Warehouse: "postgres" }),
      ).toEqual([
        {
          rule: "missing-target-schema",
          file: TRANSFORM_FILE,
          message,
          related: [],
        },
      ]);
    }
  });

  it("reads blank as Java's whitespace does: U+001F is blank, a no-break space and U+FEFF are not", () => {
    const findings = (schema: string) =>
      targetSchemaFindings([withTarget({ schema })], {
        Warehouse: "postgres",
      }).length;
    expect(findings("\u001f\u2028\t")).toBe(1);
    expect(findings("\u00a0")).toBe(0);
    expect(findings("\ufeff")).toBe(0);
  });

  it("checks a Python transform's target on the database the target names", () => {
    expect(
      targetSchemaFindings(
        [
          transformDoc({
            source: PYTHON_SOURCE,
            target: { type: "table", name: "t", database: "Lake" },
          }),
        ],
        { Warehouse: "mysql", Lake: "snowflake" },
      ).map((r) => r.message),
    ).toEqual([
      "the target names no schema; Metabase requires one for database Lake, whose engine snowflake has schemas",
    ]);
  });

  it("checks a query transform's target on its query's database, over the target's and source_database_id", () => {
    expect(
      targetSchemaFindings(
        [
          transformDoc({
            source: queryOn("Lake"),
            target: { type: "table", name: "t", database: "Legacy" },
          }),
        ],
        { Warehouse: "mysql", Legacy: "mysql", Lake: "snowflake" },
      ).map((r) => r.message),
    ).toEqual([
      "the target names no schema; Metabase requires one for database Lake, whose engine snowflake has schemas",
    ]);
  });

  it("skips a Python transform whose target names no database, whatever the engine of its source_database_id", () => {
    expect(
      targetSchemaFindings(
        [
          transformDoc({
            source: PYTHON_SOURCE,
            target: { type: "table", name: "t" },
          }),
        ],
        { Warehouse: "postgres" },
      ),
    ).toEqual([]);
  });

  it("accepts a target with a schema", () => {
    expect(
      targetSchemaFindings([withTarget({ schema: "analytics" })], {
        Warehouse: "postgres",
      }),
    ).toEqual([]);
  });

  it("accepts no schema on an engine without schemas, one that decides per database, an unknown one, or none", () => {
    for (const engine of ["mysql", "athena", "duckdb"]) {
      expect(
        targetSchemaFindings([withTarget({})], { Warehouse: engine }),
      ).toEqual([]);
    }
    expect(targetSchemaFindings([withTarget({})], {})).toEqual([]);
  });

  it("skips a transform that fails its schema", () => {
    expect(
      targetSchemaFindings(
        [
          {
            ...withTarget({}),
            schema: {
              status: "failed",
              error: { path: "/name", message: "must be string" },
            },
          },
        ],
        {
          Warehouse: "postgres",
        },
      ),
    ).toEqual([]);
  });
});

describe("reportUnsupportedTransformEngines", () => {
  it("reports a query transform on an engine that cannot run one", () => {
    expect(engineFindings([transformDoc({})], { Warehouse: "h2" })).toEqual([
      {
        rule: "unsupported-transform-engine",
        file: TRANSFORM_FILE,
        message:
          "Metabase cannot run a query transform on database Warehouse: its engine h2 lacks the driver feature transforms/table",
        related: [],
      },
    ]);
  });

  it("reports a Python transform on an engine that cannot run one", () => {
    expect(
      engineFindings([pythonOn("Warehouse")], {
        Warehouse: "sqlite",
      }).map((r) => r.message),
    ).toEqual([
      "Metabase cannot run a Python transform on database Warehouse: its engine sqlite lacks the driver feature transforms/python",
    ]);
  });

  it("checks each kind of transform against its own feature", () => {
    expect(
      engineFindings(
        [pythonOn("Warehouse"), transformDoc({ source: queryOn("Docs") })],
        { Warehouse: "mongo", Docs: "mongo" },
      ).map((r) => r.message),
    ).toEqual([
      "Metabase cannot run a query transform on database Docs: its engine mongo lacks the driver feature transforms/table",
    ]);
  });

  it("checks the database the target names", () => {
    expect(
      engineFindings(
        [
          transformDoc({
            source: PYTHON_SOURCE,
            target: { type: "table", name: "t", schema: "s", database: "Lake" },
          }),
        ],
        { Warehouse: "postgres", Lake: "vertica" },
      ).map((r) => r.message),
    ).toEqual([
      "Metabase cannot run a Python transform on database Lake: its engine vertica lacks the driver feature transforms/python",
    ]);
  });

  it("skips a Python transform whose target names no database, whatever the engine of its source_database_id", () => {
    expect(
      engineFindings([transformDoc({ source: PYTHON_SOURCE })], {
        Warehouse: "sqlite",
      }),
    ).toEqual([]);
  });

  it("accepts a transform on an engine that runs it, an unknown engine, or none", () => {
    expect(
      engineFindings([transformDoc({})], { Warehouse: "postgres" }),
    ).toEqual([]);
    expect(engineFindings([transformDoc({})], { Warehouse: "duckdb" })).toEqual(
      [],
    );
    expect(engineFindings([transformDoc({})], {})).toEqual([]);
  });
});

describe("reportUntestableEngines", () => {
  it("reports a test of a transform on an engine that cannot run transform tests", () => {
    expect(
      testEngineFindings([transformDoc({}), testDoc(TRANSFORM_ID)], {
        Warehouse: "snowflake",
      }),
    ).toEqual([
      {
        rule: "untestable-engine",
        file: TEST_FILE,
        message:
          "Metabase cannot run this test: transform Orders by day reads database Warehouse, whose engine snowflake lacks the driver feature transforms/testing",
        related: [TRANSFORM_FILE],
      },
    ]);
  });

  it("checks the query's database, not the database the target names or source_database_id", () => {
    const transform = transformDoc({
      source: queryOn("Lake"),
      target: { type: "table", name: "t", schema: "s", database: "Legacy" },
    });
    expect(
      testEngineFindings([transform, testDoc(TRANSFORM_ID)], {
        Warehouse: "postgres",
        Legacy: "postgres",
        Lake: "snowflake",
      }).map((r) => r.message),
    ).toEqual([
      "Metabase cannot run this test: transform Orders by day reads database Lake, whose engine snowflake lacks the driver feature transforms/testing",
    ]);
  });

  it("accepts a test on an engine that runs transform tests, an unknown engine, or none", () => {
    const docs = [transformDoc({}), testDoc(TRANSFORM_ID)];
    expect(testEngineFindings(docs, { Warehouse: "h2" })).toEqual([]);
    expect(testEngineFindings(docs, { Warehouse: "duckdb" })).toEqual([]);
    expect(testEngineFindings(docs, {})).toEqual([]);
  });

  it("leaves a test of no transform, or of a Python transform, to the rules on transform_id", () => {
    const engines = { Warehouse: "snowflake" };
    expect(
      testEngineFindings([testDoc("NoSuchTransform000001")], engines),
    ).toEqual([]);
    expect(
      testEngineFindings(
        [transformDoc({ source: PYTHON_SOURCE }), testDoc(TRANSFORM_ID)],
        engines,
      ),
    ).toEqual([]);
  });
});

describe("reportUnknownEngines", () => {
  const cardOn = (database: string | undefined): Doc => ({
    file: "collections/main/orders.yaml",
    model: "Card",
    schema: { status: "passed" },
    nonStringKeys: [],
    body: {
      name: "Orders",
      dataset_query:
        database === undefined ? {} : { "lib/type": "mbql/query", database },
      "serdes/meta": [{ model: "Card" }],
    },
  });

  const unknownEngineFindings = (
    docs: readonly Doc[],
    engines: Readonly<Record<string, string>>,
  ): Recorded[] => {
    const recorded: Recorded[] = [];
    reportUnknownEngines(
      docs,
      enginesOf(engines),
      createSourceFinder(loadSchemas()),
      recorder(recorded),
    );
    return recorded;
  };

  const advice =
    'so the checks that depend on it do not run. Give the database\'s driver name under "engines" in .metabase-lint.json';

  it("warns on a transform and a card whose database no file gives an engine", () => {
    expect(
      unknownEngineFindings([transformDoc({}), cardOn("Warehouse")], {}),
    ).toEqual(
      [TRANSFORM_FILE, "collections/main/orders.yaml"].map((file) => ({
        rule: "unknown-engine",
        file,
        message: `no Database file or .metabase-lint.json names the engine of database Warehouse, ${advice}`,
        related: [],
      })),
    );
  });

  it("warns on an engine the lint does not know, without advice to set it", () => {
    expect(
      unknownEngineFindings([transformDoc({})], { Warehouse: "duckdb" }).map(
        (r) => r.message,
      ),
    ).toEqual([
      "the engine duckdb of database Warehouse is not in the lint's table of Metabase's drivers, as a third-party or newer driver is not, so the checks that depend on it do not run. Check the driver name",
    ]);
  });

  it("warns once on each database a transform reads whose engine is unknown", () => {
    const python = transformDoc({
      source: {
        ...PYTHON_SOURCE,
        "source-tables": [
          { alias: "a", database_id: "Lake", table_id: ["Lake", null, "a"] },
          { alias: "b", database_id: "Lake", schema: "s", table: "b" },
          { alias: "c", database_id: "Pond", schema: "s", table: "c" },
          {
            alias: "d",
            database_id: "Warehouse",
            table_id: ["Warehouse", "s", "d"],
          },
        ],
      },
      target: { type: "table", schema: "s", name: "t", database: "Warehouse" },
    });
    expect(
      unknownEngineFindings([python], { Warehouse: "postgres" }).map(
        (r) => r.message,
      ),
    ).toEqual(
      ["Lake", "Pond"].map(
        (database) =>
          `no Database file or .metabase-lint.json names the engine of database ${database}, ${advice}`,
      ),
    );
  });

  it("checks the database a Python transform's target names, and skips one that names none", () => {
    expect(
      unknownEngineFindings([pythonOn("Lake")], { Warehouse: "postgres" }).map(
        (r) => r.message,
      ),
    ).toEqual([
      `no Database file or .metabase-lint.json names the engine of database Lake, ${advice}`,
    ]);
    expect(
      unknownEngineFindings([transformDoc({ source: PYTHON_SOURCE })], {}),
    ).toEqual([]);
  });

  it("gives no finding for a known engine, or a card whose query names no database", () => {
    expect(
      unknownEngineFindings([transformDoc({}), cardOn("Warehouse")], {
        Warehouse: "postgres",
      }),
    ).toEqual([]);
    expect(unknownEngineFindings([cardOn(undefined)], {})).toEqual([]);
  });
});

describe("RequiredFeature", () => {
  // The type check is the test.
  it("pairs each kind of transform with its own feature", () => {
    const query: RequiredFeature = {
      kind: "query",
      feature: "transforms/table",
    };
    // @ts-expect-error A query transform needs transforms/table.
    const mismatched: RequiredFeature = {
      ...query,
      feature: "transforms/python",
    };
    void mismatched;
  });
});
