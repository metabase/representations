import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join } from "path";

import { type Doc, indexByEntityId } from "./documents.js";
import { lint } from "./lint.js";
import { CONFIG_FILE } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";
import { reportTransformIds } from "./test-checks.js";

type Found = { severity: string; rule: string; message: string };

const PG = "Warehouse";
const CH = "Clicks";

beforeAll(async () => {
  await loadSqlParser();
}, 60_000);

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "representations-test-checks-"));
  writeFileSync(
    join(workdir, CONFIG_FILE),
    JSON.stringify({
      engines: { [PG]: "postgres", [CH]: "clickhouse" },
      defaultSchemas: { [PG]: "public", [CH]: "default" },
    }),
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const TRANSFORM_ID = "TestChecksTransform01";

/** A `dimension` template tag with no default on the field `[database, schema, table, field]`. */
function dimensionTag(
  name: string,
  [database, schema, table, field]: [string, string, string, string],
) {
  return {
    type: "dimension",
    name,
    id: "bb000001-0000-0000-0000-000000000001",
    "display-name": name,
    dimension: ["field", {}, [database, schema, table, field]],
    "widget-type": "date/all-options",
  };
}

/** A `temporal-unit` template tag on the field `[database, schema, table, field]`. */
function temporalUnitTag(
  name: string,
  [database, schema, table, field]: [string, string, string, string],
) {
  return {
    type: "temporal-unit",
    name,
    id: "bb000002-0000-0000-0000-000000000002",
    "display-name": name,
    dimension: ["field", {}, [database, schema, table, field]],
  };
}

/** A rows input of `table` (`schema.name` or `name`) with `columns`, all TEXT unless typed. */
function rowsInput(table: string, columns: (string | [string, string])[]) {
  const dot = table.indexOf(".");
  return {
    table:
      dot === -1
        ? { name: table }
        : { schema: table.slice(0, dot), name: table.slice(dot + 1) },
    format: "rows",
    columns: columns.map((c) =>
      typeof c === "string"
        ? { name: c, cast_type: "TEXT" }
        : { name: c[0], cast_type: c[1] },
    ),
    rows: [],
  };
}

/**
 * Lints a folder holding one transform (native, unless `stage` says) on `database` writing
 * `<targetSchema>.out` and one test of it, and returns every finding.
 */
async function lintTest({
  database = PG,
  targetSchema = "transforms",
  sql,
  tags,
  stage,
  inputs,
  expectationSql = `SELECT * FROM ${targetSchema}.out WHERE 1 = 0`,
}: {
  database?: string;
  targetSchema?: string;
  sql?: string;
  /** The query's one stage, in place of the native stage of `sql` and `tags`. */
  stage?: object;
  tags?: object[];
  inputs: object[];
  expectationSql?: string;
}): Promise<Found[]> {
  const folder = join(workdir, "collections", "transforms");
  mkdirSync(join(folder, "t"), { recursive: true });
  writeFileSync(
    join(folder, "t.yaml"),
    yaml.dump({
      name: "T",
      entity_id: TRANSFORM_ID,
      creator_id: "admin@example.com",
      source_database_id: database,
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database,
          stages: [
            stage ?? {
              "lib/type": "mbql.stage/native",
              native: sql,
              ...(tags === undefined ? {} : { "template-tags": tags }),
            },
          ],
        },
      },
      target: { database, type: "table", schema: targetSchema, name: "out" },
      "serdes/meta": [{ model: "Transform" }],
    }),
  );
  writeFileSync(
    join(folder, "t", "test.yaml"),
    yaml.dump({
      name: "T: test",
      entity_id: "TestChecksTest0000001",
      transform_id: TRANSFORM_ID,
      creator_id: "admin@example.com",
      inputs,
      expectations: [{ type: "empty", name: "e", sql: expectationSql }],
      "serdes/meta": [{ model: "TransformTest" }],
    }),
  );
  return (await lint({ folder: workdir })).findings.map((f) => ({
    severity: f.severity,
    rule: f.rule,
    message: f.message,
  }));
}

describe("inputs of a transform with a dimension tag with no default", () => {
  it("the table of a dimension tag with no default is not a read that needs an input", async () => {
    expect(
      await lintTest({
        sql: "SELECT id, created_at FROM orders",
        inputs: [rowsInput("orders", ["id", "created_at"])],
      }),
    ).toEqual([]);
    expect(
      await lintTest({
        sql: "SELECT id, created_at FROM orders WHERE {{d}}",
        tags: [dimensionTag("d", [PG, "public", "orders", "created_at"])],
        inputs: [rowsInput("orders", ["id", "created_at"])],
      }),
    ).toEqual([]);
  });

  it("an input for only the table of a dimension tag with no default is unused", async () => {
    const unused = {
      severity: "error",
      rule: "unused-input",
      message: "input public.products is not read by transform T",
    };
    const inputs = [
      rowsInput("orders", ["id"]),
      rowsInput("public.products", ["category"]),
    ];
    expect(
      await lintTest({ sql: "SELECT id FROM orders WHERE 1 = 1", inputs }),
    ).toEqual([unused]);
    expect(
      await lintTest({
        sql: "SELECT id FROM orders WHERE {{p}}",
        tags: [dimensionTag("p", [PG, "public", "products", "category"])],
        inputs,
      }),
    ).toEqual([unused]);
  });
});

describe("inputs of a transform with a temporal-unit tag", () => {
  // Metabase writes the tag's field as a column, which reads no table.
  it("a temporal-unit tag's table is not a read that needs an input", async () => {
    const sql = "SELECT {{u}} AS d, total FROM orders";
    const tags = [
      temporalUnitTag("u", [PG, "public", "products", "created_at"]),
    ];
    expect(
      await lintTest({ sql, tags, inputs: [rowsInput("orders", ["total"])] }),
    ).toEqual([]);
    expect(
      await lintTest({
        sql,
        tags,
        inputs: [
          rowsInput("orders", ["total"]),
          rowsInput("public.products", ["created_at"]),
        ],
      }),
    ).toEqual([
      {
        severity: "error",
        rule: "unused-input",
        message: "input public.products is not read by transform T",
      },
    ]);
  });
});

describe("inputs of an MBQL transform", () => {
  it("an input in the default schema stands in for a reference with no schema", async () => {
    const found = await lintTest({
      stage: {
        "lib/type": "mbql.stage/mbql",
        "source-table": [PG, null, "orders"],
      },
      inputs: [rowsInput("public.orders", ["id"])],
    });
    expect(found).toEqual([]);
  });
});

describe("inputs that stand in for one table", () => {
  it("the duplicate-input message lists only the inputs that collide", async () => {
    const found = await lintTest({
      sql: "SELECT t.id, u.id AS uid FROM a.t JOIN b.u ON t.id = u.id",
      inputs: [
        rowsInput("a.t", ["id"]),
        rowsInput("a.t", ["id"]),
        rowsInput("b.u", ["id"]),
      ],
    });
    expect(found.filter((f) => f.rule === "duplicate-input")).toEqual([
      {
        severity: "error",
        rule: "duplicate-input",
        message: "inputs stand in for the same table: a.t, a.t",
      },
    ]);
  });
});

describe("reportTransformIds", () => {
  const docOf = (file: string, model: string, body: object): Doc => ({
    file,
    model,
    schema: { status: "passed" },
    nonStringKeys: [],
    body: { ...body, "serdes/meta": [{ model }] },
  });

  // A test file in no folder has no folder for a transform to sit beside.
  it("suggests no transform beside a test file in no folder", () => {
    const test = docOf("tests.yaml", "TransformTest", {
      name: "tests",
      entity_id: "DanglingTest000000001",
      transform_id: "MissingTransform00000",
      inputs: [],
      expectations: [],
    });
    const transform = docOf("tests.yam.yaml", "Transform", {
      name: "Other",
      entity_id: "OtherTransform0000001",
    });
    const docs = [test, transform];
    const found: string[] = [];
    reportTransformIds(
      docs,
      indexByEntityId(docs),
      new Map(),
      (rule, _, message) => found.push(`${rule}: ${message}`),
    );
    expect(found).toEqual([
      "dangling-transform-id: transform_id MissingTransform00000 matches no entity",
    ]);
  });
});
