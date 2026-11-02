import { describe, it } from "bun:test";

import type { LintFinding } from "./findings.js";

const entity = { model: null, entity_id: null, name: null };

describe("LintFinding", () => {
  // The type check is the test.
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
    const wrong: LintFinding = { ...error, severity: "warning" };
    void wrong;
  });
});
