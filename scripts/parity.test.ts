import { describe, expect, it } from "bun:test";

import {
  LINT_RULE_SEVERITY,
  type LintFindingOf,
  type LintRule,
} from "../src/findings.js";
import {
  readsDiffer,
  RULE_OF_REFUSAL,
  sameTableLabel,
  TEST_RULE_ORDER,
  testVerdictDiffers,
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
