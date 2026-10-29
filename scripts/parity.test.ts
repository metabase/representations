import { describe, expect, it } from "bun:test";

import type { LintFinding } from "../src/findings.js";
import { sameTableLabel, testVerdictDiffers } from "./parity.js";

const t = (schema: string | null, name: string) => ({ schema, name });

describe("sameTableLabel", () => {
  it.each([
    ["a bare label, a bare table", "orders", t(null, "ORDERS"), true],
    [
      "a qualified label, a bare table",
      "PUBLIC.ORDERS",
      t(null, "orders"),
      true,
    ],
    ["a bare label, a qualified table", "ORDERS", t("PUBLIC", "ORDERS"), true],
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

describe("testVerdictDiffers", () => {
  const otherTable: LintFinding = {
    rule: "expectation-reads-other-table",
    severity: "error",
    file: "test.yaml",
    entity: { model: "TransformTest", entity_id: "test", name: "test" },
    message: "expectation reads people",
    related: [],
  };
  const unremapped = (onTransform: boolean) => ({
    code: "transform-test.unremapped-reference",
    message: "people",
    onTransform,
  });

  it("agrees when an expectation's unremapped reference is the lint's error", () => {
    expect(testVerdictDiffers(unremapped(false), [otherTable])).toBeNull();
  });

  it("differs when the transform's unremapped reference meets the expectation's error", () => {
    expect(testVerdictDiffers(unremapped(true), [otherTable])).toBe(
      'Metabase refuses it with transform-test.unremapped-reference on the transform ("people"), which no lint rule predicts',
    );
  });
});
