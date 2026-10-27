import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { type LintFinding, lint } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./lint-mutations.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

function rules(findings: LintFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

describe("lint", () => {
  it("finds nothing in the bundled examples", () => {
    expect(lint({ folder: EXAMPLES }).findings).toEqual([]);
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

    it("warns about a table that no table file or target defines", () => {
      mutateExamples("unused-input", workdir);
      writeOrdersTable(workdir);
      const unknown = [
        ...new Set(
          lint({ folder: workdir })
            .findings.filter((f) => f.rule === "unknown-table")
            .map((f) => f.message),
        ),
      ].sort();
      expect(unknown).toEqual([
        "table PEOPLE is defined by no table file or transform target",
        "table PRODUCTS is defined by no table file or transform target",
      ]);
    });
  });
});
