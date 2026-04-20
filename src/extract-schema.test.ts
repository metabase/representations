import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { extractSchema } from "./extract-schema.js";

describe("extractSchema", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-extract-schema-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("copies all schema files to the target folder", () => {
    const target = join(workdir, "schemas");
    const result = extractSchema({ folder: target });

    expect(result.target).toBe(target);
    expect(existsSync(target)).toBe(true);

    const files = readdirSync(target);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(".yaml"))).toBe(true);
  });

  it("creates the target folder if it does not exist", () => {
    const target = join(workdir, "nested", "schemas");
    extractSchema({ folder: target });

    expect(existsSync(target)).toBe(true);
  });
});
