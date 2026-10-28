import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { MissingDefaultSchemasError } from "./default-schemas.js";
import type { LintFinding } from "./findings.js";
import { LINT_RULE_SEVERITY, LINT_RULES } from "./index.js";
import { lint, transformReads } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./lint-mutations.js";
import * as schemas from "./schemas.js";
import { CONFIG_FILE, LintSetupError } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";
import { isRecord } from "./values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

function rules(findings: LintFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

// Loads the SQL parser under a hook's timeout, so that no test's own timeout
// bears the load.
beforeAll(async () => {
  await loadSqlParser();
}, 60_000);

describe("lint", () => {
  it("finds nothing in the bundled examples", async () => {
    expect((await lint({ folder: EXAMPLES })).findings).toEqual([]);
  });

  // In a fresh process each: this test process loaded the parser long ago.
  it("loads the SQL parser only for a folder that holds SQL", async () => {
    const parserStarted = (folder: string) => {
      const run = Bun.spawnSync({
        cmd: [
          "bun",
          "-e",
          `import { lint } from "./src/lint.ts";
           import { sqlParserStarted } from "./src/sql-parser.ts";
           await lint({ folder: process.env.LINT_FOLDER });
           console.log(sqlParserStarted());`,
        ],
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, LINT_FOLDER: folder },
      });
      expect(run.stderr.toString()).toBe("");
      return run.stdout.toString().trim();
    };
    const mbqlOnly = mkdtempSync(join(tmpdir(), "representations-lint-mbql-"));
    const mongoOnly = mkdtempSync(
      join(tmpdir(), "representations-lint-mongo-"),
    );
    try {
      const file = "collections/transforms/mbql_transform.yaml";
      mkdirSync(join(mbqlOnly, "collections/transforms"), { recursive: true });
      cpSync(join(EXAMPLES, file), join(mbqlOnly, file));
      cpSync(join(EXAMPLES, CONFIG_FILE), join(mbqlOnly, CONFIG_FILE));
      expect(parserStarted(mbqlOnly)).toBe("false");

      // A native transform and its test, both with SQL, on a MongoDB database.
      for (const native of [
        "collections/transforms/native_transform.yaml",
        "collections/transforms/native_transform/product_revenue_report__category_totals.yaml",
      ]) {
        mkdirSync(join(mongoOnly, native, ".."), { recursive: true });
        writeFileSync(
          join(mongoOnly, native),
          readFileSync(join(EXAMPLES, native), "utf8").replaceAll(
            "Sample Database",
            "Docs",
          ),
        );
      }
      writeFileSync(
        join(mongoOnly, CONFIG_FILE),
        JSON.stringify({ engines: { Docs: "mongo" } }),
      );
      expect(parserStarted(mongoOnly)).toBe("false");

      expect(parserStarted(EXAMPLES)).toBe("true");
    } finally {
      rmSync(mbqlOnly, { recursive: true, force: true });
      rmSync(mongoOnly, { recursive: true, force: true });
    }
  }, 60_000);

  it("has a mutation that reports each error rule", async () => {
    const mutated = new Set(MUTATIONS.flatMap((m) => m.rules));
    expect(
      LINT_RULES.filter(
        (rule) => LINT_RULE_SEVERITY[rule] === "error" && !mutated.has(rule),
      ),
    ).toEqual([]);
  });

  it("loads the JSON schemas once per run", async () => {
    const load = spyOn(schemas, "loadSchemas");
    try {
      await lint({ folder: EXAMPLES });
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  describe("with a mutated copy of the examples", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const findings = async (folder: string): Promise<LintFinding[]> =>
      (await lint({ folder })).findings;

    it.each(MUTATIONS.map((m) => [m.name, m.rules]))(
      "reports %s as %p, each at the severity LINT_RULE_SEVERITY gives it",
      async (name, expected) => {
        mutateExamples(name, workdir);
        const found = await findings(workdir);
        expect(rules(found)).toEqual([...expected].sort());
        expect(
          found
            .filter((f) => f.severity !== LINT_RULE_SEVERITY[f.rule])
            .map((f) => `${f.rule} as ${f.severity}`),
        ).toEqual([]);
      },
    );

    it("names the test and the missing transform for a dangling transform_id", async () => {
      mutateExamples("dangling-transform-id", workdir);
      expect(await findings(workdir)).toEqual([
        {
          rule: "dangling-transform-id",
          severity: "error",
          file: "collections/transforms/native_transform/product_revenue_report__category_totals.yaml",
          entity: {
            model: "TransformTest",
            entity_id: "aRvM7DLesF1fOV4kRHidq",
            name: "Product Revenue Report: category totals",
          },
          message: "transform_id MissingTransform00000 matches no entity",
          related: [],
        },
      ]);
    });

    it("lists every transform in a cycle", async () => {
      mutateExamples("transform-cycle", workdir);
      const [cycle] = await findings(workdir);
      expect([cycle.file, ...cycle.related].sort()).toEqual([
        "collections/transforms/native_transform.yaml",
        "collections/transforms/top_categories.yaml",
      ]);
    });

    it("names the table an implicit join reads", async () => {
      mutateExamples("implicit-join", workdir);
      expect((await findings(workdir)).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Monthly Order Summary reads",
      ]);
    });

    it("reports a table read both directly and through a segment once", async () => {
      mutateExamples("implicit-join", workdir);
      MUTATIONS.find((m) => m.name === "segment-filter")?.apply(workdir);
      expect((await findings(workdir)).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Monthly Order Summary reads",
      ]);
    });

    it("matches a qualified input to an unqualified read in the default schema", async () => {
      mutateExamples("qualified-input", workdir);
      expect(
        (
          await lint({
            folder: workdir,
            defaultSchemas: { "Sample Database": "OTHER" },
          })
        ).findings,
      ).toEqual([]);
    });

    it("reads a Python transform's source tables in both forms", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = join(
        workdir,
        "collections/transforms/python_hello_world.yaml",
      );
      const doc: unknown = yaml.load(readFileSync(file, "utf8"));
      if (!isRecord(doc)) {
        throw new Error(`${file} is not a YAML map`);
      }
      writeFileSync(
        file,
        yaml.dump({
          ...doc,
          source: {
            type: "python",
            body: "def transform(): pass",
            "source-tables": [
              {
                alias: "people",
                database_id: "Sample Database",
                table_id: ["Sample Database", "PUBLIC", "PEOPLE"],
              },
              {
                alias: "orders",
                database_id: "Sample Database",
                table: "ORDERS",
              },
            ],
          },
        }),
      );
      const python = (await transformReads({ folder: workdir })).find(
        (t) => t.name === "Python Hello World",
      );
      expect(python?.tables).toEqual([
        { schema: "PUBLIC", name: "PEOPLE" },
        { schema: null, name: "ORDERS" },
      ]);
    });

    it("reports an unqualified and a qualified input as duplicates only in the default schema", async () => {
      mutateExamples("qualified-input", workdir);
      const file = join(
        workdir,
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml",
      );
      const doc: unknown = yaml.load(readFileSync(file, "utf8"));
      if (!isRecord(doc) || !Array.isArray(doc.inputs)) {
        throw new Error(`${file} has no inputs`);
      }
      doc.inputs.push({
        table: { name: "orders" },
        format: "sql",
        sql: "SELECT 1 AS ID",
      });
      writeFileSync(file, yaml.dump(doc));
      const inputFindings = async (schema?: string) =>
        (
          await lint({
            folder: workdir,
            defaultSchemas:
              schema === undefined ? {} : { "Sample Database": schema },
          })
        ).findings
          .filter((f) => f.message.startsWith("inputs"))
          .map((f) => `${f.rule}: ${f.message}`);
      expect(await inputFindings("OTHER")).toEqual([
        "duplicate-input: inputs stand in for the same table: OTHER.ORDERS, orders",
      ]);
      expect(await inputFindings("PUBLIC")).toEqual([]);
    });

    it("reports a file that is not a YAML map as a schema error", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const broken = "collections/transforms/broken.yaml";
      const list = "collections/transforms/list.yaml";
      writeFileSync(join(workdir, broken), "name: [unclosed\n");
      writeFileSync(join(workdir, list), "- a\n- b\n");
      expect(
        (await findings(workdir)).map(({ rule, severity, file, entity }) => ({
          rule,
          severity,
          file,
          entity,
        })),
      ).toEqual(
        [broken, list].map((file) => ({
          rule: "schema",
          severity: "error",
          file,
          entity: { model: null, entity_id: null, name: null },
        })),
      );
    });

    it("reports a Database file that fails its schema", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "databases/sample_database/sample_database.yaml";
      writeFileSync(
        join(workdir, file),
        yaml.dump({
          name: "Sample Database",
          engine: 5,
          "serdes/meta": [{ model: "Database" }],
        }),
      );
      expect(
        (await findings(workdir)).map(
          (f) => `${f.rule}: ${f.file}: ${f.message}`,
        ),
      ).toEqual([`schema: ${file}: Database does not match its schema`]);
    });

    it("reports a duplicate key as a file that does not parse", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/duplicate_key.yaml";
      writeFileSync(join(workdir, file), "name: a\nname: b\n");
      expect(
        (await findings(workdir)).map(({ rule, file, message }) => ({
          rule,
          file,
          message,
        })),
      ).toEqual([
        {
          rule: "schema",
          file,
          message: "the file does not parse as YAML: duplicated mapping key",
        },
      ]);
    });

    it.each([
      ["1: x", "1"],
      ["yes: x", "yes"],
      ["'1': x\n    1: y", "1"],
    ])(
      "refuses a row whose key %p Metabase reads as no string",
      async (key, written) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file =
          "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
        const path = join(workdir, file);
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "    TOTAL: 20.0\n",
            `    TOTAL: 20.0\n    ${key}\n`,
          ),
        );
        expect(
          (await findings(workdir)).map(
            (f) => `${f.file}: ${f.rule}: ${f.message}`,
          ),
        ).toEqual([
          `${file}: row-columns-mismatch: input ORDERS, row 3: every row must carry exactly the declared columns; ${key.startsWith("'") ? 'not declared: "1"; ' : ""}keys that are not strings: ${written}`,
        ]);
      },
    );

    it("reads a plain value as Metabase does, by YAML 1.1", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/top_categories.yaml";
      const path = join(workdir, file);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(/^name: .*$/m, "name: NO"),
      );
      expect(
        (await findings(workdir)).map(({ rule, file, message }) => ({
          rule,
          file,
          message,
        })),
      ).toEqual([
        {
          rule: "schema",
          file,
          message: "Transform does not match its schema",
        },
      ]);
    });

    it("takes a duplicated entity_id to name the first file in path order, for every check", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const transforms = join(workdir, "collections/transforms");
      writeFileSync(
        join(transforms, "aaa_python_first.yaml"),
        readFileSync(join(transforms, "python_hello_world.yaml"), "utf8")
          .replace(/^entity_id: .*$/m, "entity_id: 7XqqzlsonSq4KFyOvtrAm")
          .replace(/^name: .*$/m, "name: Python First"),
      );
      const test =
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
      expect(
        (await findings(workdir))
          .filter((f) => f.file === test)
          .map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "untestable-transform: transform Python First is not a query transform; Metabase tests only query transforms",
      ]);
    });

    it("takes a transform_id whose first holder is a Card to name the Card", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const card = join(workdir, "collections/main/queries/nested_query.yaml");
      writeFileSync(
        card,
        readFileSync(card, "utf8").replace(
          /^entity_id: .*$/m,
          "entity_id: 7XqqzlsonSq4KFyOvtrAm",
        ),
      );
      const test =
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
      expect(
        (await findings(workdir))
          .filter((f) => f.file === test)
          .map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "wrong-type-transform-id: transform_id 7XqqzlsonSq4KFyOvtrAm names a Card, not a Transform",
      ]);
    });

    it("cannot read a Python source table with no name", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = join(
        workdir,
        "collections/transforms/python_hello_world.yaml",
      );
      const doc: unknown = yaml.load(readFileSync(file, "utf8"));
      if (!isRecord(doc)) {
        throw new Error(`${file} is not a YAML map`);
      }
      writeFileSync(
        file,
        yaml.dump({
          ...doc,
          source: {
            type: "python",
            body: "def transform(): pass",
            "source-tables": [
              { alias: "orders", database_id: "Sample Database" },
            ],
          },
        }),
      );
      const python = (await transformReads({ folder: workdir })).find(
        (t) => t.name === "Python Hello World",
      );
      expect(python?.tables).toBeNull();
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        "reads-not-checked: could not find the tables this transform reads: source table orders names no table",
      ]);
    });

    it("pastes a snippet by its template tag's snippet-id, not by its name", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const snippet = (
        file: string,
        entityId: string,
        name: string,
        content: string,
      ) =>
        writeFileSync(
          join(workdir, "collections/snippets", file),
          yaml.dump({
            name,
            entity_id: entityId,
            creator_id: "admin@example.com",
            content,
            "serdes/meta": [{ model: "NativeQuerySnippet" }],
          }),
        );
      // The tag points at the renamed snippet; another snippet now holds the old name.
      snippet(
        "people_join.yaml",
        "PeopleJoinSnippet0001",
        "People Join",
        "JOIN PEOPLE u ON u.ID = o.USER_ID",
      );
      snippet(
        "old_name.yaml",
        "OldNameSnippet0000001",
        "Old Name",
        "JOIN REVIEWS r ON r.PRODUCT_ID = p.ID",
      );
      const file = join(
        workdir,
        "collections/transforms/native_transform.yaml",
      );
      const doc: unknown = yaml.load(readFileSync(file, "utf8"));
      if (
        !isRecord(doc) ||
        !isRecord(doc.source) ||
        !isRecord(doc.source.query)
      ) {
        throw new Error(`${file} has no query`);
      }
      const [stage] = Array.isArray(doc.source.query.stages)
        ? doc.source.query.stages
        : [];
      if (!isRecord(stage) || typeof stage.native !== "string") {
        throw new Error(`${file} has no native stage`);
      }
      stage.native = stage.native.replace(
        "GROUP BY",
        "{{snippet: Old Name}}\nGROUP BY",
      );
      stage["template-tags"] = [
        {
          type: "snippet",
          name: "snippet: Old Name",
          id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
          "snippet-name": "Old Name",
          "snippet-id": "PeopleJoinSnippet0001",
        },
      ];
      writeFileSync(file, yaml.dump(doc));
      const report = (await transformReads({ folder: workdir })).find(
        (t) => t.name === "Product Revenue Report",
      );
      // Sorted, as Metabase's referenced_tables returns them.
      expect(report?.tables?.map((t) => t.name)).toEqual([
        "ORDERS",
        "PEOPLE",
        "PRODUCTS",
      ]);
    });

    it.each([
      [
        "no name",
        { content: "WHERE 1 = 1" },
        "undefined",
        "snippet undefined is not in the folder",
      ],
      [
        "no content",
        { name: "Broken" },
        "Broken",
        "snippet Broken is in collections/snippets/broken.yaml, which fails its schema",
      ],
    ])(
      "reports a snippet file with %s, and does not use it",
      async (_, fields, usedName, reason) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const snippetFile = "collections/snippets/broken.yaml";
        writeFileSync(
          join(workdir, snippetFile),
          yaml.dump({
            ...fields,
            entity_id: "BrokenSnippet00000001",
            creator_id: "admin@example.com",
            "serdes/meta": [{ model: "NativeQuerySnippet" }],
          }),
        );
        const transformFile = "collections/transforms/native_transform.yaml";
        const path = join(workdir, transformFile);
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "GROUP BY",
            `{{snippet: ${usedName}}} GROUP BY`,
          ),
        );
        expect(
          (await findings(workdir)).map(
            (f) => `${f.file}: ${f.rule}: ${f.message}`,
          ),
        ).toEqual([
          `${snippetFile}: schema: NativeQuerySnippet does not match its schema`,
          `${transformFile}: reads-not-checked: could not find the tables this transform reads: ${reason}`,
        ]);
      },
    );

    it("says why a snippet named by its entity id cannot be pasted", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = join(
        workdir,
        "collections/transforms/native_transform.yaml",
      );
      const unread = async (snippetId: string) => {
        const doc: unknown = yaml.load(readFileSync(file, "utf8"));
        if (
          !isRecord(doc) ||
          !isRecord(doc.source) ||
          !isRecord(doc.source.query) ||
          !Array.isArray(doc.source.query.stages) ||
          !isRecord(doc.source.query.stages[0])
        ) {
          throw new Error(`${file} has no native stage`);
        }
        const stage = doc.source.query.stages[0];
        stage.native = "SELECT * FROM ORDERS {{snippet: Filter}}";
        stage["template-tags"] = [
          {
            type: "snippet",
            name: "snippet: Filter",
            id: "1d4e9fdf-49ae-4fbe-ae27-05e7c6a5cfe8",
            "snippet-name": "Filter",
            "snippet-id": snippetId,
          },
        ];
        writeFileSync(file, yaml.dump(doc));
        return (await findings(workdir))
          .filter((f) => f.rule === "reads-not-checked")
          .map((f) => f.message);
      };
      const prefix = "could not find the tables this transform reads: ";
      expect(await unread("NoSuchSnippet00000001")).toEqual([
        `${prefix}snippet Filter (NoSuchSnippet00000001) is not in the folder`,
      ]);
      // The entity id of a transform tag.
      expect(await unread("dUW7nvQHQBdA0Rx0gJckI")).toEqual([
        `${prefix}snippet Filter (dUW7nvQHQBdA0Rx0gJckI) names a TransformTag, not a snippet`,
      ]);
    });

    it("says when snippets still remain after pasting, as with a snippet that uses itself", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      writeFileSync(
        join(workdir, "collections/snippets/loop.yaml"),
        yaml.dump({
          name: "Loop",
          entity_id: "LoopSnippet0000000001",
          creator_id: "admin@example.com",
          content: "{{snippet: Loop}}",
          "serdes/meta": [{ model: "NativeQuerySnippet" }],
        }),
      );
      const path = join(
        workdir,
        "collections/transforms/native_transform.yaml",
      );
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          "GROUP BY",
          "{{snippet: Loop}} GROUP BY",
        ),
      );
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "reads-not-checked")
          .map((f) => f.message),
      ).toEqual([
        "could not find the tables this transform reads: snippets remain after 9 rounds of pasting, as when a snippet uses itself",
      ]);
    });

    it("reads a test's SQL input in a folder that holds no other SQL", async () => {
      const files = [
        CONFIG_FILE,
        "collections/transforms/mbql_transform.yaml",
        "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml",
      ];
      for (const file of files) {
        mkdirSync(join(workdir, file, ".."), { recursive: true });
        cpSync(join(EXAMPLES, file), join(workdir, file));
      }
      const testFile = join(workdir, files[2]);
      const test: unknown = yaml.load(readFileSync(testFile, "utf8"));
      if (!isRecord(test)) {
        throw new Error("The example test is not a map");
      }
      test.inputs = [
        {
          table: { name: "ORDERS" },
          format: "sql",
          sql: "SELECT * FROM ORDERS",
        },
      ];
      test.expectations = [
        {
          type: "equals",
          name: "no months",
          format: "rows",
          columns: [{ name: "count", cast_type: "INTEGER" }],
          rows: [],
        },
      ];
      writeFileSync(testFile, yaml.dump(test));
      expect(
        (await findings(workdir)).map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "live-sql-input: input ORDERS reads ORDERS; Metabase runs an input's SQL on the database as written, so the test depends on live data",
      ]);
    });

    it("names the missing table", async () => {
      mutateExamples("missing-input", workdir);
      expect((await findings(workdir)).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Product Revenue Report reads",
      ]);
    });

    // The test of this transform has inputs; were the reads taken as empty,
    // each input would be reported unused.
    it.each([
      ["SQL SQLGlot cannot parse", "SELECT * FROM a b c", "ParseError"],
      [
        "SQL nested deeper than Python's recursion limit",
        `SELECT ${"(".repeat(60)}1${")".repeat(60)} FROM ORDERS`,
        "RecursionError",
      ],
    ])(
      "reports %s as unread, and no input as missing or unused",
      async (_, sql, error) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file = join(
          workdir,
          "collections/transforms/native_transform.yaml",
        );
        const text = readFileSync(file, "utf8");
        const native = /native: \|-\n(?: {10}.*\n)+/;
        expect(text).toMatch(native);
        writeFileSync(
          file,
          text.replace(native, `native: ${JSON.stringify(sql)}\n`),
        );
        expect(
          (await findings(workdir)).map((f) => `${f.rule}: ${f.message}`),
        ).toEqual([
          expect.stringMatching(
            new RegExp(
              `^reads-not-checked: could not find the tables this transform reads: SQLGlot could not parse it: ${error}: `,
            ),
          ),
        ]);
      },
    );
  });

  describe("default schemas", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-defaults-"));
      mutateExamples("qualified-input", workdir);
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const writeConfig = (text: string) =>
      writeFileSync(join(workdir, CONFIG_FILE), text);

    const writeDatabase = (
      engine: string,
      fields: Record<string, unknown> = {},
    ) => {
      const dir = join(workdir, "databases/sample_database");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "sample_database.yaml"),
        yaml.dump({
          name: "Sample Database",
          engine,
          ...fields,
          "serdes/meta": [{ model: "Database" }],
        }),
      );
    };

    const lintRules = async (defaultSchemas?: Record<string, string | null>) =>
      rules((await lint({ folder: workdir, defaultSchemas })).findings);

    // The rules that depend on the default schema, without the engine rules
    // a Database file's engine adds.
    const inputRules = async () =>
      (await lintRules()).filter(
        (rule) => rule === "missing-input" || rule === "unused-input",
      );

    it("refuses to lint, before any check, when a database needs a default schema nobody gives", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      // A finding the checks would report, were they run.
      MUTATIONS.find((m) => m.name === "missing-input")?.apply(workdir);
      let error: unknown;
      try {
        await lint({ folder: workdir });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MissingDefaultSchemasError);
      expect(
        error instanceof MissingDefaultSchemasError &&
          error.databases.map((d) => d.database),
      ).toEqual(["Sample Database"]);
      expect(String(error)).toContain(CONFIG_FILE);
      expect(String(error)).toContain("--default-schema");
    });

    it("reads the default schemas in the folder's settings file", async () => {
      writeConfig('{"defaultSchemas": {"Sample Database": "OTHER"}}');
      expect(await lintRules()).toEqual([]);
      writeConfig('{"defaultSchemas": {"Sample Database": "PUBLIC"}}');
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes a default schema passed to lint over the settings file's", async () => {
      writeConfig('{"defaultSchemas": {"Sample Database": "PUBLIC"}}');
      expect(await lintRules({ "Sample Database": "OTHER" })).toEqual([]);
    });

    it("reads null in the settings file as a database with no schemas", async () => {
      writeConfig('{"defaultSchemas": {"Sample Database": null}}');
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes the default schema of a SQLite or MongoDB database as null, as Metabase hard-codes it", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("sqlite");
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
      // SQLGlot has no MongoDB dialect, so the native transforms are unread:
      // only the MBQL transforms' unqualified names need the default schema.
      writeDatabase("mongo");
      expect(await inputRules()).toEqual([]);
    });

    it("takes a MySQL database to have no schemas, and asks for a Postgres database's default", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("mysql");
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
      writeDatabase("postgres");
      await expect(lint({ folder: workdir })).rejects.toThrow(
        MissingDefaultSchemasError,
      );
    });

    it("takes an engine from the settings file, unless a Database file names one", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeConfig('{"engines": {"Sample Database": "mysql"}}');
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
      writeDatabase("postgres");
      await expect(lint({ folder: workdir })).rejects.toThrow(
        MissingDefaultSchemasError,
      );
    });

    it("reads a Database file's default_schema, over the engine's", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("postgres", { default_schema: "OTHER" });
      expect(await lintRules()).toEqual([]);
      writeDatabase("mysql", { default_schema: "OTHER" });
      expect(await lintRules()).toEqual([]);
    });

    it("reads a Database file's null default_schema as no schemas on an engine without schemas, or an unknown one", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      for (const engine of ["sqlite", "duckdb"]) {
        writeDatabase(engine, { default_schema: null });
        expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
      }
    });

    it("asks for the default schema when a Database file gives null on an engine with schemas", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("postgres", { default_schema: null });
      await expect(lint({ folder: workdir })).rejects.toThrow(
        MissingDefaultSchemasError,
      );
    });

    it("falls through to the engine when a Database file's null default_schema is not taken", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("bigquery-cloud-sdk", { default_schema: null });
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes the settings file's default schema over a Database file's", async () => {
      writeConfig('{"defaultSchemas": {"Sample Database": "PUBLIC"}}');
      writeDatabase("postgres", { default_schema: "OTHER" });
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("refuses a settings file it cannot read", async () => {
      for (const text of [
        "{not json",
        "[]",
        '{"defaultSchema": {}}',
        '{"defaultSchemas": {"Sample Database": 5}}',
        '{"engines": {"Sample Database": null}}',
      ]) {
        writeConfig(text);
        await expect(lint({ folder: workdir })).rejects.toThrow(LintSetupError);
      }
    });
  });

  describe("with table files", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-tables-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const writeOrdersTable = (folder: string) => {
      const dir = join(folder, "databases/sample_database/tables/orders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "orders.yaml"),
        yaml.dump({
          name: "ORDERS",
          db_id: "Sample Database",
          schema: null,
          "serdes/meta": [{ model: "Table" }],
        }),
      );
    };

    it("warns about a table that no table file or target defines, once on each file naming it", async () => {
      mutateExamples("unused-input", workdir);
      writeOrdersTable(workdir);
      const unknown = (await lint({ folder: workdir })).findings
        .filter((f) => f.rule === "unknown-table")
        .map((f) => `${f.file}: ${f.message}`);
      const products =
        "table PRODUCTS is defined by no table file or transform target";
      const test =
        "collections/transforms/native_transform/product_revenue_report__category_totals.yaml";
      expect(unknown).toEqual([
        `collections/transforms/hourly_product_stats.yaml: ${products}`,
        `collections/transforms/monthly_sales_summary.yaml: ${products}`,
        `collections/transforms/native_transform.yaml: ${products}`,
        `${test}: ${products}`,
        `${test}: table PEOPLE is defined by no table file or transform target`,
        `collections/transforms/product_summary.yaml: ${products}`,
      ]);
    });
  });

  // Metabase rewrites an expectation's tables by name: a qualified name by the
  // key with its schema, or else by an unqualified key, which a table has when
  // it is unqualified or in the default schema.
  describe("with an expectation that names its table another way", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-expect-"));
      cpSync(EXAMPLES, workdir, { recursive: true });
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const TEST =
      "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";

    const editTest = (change: (doc: Record<string, unknown>) => void) => {
      const path = join(workdir, TEST);
      const doc: unknown = yaml.load(readFileSync(path, "utf8"));
      if (!isRecord(doc)) {
        throw new Error(`${TEST} is not a YAML map`);
      }
      change(doc);
      writeFileSync(path, yaml.dump(doc));
    };

    const readOrders = (table: string, inputSchema?: string) =>
      editTest((doc) => {
        const [input] = Array.isArray(doc.inputs) ? doc.inputs : [];
        if (inputSchema !== undefined && isRecord(input?.table)) {
          input.table.schema = inputSchema;
        }
        doc.expectations = [
          {
            type: "empty",
            name: "orders read",
            sql: `SELECT * FROM ${table} WHERE TOTAL < 0`,
          },
        ];
      });

    const expectationRules = async (schema?: string): Promise<string[]> =>
      (
        await lint({
          folder: workdir,
          defaultSchemas:
            schema === undefined ? {} : { "Sample Database": schema },
        })
      ).findings
        .filter((f) => f.message.startsWith("expectation"))
        .map((f) => f.rule);

    it("accepts a qualified read of an unqualified input, whatever the default schema", async () => {
      readOrders("PUBLIC.orders");
      expect(await expectationRules()).toEqual([]);
      expect(await expectationRules("PUBLIC")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([]);
    });

    it("accepts a read in another schema of an input in the default schema only", async () => {
      readOrders("OTHER.orders", "PUBLIC");
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER2")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("refuses an unqualified read of an input outside the default schema", async () => {
      readOrders("orders", "PUBLIC");
      expect(await expectationRules("PUBLIC")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("refuses a read of a table that is neither input nor target", async () => {
      readOrders("PEOPLE");
      expect(await expectationRules()).toEqual([
        "expectation-reads-other-table",
      ]);
    });
  });

  // Two names for a table, one unqualified: the lint takes them as one table
  // only when the qualified name is in the default schema.
  describe("with a table named once unqualified and once qualified", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-schemas-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const replaceIn = (file: string, from: string, to: string) => {
      const path = join(workdir, file);
      const text = readFileSync(path, "utf8");
      expect(text).toContain(from);
      writeFileSync(path, text.replace(from, to));
    };

    const rulesWithDefault = async (schema?: string): Promise<string[]> =>
      rules(
        (
          await lint({
            folder: workdir,
            defaultSchemas:
              schema === undefined ? {} : { "Sample Database": schema },
          })
        ).findings,
      );

    it("finds a cycle through an unqualified read only in the default schema", async () => {
      mutateExamples("transform-cycle", workdir);
      replaceIn(
        "collections/transforms/native_transform.yaml",
        "JOIN TRANSFORMS.top_categories",
        "JOIN top_categories",
      );
      expect(await rulesWithDefault("transforms")).toContain("transform-cycle");
      expect(await rulesWithDefault("PUBLIC")).not.toContain("transform-cycle");
    });

    it("finds a duplicate target written unqualified only in the default schema", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const copy = "collections/transforms/top_categories_copy.yaml";
      cpSync(
        join(workdir, "collections/transforms/top_categories.yaml"),
        join(workdir, copy),
      );
      replaceIn(
        copy,
        "entity_id: jf55MTi7z8cWQjPG2PEgz",
        "entity_id: TopCategoriesCopy000a",
      );
      replaceIn(copy, "  schema: TRANSFORMS\n", "");
      expect(await rulesWithDefault("TRANSFORMS")).toEqual([
        "duplicate-target",
      ]);
      expect(await rulesWithDefault("PUBLIC")).toEqual([]);
    });

    it("counts a table file as the table read unqualified only in the default schema", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const dir = join(workdir, "databases/sample_database/tables/orders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "orders.yaml"),
        yaml.dump({
          name: "ORDERS",
          db_id: "Sample Database",
          schema: "PUBLIC",
          "serdes/meta": [{ model: "Table" }],
        }),
      );
      const unknownTables = async (schema?: string) =>
        (
          await lint({
            folder: workdir,
            defaultSchemas:
              schema === undefined ? {} : { "Sample Database": schema },
          })
        ).findings
          .filter((f) => f.rule === "unknown-table")
          .map((f) => f.message);
      const ordersUnknown =
        "table ORDERS is defined by no table file or transform target";
      expect(await unknownTables()).not.toContain(ordersUnknown);
      expect(await unknownTables("public")).not.toContain(ordersUnknown);
      expect(await unknownTables("OTHER")).toContain(ordersUnknown);
    });
  });
});
