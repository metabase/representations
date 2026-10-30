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
import { join, resolve } from "path";

import { LINT_RULE_SEVERITY, LINT_RULES } from "./experimental.js";
import type { LintFinding } from "./findings.js";
import { lint, transformReads } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./test-support/lint-mutations.js";
import * as schemas from "./schemas.js";
import { CONFIG_FILE } from "./settings.js";
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

    it("gives no finding for a table that no table file or transform target defines", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      // Remote sync writes a Table file only for some tables; a transform
      // may read any table of the warehouse.
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

    it("reports a file that is not valid UTF-8 as such", async () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const binary = "collections/transforms/binary.yaml";
      writeFileSync(
        join(workdir, binary),
        Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xc3, 0x28, 0x0a]),
      );
      expect(
        (await findings(workdir)).map((f) => `${f.file}: ${f.message}`),
      ).toEqual([`${binary}: the file is not valid UTF-8`]);
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
      const transform = join(workdir, MBQL_TRANSFORM);
      const doc: unknown = yaml.load(readFileSync(transform, "utf8"));
      if (
        !isRecord(doc) ||
        !isRecord(doc.source) ||
        !isRecord(doc.source.query) ||
        !Array.isArray(doc.source.query.stages) ||
        !isRecord(doc.source.query.stages[0])
      ) {
        throw new Error(`${MBQL_TRANSFORM} has no query stage`);
      }
      const ordersModelId = "4eroqa4ZYl4WkNjP8XTvu";
      doc.source.query.stages[0] = {
        "lib/type": "mbql.stage/mbql",
        "source-card": ordersModelId,
      };
      writeFileSync(transform, yaml.dump(doc));
      // Sorts before the orders model's file, and reads another table.
      writeFileSync(
        join(workdir, "collections/a_segment.yaml"),
        yaml.dump({
          name: "Decoy",
          entity_id: ordersModelId,
          creator_id: "admin@example.com",
          table_id: [POSTGRES_DB, "public", "products"],
          definition: {
            "lib/type": "mbql/query",
            database: POSTGRES_DB,
            stages: [
              {
                "lib/type": "mbql.stage/mbql",
                "source-table": [POSTGRES_DB, "public", "products"],
              },
            ],
          },
          "serdes/meta": [{ model: "Segment" }],
        }),
      );
      expect(
        (await transformReads({ folder: workdir })).find(
          (t) => t.file === MBQL_TRANSFORM,
        )?.tables,
      ).toEqual([{ schema: "PUBLIC", name: "ORDERS" }]);
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
      useCard(card, "      ", ["Sample Database", "PUBLIC", "ORDERS"]);
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

    it("finds a duplicate target in any case on Redshift, which folds every name", async () => {
      const database = join(
        workdir,
        "databases/sample_postgres/sample_postgres.yaml",
      );
      const text = readFileSync(database, "utf8");
      expect(text).toContain("engine: postgres\n");
      writeFileSync(
        database,
        text.replace("engine: postgres\n", "engine: redshift\n"),
      );
      writeTransform("a.yaml", "CaseTransformA0000001", mbqlRead("x"), "Out");
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "out");
      expect(await lintRules()).toEqual(["duplicate-target"]);
      writeTransform("b.yaml", "CaseTransformB0000001", mbqlRead("y"), "out2");
      expect(await lintRules()).toEqual([]);
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

    const writeSettings = (settings: Record<string, unknown>) =>
      writeFileSync(join(workdir, CONFIG_FILE), JSON.stringify(settings));

    const nullSchemaFindings = async () =>
      (await lint({ folder: workdir })).findings
        .filter((f) => f.rule === "null-schema-reference")
        .map((f) => `${f.file}: ${f.severity}: ${f.message}`);

    const ordersError = (file: string, engine: string) =>
      `${file}: error: reads orders (no schema) in database Sample Postgres, whose engine ${engine} has schemas: a null schema in a reference names a table with no schema, which Metabase does not find there, so every run fails. Name the table's schema`;

    it("reports an error on an engine with schemas, whatever the default schema, and not on an unqualified SQL name", async () => {
      writeSettings({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(await nullSchemaFindings()).toEqual([
        ordersError(MBQL_TRANSFORM, "postgres"),
      ]);
      writeSettings({
        engines: { [POSTGRES_DB]: "redshift" },
        defaultSchemas: { [POSTGRES_DB]: "other" },
      });
      expect(await nullSchemaFindings()).toEqual([
        ordersError(MBQL_TRANSFORM, "redshift"),
      ]);
    });

    it("gives no finding on a database whose default schema is given as null, which says it has no schemas", async () => {
      writeSettings({
        engines: { [POSTGRES_DB]: "postgres" },
        defaultSchemas: { [POSTGRES_DB]: null },
      });
      expect(await nullSchemaFindings()).toEqual([]);
      writeSettings({
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

    it("reports an error on an engine with schemas when no default schema is given", async () => {
      rmSync(join(workdir, SQL));
      writeSettings({ engines: { [POSTGRES_DB]: "postgres" } });
      expect(await nullSchemaFindings()).toEqual([
        ordersError(MBQL_TRANSFORM, "postgres"),
      ]);
    });

    it("takes the engine from a Database file", async () => {
      writeDatabase({ engine: "postgres", default_schema: "public" });
      expect(await nullSchemaFindings()).toEqual([
        ordersError(MBQL_TRANSFORM, "postgres"),
      ]);
    });

    it("gives no finding on an engine without schemas, or one whose schemas depend on the connection", async () => {
      for (const engine of ["mysql", "athena"]) {
        writeSettings({
          engines: { [POSTGRES_DB]: engine },
          defaultSchemas: { [POSTGRES_DB]: "public" },
        });
        expect(await nullSchemaFindings()).toEqual([]);
      }
    });

    it("gives no finding when the engine is unknown, even with a default schema", async () => {
      writeSettings({ defaultSchemas: { [POSTGRES_DB]: "public" } });
      expect(await nullSchemaFindings()).toEqual([]);
      writeSettings({
        engines: { [POSTGRES_DB]: "no-such-driver" },
        defaultSchemas: { [POSTGRES_DB]: "public" },
      });
      expect(await nullSchemaFindings()).toEqual([]);
    });

    it("gives no finding on a table that a table file with no schema defines", async () => {
      writeDatabase({ engine: "postgres", default_schema: "public" });
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
      expect(await nullSchemaFindings()).toEqual([
        ordersError(MBQL_TRANSFORM, "postgres"),
      ]);
      tableFile("orders");
      expect(await nullSchemaFindings()).toEqual([]);
    });

    it("reports a Card whose query names a table with a null schema, as a field's table too", async () => {
      writeDatabase({ engine: "postgres", default_schema: "public" });
      rmSync(join(workdir, "collections/transforms"), { recursive: true });
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
        ordersError("collections/main/a.yaml", "postgres"),
        ordersError("collections/main/b.yaml", "postgres"),
      ]);
    });
  });
});
