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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as fs from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { LINT_RULE_SEVERITY, LINT_RULES } from "./experimental.js";
import type { LintFinding } from "./findings.js";
import { lint, transformReads } from "./lint.js";
import {
  edit,
  type ExpectedFinding,
  listAt,
  mapAt,
  MUTATIONS,
  mutateExamples,
  snippetTag,
  textAt,
  write,
  writeSettings,
} from "./test-support/lint-mutations.js";
import * as schemas from "./schemas.js";
import { CONFIG_FILE, LintSetupError } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";
import { isRecord } from "./values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");
const POSTGRES_DB = "Sample Postgres";
const MBQL_TRANSFORM = "collections/transforms/mbql_transform.yaml";
const MONTHLY_ORDER_SUMMARY_TEST =
  "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml";
const ORDERS_MODEL = "collections/main/queries/orders_model.yaml";
const ORDERS_MODEL_ENTITY_ID = "4eroqa4ZYl4WkNjP8XTvu";
const NATIVE_TRANSFORM = "collections/transforms/native_transform.yaml";
const DAILY_ORDER_SUMMARY_TEST =
  "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";

/**
 * Rewrites the MBQL transform in `folder` so that each of its references names
 * its table with a null schema.
 */
function nullSchemaReferences(folder: string): void {
  const path = join(folder, MBQL_TRANSFORM);
  const text = readFileSync(path, "utf8");
  expect(text).toContain("- public\n");
  writeFileSync(path, text.replaceAll("- public\n", "- null\n"));
}

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

  it("names each database a file writes to or reads, and not one only a Database or Table file names", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "representations-lint-dbs-"));
    const write = (file: string, body: Record<string, unknown>) => {
      mkdirSync(join(workdir, file, ".."), { recursive: true });
      writeFileSync(join(workdir, file), yaml.dump(body));
    };
    try {
      write("databases/files/files.yaml", {
        name: "Database File",
        engine: "postgres",
        "serdes/meta": [{ model: "Database" }],
      });
      write("databases/tables/tables/t/t.yaml", {
        name: "t",
        db_id: "Table File",
        schema: "public",
        "serdes/meta": [{ model: "Table" }],
      });
      write("collections/main/card.yaml", {
        name: "Card",
        entity_id: "DatabasesCard00000001",
        type: "question",
        display: "table",
        dataset_query: {
          "lib/type": "mbql/query",
          database: "Card Query",
          stages: [
            {
              "lib/type": "mbql.stage/mbql",
              "source-table": ["Card Table", "public", "orders"],
            },
          ],
        },
        "serdes/meta": [{ model: "Card" }],
      });
      write("collections/transforms/python.yaml", {
        name: "Python",
        entity_id: "DatabasesPython000001",
        creator_id: "admin@example.com",
        source_database_id: "Python Source",
        source: {
          type: "python",
          body: "def transform(src):\n    return src",
          "source-tables": [
            {
              alias: "src",
              database_id: "Python Table",
              schema: "public",
              table: "src",
            },
          ],
        },
        target: {
          database: "Python Target",
          type: "table",
          schema: "public",
          name: "out",
        },
        "serdes/meta": [{ model: "Transform" }],
      });
      expect((await lint({ folder: workdir })).databases).toEqual([
        "Card Query",
        "Card Table",
        "Python Table",
        "Python Target",
      ]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
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
            POSTGRES_DB,
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

  // A join may carry keys its schema does not name, such as `database`.
  // Metabase runs every stage of a query on the query's database.
  it("reads a join's native stage on its query's database, not on a database the join names", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "representations-lint-join-"));
    try {
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      cpSync(join(EXAMPLES, MBQL_TRANSFORM), join(workdir, MBQL_TRANSFORM));
      const ordersField = (column: string) => [
        "field",
        {},
        [POSTGRES_DB, "public", "orders", column],
      ];
      edit(workdir, MBQL_TRANSFORM, (doc) => {
        mapAt(doc, "source", "query", "stages", 0).joins = [
          {
            alias: "Products",
            database: "Docs",
            stages: [
              {
                "lib/type": "mbql.stage/native",
                native: "SELECT * FROM products",
              },
            ],
            conditions: [
              ["=", {}, ordersField("product_id"), ordersField("id")],
            ],
          },
        ];
      });
      writeSettings(workdir, {
        engines: { [POSTGRES_DB]: "postgres", Docs: "mongo" },
      });
      expect((await lint({ folder: workdir })).findings).toEqual([]);
      expect(
        (await transformReads({ folder: workdir })).map((t) => t.tables),
      ).toEqual([
        [
          { schema: "public", name: "orders" },
          { schema: null, name: "products" },
        ],
      ]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("has a mutation that reports each error rule", async () => {
    const mutated = new Set(
      MUTATIONS.flatMap((m) => m.findings.map((f) => f.rule)),
    );
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

  it("reads each file of the folder once per run", async () => {
    const read = spyOn(fs, "readFileSync");
    try {
      await lint({ folder: EXAMPLES });
      const files = read.mock.calls.flatMap(([path]) =>
        typeof path === "string" && path.startsWith(EXAMPLES) ? [path] : [],
      );
      expect(files.length).toBeGreaterThan(0);
      expect(files.filter((f, i) => files.indexOf(f) !== i)).toEqual([]);
    } finally {
      read.mockRestore();
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

    /** `found` as rule, file and related files, in a fixed order. */
    const placed = (found: readonly ExpectedFinding[]) =>
      found
        .map(({ rule, file, related = [] }) => ({ rule, file, related }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    it.each(MUTATIONS.map((m) => [m.name]))(
      "reports %s on each finding's file, with its related files",
      async (name) => {
        const mutation = mutateExamples(name, workdir);
        expect(placed(await findings(workdir))).toEqual(
          placed(mutation.findings),
        );
      },
    );

    /** Writes a Database file for the examples' warehouse with `fields`. */
    const writeWarehouseFile = (fields: Record<string, unknown>) =>
      write(workdir, "databases/sample_postgres/sample_postgres.yaml", {
        name: POSTGRES_DB,
        ...fields,
        "serdes/meta": [{ model: "Database", id: POSTGRES_DB }],
      });

    it("takes no engine from a Database file", async () => {
      const mutation = mutateExamples("null-schema-reference", workdir);
      writeWarehouseFile({ engine: "mysql" });
      expect(
        placed(
          (await findings(workdir)).filter(
            (f) => f.rule === "null-schema-reference",
          ),
        ),
      ).toEqual(placed(mutation.findings));
    });

    it("takes no default schema from a Database file", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({ engines: { [POSTGRES_DB]: "postgres" } }),
      );
      writeWarehouseFile({ engine: "postgres", default_schema: "public" });
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "missing-default-schema")
          .map((f) => f.message.match(/database ("[^"]*")/)?.[1]),
      ).toEqual([JSON.stringify(POSTGRES_DB)]);
    });

    it("breaks a different test with each rule of refused-tests", async () => {
      const mutation = mutateExamples("refused-tests", workdir);
      const errors = (await findings(workdir)).filter(
        (f) => f.severity === "error",
      );
      expect(errors.map((f): string => f.rule).sort()).toEqual(
        mutation.findings.map((f): string => f.rule).sort(),
      );
      expect(new Set(errors.map((f) => f.entity.entity_id)).size).toBe(
        mutation.findings.length,
      );
    });

    it("suggests the transform a test with a dangling transform_id likely tests", async () => {
      mutateExamples("dangling-transform-id", workdir);
      const danglingMessages = async () =>
        (await findings(workdir))
          .filter((f) => f.rule === "dangling-transform-id")
          .map((f) => [f.message, f.related]);
      const suggestion = [
        [
          "transform_id MissingTransform00000 matches no entity; the test likely tests Product Revenue Report, whose entity_id is 7JwIkkAG-06-nsl4jzsaq",
          ["collections/transforms/native_transform.yaml"],
        ],
      ];
      expect(await danglingMessages()).toEqual(suggestion);
      // Outside the transform's folder, the test's name still says.
      fs.renameSync(
        join(workdir, "collections/transforms/native_transform"),
        join(workdir, "collections/transforms/elsewhere"),
      );
      expect(await danglingMessages()).toEqual(suggestion);
    });

    it("suggests no transform for a dangling transform_id when two transforms have the test's name", async () => {
      mutateExamples("dangling-transform-id", workdir);
      fs.renameSync(
        join(workdir, "collections/transforms/native_transform"),
        join(workdir, "collections/transforms/elsewhere"),
      );
      const copy = "collections/transforms/native_transform_copy.yaml";
      cpSync(join(workdir, NATIVE_TRANSFORM), join(workdir, copy));
      edit(workdir, copy, (doc) => {
        doc.entity_id = "ProductRevenueCopy001";
        mapAt(doc, "target").name = "product_revenue_copy";
      });
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "dangling-transform-id")
          .map((f) => [f.message, f.related]),
      ).toEqual([["transform_id MissingTransform00000 matches no entity", []]]);
    });

    it("names the table an implicit join reads", async () => {
      mutateExamples("implicit-join", workdir);
      expect((await findings(workdir)).map((f) => f.message)).toEqual([
        "no input for public.products, which transform Monthly Order Summary reads",
      ]);
    });

    it("reports a table read both directly and through a segment once", async () => {
      mutateExamples("implicit-join", workdir);
      MUTATIONS.find((m) => m.name === "segment-filter")?.apply(workdir);
      expect((await findings(workdir)).map((f) => f.message)).toEqual([
        "no input for public.products, which transform Monthly Order Summary reads",
      ]);
    });

    it("follows a card a query transform uses to the tables the card reads", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      // The Orders model card reads public.orders on the warehouse, whose
      // engine runs query transforms.
      edit(workdir, ORDERS_MODEL, (doc) => {
        mapAt(doc, "dataset_query").database = POSTGRES_DB;
        mapAt(doc, "dataset_query", "stages", 0)["source-table"] = [
          POSTGRES_DB,
          "public",
          "orders",
        ];
      });
      edit(workdir, MBQL_TRANSFORM, (doc) => {
        mapAt(doc, "source").query = {
          "lib/type": "mbql/query",
          database: POSTGRES_DB,
          stages: [
            {
              "lib/type": "mbql.stage/mbql",
              "source-card": ORDERS_MODEL_ENTITY_ID,
              aggregation: [["count", {}]],
            },
          ],
        };
      });
      const test = join(workdir, MONTHLY_ORDER_SUMMARY_TEST);
      const text = readFileSync(test, "utf8");
      const input = "    schema: public\n    name: orders\n";
      expect(text).toContain(input);
      expect(await findings(workdir)).toEqual([]);
      writeFileSync(
        test,
        text.replace(input, "    schema: public\n    name: products\n"),
      );
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "missing-input")
          .map((f) => f.message),
      ).toEqual([
        "no input for public.orders, which transform Monthly Order Summary reads",
      ]);
    });

    it("reports a table read by MBQL and by SQL once", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      edit(workdir, ORDERS_MODEL, (doc) => {
        doc.dataset_query = {
          "lib/type": "mbql/query",
          database: POSTGRES_DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: "SELECT * FROM public.orders",
            },
          ],
        };
      });
      edit(workdir, MBQL_TRANSFORM, (doc) => {
        mapAt(doc, "source").query = {
          "lib/type": "mbql/query",
          database: POSTGRES_DB,
          stages: [
            {
              "lib/type": "mbql.stage/mbql",
              "source-table": [POSTGRES_DB, "public", "orders"],
              aggregation: [
                [
                  "metric",
                  { "lib/uuid": "6f1c2a43-8f0e-4c4e-9b8a-0d5f1e2a3b4c" },
                  ORDERS_MODEL_ENTITY_ID,
                ],
              ],
            },
          ],
        };
      });
      edit(workdir, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "inputs", 0, "table").name = "products";
      });
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "missing-input")
          .map((f) => f.message),
      ).toEqual([
        "no input for public.orders, which transform Monthly Order Summary reads",
      ]);
    });

    it("matches a qualified input to an unqualified read in the default schema", async () => {
      mutateExamples("qualified-input", workdir);
      expect(
        rules(
          (
            await lint({
              folder: workdir,
              defaultSchemas: { [POSTGRES_DB]: "OTHER" },
            })
          ).findings,
        ),
      ).toEqual([]);
    });

    it("matches a test input in the default schema to an MBQL reference with no schema, as to an unqualified SQL name", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      nullSchemaReferences(workdir);
      // Both tests give the input public.orders.
      edit(workdir, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "inputs", 0, "table").schema = "public";
      });
      const messages = (
        await lint({
          folder: workdir,
          defaultSchemas: { [POSTGRES_DB]: "public" },
        })
      ).findings
        .filter((f) => f.rule === "missing-input" || f.rule === "unused-input")
        .map((f) => `${f.rule}: ${f.message}`);
      // Metabase compiles the reference to the unqualified name `orders`.
      expect(messages).toEqual([]);
    });

    it("reads a Python transform's source tables in both forms", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      edit(workdir, "collections/transforms/python_hello_world.yaml", (doc) => {
        doc.source = {
          type: "python",
          body: "def transform(): pass",
          "source-tables": [
            {
              alias: "people",
              database_id: POSTGRES_DB,
              table_id: [POSTGRES_DB, "public", "people"],
            },
            {
              alias: "orders",
              database_id: POSTGRES_DB,
              table: "orders",
            },
          ],
        };
      });
      const python = (await transformReads({ folder: workdir })).find(
        (t) => t.name === "Python Hello World",
      );
      expect(python?.tables).toEqual([
        { schema: "public", name: "people" },
        { schema: null, name: "orders" },
      ]);
    });

    it("gives a Python transform whose target names no database no target, not one in its source_database_id", async () => {
      mutateExamples("missing-target-database", workdir);
      const original = "collections/transforms/python_hello_world.yaml";
      const copy = "collections/transforms/python_hello_world_copy.yaml";
      cpSync(join(EXAMPLES, original), join(workdir, copy));
      edit(workdir, copy, (doc) => {
        doc.entity_id = "PythonHelloWorldCopy1";
      });
      expect(
        (await findings(workdir)).map((f) => `${f.rule} ${f.file}`),
      ).toEqual([`missing-target-database ${original}`]);
    });

    it("reports an unqualified and a qualified input as duplicates only in the default schema", async () => {
      mutateExamples("qualified-input", workdir);
      edit(workdir, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        listAt(doc, "inputs").push({
          table: { name: "orders" },
          format: "sql",
          sql: "SELECT 1 AS id",
        });
      });
      const inputFindings = async (schema?: string) =>
        (
          await lint({
            folder: workdir,
            defaultSchemas:
              schema === undefined ? {} : { [POSTGRES_DB]: schema },
          })
        ).findings
          .filter((f) => f.message.startsWith("inputs"))
          .map((f) => `${f.rule}: ${f.message}`);
      expect(await inputFindings("OTHER")).toEqual([
        "duplicate-input: inputs stand in for the same table: OTHER.orders, orders",
      ]);
      expect(await inputFindings("public")).toEqual([]);
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

    it("warns on each transform and card whose database has no engine", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          defaultSchemas: { [POSTGRES_DB]: "public" },
          engines: { "Sample Database": "sqlite" },
        }),
      );
      const files = (await findings(workdir))
        .filter((f) => f.rule === "unknown-engine")
        .map((f) => f.file);
      expect(files).toContain(MBQL_TRANSFORM);
      expect(files.every((f) => f.startsWith("collections/transforms/"))).toBe(
        true,
      );
      writeSettings(workdir, { engines: { [POSTGRES_DB]: "postgres" } });
      expect(await findings(workdir)).toEqual([]);
    });

    it("gives no finding for a table that no transform target defines, nor for a Table file, valid or not", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      // Remote sync writes no Table file, and a transform may read any table
      // of the warehouse.
      const dir = join(workdir, "databases/sample_postgres/tables/orders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "orders.yaml"),
        yaml.dump({
          name: "orders",
          db_id: POSTGRES_DB,
          schema: "public",
          "serdes/meta": [{ model: "Table" }],
        }),
      );
      writeFileSync(
        join(dir, "broken.yaml"),
        yaml.dump({ schema: 5, "serdes/meta": [{ model: "Table" }] }),
      );
      expect(await findings(workdir)).toEqual([]);
    });

    it("reports no schema mismatch on a Card, Dashboard, Document or Collection file", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const document = readdirSync(join(workdir, "collections/main/documents"))
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => `collections/main/documents/${f}`)[0];
      for (const file of [
        "collections/main/queries/basic_aggregations.yaml",
        "collections/main/dashboards/virtual_cards.yaml",
        "collections/main/queries.yaml",
        document,
      ]) {
        const path = join(workdir, file);
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(/^name: .*\n/m, ""),
        );
      }
      expect(await findings(workdir)).toEqual([]);
    });

    it("counts the files it read, and orders one rule's findings by file", async () => {
      mkdirSync(join(workdir, "collections"), { recursive: true });
      const collection = (file: string, id: string) =>
        writeFileSync(
          join(workdir, "collections", file),
          yaml.dump({
            name: file,
            entity_id: id,
            "serdes/meta": [{ model: "Collection" }],
          }),
        );
      // Reported id by id: a1 and a3, then a2 and a4.
      collection("a1.yaml", "DuplicatedId00000000X");
      collection("a2.yaml", "DuplicatedId00000000Y");
      collection("a3.yaml", "DuplicatedId00000000X");
      collection("a4.yaml", "DuplicatedId00000000Y");
      writeFileSync(join(workdir, "collections", "notes.yaml"), "name: n\n");
      const result = await lint({ folder: workdir });
      expect(result.files).toBe(5);
      expect(
        result.findings
          .filter((f) => f.rule === "duplicate-entity-id")
          .map((f) => f.file),
      ).toEqual(["a1", "a2", "a3", "a4"].map((n) => `collections/${n}.yaml`));
    });

    it("warns on a transform file with an invalid UTF-8 byte, which Metabase reads as U+FFFD, and lints its text", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const python = "collections/transforms/python_hello_world.yaml";
      const path = join(workdir, python);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("name: Python Hello World\n");
      const [before, after] = text.split("Python Hello World");
      writeFileSync(path, `${before}Python Café${after}`);
      expect(await findings(workdir)).toEqual([]);
      writeFileSync(
        path,
        Buffer.concat([
          Buffer.from(`${before}Python Caf`),
          Buffer.from([0xe9]),
          Buffer.from(after),
        ]),
      );
      expect(
        (await findings(workdir)).map(
          (f) => `${f.severity} ${f.rule} ${f.file}: ${f.message}`,
        ),
      ).toEqual([
        `warning invalid-utf8 ${python}: the file is not valid UTF-8, and Metabase reads each invalid byte sequence as U+FFFD; save the file as UTF-8`,
      ]);
      expect(
        (await transformReads({ folder: workdir })).find(
          (t) => t.file === python,
        )?.name,
      ).toBe("Python Caf\uFFFD");
    });

    it("warns on a file with no serdes/meta, which Metabase skips, and reads no entity from it", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const empty = "collections/transforms/empty.yaml";
      const notes = "collections/transforms/notes.yaml";
      writeFileSync(join(workdir, empty), "");
      // Product Revenue Report's entity_id, which a file Metabase skips does not hold.
      writeFileSync(
        join(workdir, notes),
        yaml.dump({ name: "Notes", entity_id: "7JwIkkAG-06-nsl4jzsaq" }),
      );
      expect(await findings(workdir)).toEqual(
        [empty, notes].map((file) => ({
          rule: "skipped-by-metabase",
          severity: "warning",
          file,
          entity: { model: null, entity_id: null, name: null },
          message: "Metabase skips this file because it has no serdes/meta",
          related: [],
        })),
      );
    });

    it("warns on a file whose YAML is an empty list or an empty string, which Metabase skips, and fails a non-empty list", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const emptyList = "collections/transforms/empty_list.yaml";
      const emptyString = "collections/transforms/empty_string.yaml";
      const list = "collections/transforms/list.yaml";
      writeFileSync(join(workdir, emptyList), "[]\n");
      writeFileSync(join(workdir, emptyString), "''\n");
      writeFileSync(join(workdir, list), "- a\n");
      expect(
        (await findings(workdir)).map(
          (f) => `${f.severity} ${f.rule} ${f.file}: ${f.message}`,
        ),
      ).toEqual([
        `error schema ${list}: the file is not a YAML map`,
        `warning skipped-by-metabase ${emptyList}: Metabase skips this file because it has no serdes/meta`,
        `warning skipped-by-metabase ${emptyString}: Metabase skips this file because it has no serdes/meta`,
      ]);
    });

    it("reports a file whose serdes/meta names no model as a schema error", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/listed.yaml";
      writeFileSync(
        join(workdir, file),
        "name: Listed\nserdes/meta:\n- model: [Transform]\n",
      );
      expect(
        (await findings(workdir)).map(
          (f) => `${f.rule} ${f.file}: ${f.message}`,
        ),
      ).toEqual([`schema ${file}: the file names no model in serdes/meta`]);
    });

    it("reads a file of a model Metabase imports and no schema describes, with no finding", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      mkdirSync(join(workdir, "custom_viz_plugins"));
      writeFileSync(
        join(workdir, "custom_viz_plugins", "plugin.yaml"),
        yaml.dump({ name: 5, "serdes/meta": [{ model: "CustomVizPlugin" }] }),
      );
      expect(await findings(workdir)).toEqual([]);
    });

    it("reports a file of a model outside the models Metabase imports as a schema error", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/widget.yaml";
      writeFileSync(
        join(workdir, file),
        yaml.dump({ name: "Widget", "serdes/meta": [{ model: "Widget" }] }),
      );
      expect(
        (await findings(workdir)).map(
          (f) => `${f.rule} ${f.file} ${f.entity.model}: ${f.message}`,
        ),
      ).toEqual([
        `schema ${file} null: the file names the model "Widget", which is not among the models Metabase imports from entity files`,
      ]);
    });

    it("warns on a Database file and does not check its schema", async () => {
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
      ).toEqual([
        `database-file: ${file}: a pull creates a database connection from this file, which remote sync never syncs or removes. Remove the file, and give the database's engine and default schema in .metabase-lint.json`,
      ]);
    });

    it("names the path and the reason of a schema mismatch, not the condition around it", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      edit(workdir, "collections/transforms/python_hello_world.yaml", (doc) => {
        delete mapAt(doc, "source").body;
      });
      expect(
        (await findings(workdir)).map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "schema: Transform does not match its schema: /source must have required property 'body'",
      ]);
    });

    it("warns on a key written twice in a merge source written in place, and reads the first value", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/top_categories.yaml";
      const path = join(workdir, file);
      // The second name, a number, fails a Transform's schema if it is read.
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          /^name: (.*)$/m,
          "<<: {name: $1, name: 5}",
        ),
      );
      const lines = readFileSync(path, "utf8").split("\n");
      const line = lines.findIndex((l) => l.startsWith("<<: ")) + 1;
      const column = lines[line - 1].indexOf("name: 5") + 1;
      expect(
        (await findings(workdir)).map(({ rule, severity, file, message }) => ({
          rule,
          severity,
          file,
          message,
        })),
      ).toEqual([
        {
          rule: "duplicate-yaml-key",
          severity: "warning",
          file,
          message: `the key name is written again at ${line}:${column} in a merge source written after <<:; Metabase keeps only the first value`,
        },
      ]);
    });

    it("warns on a key written twice in one map, and reads the last value", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/top_categories.yaml";
      const path = join(workdir, file);
      // A second name, which a Transform's schema refuses as a number, so
      // the first value is not the one read.
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(/^(name: .*)$/m, "name: 5\n$1"),
      );
      const line =
        readFileSync(path, "utf8")
          .split("\n")
          .findIndex((l) => l.startsWith("name: ") && l !== "name: 5") + 1;
      expect(
        (await findings(workdir)).map(({ rule, severity, file, message }) => ({
          rule,
          severity,
          file,
          message,
        })),
      ).toEqual([
        {
          rule: "duplicate-yaml-key",
          severity: "warning",
          file,
          message: `the key name is written again at ${line}:1 in the same map; Metabase keeps only the last value`,
        },
      ]);
    });

    it.each([
      ["1: x", `keys YAML reads as no string: "1"; quote them`],
      ["yes: x", `keys YAML reads as no string: "yes"; quote them`],
      [
        "'1': x\n    1: y",
        'not declared: "1"; keys YAML reads as no string beside a quoted key of the same text: "1"; delete them',
      ],
    ])(
      "refuses a row whose key %p Metabase reads as no string",
      async (key, advice) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file =
          "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
        const path = join(workdir, file);
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "    total: 20.0\n",
            `    total: 20.0\n    ${key}\n`,
          ),
        );
        expect(
          (await findings(workdir)).map(
            (f) => `${f.file}: ${f.rule}: ${f.message}`,
          ),
        ).toEqual([
          `${file}: row-columns-mismatch: input orders, row 3: every row must carry exactly the declared columns; ${advice}`,
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
          message: "Transform does not match its schema: /name must be string",
        },
      ]);
    });

    it("takes a duplicated entity_id to name the last file of the model in path order, for every check", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const transforms = join(workdir, "collections/transforms");
      const python = readFileSync(
        join(transforms, "python_hello_world.yaml"),
        "utf8",
      ).replace(/^entity_id: .*$/m, "entity_id: 7XqqzlsonSq4KFyOvtrAm");
      // Daily Order Summary holds 7XqqzlsonSq4KFyOvtrAm; one copy sorts
      // before it and one after.
      writeFileSync(
        join(transforms, "aaa_python_first.yaml"),
        python.replace(/^name: .*$/m, "name: Python First"),
      );
      writeFileSync(
        join(transforms, "zzz_python_last.yaml"),
        python.replace(/^name: .*$/m, "name: Python Last"),
      );
      const test =
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
      const result = await findings(workdir);
      expect(
        result
          .filter((f) => f.file === test)
          .map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "untestable-transform: transform Python Last is not a query transform; Metabase tests only query transforms",
      ]);
      expect(
        result
          .filter((f) => f.rule === "duplicate-entity-id")
          .map((f) => `${f.severity} ${f.file}: ${f.message}`),
      ).toEqual(
        [
          "aaa_python_first.yaml",
          "daily_order_summary.yaml",
          "zzz_python_last.yaml",
        ].map(
          (file) =>
            `warning collections/transforms/${file}: entity_id 7XqqzlsonSq4KFyOvtrAm is also in 2 other Transform file(s); Metabase keeps only collections/transforms/zzz_python_last.yaml, the last in path order, and drops the others without a message`,
        ),
      );
    });

    it("resolves a transform_id to the Transform that shares its entity_id with a Card, and reports neither", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const card = join(workdir, "collections/main/queries/nested_query.yaml");
      writeFileSync(
        card,
        readFileSync(card, "utf8").replace(
          /^entity_id: .*$/m,
          "entity_id: 7XqqzlsonSq4KFyOvtrAm",
        ),
      );
      expect(await findings(workdir)).toEqual([]);
    });

    it("takes a transform_id that only a Card holds to name the Card", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const card = join(workdir, "collections/main/queries/nested_query.yaml");
      const cardId = /^entity_id: (.*)$/m.exec(readFileSync(card, "utf8"))?.[1];
      const test =
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
      const path = join(workdir, test);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          /^transform_id: .*$/m,
          `transform_id: ${cardId}`,
        ),
      );
      expect(
        (await findings(workdir))
          .filter((f) => f.file === test)
          .map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        `wrong-type-transform-id: transform_id ${cardId} names a Card, not a Transform`,
      ]);
    });

    it("reads a source card by model where a file of another model, first in path order, shares its entity_id", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const ordersModelId = "4eroqa4ZYl4WkNjP8XTvu";
      edit(workdir, MBQL_TRANSFORM, (doc) => {
        listAt(doc, "source", "query", "stages")[0] = {
          "lib/type": "mbql.stage/mbql",
          "source-card": ordersModelId,
        };
      });
      // One sorts before the orders model's file and one after; each reads
      // another table.
      const writeDecoy = (file: string, table: string) =>
        writeFileSync(
          join(workdir, file),
          yaml.dump({
            name: "Decoy",
            entity_id: ordersModelId,
            creator_id: "admin@example.com",
            table_id: [POSTGRES_DB, "public", table],
            definition: {
              "lib/type": "mbql/query",
              database: POSTGRES_DB,
              stages: [
                {
                  "lib/type": "mbql.stage/mbql",
                  "source-table": [POSTGRES_DB, "public", table],
                },
              ],
            },
            "serdes/meta": [{ model: "Segment" }],
          }),
        );
      writeDecoy("collections/a_segment.yaml", "products");
      writeDecoy("collections/zzz_segment.yaml", "people");
      expect(
        (await transformReads({ folder: workdir })).find(
          (t) => t.file === MBQL_TRANSFORM,
        )?.tables,
      ).toEqual([{ schema: null, name: "ORDERS" }]);
    });

    it("cannot read a Python source table with no name", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      edit(workdir, "collections/transforms/python_hello_world.yaml", (doc) => {
        doc.source = {
          type: "python",
          body: "def transform(): pass",
          "source-tables": [{ alias: "orders", database_id: POSTGRES_DB }],
        };
      });
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
        "JOIN people u ON u.id = o.user_id",
      );
      snippet(
        "old_name.yaml",
        "OldNameSnippet0000001",
        "Old Name",
        "JOIN reviews r ON r.product_id = p.id",
      );
      edit(workdir, NATIVE_TRANSFORM, (doc) => {
        const stage = mapAt(doc, "source", "query", "stages", 0);
        stage.native = textAt(stage, "native").replace(
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
      });
      const report = (await transformReads({ folder: workdir })).find(
        (t) => t.name === "Product Revenue Report",
      );
      // Sorted, as Metabase's referenced_tables returns them.
      expect(report?.tables?.map((t) => t.name)).toEqual([
        "orders",
        "people",
        "products",
      ]);
    });

    /** Pastes the snippet `name` before the GROUP BY of `file`'s SQL, by a template tag naming `id`. */
    const useSnippet = (file: string, name: string, id: string) =>
      edit(workdir, file, (doc) => {
        const stage = mapAt(doc, "source", "query", "stages", 0);
        stage.native = textAt(stage, "native").replace(
          "GROUP BY",
          `{{snippet: ${name}}} GROUP BY`,
        );
        stage["template-tags"] = [
          ...(Array.isArray(stage["template-tags"])
            ? stage["template-tags"]
            : []),
          snippetTag(name, id),
        ];
      });

    it.each([
      [
        "no name",
        { content: "WHERE 1 = 1" },
        "/ must have required property 'name'",
      ],
      [
        "no content",
        { name: "Broken" },
        "/ must have required property 'content'",
      ],
    ])(
      "reports a snippet file with %s, and does not use it",
      async (_, fields, schemaError) => {
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
        useSnippet(transformFile, "Broken", "BrokenSnippet00000001");
        expect(
          (await findings(workdir)).map(
            (f) => `${f.file}: ${f.rule}: ${f.message}`,
          ),
        ).toEqual([
          `${snippetFile}: schema: NativeQuerySnippet does not match its schema: ${schemaError}`,
          `${transformFile}: reads-not-checked: could not find the tables this transform reads: snippet Broken is in ${snippetFile}, which fails its schema`,
        ]);
      },
    );

    // Metabase compiles the text tag to a bind parameter, which names no
    // table, and the table tag to a qualified name, which follows `public.`.
    it.each([
      [
        "a text tag with a default",
        { type: "text", default: "orders" },
        [
          "missing-input: no input for public.{{t}}, which transform Product Revenue Report reads",
          "unused-input: input public.orders is not read by transform Product Revenue Report",
        ],
      ],
      [
        "a table tag",
        { type: "table", "table-id": [POSTGRES_DB, "public", "orders"] },
        [],
      ],
    ])(
      "reads %s after a schema as Metabase compiles it",
      async (_, tag, expected) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        edit(workdir, NATIVE_TRANSFORM, (doc) => {
          const stage = mapAt(doc, "source", "query", "stages", 0);
          expect(stage.native).toContain("FROM orders o");
          stage.native = textAt(stage, "native").replace(
            "FROM orders o",
            "FROM public.{{t}} o",
          );
          stage["template-tags"] = [
            {
              ...tag,
              name: "t",
              id: "aa000003-0000-0000-0000-000000000003",
              "display-name": "T",
            },
          ];
        });
        const testFile = join(
          workdir,
          "collections/transforms/native_transform/product_revenue_report__category_totals.yaml",
        );
        const test = readFileSync(testFile, "utf8");
        expect(test).toContain("- table:\n    name: orders\n");
        writeFileSync(
          testFile,
          test.replace(
            "- table:\n    name: orders\n",
            "- table:\n    schema: public\n    name: orders\n",
          ),
        );
        expect(
          (
            await lint({
              folder: workdir,
              defaultSchemas: { [POSTGRES_DB]: "public" },
            })
          ).findings
            .filter(
              (f) => f.rule === "missing-input" || f.rule === "unused-input",
            )
            .map((f) => `${f.rule}: ${f.message}`),
        ).toEqual(expected);
      },
    );

    it("says why a snippet named by its entity id cannot be pasted", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const unread = async (snippetId: string) => {
        edit(workdir, NATIVE_TRANSFORM, (doc) => {
          const stage = mapAt(doc, "source", "query", "stages", 0);
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
        });
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

    it("names the chain once when a card uses itself as a source", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const card = "collections/main/queries/orders_model.yaml";
      const useCard = (
        file: string,
        indent: string,
        table: readonly string[],
      ) => {
        const path = join(workdir, file);
        const text = readFileSync(path, "utf8");
        const sourceTable = ["source-table:", ...table.map((t) => `- ${t}`)]
          .map((line) => `${indent}${line}`)
          .join("\n");
        expect(text).toContain(sourceTable);
        writeFileSync(
          path,
          text.replace(
            sourceTable,
            `${indent}source-card: 4eroqa4ZYl4WkNjP8XTvu`,
          ),
        );
      };
      useCard(card, "      ", ["Sample Database", "null", "ORDERS"]);
      useCard(MBQL_TRANSFORM, "        ", [POSTGRES_DB, "public", "orders"]);
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "reads-not-checked")
          .map((f) => f.message),
      ).toEqual([
        `could not find the tables this transform reads: through ${card}: ${card} uses itself as a source`,
      ]);
    });

    it("says when a snippet uses itself", async () => {
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
      useSnippet(
        "collections/transforms/native_transform.yaml",
        "Loop",
        "LoopSnippet0000000001",
      );
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "reads-not-checked")
          .map((f) => f.message),
      ).toEqual([
        "could not find the tables this transform reads: snippets use each other in a cycle: Loop -> Loop",
      ]);
    });

    it("reads a test's SQL input in a folder that holds no other SQL", async () => {
      const files = [
        CONFIG_FILE,
        MBQL_TRANSFORM,
        "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml",
      ];
      for (const file of files) {
        mkdirSync(join(workdir, file, ".."), { recursive: true });
        cpSync(join(EXAMPLES, file), join(workdir, file));
      }
      edit(workdir, files[2], (test) => {
        test.inputs = [
          {
            table: { schema: "public", name: "orders" },
            format: "sql",
            sql: "SELECT * FROM orders",
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
      });
      expect(
        (await findings(workdir)).map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "live-sql-input: input public.orders reads orders; Metabase runs an input's SQL on the database as written, so the test depends on live data",
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

    describe("on a transform as Metabase writes and pulls it", () => {
      const NATIVE = "collections/transforms/native_transform.yaml";

      const findingsIn = async (file: string) =>
        (await findings(workdir))
          .filter((f) => f.file === file)
          .map((f) => `${f.severity} ${f.rule}: ${f.message}`);

      const errorsIn = async (file: string) =>
        (await findingsIn(file)).filter((f) => f.startsWith("error "));

      it("a transform whose source database was deleted is reported as such, not as a schema mismatch of source_database_id", async () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        edit(workdir, NATIVE, (doc) => {
          doc.source_database_id = null;
          mapAt(doc, "source")["serdes/unresolved"] = true;
          mapAt(doc, "source", "query").database = null;
        });
        const found = await findingsIn(NATIVE);
        expect(
          found.filter((f) => f.includes("/source_database_id must be string")),
        ).toEqual([]);
        expect(
          found.some((f) =>
            /database.*(deleted|unresolved)|(deleted|unresolved).*database/i.test(
              f,
            ),
          ),
        ).toBe(true);
      });

      it("a blank target schema on an engine without schemas is an error", async () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        writeSettings(workdir, {
          defaultSchemas: { Shop: null },
          engines: { Shop: "mysql" },
        });
        const file = "collections/transforms/shop_report.yaml";
        const writeShopTransform = (target: Record<string, unknown>) => {
          cpSync(join(EXAMPLES, NATIVE), join(workdir, file));
          edit(workdir, file, (doc) => {
            doc.name = "Shop Report";
            doc.entity_id = "ShopReportTransform01";
            doc.source_database_id = "Shop";
            mapAt(doc, "source", "query").database = "Shop";
            doc.target = {
              database: "Shop",
              type: "table",
              name: "shop_report",
              ...target,
            };
          });
        };
        writeShopTransform({});
        expect(await errorsIn(file)).toEqual([]);
        writeShopTransform({ schema: "" });
        expect(await errorsIn(file)).toEqual([
          expect.stringMatching(/^error blank-target-schema: /),
        ]);
      });

      it("a target with no schema on an engine with schemas is a warning, and a blank one an error", async () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file = "collections/transforms/python_hello_world.yaml";
        edit(workdir, file, (doc) => {
          delete mapAt(doc, "target").schema;
        });
        expect(await findingsIn(file)).toEqual([
          "warning missing-target-schema: the target names no schema, on database Sample Postgres, whose engine postgres has schemas. A pull accepts it, and a run writes the table to the database's default schema, but Metabase's API refuses to save the transform. Name the schema",
        ]);
        edit(workdir, file, (doc) => {
          mapAt(doc, "target").schema = " ";
        });
        expect(await findingsIn(file)).toEqual([
          expect.stringMatching(/^error blank-target-schema: /),
        ]);
      });
    });
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

    // A Database file for the database the transforms run on.
    const DATABASE_FILE = "databases/sample_postgres/sample_postgres.yaml";

    const writeDatabase = (
      engine: string,
      fields: Record<string, unknown> = {},
    ) =>
      write(workdir, DATABASE_FILE, {
        name: POSTGRES_DB,
        engine,
        ...fields,
        "serdes/meta": [{ model: "Database" }],
      });

    /** Writes a settings file that gives the transforms' database `engine` alone. */
    const writeEngine = (engine: string) =>
      writeConfig(JSON.stringify({ engines: { [POSTGRES_DB]: engine } }));

    // The settings these tests write give no engine for the Sample
    // Database, whose cards then warn of it.
    const lintRules = async (defaultSchemas?: Record<string, string | null>) =>
      rules((await lint({ folder: workdir, defaultSchemas })).findings).filter(
        (rule) => rule !== "unknown-engine",
      );

    // The rules that depend on the default schema, without the engine rules
    // an engine adds, and the warning on a Database file.
    const inputRules = async () =>
      (await lintRules()).filter(
        (rule) => rule === "missing-input" || rule === "unused-input",
      );

    it("warns, naming the database, and skips only the comparisons that need a default schema nobody gives", async () => {
      rmSync(join(workdir, CONFIG_FILE));
      // The products test lacks the input for products, which no default
      // schema changes; the orders test's input OTHER.orders stands in for
      // orders only outside the default schema.
      MUTATIONS.find((m) => m.name === "missing-input")?.apply(workdir);
      const inputFindings = async (
        defaultSchemas: Record<string, string> = {},
      ) =>
        (await lint({ folder: workdir, defaultSchemas })).findings
          .filter(
            (f) => f.rule === "missing-input" || f.rule === "unused-input",
          )
          .map((f) => `${f.rule}: ${f.message.split(",")[0]}`);
      const { findings } = await lint({ folder: workdir });
      expect(
        findings
          .filter((f) => f.rule === "missing-default-schema")
          .map((f) => f.message.match(/database ("[^"]*")/)?.[1]),
      ).toEqual([JSON.stringify(POSTGRES_DB)]);
      expect(await inputFindings()).toEqual([
        "missing-input: no input for products",
      ]);
      expect(await inputFindings({ [POSTGRES_DB]: "public" })).toEqual([
        "missing-input: no input for orders",
        "missing-input: no input for products",
        "unused-input: input OTHER.orders is not read by transform Daily Order Summary",
      ]);
    });

    it("reads the default schemas in the folder's settings file", async () => {
      writeConfig('{"defaultSchemas": {"Sample Postgres": "OTHER"}}');
      expect(await lintRules()).toEqual([]);
      writeConfig('{"defaultSchemas": {"Sample Postgres": "public"}}');
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes a default schema passed to lint over the settings file's", async () => {
      writeConfig('{"defaultSchemas": {"Sample Postgres": "public"}}');
      expect(await lintRules({ [POSTGRES_DB]: "OTHER" })).toEqual([]);
    });

    it("reads null in the settings file as a database with no schemas", async () => {
      writeConfig('{"defaultSchemas": {"Sample Postgres": null}}');
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes the default schema of a SQLite or MongoDB database as null, as Metabase hard-codes it", async () => {
      writeEngine("sqlite");
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
      // MongoDB's native queries are not SQL, so the native transforms are unread
      // and give no input finding. The tests' unqualified inputs still need
      // the default schema, which the engine gives.
      writeEngine("mongo");
      expect(await inputRules()).toEqual([]);
    });

    it("takes a MySQL database to have no schemas, and asks for a Postgres database's default", async () => {
      writeEngine("mysql");
      expect(await lintRules()).toEqual(["missing-input", "unused-input"]);
      writeEngine("postgres");
      expect(await lintRules()).toEqual(["missing-default-schema"]);
    });

    it("takes no engine from a Database file", async () => {
      writeEngine("mysql");
      writeDatabase("postgres");
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
    });

    it("takes no default schema from a Database file", async () => {
      writeEngine("postgres");
      writeDatabase("postgres", { default_schema: "OTHER" });
      expect(await lintRules()).toContain("missing-default-schema");
      writeDatabase("mysql", { default_schema: "OTHER" });
      writeEngine("mysql");
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
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

  // Two qualified names compare the same whatever the default schema; one
  // transform test that names one table in two schemas still needs it.
  describe("with one table name in two schemas", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-two-"));
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({ engines: { [DATABASE]: "postgres" } }),
      );
      writeTransform("a_copy", "SELECT id FROM a.account");
      writeTransform("b_copy", "SELECT id FROM b.account");
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const DATABASE = "Warehouse";

    function writeTransform(name: string, sql: string, stage?: object): void {
      mkdirSync(join(workdir, "transforms"), { recursive: true });
      writeFileSync(
        join(workdir, "transforms", `${name}.yaml`),
        yaml.dump({
          name,
          entity_id: `${name}_transform_00000`.slice(0, 21),
          creator_id: "admin@example.com",
          source_database_id: DATABASE,
          source: {
            type: "query",
            query: {
              "lib/type": "mbql/query",
              database: DATABASE,
              stages: [
                stage ?? { "lib/type": "mbql.stage/native", native: sql },
              ],
            },
          },
          target: { database: DATABASE, type: "table", schema: "out", name },
          "serdes/meta": [{ model: "Transform" }],
        }),
      );
    }

    function writeTest(transform: string, input: string, sql: string): void {
      const [schema, name] = input.split(".");
      writeFileSync(
        join(workdir, "transforms", `${transform}__test.yaml`),
        yaml.dump({
          name: `${transform} test`,
          entity_id: `${transform}_test_000000000`.slice(0, 21),
          transform_id: `${transform}_transform_00000`.slice(0, 21),
          creator_id: "admin@example.com",
          inputs: [
            {
              table: { schema, name },
              format: "rows",
              columns: [{ name: "id", cast_type: "INTEGER" }],
              rows: [{ id: 1 }],
            },
          ],
          expectations: [{ type: "empty", name: "no rows", sql }],
          "serdes/meta": [{ model: "TransformTest" }],
        }),
      );
    }

    // The rules of the findings, and why each database whose default schema
    // is unknown needs it.
    const outcome = async () => {
      const { findings } = await lint({ folder: workdir });
      return {
        rules: rules(findings),
        unknown: findings
          .filter((f) => f.rule === "missing-default-schema")
          .map(
            (f) => f.message.match(/this file (.*)\. The lint skipped/)?.[1],
          ),
      };
    };

    const stop = (reason: string) => ({
      rules: ["missing-default-schema"],
      unknown: [reason],
    });
    const twoSchemas = stop(
      'names "account" in schemas "a" and "b" in one transform test, which only the default schema tells apart',
    );

    it("lints when no transform test compares the two", async () => {
      expect(await outcome()).toEqual({ rules: [], unknown: [] });
    });

    it("lints when each test's tables name the table in one schema", async () => {
      writeTest("a_copy", "a.account", "SELECT * FROM a.account WHERE id < 0");
      writeTest("b_copy", "b.account", "SELECT * FROM out.b_copy WHERE id < 0");
      expect(await outcome()).toEqual({ rules: [], unknown: [] });
    });

    // The comparisons of two qualified names need no default schema, and run.
    it("warns when a test's input and expectation name the table in two schemas", async () => {
      writeTest("a_copy", "a.account", "SELECT * FROM b.account WHERE id < 0");
      expect(await outcome()).toEqual({
        ...twoSchemas,
        rules: ["expectation-reads-other-table", "missing-default-schema"],
      });
    });

    it("warns when a test's input and its transform's SQL name the table in two schemas", async () => {
      writeTransform(
        "a_copy",
        "SELECT x.id FROM a.account x JOIN b.account y ON x.id = y.id",
      );
      writeTest("a_copy", "a.account", "SELECT * FROM out.a_copy WHERE id < 0");
      expect(await outcome()).toEqual({
        ...twoSchemas,
        rules: ["missing-default-schema", "missing-input"],
      });
    });

    it("warns when a test's input names in a schema a table its transform reads by a reference with no schema", async () => {
      writeTransform("a_copy", "", {
        "lib/type": "mbql.stage/mbql",
        "source-table": [DATABASE, null, "account"],
      });
      writeTest("a_copy", "a.account", "SELECT * FROM out.a_copy WHERE id < 0");
      expect(await outcome()).toEqual(
        stop(
          'names "account" with no schema and in a schema in one transform test, which only the default schema matches',
        ),
      );
    });
  });

  // An expectation may read the test's inputs and the transform's target; a
  // name compares as one table with another (`sameTable`): an unqualified
  // name is in the default schema, and case does not matter.
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

    const editTest = (change: (doc: Record<string, unknown>) => void) =>
      edit(workdir, TEST, change);

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
            sql: `SELECT * FROM ${table} WHERE total < 0`,
          },
        ];
      });

    const expectationRules = async (schema?: string): Promise<string[]> =>
      (
        await lint({
          folder: workdir,
          defaultSchemas: schema === undefined ? {} : { [POSTGRES_DB]: schema },
        })
      ).findings
        .filter((f) => f.message.startsWith("expectation"))
        .map((f) => f.rule);

    it("accepts a qualified read of an unqualified input in the default schema only", async () => {
      readOrders("public.orders");
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("warns on a read in another schema than the input's", async () => {
      readOrders("OTHER.orders", "public");
      expect(await expectationRules("public")).toEqual([
        "expectation-reads-other-table",
      ]);
      expect(await expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("warns on an unqualified read of an input outside the default schema", async () => {
      readOrders("orders", "public");
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("compares a quoted name ignoring case, as any other name", async () => {
      readOrders('"Orders"');
      expect(await expectationRules("public")).toEqual([]);
      readOrders('"orders"');
      expect(await expectationRules("public")).toEqual([]);
      readOrders("Orders");
      expect(await expectationRules("public")).toEqual([]);
    });

    it("accepts the quoted mixed-case name of the transform's target", async () => {
      const test =
        "collections/transforms/native_transform/product_revenue_report__category_totals.yaml";
      const path = join(workdir, test);
      const text = readFileSync(path, "utf8");
      const target = "FROM transforms.product_revenue_report";
      expect(text).toContain(target);
      writeFileSync(
        path,
        text.replace(target, 'FROM "Transforms"."Product_Revenue_Report"'),
      );
      expect((await lint({ folder: workdir })).findings).toEqual([]);
    });

    it("reads an expectation's SQL as written, as Metabase runs it: a template tag does not parse, and Metabase refuses the test", async () => {
      readOrders("{{orders}}");
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.severity} ${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        expect.stringMatching(
          /^error unparseable-test-sql: could not parse the SQL of expectation orders read as Metabase parses it for engine postgres, so Metabase refuses the test: SQLGlot could not parse it: ParseError:/,
        ),
      ]);
    });

    it("warns, and does not refuse, SQL it cannot parse when the database's engine is unknown", async () => {
      readOrders("{{orders}}");
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({ defaultSchemas: { [POSTGRES_DB]: "public" } }),
      );
      expect(
        (await lint({ folder: workdir })).findings
          .filter((f) => f.message.startsWith("could not"))
          .map((f) => `${f.severity} ${f.rule}`),
      ).toEqual(["warning reads-not-checked"]);
    });

    it("warns only on a tested transform whose SQL does not parse in its engine's dialect", async () => {
      const transform = "collections/transforms/daily_order_summary.yaml";
      edit(workdir, transform, (doc) => {
        mapAt(doc, "source", "query", "stages", 0).native =
          "SELECT * FROM orders o p q";
      });
      expect(
        (await lint({ folder: workdir })).findings.map((f) => [
          f.severity,
          f.rule,
          f.file,
          f.related,
        ]),
      ).toEqual([["warning", "reads-not-checked", transform, []]]);
    });

    it("refuses an expectation whose large literal list does not parse, which Metabase parses as written", async () => {
      const list = Array.from({ length: 100 }, (_, i) => i + 3).join(", ");
      readOrders(`(SELECT * FROM orders WHERE id IN (1 2, ${list})) o`);
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.severity} ${f.rule}`,
        ),
      ).toEqual(["error unparseable-test-sql"]);
      readOrders(`(SELECT * FROM orders WHERE id IN (1, ${list})) o`);
      expect((await lint({ folder: workdir })).findings).toEqual([]);
    });

    // Metabase rethrows any error but a ParseError, and the test still fails.
    it("refuses SQL that fails as a TokenError, which Metabase's check rethrows", async () => {
      readOrders("orders WHERE note = 'open");
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.severity} ${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        expect.stringMatching(
          /^error unparseable-test-sql: could not parse the SQL of expectation orders read as Metabase parses it for engine postgres, so Metabase refuses the test: SQLGlot could not parse it: TokenError:/,
        ),
      ]);
    });

    it("reports unparseable SQL of a test whose default schema is unknown", async () => {
      readOrders("{{orders}}");
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          defaultSchemas: { "Sample Database": null },
          engines: { "Sample Database": "sqlite", [POSTGRES_DB]: "postgres" },
        }),
      );
      expect(
        (await lint({ folder: workdir })).findings
          .filter((f) => f.file === TEST)
          .map((f) => f.rule),
      ).toEqual(["unparseable-test-sql"]);
    });

    it("warns on a read of a table that is neither input nor target", async () => {
      readOrders("people");
      expect(
        (await lint({ folder: workdir })).findings.map((f) => [
          f.rule,
          f.severity,
        ]),
      ).toEqual([["expectation-reads-other-table", "warning"]]);
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
              schema === undefined ? {} : { [POSTGRES_DB]: schema },
          })
        ).findings,
      );

    it("finds a cycle through an unqualified read only in the default schema", async () => {
      mutateExamples("transform-cycle", workdir);
      replaceIn(
        "collections/transforms/native_transform.yaml",
        "JOIN transforms.top_categories",
        "JOIN top_categories",
      );
      expect(await rulesWithDefault("transforms")).toContain("transform-cycle");
      expect(await rulesWithDefault("public")).not.toContain("transform-cycle");
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
      replaceIn(copy, "  schema: transforms\n", "");
      // Postgres has schemas, so a target with none also gets a warning.
      expect(await rulesWithDefault("transforms")).toEqual([
        "duplicate-target",
        "missing-target-schema",
      ]);
      expect(await rulesWithDefault("public")).toEqual([
        "missing-target-schema",
      ]);
    });
  });

  describe("with an empty native query", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-empty-"));
      cpSync(EXAMPLES, workdir, { recursive: true });
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const TRANSFORM = "collections/transforms/hourly_product_stats.yaml";

    const withStage = (stage: Record<string, unknown>) =>
      edit(workdir, TRANSFORM, (doc) => {
        mapAt(doc, "source", "query").stages = [stage];
      });

    const findingsOn = async () =>
      (await lint({ folder: workdir })).findings
        .filter((f) => f.file === TRANSFORM)
        .map((f) => `${f.rule}: ${f.message}`);

    it("warns on a native stage of empty or blank SQL, and not on one with SQL", async () => {
      for (const native of ["", " \n\t"]) {
        withStage({ "lib/type": "mbql.stage/native", native });
        expect(await findingsOn()).toEqual([
          "empty-native-query: a native query of this transform is empty; Metabase accepts it, and every run fails",
        ]);
      }
      withStage({
        "lib/type": "mbql.stage/native",
        native: "SELECT * FROM products",
      });
      expect(await findingsOn()).toEqual([]);
    });
  });

  describe("with a default schema that no source gives", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-nodefault-"));
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({ engines: { [POSTGRES_DB]: "postgres" } }),
      );
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    /** Writes a transform running `sql` and writing `target`. */
    const writeTransform = (
      file: string,
      entityId: string,
      sql: string,
      target: { schema?: string; name: string },
    ) =>
      writeFileSync(
        join(workdir, "collections/transforms", file),
        yaml.dump({
          name: file,
          entity_id: entityId,
          creator_id: "admin@example.com",
          source_database_id: POSTGRES_DB,
          source: {
            type: "query",
            query: {
              "lib/type": "mbql/query",
              database: POSTGRES_DB,
              stages: [{ "lib/type": "mbql.stage/native", native: sql }],
            },
          },
          target: { database: POSTGRES_DB, type: "table", ...target },
          "serdes/meta": [{ model: "Transform" }],
        }),
      );

    it("warns once per database, naming its files, skips their comparisons, and runs every other check", async () => {
      // Each needs the default schema: an unqualified target, and an
      // unqualified read. With public as the default schema, a.yaml and
      // b.yaml write one table.
      writeTransform("a.yaml", "NoDefaultTransformA01", "SELECT 1 AS n", {
        name: "out",
      });
      writeTransform("b.yaml", "NoDefaultTransformB01", "SELECT * FROM x", {
        schema: "public",
        name: "out",
      });
      // Qualified names only: compared as before.
      writeTransform("c.yaml", "NoDefaultTransformC01", "SELECT 1 AS n", {
        schema: "public",
        name: "twice",
      });
      writeTransform("d.yaml", "NoDefaultTransformD01", "SELECT 1 AS n", {
        schema: "public",
        name: "twice",
      });
      // The rules this test is about, without the target rules.
      const findings = (await lint({ folder: workdir })).findings.filter(
        (f) =>
          f.rule === "missing-default-schema" || f.rule === "duplicate-target",
      );
      expect(
        findings.map(({ rule, severity, file, related, message }) => ({
          rule,
          severity,
          file,
          related,
          message,
        })),
      ).toEqual([
        {
          rule: "missing-default-schema",
          severity: "warning",
          file: "collections/transforms/a.yaml",
          related: ["collections/transforms/b.yaml"],
          message: `the default schema of database "Sample Postgres" is unknown, and this file names "out" without a schema, so it resolves to the default schema. The lint skipped the comparisons that depend on it, in this file and 1 other file. Give the default schema in ${CONFIG_FILE}, as {"defaultSchemas": {"<database>": "<schema>"}} (null for a database with no schemas)`,
        },
        expect.objectContaining({
          rule: "duplicate-target",
          file: "collections/transforms/c.yaml",
        }),
        expect.objectContaining({
          rule: "duplicate-target",
          file: "collections/transforms/d.yaml",
        }),
      ]);
    });

    it("compares a test's tables where the default schema does not matter, and skips only the comparisons where it does", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          defaultSchemas: { "Sample Database": null },
          engines: { "Sample Database": "sqlite", [POSTGRES_DB]: "postgres" },
        }),
      );
      edit(
        workdir,
        "collections/transforms/daily_order_summary.yaml",
        (doc) => {
          mapAt(doc, "source", "query", "stages", 0).native =
            "SELECT DATE_TRUNC('day', o.created_at) AS order_date, COUNT(*) AS order_count, SUM(o.total) AS total_revenue FROM orders o JOIN public.products p ON p.id = o.product_id GROUP BY 1";
        },
      );
      edit(workdir, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        listAt(doc, "inputs").push({
          table: { schema: "public", name: "people" },
          format: "rows",
          columns: [{ name: "id", cast_type: "INTEGER" }],
          rows: [{ id: 1 }],
        });
        // public.orders is the input orders only in the default schema.
        listAt(doc, "expectations").push({
          type: "empty",
          name: "no reviews",
          sql: "SELECT * FROM public.orders o JOIN public.reviews r ON true",
        });
      });
      const onTest = async (defaultSchemas: Record<string, string> = {}) =>
        (await lint({ folder: workdir, defaultSchemas })).findings
          .filter((f) => f.file === DAILY_ORDER_SUMMARY_TEST)
          .map((f) => `${f.rule}: ${f.message.split(",")[0]}`);
      expect(await onTest()).toEqual([
        "missing-input: no input for public.products",
        "unused-input: input public.people is not read by transform Daily Order Summary",
        "expectation-reads-other-table: expectation no reviews reads public.reviews",
      ]);
      expect(await onTest({ [POSTGRES_DB]: "other" })).toEqual([
        "missing-input: no input for public.products",
        "unused-input: input public.people is not read by transform Daily Order Summary",
        "expectation-reads-other-table: expectation no reviews reads public.orders",
        "expectation-reads-other-table: expectation no reviews reads public.reviews",
      ]);
    });

    describe("on a test of the examples, with no default schema for Sample Postgres", () => {
      beforeEach(() => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        writeFileSync(
          join(workdir, CONFIG_FILE),
          JSON.stringify({
            defaultSchemas: { "Sample Database": null },
            engines: { "Sample Database": "sqlite", [POSTGRES_DB]: "postgres" },
          }),
        );
      });

      const onTest = async (
        rule: string,
        defaultSchemas: Record<string, string> = {},
      ) =>
        (await lint({ folder: workdir, defaultSchemas })).findings
          .filter((f) => f.file === DAILY_ORDER_SUMMARY_TEST && f.rule === rule)
          .map((f) => f.message);

      it("reports no duplicate input that only the default schema decides", async () => {
        edit(workdir, DAILY_ORDER_SUMMARY_TEST, (doc) => {
          const [orders] = listAt(doc, "inputs");
          listAt(doc, "inputs").push({
            ...mapAt(orders),
            table: { schema: "public", name: "orders" },
          });
        });
        expect(await onTest("duplicate-input")).toEqual([]);
        expect(
          await onTest("duplicate-input", { [POSTGRES_DB]: "public" }),
        ).toEqual([
          "inputs stand in for the same table: orders, public.orders",
        ]);
      });

      it("reports no other table for an expectation's read that only the default schema decides", async () => {
        edit(workdir, DAILY_ORDER_SUMMARY_TEST, (doc) => {
          mapAt(doc, "inputs", 0, "table").schema = "public";
          mapAt(doc, "expectations", 0).sql =
            "SELECT * FROM orders WHERE total < 0";
        });
        const rule = "expectation-reads-other-table";
        expect(await onTest(rule)).toEqual([]);
        expect(await onTest(rule, { [POSTGRES_DB]: "public" })).toEqual([]);
        expect(await onTest(rule, { [POSTGRES_DB]: "other" })).toEqual([
          "expectation one row per day reads orders, which is neither the transform's target nor an input of this test",
        ]);
      });
    });

    it("still compares the qualified names of files that need the default schema", async () => {
      // Every name of the cycle and of the shared target is qualified; only
      // the read of orders, in b.yaml and d.yaml, needs the default schema.
      writeTransform(
        "a.yaml",
        "NoDefaultTransformA01",
        "SELECT * FROM transforms.rci62_b",
        { schema: "transforms", name: "rci62_a" },
      );
      writeTransform(
        "b.yaml",
        "NoDefaultTransformB01",
        "SELECT * FROM transforms.rci62_a JOIN orders ON true",
        { schema: "transforms", name: "rci62_b" },
      );
      writeTransform("c.yaml", "NoDefaultTransformC01", "SELECT 1 AS n", {
        schema: "public",
        name: "twice",
      });
      writeTransform(
        "d.yaml",
        "NoDefaultTransformD01",
        "SELECT * FROM orders",
        {
          schema: "public",
          name: "twice",
        },
      );
      expect(
        (await lint({ folder: workdir })).findings
          .filter((f) =>
            [
              "missing-default-schema",
              "duplicate-target",
              "transform-cycle",
            ].includes(f.rule),
          )
          .map((f) => [f.rule, f.file]),
      ).toEqual([
        ["missing-default-schema", "collections/transforms/b.yaml"],
        ["duplicate-target", "collections/transforms/c.yaml"],
        ["duplicate-target", "collections/transforms/d.yaml"],
        ["transform-cycle", "collections/transforms/a.yaml"],
      ]);
    });

    it("skips a comparison of an unqualified target with a null-schema reference", async () => {
      // Each reads the other's unqualified target by an MBQL reference with a
      // null schema: one table only when the default schema is none.
      const write = (
        file: string,
        entityId: string,
        reads: string,
        target: string,
      ) =>
        writeFileSync(
          join(workdir, "collections/transforms", file),
          yaml.dump({
            name: file,
            entity_id: entityId,
            creator_id: "admin@example.com",
            source_database_id: POSTGRES_DB,
            source: {
              type: "query",
              query: {
                "lib/type": "mbql/query",
                database: POSTGRES_DB,
                stages: [
                  {
                    "lib/type": "mbql.stage/mbql",
                    "source-table": [POSTGRES_DB, null, reads],
                  },
                ],
              },
            },
            target: { database: POSTGRES_DB, type: "table", name: target },
            "serdes/meta": [{ model: "Transform" }],
          }),
        );
      write("a.yaml", "NoDefaultTransformA01", "y", "x");
      write("b.yaml", "NoDefaultTransformB01", "x", "y");
      const cycles = async (defaultSchemas: Record<string, string | null>) =>
        (await lint({ folder: workdir, defaultSchemas })).findings.filter(
          (f) => f.rule === "transform-cycle",
        ).length;
      expect(await cycles({})).toBe(0);
      expect(await cycles({ [POSTGRES_DB]: null })).toBe(1);
      expect(await cycles({ [POSTGRES_DB]: "public" })).toBe(0);
    });

    it("compares a test input with another transform's target where the default schema does not decide it", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      mutateExamples("upstream-column-mismatch", workdir);
      const upstream = async (defaultSchemas: Record<string, string>) =>
        (await lint({ folder: workdir, defaultSchemas })).findings
          .filter((f) => f.rule === "upstream-column-mismatch")
          .map((f) => f.file);
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          defaultSchemas: { "Sample Database": null },
          engines: { "Sample Database": "sqlite", [POSTGRES_DB]: "postgres" },
        }),
      );
      const TEST =
        "collections/transforms/top_categories/top_categories__three_highest.yaml";
      // The input and the target both name the schema transforms.
      expect(await upstream({})).toEqual([TEST]);
      // An unqualified input is the target only in the default schema.
      edit(workdir, TEST, (doc) => {
        delete mapAt(doc, "inputs", 0, "table").schema;
      });
      expect(await upstream({})).toEqual([]);
      expect(await upstream({ [POSTGRES_DB]: "public" })).toEqual([]);
      expect(await upstream({ [POSTGRES_DB]: "transforms" })).toEqual([TEST]);
    });

    describe("upstream columns of a test whose files need the default schema", () => {
      // U returns n; the test's input for U's target declares m, which U does
      // not return. Every name the comparison reads is qualified.
      const writeTest = (expectationSql: string) =>
        writeFileSync(
          join(workdir, "collections/transforms/t__test.yaml"),
          yaml.dump({
            name: "T: test",
            entity_id: "NoDefaultTransformTst",
            transform_id: "NoDefaultTransformT01",
            creator_id: "admin@example.com",
            inputs: [
              {
                table: { schema: "transforms", name: "u" },
                format: "rows",
                columns: [{ name: "m", cast_type: "INTEGER" }],
                rows: [{ m: 1 }],
              },
            ],
            expectations: [
              { type: "empty", name: "none", sql: expectationSql },
            ],
            "serdes/meta": [{ model: "TransformTest" }],
          }),
        );
      const upstream = async (defaultSchemas: Record<string, string> = {}) =>
        (await lint({ folder: workdir, defaultSchemas })).findings
          .filter((f) => f.rule === "upstream-column-mismatch")
          .map((f) => f.file);

      beforeEach(() => {
        writeTransform("u.yaml", "NoDefaultTransformU01", "SELECT 1 AS n", {
          schema: "transforms",
          name: "u",
        });
      });

      // Metabase runs the SQL of a stage with no template tags as written.
      it("reads no columns of an upstream stage with no template tags whose optional clause does not parse as written", async () => {
        writeTransform(
          "u.yaml",
          "NoDefaultTransformU01",
          "SELECT 1 AS n [[, {{x}} AS m]]",
          { schema: "transforms", name: "u" },
        );
        writeTransform(
          "t.yaml",
          "NoDefaultTransformT01",
          "SELECT n FROM transforms.u",
          { schema: "transforms", name: "t" },
        );
        writeTest("SELECT * FROM transforms.t");
        expect(await upstream({ [POSTGRES_DB]: "public" })).toEqual([]);
      });

      it("compares a test whose own file needs it, where the names are qualified", async () => {
        writeTransform(
          "t.yaml",
          "NoDefaultTransformT01",
          "SELECT n FROM transforms.u",
          {
            schema: "transforms",
            name: "t",
          },
        );
        writeTest("SELECT * FROM transforms.t JOIN x ON true");
        expect(await upstream()).toEqual([
          "collections/transforms/t__test.yaml",
        ]);
        expect(await upstream({ [POSTGRES_DB]: "public" })).toEqual([
          "collections/transforms/t__test.yaml",
        ]);
      });

      it("compares a test whose transform's file needs it, where the names are qualified", async () => {
        writeTransform(
          "t.yaml",
          "NoDefaultTransformT01",
          "SELECT n FROM transforms.u JOIN y ON true",
          { schema: "transforms", name: "t" },
        );
        writeTest("SELECT * FROM transforms.t");
        expect(await upstream()).toEqual([
          "collections/transforms/t__test.yaml",
        ]);
        expect(await upstream({ [POSTGRES_DB]: "public" })).toEqual([
          "collections/transforms/t__test.yaml",
        ]);
      });
    });

    it("compares the same files once the default schema is given", async () => {
      writeTransform("a.yaml", "NoDefaultTransformA01", "SELECT 1 AS n", {
        name: "out",
      });
      writeTransform("b.yaml", "NoDefaultTransformB01", "SELECT 1 AS n", {
        schema: "public",
        name: "out",
      });
      const { findings } = await lint({
        folder: workdir,
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(
        findings
          .filter((f) => f.rule === "duplicate-target")
          .map((f) => [f.rule, f.file]),
      ).toEqual([
        ["duplicate-target", "collections/transforms/a.yaml"],
        ["duplicate-target", "collections/transforms/b.yaml"],
      ]);
    });
  });

  // Metabase's import looks a table up by exact name (`table-id-by-name`), and
  // creates an inactive table on a miss; the transform-test validator and a
  // warehouse reading unquoted SQL compare ignoring case.
  describe("with table names that differ only in case", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-case-"));
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      writeSettings(workdir);
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    /** Writes a transform reading `stage` and writing `public.<target>`. */
    const writeTransform = (
      file: string,
      entityId: string,
      stage: Record<string, unknown>,
      target: string,
    ) =>
      writeFileSync(
        join(workdir, "collections/transforms", file),
        yaml.dump({
          name: file,
          entity_id: entityId,
          creator_id: "admin@example.com",
          source_database_id: POSTGRES_DB,
          source: {
            type: "query",
            query: {
              "lib/type": "mbql/query",
              database: POSTGRES_DB,
              stages: [stage],
            },
          },
          target: {
            database: POSTGRES_DB,
            type: "table",
            schema: "public",
            name: target,
          },
          "serdes/meta": [{ model: "Transform" }],
        }),
      );
    const mbqlRead = (table: string) => ({
      "lib/type": "mbql.stage/mbql",
      "source-table": [POSTGRES_DB, "public", table],
    });
    const sqlRead = (table: string) => ({
      "lib/type": "mbql.stage/native",
      native: `SELECT * FROM public.${table}`,
    });
    const lintRules = async () =>
      rules((await lint({ folder: workdir })).findings);

    it("finds no cycle through an MBQL reference whose case differs from the target", async () => {
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("Foo"), "bar");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("bar"), "foo");
      expect(await lintRules()).toEqual([]);
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("foo"), "bar");
      expect(await lintRules()).toEqual(["transform-cycle"]);
    });

    it("finds a cycle through a SQL read whose case differs from the target", async () => {
      writeTransform("a.yaml", "CaseTransformA0000001", sqlRead("Foo"), "bar");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("bar"), "foo");
      expect(await lintRules()).toEqual(["transform-cycle"]);
    });

    it("finds a duplicate target only in the same case", async () => {
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("x"), "Out");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "out");
      expect(await lintRules()).toEqual([]);
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "Out");
      expect(await lintRules()).toEqual(["duplicate-target"]);
    });

    it("compares names on Redshift as on any other engine", async () => {
      writeSettings(workdir, { engines: { [POSTGRES_DB]: "redshift" } });
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("x"), "Out");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "out");
      expect(await lintRules()).toEqual([]);
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("Foo"), "bar");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("bar"), "foo");
      expect(await lintRules()).toEqual([]);
    });
  });

  describe("with two transforms that write one schema and name", () => {
    const OTHER_DB = "Other Postgres";
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-target-"));
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          engines: { [POSTGRES_DB]: "postgres", [OTHER_DB]: "postgres" },
          defaultSchemas: { [POSTGRES_DB]: "public", [OTHER_DB]: "public" },
        }),
      );
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    /** Writes a native transform on `database` that writes `transforms.same`. */
    const writeTransform = (file: string, entityId: string, database: string) =>
      writeFileSync(
        join(workdir, "collections/transforms", file),
        yaml.dump({
          name: file,
          entity_id: entityId,
          creator_id: "admin@example.com",
          source_database_id: database,
          source: {
            type: "query",
            query: {
              "lib/type": "mbql/query",
              database,
              stages: [
                { "lib/type": "mbql.stage/native", native: "SELECT 1 AS x" },
              ],
            },
          },
          target: {
            database,
            type: "table",
            schema: "transforms",
            name: "same",
          },
          "serdes/meta": [{ model: "Transform" }],
        }),
      );

    const duplicateTargetFiles = async () =>
      (await lint({ folder: workdir })).findings
        .filter((f) => f.rule === "duplicate-target")
        .map((f) => f.file)
        .sort();

    it("finds a duplicate target only in one database", async () => {
      writeTransform("a.yaml", "SameTargetTransform01", POSTGRES_DB);
      writeTransform("b.yaml", "SameTargetTransform02", OTHER_DB);
      expect(await duplicateTargetFiles()).toEqual([]);
      writeTransform("b.yaml", "SameTargetTransform02", POSTGRES_DB);
      expect(await duplicateTargetFiles()).toEqual([
        "collections/transforms/a.yaml",
        "collections/transforms/b.yaml",
      ]);
    });
  });

  // Metabase imports `[database, null, table]` as the table with no schema; on
  // a database whose default schema is not null, that table rarely exists.
  describe("with an MBQL reference with a null schema", () => {
    let workdir: string;

    const SQL = "collections/transforms/native_transform.yaml";
    const CARD = "collections/main/orders_card.yaml";

    const writeCard = (file: string, stage: Record<string, unknown>) => {
      mkdirSync(join(workdir, "collections/main"), { recursive: true });
      writeFileSync(
        join(workdir, file),
        yaml.dump({
          name: file,
          entity_id: `${file.slice(-6, -5).toUpperCase()}`.padEnd(21, "0"),
          type: "question",
          display: "table",
          dataset_query: {
            "lib/type": "mbql/query",
            database: POSTGRES_DB,
            stages: [{ "lib/type": "mbql.stage/mbql", ...stage }],
          },
          "serdes/meta": [{ model: "Card" }],
        }),
      );
    };

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-nullref-"));
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      for (const file of [MBQL_TRANSFORM, SQL]) {
        cpSync(join(EXAMPLES, file), join(workdir, file));
      }
      nullSchemaReferences(workdir);
      writeCard(CARD, {
        "source-table": [POSTGRES_DB, null, "orders"],
        aggregation: [["count", {}]],
      });
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const writeDatabase = (fields: Record<string, unknown>) => {
      const dir = join(workdir, "databases/sample_postgres");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "sample_postgres.yaml"),
        yaml.dump({
          name: POSTGRES_DB,
          ...fields,
          "serdes/meta": [{ model: "Database" }],
        }),
      );
    };

    const writeSettingsFile = (settings: Record<string, unknown>) =>
      writeFileSync(join(workdir, CONFIG_FILE), JSON.stringify(settings));

    const nullSchemaFindings = async () =>
      (await lint({ folder: workdir })).findings
        .filter((f) => f.rule === "null-schema-reference")
        .map((f) => `${f.file}: ${f.severity}: ${f.message}`);

    const ordersError = (file: string) =>
      `${file}: error: reads orders with a null schema in Sample Postgres, which has schemas; name the table's schema`;

    it("reports an error on a Card on an engine with schemas, whatever the default schema, and not on a transform or an unqualified SQL name", async () => {
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(await nullSchemaFindings()).toEqual([ordersError(CARD)]);
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "redshift" },
        defaultSchemas: { [POSTGRES_DB]: "other" },
      });
      expect(await nullSchemaFindings()).toEqual([ordersError(CARD)]);
    });

    it("gives no finding on a database whose default schema is given as null, which says it has no schemas", async () => {
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: null },
      });
      expect(await nullSchemaFindings()).toEqual([]);
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(
        (
          await lint({
            folder: workdir,
            defaultSchemas: { [POSTGRES_DB]: null },
          })
        ).findings.filter((f) => f.rule === "null-schema-reference"),
      ).toEqual([]);
    });

    it("takes neither the engine nor the default schema from a Database file", async () => {
      rmSync(join(workdir, SQL));
      writeSettingsFile({ engines: { [POSTGRES_DB]: "postgres" } });
      writeDatabase({ engine: "mysql", default_schema: null });
      expect(await nullSchemaFindings()).toEqual([ordersError(CARD)]);
    });

    it("reports an error on a Card on an engine with schemas when no default schema is given", async () => {
      rmSync(join(workdir, SQL));
      writeSettingsFile({ engines: { [POSTGRES_DB]: "postgres" } });
      expect(await nullSchemaFindings()).toEqual([ordersError(CARD)]);
    });

    it("gives no finding on an engine without schemas, or one whose schemas depend on the connection", async () => {
      for (const engine of ["mysql", "athena"]) {
        writeSettingsFile({
          engines: { [POSTGRES_DB]: engine },
          defaultSchemas: { [POSTGRES_DB]: "public" },
        });
        expect(await nullSchemaFindings()).toEqual([]);
      }
    });

    it("gives no finding when the engine is unknown, even with a default schema", async () => {
      writeSettingsFile({ defaultSchemas: { [POSTGRES_DB]: "public" } });
      expect(await nullSchemaFindings()).toEqual([]);
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "no-such-driver" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(await nullSchemaFindings()).toEqual([]);
    });

    it("gives no finding on a Card that reads a table a transform's target with no schema names", async () => {
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      const transform = join(workdir, SQL);
      writeFileSync(
        transform,
        readFileSync(transform, "utf8").replace(
          "  schema: transforms\n  name: product_revenue_report\n",
          "  name: orders\n",
        ),
      );
      expect(await nullSchemaFindings()).toEqual([]);
    });

    it("reports a Card's null-schema reference though a Table file with no schema names the table", async () => {
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      rmSync(join(workdir, "collections/transforms"), { recursive: true });
      rmSync(join(workdir, CARD));
      const card = "collections/main/card.yaml";
      mkdirSync(join(workdir, "collections/main"), { recursive: true });
      writeFileSync(
        join(workdir, card),
        yaml.dump({
          name: "Card",
          entity_id: "TableFileCard00000001",
          type: "question",
          display: "table",
          dataset_query: {
            "lib/type": "mbql/query",
            database: POSTGRES_DB,
            stages: [
              {
                "lib/type": "mbql.stage/mbql",
                "source-table": [POSTGRES_DB, null, "orders"],
              },
            ],
          },
          "serdes/meta": [{ model: "Card" }],
        }),
      );
      const dir = join(workdir, "databases/sample_postgres/tables/orders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "orders.yaml"),
        yaml.dump({
          name: "orders",
          db_id: POSTGRES_DB,
          schema: null,
          "serdes/meta": [{ model: "Table" }],
        }),
      );
      expect(await nullSchemaFindings()).toEqual([ordersError(card)]);
    });

    // A transform runs with no user bound, so Metabase's inactive-table guard
    // does not run, and the query reads the table of that name in the default
    // schema. Template tags are written without their schema too. Neither gives
    // a finding: the lint does not predict which table such a run reads.
    describe("a transform's reference or a template tag with a null schema", () => {
      const TRANSFORM = "collections/transforms/tagged.yaml";
      const TAGGED_CARD = "collections/main/tagged.yaml";
      const KINDS: [string, Record<string, unknown>][] = [
        [
          "a dimension tag with no default",
          { type: "dimension", "widget-type": "number/=" },
        ],
        [
          "a dimension tag with a default",
          { type: "dimension", "widget-type": "number/=", default: [1] },
        ],
        ["a temporal-unit tag", { type: "temporal-unit" }],
        ["a table tag", { type: "table" }],
      ];

      const stage = (tag: Record<string, unknown>) => {
        const isTable = tag.type === "table";
        return {
          "lib/type": "mbql.stage/native",
          native: isTable
            ? "SELECT count(*) AS n FROM {{p}}"
            : "SELECT id FROM public.items WHERE {{p}}",
          "template-tags": [
            {
              name: "p",
              id: "bb000001-0000-0000-0000-000000000001",
              "display-name": "p",
              ...(isTable
                ? { "table-id": [POSTGRES_DB, null, "orders"] }
                : {
                    dimension: [
                      "field",
                      {},
                      [POSTGRES_DB, null, "orders", "id"],
                    ],
                  }),
              ...tag,
            },
          ],
        };
      };
      const query = (tag: Record<string, unknown>) => ({
        "lib/type": "mbql/query",
        database: POSTGRES_DB,
        stages: [stage(tag)],
      });
      const writeTagged = (owner: string, tag: Record<string, unknown>) => {
        mkdirSync(join(workdir, dirname(owner)), { recursive: true });
        writeFileSync(
          join(workdir, owner),
          yaml.dump(
            owner === TRANSFORM
              ? {
                  name: "Tagged",
                  entity_id: "TaggedTransform000001",
                  creator_id: "admin@example.com",
                  source_database_id: POSTGRES_DB,
                  source: { type: "query", query: query(tag) },
                  target: {
                    database: POSTGRES_DB,
                    type: "table",
                    schema: "transforms",
                    name: "tagged",
                  },
                  "serdes/meta": [{ model: "Transform" }],
                }
              : {
                  name: "Tagged",
                  entity_id: "TaggedCard00000000001",
                  type: "question",
                  display: "table",
                  dataset_query: query(tag),
                  "serdes/meta": [{ model: "Card" }],
                },
          ),
        );
      };
      // A transform that writes orders in the schema other, so that the
      // folder names orders only outside the default schema public.
      const writeOtherOrders = () =>
        writeFileSync(
          join(workdir, "collections/transforms/other_orders.yaml"),
          yaml.dump({
            name: "Other orders",
            entity_id: "OtherOrdersTransform1",
            creator_id: "admin@example.com",
            source_database_id: POSTGRES_DB,
            source: {
              type: "query",
              query: {
                "lib/type": "mbql/query",
                database: POSTGRES_DB,
                stages: [
                  { "lib/type": "mbql.stage/native", native: "SELECT 1 AS n" },
                ],
              },
            },
            target: {
              database: POSTGRES_DB,
              type: "table",
              schema: "other",
              name: "orders",
            },
            "serdes/meta": [{ model: "Transform" }],
          }),
        );
      const messages = async () =>
        (await lint({ folder: workdir })).findings
          .filter((f) => f.rule.startsWith("null-schema-"))
          .map((f) => `${f.file}: ${f.severity} ${f.rule}: ${f.message}`);

      beforeEach(() => {
        rmSync(join(workdir, SQL));
        rmSync(join(workdir, CARD));
        writeOtherOrders();
        writeSettingsFile({
          engines: { [POSTGRES_DB]: "postgres" },
          defaultSchemas: { [POSTGRES_DB]: "public" },
        });
      });

      it("gives no finding on a transform's MBQL reference, with or without the default schema", async () => {
        expect(await messages()).toEqual([]);
        writeSettingsFile({ engines: { [POSTGRES_DB]: "postgres" } });
        expect(await messages()).toEqual([]);
      });

      for (const owner of [TRANSFORM, TAGGED_CARD]) {
        it.each(KINDS)(
          `gives no finding on %s in ${owner.includes("transforms") ? "a transform" : "a card"}, with or without the default schema`,
          async (_, tag) => {
            rmSync(join(workdir, MBQL_TRANSFORM));
            writeTagged(owner, tag);
            expect(await messages()).toEqual([]);
            writeSettingsFile({ engines: { [POSTGRES_DB]: "postgres" } });
            expect(await messages()).toEqual([]);
          },
        );
      }
    });

    it("reports a Card whose query names a table with a null schema, as a field's table too", async () => {
      writeSettingsFile({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      rmSync(join(workdir, "collections/transforms"), { recursive: true });
      rmSync(join(workdir, CARD));
      const card = (file: string, stage: Record<string, unknown>) => {
        mkdirSync(join(workdir, "collections/main"), { recursive: true });
        writeFileSync(
          join(workdir, "collections/main", file),
          yaml.dump({
            name: file,
            entity_id: `${file.slice(0, 1).toUpperCase()}`.padEnd(21, "0"),
            type: "question",
            display: "table",
            dataset_query: {
              "lib/type": "mbql/query",
              database: POSTGRES_DB,
              stages: [{ "lib/type": "mbql.stage/mbql", ...stage }],
            },
            "serdes/meta": [{ model: "Card" }],
          }),
        );
      };
      card("a.yaml", { "source-table": [POSTGRES_DB, null, "orders"] });
      card("b.yaml", {
        "source-table": [POSTGRES_DB, "public", "people"],
        fields: [["field", {}, [POSTGRES_DB, null, "orders", "id"]]],
      });
      card("c.yaml", { "source-table": [POSTGRES_DB, "public", "orders"] });
      expect(await nullSchemaFindings()).toEqual([
        ordersError("collections/main/a.yaml"),
        ordersError("collections/main/b.yaml"),
      ]);
    });
  });

  // Metabase keeps a transform's source_database_id when its query changes, so
  // the two can name different databases. A test runs on the query's database.
  describe("with a source_database_id other than the query's database", () => {
    let workdir: string;

    const TEST =
      "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml";

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-querydb-"));
      for (const file of [MBQL_TRANSFORM, TEST]) {
        mkdirSync(join(workdir, file, ".."), { recursive: true });
        cpSync(join(EXAMPLES, file), join(workdir, file));
      }
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    // The query reads Sample Postgres; source_database_id names another.
    const setUp = (
      sourceDatabaseId: string,
      settings: {
        engines: Record<string, string>;
        defaultSchemas: Record<string, string>;
      },
      expectationSql: readonly string[],
    ) => {
      writeFileSync(join(workdir, CONFIG_FILE), JSON.stringify(settings));
      edit(workdir, MBQL_TRANSFORM, (doc) => {
        doc.source_database_id = sourceDatabaseId;
      });
      edit(workdir, TEST, (doc) => {
        doc.expectations = expectationSql.map((sql, i) => ({
          type: "empty",
          name: `expectation ${i + 1}`,
          sql,
        }));
      });
    };

    const messages = async () =>
      (await lint({ folder: workdir })).findings.map(
        (f) => `${f.rule}: ${f.message}`,
      );

    it("needs the default schema of the query's database, not of source_database_id, for an expectation's unqualified read", async () => {
      setUp(
        "Warehouse",
        {
          engines: { [POSTGRES_DB]: "postgres", Warehouse: "postgres" },
          defaultSchemas: { [POSTGRES_DB]: "transforms" },
        },
        ["SELECT * FROM monthly_order_summary WHERE sum < 0"],
      );
      expect(await messages()).toEqual([]);
    });

    it("needs a default schema when the only unqualified name is a test's input or an expectation's read", async () => {
      const settings = {
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: {},
      };
      // Each database whose default schema is unknown, with the files that
      // need it.
      const stops = async () =>
        (await lint({ folder: workdir })).findings
          .filter((f) => f.rule === "missing-default-schema")
          .map((f) => `${POSTGRES_DB}: ${[f.file, ...f.related].join(", ")}`);
      setUp(POSTGRES_DB, settings, [
        "SELECT * FROM transforms.monthly_order_summary WHERE sum < 0",
      ]);
      expect(await stops()).toEqual([]);
      edit(workdir, TEST, (doc) => {
        const [orders]: unknown[] = Array.isArray(doc.inputs) ? doc.inputs : [];
        if (!isRecord(orders) || !isRecord(orders.table)) {
          throw new Error(`${TEST} has no input table`);
        }
        doc.inputs = [{ ...orders, table: { name: "orders" } }];
      });
      expect(await stops()).toEqual([`${POSTGRES_DB}: ${TEST}`]);
      setUp(POSTGRES_DB, settings, [
        "SELECT * FROM monthly_order_summary WHERE sum < 0",
      ]);
      edit(workdir, TEST, (doc) => {
        const [orders]: unknown[] = Array.isArray(doc.inputs) ? doc.inputs : [];
        if (isRecord(orders)) {
          doc.inputs = [
            { ...orders, table: { schema: "public", name: "orders" } },
          ];
        }
      });
      expect(await stops()).toEqual([`${POSTGRES_DB}: ${TEST}`]);
    });

    it("reads a test's SQL when source_database_id names a MongoDB database and the query a Postgres one", async () => {
      setUp(
        "Docs",
        {
          engines: { [POSTGRES_DB]: "postgres", Docs: "mongo" },
          defaultSchemas: { [POSTGRES_DB]: "public" },
        },
        ["SELECT * FROM people"],
      );
      expect(await messages()).toEqual([
        "expectation-reads-other-table: expectation expectation 1 reads people, which is neither the transform's target nor an input of this test",
      ]);
    });

    it("reads a test's SQL in the dialect, and its inputs with the default schema, of the query's database", async () => {
      // MySQL reads backquoted names, which Postgres cannot parse. MySQL has no
      // schemas, so the input public.orders is another table than orders.
      setUp(
        "Warehouse",
        {
          engines: { [POSTGRES_DB]: "mysql", Warehouse: "postgres" },
          defaultSchemas: { Warehouse: "public" },
        },
        ["SELECT * FROM `transforms`.`monthly_order_summary` WHERE sum < 0"],
      );
      nullSchemaReferences(workdir);
      edit(workdir, TEST, (doc) => {
        const [orders]: unknown[] = Array.isArray(doc.inputs) ? doc.inputs : [];
        if (!isRecord(orders) || !isRecord(orders.table)) {
          throw new Error(`${TEST} has no input table`);
        }
        doc.inputs = [{ ...orders, table: { name: "orders" } }, orders];
      });
      expect(await messages()).toEqual([
        "unused-input: input public.orders is not read by transform Monthly Order Summary",
      ]);
    });
  });
});

describe("the tables a transform test's expectations read", () => {
  const H2_DB = "Legacy";
  const DAILY_ORDER_SUMMARY = "collections/transforms/daily_order_summary.yaml";
  const DAILY_ORDER_SUMMARY_TEST =
    "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-lint-stand-ins-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const writeYaml = (file: string, doc: Record<string, unknown>) =>
    write(workdir, file, doc);

  const editYaml = (
    file: string,
    change: (doc: Record<string, unknown>) => void,
  ) => edit(workdir, file, change);

  const otherTableReads = async () =>
    (await lint({ folder: workdir })).findings.filter(
      (f) => f.rule === "expectation-reads-other-table",
    );

  it("an unqualified read of an input in the default schema written in another case reads no other table", async () => {
    cpSync(EXAMPLES, workdir, { recursive: true });
    // H2's default schema, PUBLIC, is upper case.
    writeSettings(workdir, {
      defaultSchemas: { [H2_DB]: "PUBLIC" },
      engines: { [H2_DB]: "h2" },
    });
    editYaml(DAILY_ORDER_SUMMARY, (doc) => {
      doc.source_database_id = H2_DB;
      mapAt(doc, "source", "query").database = H2_DB;
      mapAt(doc, "target").database = H2_DB;
    });
    const readOrdersUnqualified = (inputSchema: string) =>
      editYaml(DAILY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "inputs", 0, "table").schema = inputSchema;
        doc.expectations = [
          {
            type: "empty",
            name: "orders read",
            sql: "SELECT * FROM orders WHERE total < 0",
          },
        ];
      });
    readOrdersUnqualified("PUBLIC");
    expect(await otherTableReads()).toEqual([]);
    readOrdersUnqualified("public");
    expect(await otherTableReads()).toEqual([]);
  });

  it("an expectation that reads the target of a test with ten inputs reads no other table", async () => {
    const tables = Array.from({ length: 10 }, (_, i) => `t${i}`);
    writeFileSync(
      join(workdir, CONFIG_FILE),
      JSON.stringify({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      }),
    );
    writeYaml("collections/transforms/wide.yaml", {
      name: "Wide",
      entity_id: "WideTransform00000001",
      creator_id: "admin@example.com",
      source_database_id: POSTGRES_DB,
      source: {
        type: "query",
        query: {
          "lib/type": "mbql/query",
          database: POSTGRES_DB,
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: `SELECT t0.id FROM ${tables.join(", ")}`,
            },
          ],
        },
      },
      target: {
        database: POSTGRES_DB,
        type: "table",
        schema: "transforms",
        name: "wide",
      },
      "serdes/meta": [{ model: "Transform" }],
    });
    writeYaml("collections/transforms/wide/wide__ten_inputs.yaml", {
      name: "Wide: ten inputs",
      entity_id: "WideTransformTest0001",
      transform_id: "WideTransform00000001",
      creator_id: "admin@example.com",
      inputs: tables.map((name) => ({
        table: { schema: "public", name },
        format: "rows",
        columns: [{ name: "id", cast_type: "INTEGER" }],
        rows: [{ id: 1 }],
      })),
      expectations: [
        {
          type: "empty",
          name: "no negative id",
          sql: "SELECT * FROM transforms.wide WHERE id < 0",
        },
        {
          type: "empty",
          name: "no input id of zero",
          sql: "SELECT * FROM t9 WHERE id = 0",
        },
      ],
      "serdes/meta": [{ model: "TransformTest" }],
    });
    expect((await lint({ folder: workdir })).findings).toEqual([]);
  });
});
