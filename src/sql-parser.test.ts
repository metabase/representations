import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  answerOf,
  cacheBySql,
  dialectOf,
  loadSqlParser,
  type SqlParser,
  type Unread,
} from "./sql-parser.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

describe("dialectOf", () => {
  it.each([
    ["postgres", "postgres"],
    ["sqlserver", "tsql"],
    ["bigquery-cloud-sdk", "bigquery"],
    ["starburst", "trino"],
    ["h2", null],
    ["vertica", null],
    ["oracle", "oracle"],
    [null, null],
  ] as const)(
    "maps engine %p to SQLGlot dialect %p, as Metabase does",
    (engine, dialect) => {
      expect(dialectOf(engine)).toBe(dialect);
    },
  );
});

describe("cacheBySql", () => {
  it("parses each SQL, in each dialect, once", () => {
    const parsed: [string, string | null][] = [];
    const parse = cacheBySql((sql: string, dialect: string | null) => {
      parsed.push([sql, dialect]);
      return { sql, dialect };
    });
    const first = parse("SELECT 1", "postgres");
    expect(parse("SELECT 1", "postgres")).toBe(first);
    parse("SELECT 1", null);
    parse("SELECT 2", "postgres");
    expect(parsed).toEqual([
      ["SELECT 1", "postgres"],
      ["SELECT 1", null],
      ["SELECT 2", "postgres"],
    ]);
  });
});

describe("answerOf", () => {
  it("strips the mark, then gives the answer or the error sql_tools raised", () => {
    expect(answerOf('\u00b6{"answer": [1]}')).toEqual({
      status: "read",
      answer: [1],
    });
    expect(
      answerOf(
        '\u00b6{"error": "ParseError", "message": "Invalid expression"}',
      ),
    ).toEqual({ status: "unread", reason: "ParseError: Invalid expression" });
  });

  // Pyodide 314.0.7 returns an ASCII-only string held above 2 GiB of its
  // memory as the bytes at another address, and these can be valid JSON.
  it("is unread when the mark is missing or not first", () => {
    const unmarked: Unread = {
      status: "unread",
      reason: "the SQL parser answered without its mark",
    };
    expect(answerOf('{"answer": [1]}')).toEqual(unmarked);
    expect(answerOf('{"answer": [1]}\u00b6')).toEqual(unmarked);
    expect(answerOf(' \u00b6{"answer": [1]}')).toEqual(unmarked);
    expect(answerOf("")).toEqual(unmarked);
  });

  it("is unread when the marked answer is not JSON, or not an answer", () => {
    expect(answerOf("\u00b6\u0000\u0000@t\u001eB")).toEqual({
      status: "unread",
      reason: expect.stringMatching(
        /^the SQL parser answered with text that is not JSON: /,
      ),
    });
    expect(answerOf('\u00b6\u00b6{"answer": [1]}')).toEqual({
      status: "unread",
      reason: expect.stringMatching(
        /^the SQL parser answered with text that is not JSON: /,
      ),
    });
    expect(answerOf('\u00b6{"other": 1}')).toEqual({
      status: "unread",
      reason: "the SQL parser answered with JSON that is not an answer",
    });
  });
});

describe("the vendored sources", () => {
  it("hold the SQLGlot wheel that sources.json names, with its hash", () => {
    const { sqlglot } = readVendorSources();
    expect(sqlglot.wheel).toBe(`sqlglot-${sqlglot.version}-py3-none-any.whl`);
    expect(
      createHash("sha256")
        .update(readFileSync(resolve(VENDOR_DIR, sqlglot.wheel)))
        .digest("hex"),
    ).toBe(sqlglot.sha256);
  });
});

describe("loadSqlParser", () => {
  let parser: SqlParser;

  beforeAll(async () => {
    parser = await loadSqlParser();
  }, 60_000);

  it("loads one parser per process", async () => {
    expect(await loadSqlParser()).toBe(parser);
  });

  // In a fresh process: this test process loaded the parser long ago.
  it("starts again after a failed start, and keeps the parser that starts", () => {
    const run = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        `import { mock } from "bun:test";
         const pyodide = await import("pyodide");
         // The namespace becomes the mock: keep the real function.
         const { loadPyodide } = pyodide;
         let starts = 0;
         mock.module("pyodide", () => ({
           ...pyodide,
           loadPyodide: (...args) =>
             ++starts === 1
               ? Promise.reject(new RangeError("out of memory"))
               : loadPyodide(...args),
         }));
         const { loadSqlParser, sqlParserStarted } = await import("./src/sql-parser.ts");
         const outcome = (load) =>
           load.then(() => "loaded", (e) => \`\${e.name}: \${e.message}\`);
         const first = await outcome(loadSqlParser());
         const startedAfterFailure = sqlParserStarted();
         const second = await outcome(loadSqlParser());
         const sameParser =
           second === "loaded" && (await loadSqlParser()) === (await loadSqlParser());
         console.log(JSON.stringify({ first, startedAfterFailure, second, sameParser, starts }));`,
      ],
      cwd: resolve(import.meta.dirname, ".."),
    });
    expect(JSON.parse(run.stdout.toString())).toEqual({
      first: "LintSetupError: The SQL parser could not start: out of memory",
      startedAfterFailure: false,
      second: "loaded",
      sameParser: true,
      starts: 2,
    });
    expect(run.stderr.toString()).toBe("");
  }, 60_000);

  it("reads the tables Metabase's referenced_tables reads, without the catalog", () => {
    expect(
      parser.referencedTables(
        "SELECT * FROM public.orders o JOIN customers c ON c.id = o.customer_id",
        "postgres",
      ),
    ).toEqual({
      status: "read",
      tables: [
        { schema: null, name: "customers" },
        { schema: "public", name: "orders" },
      ],
    });
    expect(
      parser.referencedTables("SELECT * FROM `proj.ds.orders`", "bigquery"),
    ).toEqual({ status: "read", tables: [{ schema: "ds", name: "orders" }] });
  });

  it("reads a table whose name holds the mark or other non-ASCII characters", () => {
    expect(
      parser.referencedTables(
        'SELECT * FROM "\u00b6orders" JOIN "caf\u00e9" ON 1 = 1',
        "postgres",
      ),
    ).toEqual({
      status: "read",
      tables: [
        { schema: null, name: "caf\u00e9" },
        { schema: null, name: "\u00b6orders" },
      ],
    });
  });

  it("parses in SQLGlot's default dialect when given none", () => {
    // In the default dialect a backtick is not a quote, so this fails to parse.
    expect(
      parser.referencedTables("SELECT * FROM `proj.ds.orders`", null).status,
    ).toBe("unread");
    expect(parser.referencedTables("SELECT * FROM ORDERS", null)).toEqual({
      status: "read",
      tables: [{ schema: null, name: "ORDERS" }],
    });
  });

  it("reports a parse error, a recursion error or an unknown dialect as unread, with the error", () => {
    const unread = (sql: string, dialect: string | null) => {
      const result = parser.referencedTables(sql, dialect);
      return result.status === "unread" ? result.reason : null;
    };
    expect(unread("SELECT * FROM", "postgres")).toStartWith("ParseError: ");
    expect(
      unread(`SELECT ${"(".repeat(60)}1${")".repeat(60)}`, null),
    ).toStartWith("RecursionError: ");
    expect(unread("SELECT 1", "no-such-dialect")).not.toBeNull();
  });

  it("reads the fields Metabase's field_references reads: used, returned, and errors", () => {
    expect(
      parser.fieldReferences(
        "SELECT o.id, count(*) AS n FROM orders o WHERE ghost.x = 1 GROUP BY o.id",
        "postgres",
      ),
    ).toEqual({
      status: "read",
      references: {
        usedFields: [
          {
            type: "single_column",
            column: "id",
            alias: null,
            sourceColumns: [
              [
                {
                  type: "all_columns",
                  table: { schema: null, name: "orders" },
                },
              ],
            ],
          },
        ],
        returnedFields: [
          {
            type: "single_column",
            column: "id",
            alias: null,
            sourceColumns: [
              [
                {
                  type: "all_columns",
                  table: { schema: null, name: "orders" },
                },
              ],
            ],
          },
          { type: "custom_field", alias: "n" },
        ],
        missingTableAliases: ["ghost"],
      },
    });
  });

  it("reads SQL field_references cannot parse, or a union's columns, as SQLGlot leaves them", () => {
    expect(parser.fieldReferences("SELECT * FROM", "postgres")).toEqual({
      status: "unread",
      reason: "field_references could not parse it",
    });
    const union = parser.fieldReferences(
      "SELECT a FROM t UNION ALL SELECT b FROM u",
      null,
    );
    expect(
      union.status === "read" ? union.references.returnedFields : null,
    ).toEqual([{ type: "composite_field", alias: "a" }]);
  });

  it("reads SQL whose query field_references walks as neither a SELECT nor a UNION as unread", () => {
    for (const sql of [
      "SELECT a FROM t INTERSECT SELECT a FROM u",
      "SELECT a FROM t EXCEPT SELECT a FROM u",
    ]) {
      expect(parser.fieldReferences(sql, "postgres")).toEqual({
        status: "unread",
        reason: "field_references could not parse it",
      });
    }
  });

  it("replaces table names as Metabase's replace_names does", () => {
    expect(
      parser.replaceNames(
        "SELECT orders.id FROM analytics.orders JOIN people p ON 1 = 1",
        [
          [
            { schema: "analytics", table: "orders" },
            { db: null, schema: null, table: "mb_test_1" },
          ],
          [{ table: "people" }, { db: null, schema: null, table: "mb_test_2" }],
        ],
        "postgres",
      ),
    ).toEqual({
      status: "read",
      sql: "SELECT orders.id FROM mb_test_1 JOIN mb_test_2 AS p ON 1 = 1",
    });
    expect(parser.replaceNames("SELECT * FROM", [], "postgres").status).toBe(
      "unread",
    );
  });

  it("gives the first line of SQLGlot's error, not the SQL it quotes with terminal escapes", () => {
    expect(parser.referencedTables("SELECT * FROM a b c", "postgres")).toEqual({
      status: "unread",
      reason:
        "ParseError: Invalid expression / Unexpected token. Line 1, Col: 19.",
    });
  });
});
