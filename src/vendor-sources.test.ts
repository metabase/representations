import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readVendorSources } from "./vendor-sources.js";

describe("readVendorSources", () => {
  it("reads the vendored sources", () => {
    expect(readVendorSources().sqlTools.path).toEndWith("sql_tools.py");
  });

  it("refuses a sources.json that lacks a source", () => {
    const dir = mkdtempSync(join(tmpdir(), "representations-vendor-"));
    try {
      writeFileSync(
        join(dir, "sources.json"),
        JSON.stringify({
          sqlTools: { repository: "r", path: "p", commit: "c" },
        }),
      );
      expect(() => readVendorSources(dir)).toThrow(
        "does not record the sources of sqlTools, importedModels and sqlglot",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
