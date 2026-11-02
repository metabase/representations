import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import YAML from "yaml";

import {
  LINT_RULE_SEVERITY,
  type LintFinding,
  type LintFindingOf,
  type LintRule,
} from "../src/findings.js";
import { isRecord } from "../src/values.js";
import {
  changedTransforms,
  compareTest,
  describeRefusal,
  readsDiffer,
  RULE_OF_REFUSAL,
  RULE_OF_TRANSFORM_REFUSAL,
  sameTableLabel,
  TEST_RULE_ORDER,
  type TestComparison,
  TRANSFORM_RULE_ORDER,
  transformVerdictDiffers,
} from "./parity.js";

const t = (schema: string | null, name: string) => ({ schema, name });

describe("sameTableLabel", () => {
  it.each([
    ["a bare label, a bare table", "orders", t(null, "ORDERS"), true],
    [
      "a qualified label, a bare table",
      "PUBLIC.ORDERS",
      t(null, "orders"),
      false,
    ],
    ["a bare label, a qualified table", "ORDERS", t("PUBLIC", "ORDERS"), false],
    ["one schema, in two cases", "public.orders", t("PUBLIC", "ORDERS"), true],
    ["two schemas", "OTHER.ORDERS", t("PUBLIC", "ORDERS"), false],
    ["two names", "PUBLIC.PEOPLE", t("PUBLIC", "ORDERS"), false],
    [
      "a name ending like another",
      "PUBLIC.MY_ORDERS",
      t(null, "ORDERS"),
      false,
    ],
    ["a dot in the schema", "a.b.c", t("a.b", "c"), true],
    // A label cannot tell a dot in the schema from one in the name.
    ["a dot in the name", "a.b.c", t("a", "b.c"), true],
  ] as const)("%s", (_, label, table, expected) => {
    expect(sameTableLabel(label, table)).toBe(expected);
  });
});

describe("readsDiffer", () => {
  it("agrees when each side names the same tables", () => {
    expect(
      readsDiffer(
        [t("public", "orders"), t(null, "people")],
        ["PUBLIC.ORDERS", "people"],
      ),
    ).toBeNull();
  });

  it("differs when the lint drops a schema Metabase reads", () => {
    expect(readsDiffer([t(null, "orders")], ["other.orders"])).toBe(
      "only the lint reads orders; only Metabase reads other.orders",
    );
  });

  it("differs when the lint adds a schema Metabase does not read", () => {
    expect(readsDiffer([t("a", "orders")], ["orders"])).toBe(
      "only the lint reads a.orders; only Metabase reads orders",
    );
  });

  it("differs when one lint read stands for two Metabase tables", () => {
    expect(readsDiffer([t(null, "orders")], ["a.orders", "b.orders"])).toBe(
      "only the lint reads orders; only Metabase reads a.orders, b.orders",
    );
  });
});

describe("compareTest", () => {
  const finding = <R extends LintRule>(
    rule: R,
    message: string = rule,
  ): LintFindingOf<R> => ({
    rule,
    severity: LINT_RULE_SEVERITY[rule],
    file: "test.yaml",
    entity: { model: "TransformTest", entity_id: "test", name: "test" },
    message,
    related: [],
  });
  const refused = (code: string) => ({ code, message: null });
  const unremapped = {
    code: "transform-test.unremapped-reference",
    message: "people",
  };
  const agrees: TestComparison = { verdict: "agrees" };
  const differs = (difference: string): TestComparison => ({
    verdict: "differs",
    difference,
  });

  it("orders every rule a refusal maps to", () => {
    expect([...TEST_RULE_ORDER].sort()).toEqual(
      [...new Set(RULE_OF_REFUSAL.values())].sort(),
    );
  });

  it("compares only the input checks", () => {
    expect([...TEST_RULE_ORDER]).toEqual([
      "missing-input",
      "unused-input",
      "duplicate-input",
    ]);
  });

  it("agrees when Metabase accepts and the lint reports no input error", () => {
    expect(compareTest(null, null, [])).toEqual(agrees);
    expect(
      compareTest(null, null, [
        finding("expectation-reads-other-table"),
        finding("unparseable-test-sql"),
      ]),
    ).toEqual(agrees);
  });

  it("differs when Metabase accepts and the lint reports an input error", () => {
    expect(compareTest(null, null, [finding("missing-input")])).toEqual(
      differs("Metabase accepts it; the lint reports missing-input"),
    );
  });

  it("agrees when Metabase refuses after the input checks and the lint reports no input error", () => {
    expect(
      compareTest(unremapped, null, [finding("expectation-reads-other-table")]),
    ).toEqual(agrees);
    expect(compareTest(unremapped, null, [])).toEqual(agrees);
  });

  it("differs when Metabase refuses after the input checks and the lint reports an input error", () => {
    expect(compareTest(unremapped, null, [finding("duplicate-input")])).toEqual(
      differs(
        'Metabase refuses it with transform-test.unremapped-reference ("people"), so it passed the input checks; the lint reports duplicate-input',
      ),
    );
  });

  it("compares nothing when Metabase refuses before the input checks", () => {
    expect(
      compareTest(refused("transform-test.unsupported-transform"), null, [
        finding("missing-input"),
      ]),
    ).toEqual({
      verdict: "compared-nothing",
      reason:
        "Metabase refuses it with transform-test.unsupported-transform, which says nothing of its inputs",
    });
  });

  // Metabase refuses SQL it cannot parse before the input checks, for the
  // transform's SQL, or after them, for an expectation's.
  it("compares nothing when Metabase cannot parse SQL of the test", () => {
    for (const message of [
      'Expectation "e" has SQL that could not be parsed: ParseError: Expecting ).',
      null,
    ]) {
      const refusal = { code: "transform-test.unparseable-source", message };
      for (const findings of [
        [],
        [finding("unparseable-test-sql")],
        [finding("missing-input")],
      ]) {
        expect(compareTest(refusal, null, findings)).toEqual({
          verdict: "compared-nothing",
          reason: `Metabase refuses it with ${describeRefusal(refusal)}, which says nothing of its inputs`,
        });
      }
    }
  });

  it("differs on a refusal no input rule predicts", () => {
    expect(compareTest(refused("transform-test.other"), null, [])).toEqual(
      differs(
        "Metabase refuses it with transform-test.other, which no error rule predicts",
      ),
    );
  });

  it("agrees when the lint also reports a rule Metabase checks after the refusal", () => {
    expect(
      compareTest(refused("transform-test.missing-inputs"), null, [
        finding("missing-input"),
        finding("unused-input"),
      ]),
    ).toEqual(agrees);
  });

  it("differs when the lint also reports a rule Metabase checks before the refusal", () => {
    expect(
      compareTest(refused("transform-test.unused-inputs"), null, [
        finding("missing-input"),
        finding("unused-input"),
      ]),
    ).toEqual(
      differs(
        "Metabase refuses it with transform-test.unused-inputs, so it passed the checks before unused-input; the lint reports missing-input",
      ),
    );
    // validator.clj checks unused inputs before duplicate ones.
    expect(
      compareTest(refused("transform-test.duplicate-input-table"), null, [
        finding("unused-input"),
        finding("duplicate-input"),
      ]),
    ).toEqual(
      differs(
        "Metabase refuses it with transform-test.duplicate-input-table, so it passed the checks before duplicate-input; the lint reports unused-input",
      ),
    );
  });

  it("differs when the lint misses the refusal's rule", () => {
    expect(
      compareTest(refused("transform-test.duplicate-input-table"), null, []),
    ).toEqual(
      differs(
        "Metabase refuses it with transform-test.duplicate-input-table; the lint reports no duplicate-input",
      ),
    );
  });

  describe("with the tables Metabase lists", () => {
    const missing = (table: string) =>
      finding(
        "missing-input",
        `no input for ${table}, which transform T reads`,
      );
    const unused = (table: string) =>
      finding("unused-input", `input ${table} is not read by transform T`);
    const duplicate = (...tables: string[]) =>
      finding(
        "duplicate-input",
        `inputs stand in for the same table: ${tables.join(", ")}`,
      );

    it("agrees when the lint names the tables Metabase lists, ignoring case and a missing schema's label", () => {
      expect(
        compareTest(
          refused("transform-test.missing-inputs"),
          ["PRODUCTS", "public.people"],
          [missing("products"), missing("public.People")],
        ),
      ).toEqual(agrees);
      expect(
        compareTest(
          refused("transform-test.unused-inputs"),
          ["orders"],
          [unused("orders (no schema)")],
        ),
      ).toEqual(agrees);
      expect(
        compareTest(
          refused("transform-test.duplicate-input-table"),
          ["a.t"],
          [duplicate("a.t", "A.T")],
        ),
      ).toEqual(agrees);
    });

    it("differs when the lint names other tables than Metabase lists", () => {
      expect(
        compareTest(
          refused("transform-test.missing-inputs"),
          ["products"],
          [missing("orders"), missing("products")],
        ),
      ).toEqual(
        differs(
          "Metabase refuses it with transform-test.missing-inputs for products; the lint reports missing-input for orders, products",
        ),
      );
      expect(
        compareTest(
          refused("transform-test.unused-inputs"),
          ["orders", "people"],
          [unused("orders")],
        ),
      ).toEqual(
        differs(
          "Metabase refuses it with transform-test.unused-inputs for orders, people; the lint reports unused-input for orders",
        ),
      );
    });
  });
});

describe("transformVerdictDiffers", () => {
  const noSchema: LintFinding = {
    rule: "missing-target-schema",
    severity: "warning",
    file: "transform.yaml",
    entity: { model: "Transform", entity_id: "transform", name: "transform" },
    message: "the target names no schema",
    related: [],
  };
  const schemaRequired = "A target schema is required for this database.";

  it("agrees when Metabase refuses with the message of the lint's warning", () => {
    expect(transformVerdictDiffers(schemaRequired, [noSchema])).toBeNull();
  });

  it("agrees when Metabase refuses no schema and the lint reports a blank one, which a probe sends as none", () => {
    expect(
      transformVerdictDiffers(schemaRequired, [
        { ...noSchema, rule: "blank-target-schema", severity: "error" },
      ]),
    ).toBeNull();
  });

  it("differs when Metabase refuses with the message of another rule", () => {
    expect(
      transformVerdictDiffers("The target database cannot be found.", [
        noSchema,
      ]),
    ).toBe(
      'Metabase refuses it with "The target database cannot be found."; the lint reports no missing-target-database',
    );
  });

  it("differs when Metabase refuses with a message no rule predicts", () => {
    expect(transformVerdictDiffers("Checkpoint field not found.", [])).toBe(
      'Metabase refuses it with "Checkpoint field not found.", which no lint rule predicts',
    );
  });

  it("differs when Metabase accepts what the lint warns of", () => {
    expect(transformVerdictDiffers(null, [noSchema])).toBe(
      "Metabase accepts it; the lint reports missing-target-schema",
    );
  });

  const noDatabase: LintFinding = {
    ...noSchema,
    rule: "missing-target-database",
    severity: "error",
    message: "the target names no database",
  };
  const noTableTag: LintFinding = {
    ...noSchema,
    rule: "missing-incremental-table-tag",
    severity: "error",
    message: "the incremental native query has no table variable",
  };

  it("orders every rule a refusal maps to", () => {
    expect([...TRANSFORM_RULE_ORDER].sort()).toEqual(
      [...new Set(RULE_OF_TRANSFORM_REFUSAL.values())].sort(),
    );
  });

  it("agrees when the lint also reports a rule Metabase checks after the refusal", () => {
    expect(
      transformVerdictDiffers(schemaRequired, [noSchema, noTableTag]),
    ).toBeNull();
  });

  it("differs when the lint also reports a rule Metabase checks before the refusal", () => {
    expect(
      transformVerdictDiffers(schemaRequired, [noDatabase, noSchema]),
    ).toBe(
      'Metabase refuses it with "A target schema is required for this database.", so it passed the checks before missing-target-schema; the lint reports missing-target-database',
    );
  });
});

describe("changedTransforms", () => {
  const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");
  const PYTHON = "collections/transforms/python_hello_world.yaml";
  const SUMMARY = "collections/transforms/product_summary.yaml";
  let workdir: string | undefined;

  afterEach(() => {
    if (workdir !== undefined) {
      rmSync(workdir, { recursive: true, force: true });
      workdir = undefined;
    }
  });

  /** A copy of the examples with `change` applied to the YAML map of each of `files`. */
  function changed(
    files: readonly string[],
    change: (doc: Record<string, unknown>) => void,
  ): string {
    workdir = mkdtempSync(join(tmpdir(), "representations-parity-"));
    const folder = join(workdir, "repo");
    cpSync(EXAMPLES, folder, { recursive: true });
    for (const file of files) {
      const path = join(folder, file);
      const doc: unknown = YAML.parse(readFileSync(path, "utf8"));
      if (!isRecord(doc)) {
        throw new Error(`${file} is not a map`);
      }
      change(doc);
      writeFileSync(path, YAML.stringify(doc));
    }
    return folder;
  }

  /** `changedTransforms` as file names and whether each change is carried. */
  const changes = (folder: string) =>
    changedTransforms(EXAMPLES, folder).map((pair) => [
      pair.clean.file,
      pair.carried,
    ]);

  const target = (doc: Record<string, unknown>) => {
    if (!isRecord(doc.target)) {
      throw new Error("no target");
    }
    return doc.target;
  };

  it("lists each changed transform, carried when only the target's schema changed", () => {
    expect(
      changes(changed([PYTHON], (doc) => delete target(doc).schema)),
    ).toEqual([[PYTHON, true]]);
  });

  it("calls a change of the target's name not carried", () => {
    expect(
      changes(
        changed([PYTHON], (doc) => {
          delete target(doc).schema;
          target(doc).name = "other";
        }),
      ),
    ).toEqual([[PYTHON, false]]);
  });

  it("calls a change of the target's database carried, and one outside the target not", () => {
    expect(
      changes(
        changed([PYTHON, SUMMARY], (doc) => {
          if (doc.name === "Product Summary") {
            doc.description = "changed";
          } else {
            target(doc).database = "Other";
          }
        }),
      ),
    ).toEqual([
      [SUMMARY, false],
      [PYTHON, true],
    ]);
  });
});
