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
  readsDiffer,
  RULE_OF_REFUSAL,
  RULE_OF_TRANSFORM_REFUSAL,
  sameTableLabel,
  TEST_RULE_ORDER,
  testVerdictDiffers,
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

describe("testVerdictDiffers", () => {
  const finding = <R extends LintRule>(rule: R): LintFindingOf<R> => ({
    rule,
    severity: LINT_RULE_SEVERITY[rule],
    file: "test.yaml",
    entity: { model: "TransformTest", entity_id: "test", name: "test" },
    message: rule,
    related: [],
  });
  const otherTable = finding("expectation-reads-other-table");
  const unremapped = (onTransform: boolean) => ({
    code: "transform-test.unremapped-reference",
    message: "people",
    onTransform,
  });
  const refused = (code: string) => ({
    code,
    message: null,
    onTransform: false,
  });

  it("orders every rule a refusal maps to", () => {
    expect([...TEST_RULE_ORDER].sort()).toEqual(
      [...new Set(RULE_OF_REFUSAL.values())].sort(),
    );
  });

  it("agrees when Metabase accepts and the lint reports no error", () => {
    expect(testVerdictDiffers(null, [])).toBeNull();
  });

  it("differs when Metabase accepts and the lint reports an error", () => {
    expect(testVerdictDiffers(null, [finding("missing-input")])).toBe(
      "Metabase accepts it; the lint reports missing-input",
    );
  });

  it("agrees when an expectation's unremapped reference is the lint's error", () => {
    expect(testVerdictDiffers(unremapped(false), [otherTable])).toBeNull();
  });

  it("differs when the transform's unremapped reference meets the expectation's error", () => {
    expect(testVerdictDiffers(unremapped(true), [otherTable])).toBe(
      'Metabase refuses it with transform-test.unremapped-reference on the transform ("people"), which no lint rule predicts',
    );
  });

  it("agrees when the lint also reports a rule Metabase checks after the refusal", () => {
    expect(
      testVerdictDiffers(refused("transform-test.missing-inputs"), [
        finding("missing-input"),
        finding("unused-input"),
        otherTable,
      ]),
    ).toBeNull();
  });

  it("differs when the lint also reports a rule Metabase checks before the refusal", () => {
    expect(
      testVerdictDiffers(refused("transform-test.unused-inputs"), [
        finding("missing-input"),
        finding("unused-input"),
      ]),
    ).toBe(
      "Metabase refuses it with transform-test.unused-inputs, so it passed the checks before unused-input; the lint reports missing-input",
    );
    expect(
      testVerdictDiffers(unremapped(false), [
        finding("duplicate-input"),
        otherTable,
      ]),
    ).toBe(
      'Metabase refuses it with transform-test.unremapped-reference ("people"), so it passed the checks before expectation-reads-other-table; the lint reports duplicate-input',
    );
    // validator.clj checks unused inputs before duplicate ones.
    expect(
      testVerdictDiffers(refused("transform-test.duplicate-input-table"), [
        finding("unused-input"),
        finding("duplicate-input"),
      ]),
    ).toBe(
      "Metabase refuses it with transform-test.duplicate-input-table, so it passed the checks before duplicate-input; the lint reports unused-input",
    );
    // runner.clj refuses a transform that is not a query before it validates inputs.
    expect(
      testVerdictDiffers(refused("transform-test.unused-inputs"), [
        finding("untestable-transform"),
        finding("unused-input"),
      ]),
    ).toBe(
      "Metabase refuses it with transform-test.unused-inputs, so it passed the checks before unused-input; the lint reports untestable-transform",
    );
  });

  it("differs when the lint misses the refusal's rule", () => {
    expect(
      testVerdictDiffers(refused("transform-test.duplicate-input-table"), [
        otherTable,
      ]),
    ).toBe(
      "Metabase refuses it with transform-test.duplicate-input-table; the lint reports no duplicate-input",
    );
  });
});

describe("transformVerdictDiffers", () => {
  const noSchema: LintFinding = {
    rule: "missing-target-schema",
    severity: "error",
    file: "transform.yaml",
    entity: { model: "Transform", entity_id: "transform", name: "transform" },
    message: "the target names no schema",
    related: [],
  };
  const schemaRequired = "A target schema is required for this database.";

  it("agrees when Metabase refuses with the message of the lint's error", () => {
    expect(transformVerdictDiffers(schemaRequired, [noSchema])).toBeNull();
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

  it("differs when Metabase accepts what the lint calls an error", () => {
    expect(transformVerdictDiffers(null, [noSchema])).toBe(
      "Metabase accepts it; the lint reports missing-target-schema",
    );
  });

  const noDatabase: LintFinding = {
    ...noSchema,
    rule: "missing-target-database",
    message: "the target names no database",
  };
  const noTableTag: LintFinding = {
    ...noSchema,
    rule: "missing-incremental-table-tag",
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
