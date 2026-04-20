import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { validateSchema } from "./validate-schema.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

describe("validateSchema", () => {
  it("validates all bundled example files", () => {
    const { results, passed, failed } = validateSchema({ folder: EXAMPLES });
    expect(results.length).toBeGreaterThan(0);
    expect(failed).toBe(0);
    expect(passed).toBe(results.length);
  });

  describe("with an ad-hoc folder", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-validate-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("returns zero results when no YAML files are present", () => {
      const { results, passed, failed } = validateSchema({ folder: workdir });
      expect(results).toEqual([]);
      expect(passed).toBe(0);
      expect(failed).toBe(0);
    });

    it("fails files missing serdes/meta", () => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "broken.yaml"),
        "name: Broken\n",
      );

      const { passed, failed, results } = validateSchema({ folder: workdir });
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      expect(results[0].status).toBe("fail");
      if (results[0].status === "fail") {
        expect(results[0].errors[0].message).toMatch(/serdes\/meta/);
      }
    });

    it("fails files with an unknown model", () => {
      mkdirSync(join(workdir, "collections", "main"), { recursive: true });
      writeFileSync(
        join(workdir, "collections", "main", "unknown.yaml"),
        [
          "name: Unknown",
          "serdes/meta:",
          "- id: abc",
          "  model: NotARealModel",
          "",
        ].join("\n"),
      );

      const { failed, results } = validateSchema({ folder: workdir });
      expect(failed).toBe(1);
      if (results[0].status === "fail") {
        expect(results[0].errors[0].message).toMatch(/unknown model/);
      }
    });
  });
});
