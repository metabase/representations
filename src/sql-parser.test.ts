import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import {
  answerOf,
  cacheBySql,
  dialectOf,
  fieldReferencesOf,
  loadSqlParser,
  queryShapeOf,
  referencedTablesOf,
  type SqlParser,
  type Unread,
  withSqlParser,
} from "./sql-parser.js";
import { readVendorSources, VENDOR_DIR } from "./vendor-sources.js";

describe("dialectOf", () => {
  it.each([
    ["postgres", "postgres"],
    ["sqlserver", "tsql"],
    ["bigquery-cloud-sdk", "bigquery"],
    ["starburst", "trino"],
    ["sparksql", "spark"],
    ["presto-jdbc", "presto"],
    ["druid-jdbc", "druid"],
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

describe("reading sql_tools' answers", () => {
  const unexpected: Unread = {
    status: "unread",
    reason: "the SQL parser answered in a shape the lint does not know",
  };
  const fields = (fields: unknown, errors: unknown = []) =>
    JSON.stringify({ used_fields: fields, returned_fields: [], errors });

  it("reads a field spec of a type the lint does not know as unknown columns", () => {
    expect(fieldReferencesOf(fields([{ type: "window_field" }]))).toEqual({
      status: "read",
      references: {
        usedFields: [{ type: "unknown_columns" }],
        returnedFields: [],
        missingTableAliases: [],
      },
    });
  });

  it("reads an error as a map or as [key, value] pairs", () => {
    expect(
      fieldReferencesOf(
        fields(
          [],
          [
            [
              ["type", "missing_table_alias"],
              ["table", "b"],
            ],
            { type: "missing_table_alias", table: "a" },
          ],
        ),
      ),
    ).toMatchObject({
      status: "read",
      references: { missingTableAliases: ["a", "b"] },
    });
  });

  it.each([
    ["not text", 5],
    ["not JSON", "{"],
    ["not a map", "[]"],
    ["fields that are not a list", fields({})],
    ["a field spec with no type", fields([{ column: "a" }])],
    [
      "a single column with no column",
      fields([{ type: "single_column", alias: null, source_columns: [] }]),
    ],
    [
      "a source scope that is not a list",
      fields([
        {
          type: "single_column",
          column: "a",
          alias: null,
          source_columns: [{}],
        },
      ]),
    ],
    [
      "all columns of a table with no name",
      fields([{ type: "all_columns", table: { schema: "s" } }]),
    ],
    ["an error that is not a map", fields([], [5])],
  ])("reads no field references from an answer that is %s", (_, answer) => {
    expect(fieldReferencesOf(answer)).toEqual(unexpected);
  });

  it("reads tables only from [catalog, schema, table] lists", () => {
    expect(referencedTablesOf('[[null, "s", "t"]]')).toEqual({
      status: "read",
      tables: [{ schema: "s", name: "t" }],
    });
    expect(referencedTablesOf('[["s", "t"]]')).toEqual(unexpected);
    expect(referencedTablesOf('[[null, "s", null]]')).toEqual(unexpected);
    expect(referencedTablesOf('{"t": 1}')).toEqual(unexpected);
  });

  it("reads a query shape only in the shape lint_query_shape writes", () => {
    const shape = {
      returns_star: false,
      select_aliases: ["a"],
      array_join_aliases: [],
      column_aliased_tables: [[null, "t"]],
      quoted_columns: [],
      unquoted_columns: ["x"],
    };
    expect(queryShapeOf(JSON.stringify(shape))).toEqual({
      status: "read",
      shape: {
        returnsStar: false,
        selectAliases: ["a"],
        arrayJoinAliases: [],
        columnAliasedTables: [{ schema: null, name: "t" }],
        quotedColumns: [],
        unquotedColumns: ["x"],
      },
    });
    for (const broken of [
      { ...shape, returns_star: "no" },
      { ...shape, select_aliases: [1] },
      { ...shape, column_aliased_tables: [["t"]] },
    ]) {
      expect(queryShapeOf(JSON.stringify(broken))).toEqual(unexpected);
    }
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

/**
 * What `script` prints, run after importing `withSqlParser` and
 * `sqlParserStarted` in a fresh process, where the parser has not loaded.
 */
function inFreshProcess(script: string): string {
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `import { sqlParserStarted, withSqlParser } from "./src/sql-parser.ts";
       ${script}`,
    ],
    cwd: resolve(import.meta.dirname, ".."),
  });
  expect(run.stderr.toString()).toBe("");
  return run.stdout.toString().trim();
}

describe("withSqlParser", () => {
  it("answers without loading the parser when use never calls it", () => {
    expect(
      inFreshProcess(
        "console.log(await withSqlParser(() => 1), sqlParserStarted());",
      ),
    ).toBe("1 false");
  });

  it("rejects with the error use throws, other than the stand-in's", () => {
    expect(
      inFreshProcess(`
        const answer = await withSqlParser(() => {
          throw new Error("use failed");
        }).catch((e) => e.message);
        console.log(answer, sqlParserStarted());`),
    ).toBe("use failed false");
  });

  it("loads the parser and runs use again when use calls it", () => {
    expect(
      inFreshProcess(`
        const answer = await withSqlParser((parser) =>
          parser.referencedTables("SELECT * FROM t", null),
        );
        console.log(JSON.stringify(answer), sqlParserStarted());`),
    ).toBe('{"status":"read","tables":[{"schema":null,"name":"t"}]} true');
  }, 60_000);

  it("refuses, by its type, a use that answers a promise", () => {
    // Never called: the type check is the test.
    const use = async (parser: SqlParser) =>
      parser.referencedTables("SELECT 1", null);
    // @ts-expect-error A promise's work runs after the stand-in parser's throw is caught.
    const asyncUse = () => withSqlParser(use);
    expect(typeof asyncUse).toBe("function");
  });

  it("refuses, by its type, a use that may answer a promise", () => {
    // Never called: the type check is the test.
    const maybe = (parser: SqlParser) =>
      Math.random() < 0.5 ? 1 : Promise.resolve(parser);
    const unknownUse = (parser: SqlParser): unknown => parser;
    const anyUse = (parser: SqlParser): any => parser;
    const uses = [
      // @ts-expect-error A union with a promise may answer a promise.
      () => withSqlParser(maybe),
      // @ts-expect-error `unknown` may be a promise.
      () => withSqlParser(unknownUse),
      // @ts-expect-error `any` may be a promise.
      () => withSqlParser(anyUse),
      () =>
        withSqlParser((parser) => parser.referencedTables("SELECT 1", null)),
    ];
    expect(uses.length).toBe(4);
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

  it("orders the tables by catalog, then schema, then name, before it drops the catalog", () => {
    expect(
      parser.referencedTables("SELECT * FROM b.a.x JOIN a.z.y ON 1=1", "trino"),
    ).toEqual({
      status: "read",
      tables: [
        { schema: "z", name: "y" },
        { schema: "a", name: "x" },
      ],
    });
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

  it("gives the used fields and the missing table aliases in a fixed order, though Python holds them in sets", () => {
    const names = ["h", "c", "f", "a", "g", "b", "e", "d"];
    const result = parser.fieldReferences(
      `SELECT ${names.map((n) => `t.${n}, q${n}.x`).join(", ")} FROM t`,
      "postgres",
    );
    if (result.status !== "read") {
      throw new Error(result.reason);
    }
    const { usedFields, missingTableAliases } = result.references;
    const keys = usedFields.map((f) => JSON.stringify(f));
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBe(names.length);
    expect(missingTableAliases).toEqual(names.map((n) => `q${n}`).sort());
  });

  it("reads SQL field_references cannot parse, or a union's columns, as SQLGlot leaves them", () => {
    expect(parser.fieldReferences("SELECT * FROM", "postgres")).toEqual({
      status: "unread",
      reason:
        "field_references reads only a single SELECT or UNION, and could not read it",
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
      "INSERT INTO t SELECT a FROM u",
      "UPDATE t SET a = 1",
      "SELECT a FROM t; SELECT b FROM u",
    ]) {
      expect(parser.fieldReferences(sql, "postgres")).toEqual({
        status: "unread",
        reason:
          "field_references reads only a single SELECT or UNION, and could not read it",
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

  it("gives the first line of SQLGlot's error, not the SQL it quotes with terminal escapes, and the line of SQL a ParseError names", () => {
    expect(
      parser.referencedTables("SELECT *\n  FROM a b c\nLIMIT 1", "postgres"),
    ).toEqual({
      status: "unread",
      reason:
        "ParseError: Invalid expression / Unexpected token. Line 2, Col: 12. Line 2: FROM a b c",
    });
  });
});
