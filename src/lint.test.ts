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
import { CONFIG_FILE } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");
const POSTGRES_DB = "Sample Postgres";
const MBQL_TRANSFORM = "collections/transforms/mbql_transform.yaml";
const NATIVE_TRANSFORM = "collections/transforms/native_transform.yaml";

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
      const { findings } = await lint({ folder: workdir });
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
      expect(findings.map((f) => [f.rule, f.file])).toEqual([
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
});
