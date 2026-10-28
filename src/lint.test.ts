import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

import type { LintFinding } from "./findings.js";
import { LINT_RULE_SEVERITY, LINT_RULES } from "./index.js";
import { lint, transformReads } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./lint-mutations.js";
import { isRecord } from "./values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

function rules(findings: LintFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

describe("lint", () => {
  it("finds nothing in the bundled examples", () => {
    expect(lint({ folder: EXAMPLES }).findings).toEqual([]);
  });

  it("has a mutation that reports each error rule", () => {
    const mutated = new Set(MUTATIONS.flatMap((m) => m.rules));
    expect(
      LINT_RULES.filter(
        (rule) => LINT_RULE_SEVERITY[rule] === "error" && !mutated.has(rule),
      ),
    ).toEqual([]);
  });

  describe("with a mutated copy of the examples", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const findings = (folder: string): LintFinding[] =>
      lint({ folder }).findings;

    it.each(MUTATIONS.map((m) => [m.name, m.rules]))(
      "reports %s as %p",
      (name, expected) => {
        mutateExamples(name, workdir);
        expect(rules(findings(workdir))).toEqual([...expected].sort());
      },
    );

    it("reports each rule at the severity LINT_RULE_SEVERITY gives it", () => {
      const mismatched = MUTATIONS.flatMap((m) => {
        const folder = join(workdir, m.name);
        mutateExamples(m.name, folder);
        return findings(folder)
          .filter((f) => f.severity !== LINT_RULE_SEVERITY[f.rule])
          .map((f) => `${f.rule} as ${f.severity}`);
      });
      expect(mismatched).toEqual([]);
    });

    it("names the test and the missing transform for a dangling transform_id", () => {
      mutateExamples("dangling-transform-id", workdir);
      expect(findings(workdir)).toEqual([
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

    it("lists every transform in a cycle", () => {
      mutateExamples("transform-cycle", workdir);
      const [cycle] = findings(workdir);
      expect([cycle.file, ...cycle.related].sort()).toEqual([
        "collections/transforms/native_transform.yaml",
        "collections/transforms/top_categories.yaml",
      ]);
    });

    it("names the table an implicit join reads", () => {
      mutateExamples("implicit-join", workdir);
      expect(findings(workdir).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Monthly Order Summary reads",
      ]);
    });

    it("reports a table read both directly and through a segment once", () => {
      mutateExamples("implicit-join", workdir);
      MUTATIONS.find((m) => m.name === "segment-filter")?.apply(workdir);
      expect(findings(workdir).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Monthly Order Summary reads",
      ]);
    });

    it("matches a qualified input to an unqualified read in the default schema", () => {
      mutateExamples("qualified-input", workdir);
      expect(
        lint({
          folder: workdir,
          defaultSchemas: { "Sample Database": "PUBLIC" },
        }).findings,
      ).toEqual([]);
    });

    it("refuses a qualified input outside the default schema", () => {
      mutateExamples("qualified-input", workdir);
      const { findings } = lint({
        folder: workdir,
        defaultSchemas: { "Sample Database": "OTHER" },
      });
      expect(rules(findings)).toEqual(["missing-input", "unused-input"]);
    });

    it("reads a Python transform's source tables in both forms", () => {
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
      const python = transformReads({ folder: workdir }).find(
        (t) => t.name === "Python Hello World",
      );
      expect(python?.tables).toEqual([
        { schema: "PUBLIC", name: "PEOPLE" },
        { schema: null, name: "ORDERS" },
      ]);
    });

    it("reports an unqualified and a qualified input as duplicates only in the default schema", () => {
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
      const inputFindings = (schema?: string) =>
        lint({
          folder: workdir,
          defaultSchemas:
            schema === undefined ? {} : { "Sample Database": schema },
        })
          .findings.filter((f) => f.message.startsWith("inputs"))
          .map((f) => `${f.rule}: ${f.message}`);
      expect(inputFindings()).toEqual([
        "input-match-undecided: inputs PUBLIC.ORDERS and orders stand in for the same table only if PUBLIC is the default schema of Sample Database; set it with --default-schema",
      ]);
      expect(inputFindings("PUBLIC")).toEqual([
        "duplicate-input: inputs stand in for the same table: PUBLIC.ORDERS, orders",
      ]);
      expect(inputFindings("OTHER")).toEqual([]);
    });

    it("reports a file that is not a YAML map as a schema error", () => {
      cpSync(EXAMPLES, workdir, { recursive: true });
      const broken = "collections/transforms/broken.yaml";
      const list = "collections/transforms/list.yaml";
      writeFileSync(join(workdir, broken), "name: [unclosed\n");
      writeFileSync(join(workdir, list), "- a\n- b\n");
      expect(
        findings(workdir).map(({ rule, severity, file, entity }) => ({
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

    it("cannot read a Python source table with no name", () => {
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
      const python = transformReads({ folder: workdir }).find(
        (t) => t.name === "Python Hello World",
      );
      expect(python?.tables).toBeNull();
      expect(
        lint({ folder: workdir }).findings.map(
          (f) => `${f.rule}: ${f.message}`,
        ),
      ).toEqual([
        "reads-not-checked: could not find the tables this transform reads: source table orders names no table",
      ]);
    });

    it("pastes a snippet by its template tag's snippet-id, not by its name", () => {
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
      const report = transformReads({ folder: workdir }).find(
        (t) => t.name === "Product Revenue Report",
      );
      expect(report?.tables?.map((t) => t.name)).toEqual([
        "ORDERS",
        "PRODUCTS",
        "PEOPLE",
      ]);
    });

    it("names the missing table", () => {
      mutateExamples("missing-input", workdir);
      expect(findings(workdir).map((f) => f.message)).toEqual([
        "no input for PRODUCTS, which transform Product Revenue Report reads",
      ]);
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

    it("warns about a table that no table file or target defines, once on each file naming it", () => {
      mutateExamples("unused-input", workdir);
      writeOrdersTable(workdir);
      const unknown = lint({ folder: workdir })
        .findings.filter((f) => f.rule === "unknown-table")
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

    const expectationRules = (schema?: string): string[] =>
      lint({
        folder: workdir,
        defaultSchemas:
          schema === undefined ? {} : { "Sample Database": schema },
      })
        .findings.filter((f) => f.message.startsWith("expectation"))
        .map((f) => f.rule);

    it("accepts a qualified read of an unqualified input, whatever the default schema", () => {
      readOrders("PUBLIC.orders");
      expect(expectationRules()).toEqual([]);
      expect(expectationRules("PUBLIC")).toEqual([]);
      expect(expectationRules("OTHER")).toEqual([]);
    });

    it("accepts a read in another schema of an input in the default schema only", () => {
      readOrders("OTHER.orders", "PUBLIC");
      expect(expectationRules()).toEqual(["input-match-undecided"]);
      expect(expectationRules("public")).toEqual([]);
      expect(expectationRules("OTHER2")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("refuses an unqualified read of an input outside the default schema", () => {
      readOrders("orders", "PUBLIC");
      expect(expectationRules()).toEqual(["input-match-undecided"]);
      expect(expectationRules("PUBLIC")).toEqual([]);
      expect(expectationRules("OTHER")).toEqual([
        "expectation-reads-other-table",
      ]);
    });

    it("refuses a read of a table that is neither input nor target", () => {
      readOrders("PEOPLE");
      expect(expectationRules()).toEqual(["expectation-reads-other-table"]);
    });
  });

  // Two names for a table, one unqualified: without a default schema the
  // lint takes them as one table; with one, only when the qualified name is in
  // the default schema.
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

    const rulesWithDefault = (schema?: string): string[] =>
      rules(
        lint({
          folder: workdir,
          defaultSchemas:
            schema === undefined ? {} : { "Sample Database": schema },
        }).findings,
      );

    it("finds a cycle through an unqualified read only in the default schema", () => {
      mutateExamples("transform-cycle", workdir);
      replaceIn(
        "collections/transforms/native_transform.yaml",
        "JOIN TRANSFORMS.top_categories",
        "JOIN top_categories",
      );
      expect(rulesWithDefault()).toContain("transform-cycle");
      expect(rulesWithDefault("transforms")).toContain("transform-cycle");
      expect(rulesWithDefault("PUBLIC")).not.toContain("transform-cycle");
    });

    it("finds a duplicate target written unqualified only in the default schema", () => {
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
      expect(rulesWithDefault()).toEqual(["duplicate-target"]);
      expect(rulesWithDefault("TRANSFORMS")).toEqual(["duplicate-target"]);
      expect(rulesWithDefault("PUBLIC")).toEqual([]);
    });

    it("counts a table file as the table read unqualified only in the default schema", () => {
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
      const unknownTables = (schema?: string) =>
        lint({
          folder: workdir,
          defaultSchemas:
            schema === undefined ? {} : { "Sample Database": schema },
        })
          .findings.filter((f) => f.rule === "unknown-table")
          .map((f) => f.message);
      const ordersUnknown =
        "table ORDERS is defined by no table file or transform target";
      expect(unknownTables()).not.toContain(ordersUnknown);
      expect(unknownTables("public")).not.toContain(ordersUnknown);
      expect(unknownTables("OTHER")).toContain(ordersUnknown);
    });
  });
});
