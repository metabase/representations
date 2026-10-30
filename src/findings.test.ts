import { describe, expect, it } from "bun:test";

import {
  LINT_RULE_SEVERITY,
  LINT_RULES,
  type LintFinding,
} from "./findings.js";

const entity = { model: null, entity_id: null, name: null };

describe("LintFinding", () => {
  it("ties a finding's severity to its rule's", () => {
    const error: LintFinding = {
      rule: "schema",
      severity: "error",
      file: "f.yaml",
      entity,
      message: "m",
      related: [],
    };
    // @ts-expect-error A schema finding is an error.
    const wrong: LintFinding = {
      rule: "schema",
      severity: "warning",
      file: "f.yaml",
      entity,
      message: "m",
      related: [],
    };
    expect(error.severity).toBe(LINT_RULE_SEVERITY[error.rule]);
    expect(wrong.rule).toBe("schema");
  });

  it("lists every rule, in the order of LINT_RULE_SEVERITY", () => {
    expect(LINT_RULES.map(String)).toEqual(Object.keys(LINT_RULE_SEVERITY));
  });
});
