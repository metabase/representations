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
import * as fs from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { MissingDefaultSchemasError } from "./default-schemas.js";
import { LINT_RULE_SEVERITY, LINT_RULES } from "./experimental.js";
import type { LintFinding } from "./findings.js";
import { lint, transformReads } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./test-support/lint-mutations.js";
import * as schemas from "./schemas.js";
import { CONFIG_FILE, LintSetupError } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";
import { isRecord } from "./values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");
const POSTGRES_DB = "Sample Postgres";
const MBQL_TRANSFORM = "collections/transforms/mbql_transform.yaml";

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
      const file = MBQL_TRANSFORM;
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      const transform: unknown = yaml.load(
        readFileSync(join(EXAMPLES, file), "utf8"),
      );
      if (
        !isRecord(transform) ||
        !isRecord(transform.source) ||
        !isRecord(transform.source.query) ||
        !Array.isArray(transform.source.query.stages) ||
        !isRecord(transform.source.query.stages[0])
      ) {
        throw new Error(`${file} has no query stage`);
      }
      const ordersField = (column: string) => [
        "field",
        {},
        [POSTGRES_DB, "public", "orders", column],
      ];
      transform.source.query.stages[0].joins = [
        {
          alias: "Products",
          database: "Docs",
          stages: [
            {
              "lib/type": "mbql.stage/native",
              native: "SELECT * FROM products",
            },
          ],
          conditions: [["=", {}, ordersField("product_id"), ordersField("id")]],
        },
      ];
      writeFileSync(join(workdir, file), yaml.dump(transform));
      writeFileSync(
        join(workdir, CONFIG_FILE),
        JSON.stringify({
          engines: { [POSTGRES_DB]: "postgres", Docs: "mongo" },
          defaultSchemas: { [POSTGRES_DB]: "public" },
        }),
      );
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

    it.each(MUTATIONS.map((m) => [m.name, m.rules]))(
      "reports %s as %p",
      async (name, expected) => {
        mutateExamples(name, workdir);
        expect(rules(await findings(workdir))).toEqual([...expected].sort());
      },
    );

    it("breaks a different test with each rule of refused-tests", async () => {
      const mutation = mutateExamples("refused-tests", workdir);
      const errors = (await findings(workdir)).filter(
        (f) => f.severity === "error",
      );
      expect(errors.map((f): string => f.rule).sort()).toEqual(
        [...mutation.rules].sort(),
      );
      expect(new Set(errors.map((f) => f.entity.entity_id)).size).toBe(
        mutation.rules.length,
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
      const transform = join(workdir, MBQL_TRANSFORM);
      const doc: unknown = yaml.load(readFileSync(transform, "utf8"));
      if (!isRecord(doc) || !isRecord(doc.source)) {
        throw new Error(`${transform} has no source`);
      }
      // The Orders model card reads ORDERS on the Sample Database, which has
      // no schemas.
      doc.source.query = {
        "lib/type": "mbql/query",
        database: "Sample Database",
        stages: [
          {
            "lib/type": "mbql.stage/mbql",
            "source-card": "4eroqa4ZYl4WkNjP8XTvu",
            aggregation: [["count", {}]],
          },
        ],
      };
      writeFileSync(transform, yaml.dump(doc));
      const test = join(
        workdir,
        "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml",
      );
      const text = readFileSync(test, "utf8");
      const input = "    schema: public\n    name: orders\n";
      expect(text).toContain(input);
      const giveInput = (table: string) =>
        writeFileSync(test, text.replace(input, `    name: ${table}\n`));
      giveInput("ORDERS");
      expect(await findings(workdir)).toEqual([]);
      giveInput("PRODUCTS");
      expect(
        (await findings(workdir))
          .filter((f) => f.rule === "missing-input")
          .map((f) => f.message),
      ).toEqual([
        "no input for ORDERS (no schema), which transform Monthly Order Summary reads",
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

    it("takes an MBQL reference with no schema as the table with no schema, and an unqualified SQL name as the default schema's", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      nullSchemaReferences(workdir);
      // Both tests give the input public.orders.
      const file = join(
        workdir,
        "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml",
      );
      const doc: unknown = yaml.load(readFileSync(file, "utf8"));
      if (!isRecord(doc) || !Array.isArray(doc.inputs)) {
        throw new Error(`${file} has no inputs`);
      }
      const [orders]: unknown[] = doc.inputs;
      if (!isRecord(orders) || !isRecord(orders.table)) {
        throw new Error(`${file} has no input table`);
      }
      orders.table.schema = "public";
      writeFileSync(file, yaml.dump(doc));
      const messages = (
        await lint({
          folder: workdir,
          defaultSchemas: { [POSTGRES_DB]: "public" },
        })
      ).findings
        .filter((f) => f.rule === "missing-input" || f.rule === "unused-input")
        .map((f) => `${f.rule}: ${f.message}`);
      expect(messages).toEqual([
        "missing-input: no input for orders (no schema), which transform Monthly Order Summary reads",
        "unused-input: input public.orders is not read by transform Monthly Order Summary",
      ]);
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
                database_id: POSTGRES_DB,
                table_id: [POSTGRES_DB, "public", "people"],
              },
              {
                alias: "orders",
                database_id: POSTGRES_DB,
                table: "orders",
              },
            ],
          },
        }),
      );
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
      const doc: unknown = yaml.load(
        readFileSync(join(EXAMPLES, original), "utf8"),
      );
      if (!isRecord(doc)) {
        throw new Error(`${original} is not a YAML map`);
      }
      writeFileSync(
        join(workdir, copy),
        yaml.dump({ ...doc, entity_id: "PythonHelloWorldCopy1" }),
      );
      expect(
        (await findings(workdir)).map((f) => `${f.rule} ${f.file}`),
      ).toEqual([`missing-target-database ${original}`]);
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
        sql: "SELECT 1 AS id",
      });
      writeFileSync(file, yaml.dump(doc));
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

    it("reports a file of a model Metabase does not import as a schema error", async () => {
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
        `schema ${file} null: the file names the model "Widget", which Metabase does not import`,
      ]);
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
      ).toEqual([
        `schema: ${file}: Database does not match its schema: /engine must be string`,
      ]);
    });

    it("names the path and the reason of a schema mismatch, not the condition around it", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const file = "collections/transforms/python_hello_world.yaml";
      const path = join(workdir, file);
      const doc: unknown = yaml.load(readFileSync(path, "utf8"));
      if (!isRecord(doc) || !isRecord(doc.source)) {
        throw new Error(`${file} is not a transform`);
      }
      const { body: _, ...source } = doc.source;
      writeFileSync(path, yaml.dump({ ...doc, source }));
      expect(
        (await findings(workdir)).map((f) => `${f.rule}: ${f.message}`),
      ).toEqual([
        "schema: Transform does not match its schema: /source must have required property 'body'",
      ]);
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
            "    total: 20.0\n",
            `    total: 20.0\n    ${key}\n`,
          ),
        );
        expect(
          (await findings(workdir)).map(
            (f) => `${f.file}: ${f.rule}: ${f.message}`,
          ),
        ).toEqual([
          `${file}: row-columns-mismatch: input orders, row 3: every row must carry exactly the declared columns; ${key.startsWith("'") ? 'not declared: "1"; ' : ""}keys that are not strings: ${written}`,
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
            "source-tables": [{ alias: "orders", database_id: POSTGRES_DB }],
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
        "JOIN people u ON u.id = o.user_id",
      );
      snippet(
        "old_name.yaml",
        "OldNameSnippet0000001",
        "Old Name",
        "JOIN reviews r ON r.product_id = p.id",
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
        "orders",
        "people",
        "products",
      ]);
    });

    it.each([
      [
        "no name",
        { content: "WHERE 1 = 1" },
        "undefined",
        "snippet undefined is not in the folder",
        "/ must have required property 'name'",
      ],
      [
        "no content",
        { name: "Broken" },
        "Broken",
        "snippet Broken is in collections/snippets/broken.yaml, which fails its schema",
        "/ must have required property 'content'",
      ],
    ])(
      "reports a snippet file with %s, and does not use it",
      async (_, fields, usedName, reason, schemaError) => {
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
          `${snippetFile}: schema: NativeQuerySnippet does not match its schema: ${schemaError}`,
          `${transformFile}: reads-not-checked: could not find the tables this transform reads: ${reason}`,
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
        [
          "missing-input: no input for public.{{t}}, which transform Product Revenue Report reads",
        ],
      ],
    ])(
      "reports %s after a schema as a missing input, named as written",
      async (_, tag, expected) => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file = join(
          workdir,
          "collections/transforms/native_transform.yaml",
        );
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
        if (typeof stage.native !== "string") {
          throw new Error(`${file} has no native SQL`);
        }
        expect(stage.native).toContain("FROM orders o");
        stage.native = stage.native.replace(
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
        writeFileSync(file, yaml.dump(doc));
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
      const testFile = join(workdir, files[2]);
      const test: unknown = yaml.load(readFileSync(testFile, "utf8"));
      if (!isRecord(test)) {
        throw new Error("The example test is not a map");
      }
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
      writeFileSync(testFile, yaml.dump(test));
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

    // Replaces the Database file of the database the transforms run on.
    const DATABASE_FILE = "databases/sample_postgres/sample_postgres.yaml";

    const writeDatabase = (
      engine: string,
      fields: Record<string, unknown> = {},
    ) =>
      writeFileSync(
        join(workdir, DATABASE_FILE),
        yaml.dump({
          name: POSTGRES_DB,
          engine,
          ...fields,
          "serdes/meta": [{ model: "Database" }],
        }),
      );

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
      ).toEqual([POSTGRES_DB]);
      expect(String(error)).toContain(CONFIG_FILE);
      // The library has no command-line options to name.
      expect(String(error)).not.toContain("--default-schema");
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
      rmSync(join(workdir, CONFIG_FILE));
      writeDatabase("sqlite");
      expect(await inputRules()).toEqual(["missing-input", "unused-input"]);
      // MongoDB's native queries are not SQL, so the native transforms are unread
      // and give no input finding. The tests' unqualified inputs still need
      // the default schema, which the engine gives.
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
      rmSync(join(workdir, DATABASE_FILE));
      writeConfig('{"engines": {"Sample Postgres": "mysql"}}');
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
      writeConfig('{"defaultSchemas": {"Sample Postgres": "public"}}');
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

  // Two qualified names compare the same whatever the default schema, except
  // where a transform test's rewrite falls back to a table's unqualified key.
  describe("with one table name in two schemas", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-two-"));
      writeTransform("a_copy", "SELECT id FROM a.account");
      writeTransform("b_copy", "SELECT id FROM b.account");
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const DATABASE = "Warehouse";

    function writeTransform(name: string, sql: string): void {
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
              stages: [{ "lib/type": "mbql.stage/native", native: sql }],
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

    // The rules of the findings, or, when the lint stops for default
    // schemas, each database it names and why.
    const outcome = async (): Promise<
      { rules: string[] } | { stops: string[] }
    > => {
      try {
        return { rules: rules((await lint({ folder: workdir })).findings) };
      } catch (e) {
        if (e instanceof MissingDefaultSchemasError) {
          return {
            stops: e.databases.map((d) => `${d.database}: ${d.reason}`),
          };
        }
        throw e;
      }
    };

    const stop = {
      stops: [
        `${DATABASE}: names account in schemas a and b in one transform test, which only the default schema tells apart`,
      ],
    };

    it("lints when no transform test compares the two", async () => {
      expect(await outcome()).toEqual({ rules: [] });
    });

    it("lints when each test's tables name the table in one schema", async () => {
      writeTest("a_copy", "a.account", "SELECT * FROM a.account WHERE id < 0");
      writeTest("b_copy", "b.account", "SELECT * FROM out.b_copy WHERE id < 0");
      expect(await outcome()).toEqual({ rules: [] });
    });

    it("stops when a test's input and expectation name the table in two schemas", async () => {
      writeTest("a_copy", "a.account", "SELECT * FROM b.account WHERE id < 0");
      expect(await outcome()).toEqual(stop);
    });

    it("stops when a test's input and its transform's SQL name the table in two schemas", async () => {
      writeTransform(
        "a_copy",
        "SELECT x.id FROM a.account x JOIN b.account y ON x.id = y.id",
      );
      writeTest("a_copy", "a.account", "SELECT * FROM out.a_copy WHERE id < 0");
      expect(await outcome()).toEqual(stop);
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

    it("accepts a qualified read of an unqualified input, whatever the default schema", async () => {
      readOrders("public.orders");
      expect(await expectationRules()).toEqual([]);
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([]);
    });

    it("accepts a read in another schema of an input in the default schema only", async () => {
      readOrders("OTHER.orders", "public");
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER2")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("refuses an unqualified read of an input outside the default schema", async () => {
      readOrders("orders", "public");
      expect(await expectationRules("public")).toEqual([]);
      expect(await expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("matches a quoted name only in its own case, as Metabase's rewrite does", async () => {
      readOrders('"Orders"');
      expect(await expectationRules()).toEqual([
        "expectation-reads-other-table",
      ]);
      readOrders('"orders"');
      expect(await expectationRules()).toEqual([]);
      readOrders("Orders");
      expect(await expectationRules()).toEqual([]);
    });

    it("refuses the quoted mixed-case name of the transform's target", async () => {
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
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.file}: ${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        `${test}: expectation-reads-other-table: expectation one row per category reads Transforms.Product_Revenue_Report, which is neither the transform's target nor an input of this test`,
      ]);
    });

    it("reads an expectation's SQL as written, as Metabase runs it: a template tag does not parse", async () => {
      readOrders("{{orders}}");
      expect(
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        expect.stringMatching(
          /^reads-not-checked: could not find the tables expectation orders read reads: SQLGlot could not parse it: ParseError:/,
        ),
      ]);
    });

    it("refuses a read of a table that is neither input nor target", async () => {
      readOrders("people");
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
      // Postgres has schemas, so a target with none is also an error.
      expect(await rulesWithDefault("transforms")).toEqual([
        "duplicate-target",
        "missing-target-schema",
      ]);
      expect(await rulesWithDefault("public")).toEqual([
        "missing-target-schema",
      ]);
    });

    it("counts a table file as the table read unqualified only in the default schema, and never as an MBQL reference with no schema", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      nullSchemaReferences(workdir);
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
      const sqlRead = "collections/transforms/daily_order_summary.yaml";
      const mbqlRead = MBQL_TRANSFORM;
      const ordersUnknown = async (schema: string) =>
        (
          await lint({
            folder: workdir,
            defaultSchemas: { [POSTGRES_DB]: schema },
          })
        ).findings
          .filter(
            (f) =>
              f.rule === "unknown-table" &&
              f.message.startsWith("table orders ") &&
              (f.file === sqlRead || f.file === mbqlRead),
          )
          .map((f) => `${f.file}: ${f.message}`);
      const sqlUnknown = `${sqlRead}: table orders is defined by no table file or transform target`;
      const mbqlUnknown = `${mbqlRead}: table orders (no schema) is defined by no table file or transform target`;
      expect(await ordersUnknown("public")).toEqual([mbqlUnknown]);
      expect(await ordersUnknown("OTHER")).toEqual([sqlUnknown, mbqlUnknown]);
    });

    it("reads a table file and a transform by their model, wherever they sit under an imported folder", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const transform = "snippets/elsewhere/daily_order_summary.yaml";
      mkdirSync(join(workdir, "snippets/elsewhere"), { recursive: true });
      fs.renameSync(
        join(workdir, "collections/transforms/daily_order_summary.yaml"),
        join(workdir, transform),
      );
      mkdirSync(join(workdir, "collections/odd"), { recursive: true });
      writeFileSync(
        join(workdir, "collections/odd/orders.yaml"),
        yaml.dump({
          name: "orders",
          db_id: POSTGRES_DB,
          schema: "public",
          "serdes/meta": [{ model: "Table" }],
        }),
      );
      const ordersFindings = async (schema: string) =>
        (
          await lint({
            folder: workdir,
            defaultSchemas: { [POSTGRES_DB]: schema },
          })
        ).findings
          .filter(
            (f) =>
              f.file === "collections/odd/orders.yaml" ||
              (f.file === transform && f.message.includes("table orders ")),
          )
          .map((f) => `${f.file}: ${f.rule}: ${f.message}`);
      expect(await ordersFindings("public")).toEqual([]);
      expect(await ordersFindings("OTHER")).toEqual([
        `${transform}: unknown-table: table orders is defined by no table file or transform target`,
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

    const withStage = (stage: Record<string, unknown>) => {
      const path = join(workdir, TRANSFORM);
      const doc: unknown = yaml.load(readFileSync(path, "utf8"));
      if (
        !isRecord(doc) ||
        !isRecord(doc.source) ||
        !isRecord(doc.source.query)
      ) {
        throw new Error(`${TRANSFORM} has no query`);
      }
      doc.source.query.stages = [stage];
      writeFileSync(path, yaml.dump(doc));
    };

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

  // Metabase's import looks a table up by exact name (`table-id-by-name`), and
  // creates an inactive table on a miss; the transform-test validator and a
  // warehouse reading unquoted SQL compare ignoring case.
  describe("with table names that differ only in case", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-case-"));
      const database = "databases/sample_postgres/sample_postgres.yaml";
      mkdirSync(join(workdir, "databases/sample_postgres"), {
        recursive: true,
      });
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      cpSync(join(EXAMPLES, database), join(workdir, database));
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
    const writeTableFile = (name: string) => {
      const dir = join(workdir, "databases/sample_postgres/tables", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${name}.yaml`),
        yaml.dump({
          name,
          db_id: POSTGRES_DB,
          schema: "public",
          "serdes/meta": [{ model: "Table" }],
        }),
      );
    };
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

    it("counts a table file as an MBQL reference's table only in the same case, and as a SQL read's in any case", async () => {
      writeTableFile("products");
      writeTransform(
        "a.yaml",
        "CaseTransformA0000001",
        mbqlRead("Products"),
        "a",
      );
      const messages = async () =>
        (await lint({ folder: workdir })).findings.map(
          (f) => `${f.rule}: ${f.message}`,
        );
      expect(await messages()).toEqual([
        "unknown-table: table public.Products is defined by no table file or transform target",
      ]);
      writeTransform(
        "a.yaml",
        "CaseTransformA0000001",
        mbqlRead("products"),
        "a",
      );
      expect(await messages()).toEqual([]);
      writeTransform(
        "a.yaml",
        "CaseTransformA0000001",
        sqlRead("Products"),
        "a",
      );
      expect(await messages()).toEqual([]);
    });

    it("counts a transform target as an MBQL reference's table only in the same case", async () => {
      writeTableFile("products");
      writeTransform(
        "a.yaml",
        "CaseTransformA0000001",
        mbqlRead("products"),
        "Made",
      );
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("made"), "b");
      expect(await lintRules()).toEqual(["unknown-table"]);
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("Made"), "b");
      expect(await lintRules()).toEqual([]);
    });

    it("finds a duplicate target only in the same case", async () => {
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("x"), "Out");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "out");
      expect(await lintRules()).toEqual([]);
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "Out");
      expect(await lintRules()).toEqual(["duplicate-target"]);
    });
  });

  // Metabase imports `[database, null, table]` as the table with no schema; on
  // a database whose default schema is not null, that table rarely exists.
  describe("with an MBQL reference with a null schema", () => {
    let workdir: string;

    const SQL = "collections/transforms/native_transform.yaml";

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-nullref-"));
      mkdirSync(join(workdir, "collections/transforms"), { recursive: true });
      for (const file of [MBQL_TRANSFORM, SQL]) {
        cpSync(join(EXAMPLES, file), join(workdir, file));
      }
      nullSchemaReferences(workdir);
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

    const nullSchemaFindings = async (
      defaultSchemas?: Record<string, string | null>,
    ) =>
      (await lint({ folder: workdir, defaultSchemas })).findings
        .filter((f) => f.rule === "null-schema-reference")
        .map((f) => `${f.file}: ${f.severity}: ${f.message}`);

    const ordersWarning = `${MBQL_TRANSFORM}: warning: reads orders (no schema) in database Sample Postgres, whose default schema is public: a null schema in a reference names a table with no schema, which such a database likely lacks`;

    it("warns when the default schema is public, and not on an unqualified SQL name", async () => {
      expect(await nullSchemaFindings({ [POSTGRES_DB]: "public" })).toEqual([
        ordersWarning,
      ]);
    });

    it("takes the default schema from a Database file", async () => {
      writeDatabase({ engine: "postgres", default_schema: "public" });
      expect(await nullSchemaFindings()).toEqual([ordersWarning]);
    });

    it("does not warn when the default schema is null, given or by the engine", async () => {
      expect(await nullSchemaFindings({ [POSTGRES_DB]: null })).toEqual([]);
      writeDatabase({ engine: "sqlite" });
      expect(await nullSchemaFindings()).toEqual([]);
    });

    it("does not warn on a table that a table file with no schema defines", async () => {
      const dir = join(workdir, "databases/sample_postgres/tables/orders");
      mkdirSync(dir, { recursive: true });
      const tableFile = (name: string) =>
        writeFileSync(
          join(dir, "orders.yaml"),
          yaml.dump({
            name,
            db_id: POSTGRES_DB,
            schema: null,
            "serdes/meta": [{ model: "Table" }],
          }),
        );
      tableFile("Orders");
      expect(await nullSchemaFindings({ [POSTGRES_DB]: "public" })).toEqual([
        ordersWarning,
      ]);
      tableFile("orders");
      expect(await nullSchemaFindings({ [POSTGRES_DB]: "public" })).toEqual([]);
    });

    it("does not warn when the default schema is unknown", async () => {
      rmSync(join(workdir, SQL));
      expect(await nullSchemaFindings()).toEqual([]);
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

    const edit = (
      file: string,
      change: (doc: Record<string, unknown>) => void,
    ) => {
      const path = join(workdir, file);
      const doc: unknown = yaml.load(readFileSync(path, "utf8"));
      if (!isRecord(doc)) {
        throw new Error(`${file} is not a YAML map`);
      }
      change(doc);
      writeFileSync(path, yaml.dump(doc));
    };

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
      edit(MBQL_TRANSFORM, (doc) => {
        doc.source_database_id = sourceDatabaseId;
      });
      edit(TEST, (doc) => {
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
      edit(TEST, (doc) => {
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
