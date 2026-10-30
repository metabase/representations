import { beforeAll, describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { type Doc, indexByEntityId, validDocsOf } from "./documents.js";
import type { LintRule } from "./findings.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { loadSchemas } from "./schemas.js";
import { createSqlColumnReader } from "./sql-columns.js";
import { loadSqlParser } from "./sql-parser.js";
import { createSqlTableReader } from "./sql-tables.js";
import { testedTransformsOf } from "./test-checks.js";
import {
  reportLiveSqlInputs,
  reportMissingReadColumns,
  reportQualifiedColumns,
  reportTestSql,
  reportUpstreamColumns,
  type TestSqlChecks,
} from "./test-sql-checks.js";

type Recorded = {
  rule: LintRule;
  file: string;
  message: string;
  related: string[];
};

const DB = "Warehouse";
const engineOf: EngineOf = () => "postgres";
const schemas = loadSchemas();

let checksOf: (docs: readonly Doc[]) => TestSqlChecks;

beforeAll(async () => {
  const parser = await loadSqlParser();
  const readSql = createSqlTableReader(parser, engineOf);
  const columns = createSqlColumnReader(parser, engineOf);
  checksOf = (docs) => {
    const byEntityId = indexByEntityId(docs);
    const readsOf = createReader(docs, byEntityId, schemas, readSql);
    const transforms = validDocsOf(docs, "Transform").map((doc) =>
      transformOf(doc, readsOf),
    );
    const transformOfDoc = new Map<Doc, Transform>(
      transforms.map((t) => [t.doc, t]),
    );
    return {
      docs,
      byEntityId,
      transforms,
      tested: testedTransformsOf(docs, byEntityId, transformOfDoc),
      defaultSchemaOf: () => "public",
      schemas,
      readSql,
      columns,
    };
  };
}, 60_000);

/** Runs `check` on `docs` and returns what it reported. */
function run(
  check: (
    checks: TestSqlChecks,
    report: Parameters<typeof reportLiveSqlInputs>[1],
  ) => void,
  docs: readonly Doc[],
): Recorded[] {
  const recorded: Recorded[] = [];
  check(checksOf(docs), (rule, doc, message, related = []) =>
    recorded.push({ rule, file: doc.file, message, related }),
  );
  return recorded;
}

const nativeStage = (sql: string) => ({
  "lib/type": "mbql.stage/native",
  native: sql,
});

/** A schema-valid query transform writing `analytics.<target>` with `stages`. */
function transformDoc(
  target: string,
  stages: readonly object[],
  body: Record<string, unknown> = {},
): Doc {
  return {
    file: `collections/transforms/${target}.yaml`,
    model: "Transform",
    schemaError: null,
    nonStringKeys: [],
    body: {
      name: target,
      entity_id: `${target}_transform`.padEnd(21, "0").slice(0, 21),
      creator_id: "admin@example.com",
      source_database_id: DB,
      source: {
        type: "query",
        query: { "lib/type": "mbql/query", database: DB, stages },
      },
      target: { type: "table", schema: "analytics", name: target },
      "serdes/meta": [{ model: "Transform" }],
      ...body,
    },
  };
}

/** A schema-valid test of `transform` with `inputs` and `expectations`. */
function testDoc(
  transform: Doc,
  inputs: readonly object[],
  expectations: readonly object[] = [],
): Doc {
  return {
    file: `${transform.file.replace(/\.yaml$/, "")}/test.yaml`,
    model: "TransformTest",
    schemaError: null,
    nonStringKeys: [],
    body: {
      name: `${String(transform.body.name)} test`,
      entity_id: "TheTest00000000000001",
      transform_id: transform.body.entity_id,
      creator_id: "admin@example.com",
      inputs,
      expectations,
      "serdes/meta": [{ model: "TransformTest" }],
    },
  };
}

/** SQL whose tables SQLGlot reads, but whose columns `field_references` cannot. */
const TWO_STATEMENTS =
  "SELECT o.id FROM public.orders o; SELECT o.total FROM public.orders o";

/** The warning for a query whose columns could not be read. */
const unreadColumns = (file: string, query: string): Recorded => ({
  rule: "reads-not-checked",
  file,
  message: `could not find the columns ${query}: field_references could not parse it`,
  related: [],
});

const table = (schema: string | null, name: string) =>
  schema === null ? { name } : { schema, name };

function rowsInput(schema: string | null, name: string, columns: string[]) {
  return {
    table: table(schema, name),
    format: "rows",
    columns: columns.map((column) => ({ name: column, cast_type: "TEXT" })),
    rows: [],
  };
}

function sqlInput(schema: string | null, name: string, sql: string) {
  return { table: table(schema, name), format: "sql", sql };
}

describe("reportLiveSqlInputs", () => {
  const transform = transformDoc("orders_by_day", [
    nativeStage(
      "SELECT o.id, c.name FROM public.orders o JOIN public.customers c ON c.id = o.customer_id",
    ),
  ]);

  it("warns on an input whose SQL reads a table", () => {
    const test = testDoc(transform, [
      sqlInput(
        "public",
        "orders",
        "SELECT * FROM public.orders WHERE created_at > now() - interval '7 days'",
      ),
      sqlInput("public", "customers", "SELECT 1 AS id, 'Ann' AS name"),
    ]);
    expect(run(reportLiveSqlInputs, [transform, test])).toEqual([
      {
        rule: "live-sql-input",
        file: test.file,
        message:
          "input public.orders reads public.orders; Metabase runs an input's SQL on the database as written, so the test depends on live data",
        related: [],
      },
    ]);
  });

  it("finds nothing in SQL that reads no table", () => {
    const test = testDoc(transform, [
      sqlInput(
        "public",
        "orders",
        "SELECT * FROM generate_series(1, 3) AS g(id) UNION ALL SELECT 4",
      ),
      rowsInput("public", "people", ["id"]),
    ]);
    expect(run(reportLiveSqlInputs, [transform, test])).toEqual([]);
  });

  it("reports an input's SQL it cannot read as unread", () => {
    const test = testDoc(transform, [
      sqlInput("public", "customers", "SELECT * FROM a b c"),
    ]);
    expect(run(reportLiveSqlInputs, [transform, test])).toEqual([
      {
        rule: "reads-not-checked",
        file: test.file,
        message:
          "could not find the tables input public.customers reads: SQLGlot could not parse it: ParseError: Invalid expression / Unexpected token. Line 1, Col: 19.",
        related: [],
      },
    ]);
  });
});

describe("reportMissingReadColumns", () => {
  const sqlTransform = transformDoc("orders_net", [
    nativeStage(
      "SELECT o.ID, o.total - o.discount AS net, c.name FROM public.orders o JOIN customers c ON c.id = o.customer_id",
    ),
  ]);

  it("warns on each column the transform's SQL reads from an input's table that the input lacks", () => {
    const test = testDoc(sqlTransform, [
      rowsInput("public", "orders", ["ID", "total"]),
      rowsInput(null, "customers", ["id"]),
    ]);
    const missing = (input: string, column: string) => ({
      rule: "input-missing-read-column" as const,
      file: test.file,
      message: `input ${input} has no column ${column}, which transform orders_net reads`,
      related: [sqlTransform.file],
    });
    expect(run(reportMissingReadColumns, [sqlTransform, test])).toEqual([
      missing("public.orders", "customer_id"),
      missing("public.orders", "discount"),
      missing("customers", "name"),
    ]);
  });

  it("warns on a column an MBQL transform's field reference names", () => {
    const field = (name: string) => [
      "field",
      {},
      [DB, "public", "orders", name],
    ];
    const mbqlTransform = transformDoc("orders_total", [
      {
        "lib/type": "mbql.stage/mbql",
        "source-table": [DB, "public", "orders"],
        aggregation: [["sum", {}, field("total")]],
        breakout: [field("created_at")],
      },
    ]);
    const test = testDoc(mbqlTransform, [
      rowsInput("public", "orders", ["created_at"]),
    ]);
    expect(
      run(reportMissingReadColumns, [mbqlTransform, test]).map(
        (f) => f.message,
      ),
    ).toEqual([
      "input public.orders has no column total, which transform orders_total reads",
    ]);
  });

  it("warns only on a field of the test's database, by its exact name", () => {
    const field = (database: string, name: string) => [
      "field",
      {},
      [database, "public", "orders", name],
    ];
    const mbqlTransform = transformDoc("orders_total", [
      {
        "lib/type": "mbql.stage/mbql",
        "source-table": [DB, "public", "orders"],
        aggregation: [
          ["sum", {}, field("Other", "total")],
          ["sum", {}, field(DB.toLowerCase(), "tax")],
          ["sum", {}, field(DB, "discount")],
        ],
      },
    ]);
    const test = testDoc(mbqlTransform, [rowsInput("public", "orders", [])]);
    expect(
      run(reportMissingReadColumns, [mbqlTransform, test]).map(
        (f) => f.message,
      ),
    ).toEqual([
      "input public.orders has no column discount, which transform orders_total reads",
    ]);
  });

  it("finds nothing for a column it cannot place in one table, or a SQL input", () => {
    const transform = transformDoc("orders_people", [
      nativeStage(
        "SELECT id, o.total FROM orders o JOIN people p ON o.user_id = p.id",
      ),
    ]);
    const test = testDoc(transform, [
      rowsInput("public", "orders", ["total", "user_id"]),
      sqlInput("public", "people", "SELECT 1 AS other"),
    ]);
    expect(run(reportMissingReadColumns, [transform, test])).toEqual([]);
  });

  it("warns once on a transform whose tables it reads but whose columns it cannot, however many tests it has", () => {
    const transform = transformDoc("orders_ids", [nativeStage(TWO_STATEMENTS)]);
    const first = testDoc(transform, [rowsInput("public", "orders", ["id"])]);
    const second = {
      ...testDoc(transform, [rowsInput("public", "orders", ["total"])]),
      file: "collections/transforms/orders_ids/second_test.yaml",
    };
    expect(run(reportMissingReadColumns, [transform, first, second])).toEqual([
      unreadColumns(transform.file, "this transform reads or returns"),
    ]);
  });

  it("gives no column warning for a transform whose tables it cannot read", () => {
    const transform = transformDoc("orders_ids", [
      nativeStage("SELECT o.id FROM public.orders o WHERE"),
    ]);
    const test = testDoc(transform, [rowsInput("public", "orders", ["id"])]);
    expect(run(reportMissingReadColumns, [transform, test])).toEqual([]);
  });
});

describe("reportUpstreamColumns", () => {
  const upstream = (sql: string) =>
    transformDoc("orders_clean", [nativeStage(sql)]);
  const downstream = transformDoc("order_totals", [
    nativeStage(
      "SELECT sum(amount_cents) AS total FROM analytics.orders_clean",
    ),
  ]);
  const findings = (upstreamSql: string, columns: string[]) => {
    const source = upstream(upstreamSql);
    const test = testDoc(downstream, [
      rowsInput("analytics", "orders_clean", columns),
    ]);
    return run(reportUpstreamColumns, [source, downstream, test]);
  };

  it("warns on each column of an input standing in for another transform's output that it does not return", () => {
    const source = upstream(
      "SELECT o.id, o.customer_id, o.amount AS amount_cents FROM raw.orders o",
    );
    const test = testDoc(downstream, [
      rowsInput("analytics", "orders_clean", ["ID", "amount", "status"]),
    ]);
    expect(run(reportUpstreamColumns, [source, downstream, test])).toEqual(
      ["amount", "status"].map((column) => ({
        rule: "upstream-column-mismatch" as const,
        file: test.file,
        message: `input analytics.orders_clean has column ${column}, which transform orders_clean does not return; it returns id, customer_id, amount_cents`,
        related: [source.file],
      })),
    );
  });

  it.each([
    ["SELECT * FROM raw.orders", "returns *"],
    [
      "SELECT id, amount + 1 FROM raw.orders",
      "returns an expression with no name",
    ],
    ["SELECT id FROM raw.orders WHERE", "is SQL the parser cannot read"],
  ])("finds nothing when the other transform's SQL %s", (sql) => {
    expect(findings(sql, ["id", "amount"])).toEqual([]);
  });

  it("warns on the other transform when it reads its tables but not its columns", () => {
    const source = upstream(TWO_STATEMENTS);
    const test = testDoc(downstream, [
      rowsInput("analytics", "orders_clean", ["id"]),
    ]);
    expect(run(reportUpstreamColumns, [source, downstream, test])).toEqual([
      unreadColumns(source.file, "this transform reads or returns"),
    ]);
  });

  it("finds nothing for an input that stands in for no other transform's output", () => {
    const source = upstream("SELECT id FROM raw.orders");
    const test = testDoc(downstream, [
      rowsInput("public", "orders_clean", ["amount"]),
    ]);
    expect(run(reportUpstreamColumns, [source, downstream, test])).toEqual([]);
  });

  it("finds nothing when the other transform's native stage is followed by another", () => {
    const source = transformDoc("orders_clean", [
      nativeStage("SELECT id FROM raw.orders"),
      { "lib/type": "mbql.stage/mbql" },
    ]);
    const test = testDoc(downstream, [
      rowsInput("analytics", "orders_clean", ["amount"]),
    ]);
    expect(run(reportUpstreamColumns, [source, downstream, test])).toEqual([]);
  });

  it("finds nothing for an input that stands in for the tested transform's own output", () => {
    const incremental = transformDoc("orders_clean", [
      nativeStage(
        "SELECT id FROM raw.orders WHERE id > (SELECT max(id) FROM analytics.orders_clean)",
      ),
    ]);
    const test = testDoc(incremental, [
      rowsInput("raw", "orders", ["id"]),
      rowsInput("analytics", "orders_clean", ["id", "loaded_at"]),
    ]);
    expect(run(reportUpstreamColumns, [incremental, test])).toEqual([]);
  });

  it("finds nothing when the other transform is MBQL", () => {
    const source = transformDoc("orders_clean", [
      {
        "lib/type": "mbql.stage/mbql",
        "source-table": [DB, "raw", "orders"],
      },
    ]);
    const test = testDoc(downstream, [
      rowsInput("analytics", "orders_clean", ["amount"]),
    ]);
    expect(run(reportUpstreamColumns, [source, downstream, test])).toEqual([]);
  });
});

describe("reportQualifiedColumns", () => {
  const ALIAS_ADVICE =
    "Metabase refuses the test. Alias the table and qualify its columns by the alias";

  it("warns when the transform's SQL qualifies a column by the name of a table the test replaces", () => {
    const transform = transformDoc("orders_by_day", [
      nativeStage(
        "SELECT orders.created_at, count(*) AS n FROM analytics.orders GROUP BY orders.created_at",
      ),
    ]);
    const test = testDoc(transform, [
      rowsInput("analytics", "orders", ["created_at"]),
    ]);
    expect(run(reportQualifiedColumns, [transform, test])).toEqual([
      {
        rule: "table-qualified-column",
        file: test.file,
        message: `transform orders_by_day qualifies a column by orders, the name of analytics.orders, which this test replaces. ${ALIAS_ADVICE}`,
        related: [transform.file],
      },
    ]);
  });

  it("warns when an expectation's SQL qualifies a column by the name of the transform's target", () => {
    const transform = transformDoc("orders_by_day", [
      nativeStage("SELECT o.day, count(*) AS n FROM orders o GROUP BY o.day"),
    ]);
    const test = testDoc(
      transform,
      [rowsInput(null, "orders", ["day"])],
      [
        {
          type: "empty",
          name: "no negative counts",
          sql: "SELECT * FROM analytics.orders_by_day WHERE orders_by_day.n < 0",
        },
      ],
    );
    expect(run(reportQualifiedColumns, [transform, test])).toEqual([
      {
        rule: "table-qualified-column",
        file: test.file,
        message: `expectation no negative counts qualifies a column by orders_by_day, the name of analytics.orders_by_day, which this test replaces. ${ALIAS_ADVICE}`,
        related: [],
      },
    ]);
  });

  it("warns on a qualifier that names no table or alias, which Metabase refuses too", () => {
    const transform = transformDoc("orders_ids", [
      nativeStage("SELECT ghost.id FROM analytics.orders o"),
    ]);
    const test = testDoc(transform, [rowsInput("analytics", "orders", ["id"])]);
    expect(
      run(reportQualifiedColumns, [transform, test]).map((f) => f.message),
    ).toEqual([
      "transform orders_ids qualifies a column by ghost, which names no table or alias in its query. Metabase refuses the test. Qualify each column by the alias of a table the query reads",
    ]);
  });

  it.each([
    ["a column qualified by an alias", "SELECT o.id FROM analytics.orders o"],
    [
      "a qualifier Metabase replaces with its table",
      "SELECT orders.id FROM orders",
    ],
    [
      "a qualifier naming a table in the default schema, which Metabase replaces too",
      "SELECT orders.id FROM public.orders",
    ],
  ])("finds nothing for %s", (_, sql) => {
    const transform = transformDoc("orders_ids", [nativeStage(sql)]);
    const test = testDoc(transform, [
      rowsInput("analytics", "orders", ["id"]),
      rowsInput("public", "orders", ["id"]),
    ]);
    expect(run(reportQualifiedColumns, [transform, test])).toEqual([]);
  });

  it("warns once on each query whose tables it reads but whose columns it cannot", () => {
    const transform = transformDoc("orders_ids", [nativeStage(TWO_STATEMENTS)]);
    const test = testDoc(
      transform,
      [rowsInput("public", "orders", ["id", "total"])],
      [
        {
          type: "empty",
          name: "no ids",
          sql: "SELECT id FROM analytics.orders_ids; SELECT 1",
        },
        {
          type: "empty",
          name: "unparsed",
          sql: "SELECT * FROM a b c",
        },
      ],
    );
    expect(run(reportQualifiedColumns, [transform, test])).toEqual([
      unreadColumns(transform.file, "this transform reads or returns"),
      unreadColumns(test.file, "expectation no ids reads"),
    ]);
  });
});

describe("reportTestSql", () => {
  it("warns once on a transform whose columns every column rule fails to read", () => {
    const source = transformDoc("orders_clean", [nativeStage(TWO_STATEMENTS)]);
    const sourceTest = testDoc(source, [
      rowsInput("public", "orders", ["id", "total"]),
    ]);
    const downstream = transformDoc("order_totals", [
      nativeStage("SELECT sum(c.total) AS total FROM analytics.orders_clean c"),
    ]);
    const downstreamTest = {
      ...testDoc(downstream, [
        rowsInput("analytics", "orders_clean", ["total"]),
      ]),
      file: "collections/transforms/order_totals/test.yaml",
    };
    expect(
      run(reportTestSql, [source, sourceTest, downstream, downstreamTest]),
    ).toEqual([unreadColumns(source.file, "this transform reads or returns")]);
  });
});
