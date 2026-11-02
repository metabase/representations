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

import { lint } from "./lint.js";
import { CONFIG_FILE } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";

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

/** A `dimension` template tag on the field `[database, schema, table, field]`. */
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
 * Lints a folder holding one native transform on `database` writing
 * `<targetSchema>.out` and one test of it, and returns every finding.
 */
async function lintTest({
  database = PG,
  targetSchema = "transforms",
  sql,
  tags,
  inputs,
  expectationSql = `SELECT * FROM ${targetSchema}.out WHERE 1 = 0`,
}: {
  database?: string;
  targetSchema?: string;
  sql: string;
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
            {
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

describe("inputs of a transform with a field-filter tag", () => {
  it("a field-filter tag's table is not a read that needs an input", async () => {
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

  it("an input for only a field-filter tag's table is unused", async () => {
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

describe("tables the transform's SQL reads after the rewrite", () => {
  it("a quoted table name whose case is not the input's is an error", async () => {
    const errors = async (table: string) =>
      (
        await lintTest({
          sql: `SELECT o.id FROM ${table} o`,
          inputs: [rowsInput("orders", ["id"])],
        })
      ).filter((f) => f.severity === "error");
    expect(await errors('"orders"')).toEqual([]);
    expect(await errors('"Orders"')).toEqual([
      {
        severity: "error",
        rule: "missing-input",
        message:
          "no input for Orders, which transform T reads: Metabase replaces a quoted name only in its exact case, so input orders does not stand in for it. Name the input Orders, or write the name in the SQL as the input does",
      },
    ]);
  });

  it("a field-filter tag's field in another case needs no input", async () => {
    expect(
      await lintTest({
        sql: "SELECT id, created_at FROM orders WHERE {{d}}",
        tags: [dimensionTag("d", [PG, "public", "Orders", "created_at"])],
        inputs: [rowsInput("orders", ["id", "created_at"])],
      }),
    ).toEqual([]);
  });
});

describe("expectation SQL that Metabase refuses", () => {
  const transform = {
    sql: "SELECT o.id FROM orders o",
    inputs: [rowsInput("orders", ["id"])],
  };

  it("a column qualifier in an expectation that names no table after the rewrite is an error", async () => {
    expect(
      await lintTest({
        ...transform,
        expectationSql: "SELECT o.id FROM transforms.out o WHERE o.id < 0",
      }),
    ).toEqual([]);
    expect(
      await lintTest({
        ...transform,
        expectationSql: "SELECT out.id FROM transforms.out WHERE out.id < 0",
      }),
    ).toEqual([
      expect.objectContaining({
        severity: "error",
        rule: "expectation-qualified-column",
        message: expect.stringContaining("qualifies a column by out"),
      }),
    ]);
  });
});

describe("columns an input lacks", () => {
  it("a ClickHouse column whose case is not the input's is missing", async () => {
    const missing = async (database: string, targetSchema: string) =>
      (
        await lintTest({
          database,
          targetSchema,
          sql: "SELECT o.id, o.total FROM orders o",
          inputs: [rowsInput("orders", ["id", "Total"])],
        })
      ).filter((f) => f.rule === "input-missing-read-column");
    expect(await missing(PG, "transforms")).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining(
          "reads the column total from input orders, which declares Total",
        ),
      }),
    ]);
    expect(await missing(CH, "default")).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining(
          "reads the column total from input orders, which declares Total",
        ),
      }),
    ]);
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
