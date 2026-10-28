import { describe, expect, it } from "bun:test";

import type { Doc } from "./documents.js";
import type { LintRule, Report } from "./findings.js";
import {
  reportEmptyExpectations,
  reportExpectationNames,
  reportRowsColumns,
} from "./test-body-checks.js";

type Recorded = { rule: LintRule; file: string; message: string };

/** Runs `check` on `docs` and returns what it reported. */
function run(
  check: (docs: readonly Doc[], report: Report) => void,
  docs: readonly Doc[],
): Recorded[] {
  const recorded: Recorded[] = [];
  check(docs, (rule, doc, message) =>
    recorded.push({ rule, file: doc.file, message }),
  );
  return recorded;
}

const ORDERS_COLUMNS = [
  { name: "id", cast_type: "INTEGER" },
  { name: "total", cast_type: "NUMERIC" },
];

/** A schema-valid transform test with `body`'s fields over a minimal test. */
function testDoc(body: Record<string, unknown>): Doc {
  return {
    file: "collections/transforms/orders/orders__test.yaml",
    model: "TransformTest",
    schemaValid: true,
    body: {
      name: "orders test",
      entity_id: "OrdersTest00000000001",
      transform_id: "OrdersTransform000001",
      creator_id: "admin@example.com",
      inputs: [],
      expectations: [],
      "serdes/meta": [{ model: "TransformTest" }],
      ...body,
    },
  };
}

function ordersInput(rows: readonly Record<string, unknown>[]) {
  return {
    table: { schema: "public", name: "orders" },
    format: "rows",
    columns: ORDERS_COLUMNS,
    rows,
  };
}

describe("reportRowsColumns", () => {
  it("names the first input row that lacks a declared column or carries an undeclared one", () => {
    const doc = testDoc({
      inputs: [
        ordersInput([{ id: 1, total: 10 }, { id: 2, totl: 20 }, { id: 3 }]),
      ],
    });
    expect(run(reportRowsColumns, [doc])).toEqual([
      {
        rule: "row-columns-mismatch",
        file: doc.file,
        message:
          'input public.orders, row 2: every row must carry exactly the declared columns; missing "total"; not declared: "totl"',
      },
    ]);
  });

  it("names a row that only lacks a declared column", () => {
    const doc = testDoc({
      inputs: [ordersInput([{ id: 1, total: 10 }, { id: 2 }])],
    });
    expect(run(reportRowsColumns, [doc]).map((r) => r.message)).toEqual([
      'input public.orders, row 2: every row must carry exactly the declared columns; missing "total"',
    ]);
  });

  it("checks an equals expectation in rows format", () => {
    const doc = testDoc({
      expectations: [
        {
          type: "equals",
          name: "totals",
          format: "rows",
          columns: ORDERS_COLUMNS,
          rows: [{ id: 1, total: 10, extra: null }],
        },
      ],
    });
    expect(run(reportRowsColumns, [doc]).map((r) => r.message)).toEqual([
      'expectation totals, row 1: every row must carry exactly the declared columns; not declared: "extra"',
    ]);
  });

  it("compares column names case-sensitively, as Metabase does", () => {
    const doc = testDoc({ inputs: [ordersInput([{ id: 1, TOTAL: 10 }])] });
    expect(run(reportRowsColumns, [doc]).map((r) => r.message)).toEqual([
      'input public.orders, row 1: every row must carry exactly the declared columns; missing "total"; not declared: "TOTAL"',
    ]);
  });

  it("accepts rows that carry exactly the declared columns, in any order, and data in sql format", () => {
    const doc = testDoc({
      inputs: [
        ordersInput([
          { total: 10, id: 1 },
          { id: 2, total: null },
        ]),
        { table: { name: "people" }, format: "sql", sql: "SELECT 1 AS id" },
      ],
      expectations: [
        { type: "equals", name: "by sql", format: "sql", sql: "SELECT 1" },
        { type: "empty", name: "none negative", sql: "SELECT 1" },
      ],
    });
    expect(run(reportRowsColumns, [doc])).toEqual([]);
  });

  it("does not check a test that fails its schema", () => {
    const doc: Doc = {
      ...testDoc({ inputs: [ordersInput([{ id: 1 }])] }),
      schemaValid: false,
    };
    expect(run(reportRowsColumns, [doc])).toEqual([]);
  });
});

describe("reportExpectationNames", () => {
  const empty = (name: string) => ({ type: "empty", name, sql: "SELECT 1" });

  it("reports each name that more than one expectation of a test holds, once", () => {
    const doc = testDoc({
      expectations: [
        empty("no negative totals"),
        empty("one row per id"),
        empty("no negative totals"),
        empty("one row per id"),
        empty("no negative totals"),
      ],
    });
    expect(run(reportExpectationNames, [doc])).toEqual([
      {
        rule: "duplicate-expectation-name",
        file: doc.file,
        message:
          'expectation name "no negative totals" is held by 3 expectations; names must be unique within a test',
      },
      {
        rule: "duplicate-expectation-name",
        file: doc.file,
        message:
          'expectation name "one row per id" is held by 2 expectations; names must be unique within a test',
      },
    ]);
  });

  it("accepts names that differ only in case, as Metabase does", () => {
    const doc = testDoc({
      expectations: [empty("No negative totals"), empty("no negative totals")],
    });
    expect(run(reportExpectationNames, [doc])).toEqual([]);
  });

  it("does not compare the names of two tests", () => {
    const first = testDoc({ expectations: [empty("no negative totals")] });
    const second = { ...first, file: "collections/transforms/other.yaml" };
    expect(run(reportExpectationNames, [first, second])).toEqual([]);
  });
});

describe("reportEmptyExpectations", () => {
  it("warns on a test with no expectations", () => {
    const doc = testDoc({ expectations: [] });
    expect(run(reportEmptyExpectations, [doc])).toEqual([
      {
        rule: "no-expectations",
        file: doc.file,
        message:
          "the test has no expectations; it passes whenever the transform runs on its inputs",
      },
    ]);
  });

  it("accepts a test with one expectation", () => {
    const doc = testDoc({
      expectations: [{ type: "empty", name: "none", sql: "SELECT 1" }],
    });
    expect(run(reportEmptyExpectations, [doc])).toEqual([]);
  });
});
