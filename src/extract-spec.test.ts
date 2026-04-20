import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { extractSpec } from "./extract-spec.js";

describe("extractSpec", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-extract-spec-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("copies the bundled spec to the target file", () => {
    const target = join(workdir, "spec.md");
    const result = extractSpec({ file: target });

    expect(result.target).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBeGreaterThan(0);
    expect(readFileSync(target, "utf8")).toContain(
      "Metabase Representation Format",
    );
  });

  it("creates missing parent directories", () => {
    const target = join(workdir, "nested", "dir", "spec.md");
    extractSpec({ file: target });

    expect(existsSync(target)).toBe(true);
  });
});
