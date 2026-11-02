import { beforeAll, describe, expect, it } from "bun:test";

import type { EngineOf } from "./databases.js";
import { type Doc, indexByEntityId, validDocsOf } from "./documents.js";
import type { LintRule } from "./findings.js";
import { createReader, type Transform, transformOf } from "./reads.js";
import { createSourceFinder } from "./query-sources.js";
import { loadSchemas } from "./schemas.js";
import { createSqlColumnReader } from "./sql-columns.js";
import { loadSqlParser } from "./sql-parser.js";
import { createSqlTableReader } from "./sql-tables.js";
import { createTableComparisons, testedTransformsOf } from "./test-checks.js";
import {
  createQueryReader,
  reportLiveSqlInputs,
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
const postgres: EngineOf = () => "postgres";
const schemas = loadSchemas();

let checksOf: (docs: readonly Doc[], engineOf?: EngineOf) => TestSqlChecks;

beforeAll(async () => {
  const parser = await loadSqlParser();
  checksOf = (docs, engineOf = postgres) => {
    const readSql = createSqlTableReader(parser, engineOf);
    const columns = createSqlColumnReader(parser, engineOf);
    const byEntityId = indexByEntityId(docs);
    const findSources = createSourceFinder(schemas);
    const readsOf = createReader(docs, byEntityId, findSources, readSql);
    const transforms = validDocsOf(docs, "Transform").map((doc) =>
      transformOf(doc, readsOf),
    );
    const transformOfDoc = new Map<Doc, Transform>(
      transforms.map((t) => [t.doc, t]),
    );
    return {
      transforms,
      tested: testedTransformsOf(docs, byEntityId, transformOfDoc),
      compare: createTableComparisons(() => "public", new Set()),
      engineOf,
      queryOf: createQueryReader(byEntityId, findSources),
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
  engineOf?: EngineOf,
): Recorded[] {
  const recorded: Recorded[] = [];
  check(checksOf(docs, engineOf), (rule, doc, message, related = []) =>
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
    schema: { status: "passed" },
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
    schema: { status: "passed" },
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
  message: `could not find the columns ${query}: Metabase reads columns only from a single SELECT or UNION statement, and could not read them from this SQL`,
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

  it("reads an input's SQL as written, as Metabase runs it, with no optional clause or template tag", () => {
    const test = testDoc(transform, [
      sqlInput(
        "public",
        "orders",
        "SELECT 1 AS id -- [[ a comment ]]\nUNION ALL SELECT id FROM public.orders [[WHERE x = {{x}}]]",
      ),
    ]);
    expect(run(reportLiveSqlInputs, [transform, test])).toEqual([
      {
        rule: "reads-not-checked",
        file: test.file,
        message: expect.stringMatching(
          /^could not find the tables input public\.orders reads: SQLGlot could not parse it: /,
        ),
        related: [],
      },
    ]);
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
          "could not find the tables input public.customers reads: SQLGlot could not parse it: ParseError: Invalid expression / Unexpected token. Line 1, Col: 19. Line 1: SELECT * FROM a b c",
        related: [],
      },
    ]);
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
