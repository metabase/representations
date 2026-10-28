import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

import { createEngineOf } from "./databases.js";
import { loadDocs } from "./documents.js";
import { loadSchemas } from "./schemas.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

describe("createEngineOf", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-databases-"));
    cpSync(EXAMPLES, workdir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const writeDatabase = (file: string, body: Record<string, unknown>) => {
    const path = join(workdir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      yaml.dump({ ...body, "serdes/meta": [{ model: "Database" }] }),
    );
  };

  const engineOf = (settings: Readonly<Record<string, string>> = {}) =>
    createEngineOf(loadDocs(workdir, loadSchemas()).docs, settings);

  it("reads each database's engine from its Database file", () => {
    writeDatabase("databases/warehouse/warehouse.yaml", {
      name: "Warehouse",
      engine: "postgres",
    });
    writeDatabase("databases/legacy/legacy.yaml", {
      name: "Legacy",
      engine: "mysql",
    });
    expect(engineOf()("Warehouse")).toBe("postgres");
    expect(engineOf()("Legacy")).toBe("mysql");
  });

  it("knows no engine for a database with no file, a file with no engine, or no database", () => {
    writeDatabase("databases/bare/bare.yaml", { name: "Bare" });
    expect(engineOf()("Sample Database")).toBeNull();
    expect(engineOf()("Bare")).toBeNull();
    expect(engineOf()(null)).toBeNull();
  });

  it("ignores a Database file that fails its schema", () => {
    writeDatabase("databases/broken/broken.yaml", {
      name: "Broken",
      engine: 5,
    });
    expect(engineOf()("Broken")).toBeNull();
  });

  it("takes an engine from the settings for a database with no engine in a Database file", () => {
    writeDatabase("databases/warehouse/warehouse.yaml", {
      name: "Warehouse",
      engine: "postgres",
    });
    writeDatabase("databases/bare/bare.yaml", { name: "Bare" });
    const settings = {
      Warehouse: "mysql",
      Bare: "snowflake",
      Lake: "bigquery-cloud-sdk",
    };
    expect(engineOf(settings)("Warehouse")).toBe("postgres");
    expect(engineOf(settings)("Bare")).toBe("snowflake");
    expect(engineOf(settings)("Lake")).toBe("bigquery-cloud-sdk");
    expect(engineOf(settings)("Other")).toBeNull();
  });

  it("takes the first file in path order when two name one database", () => {
    writeDatabase("databases/a/a.yaml", { name: "Twin", engine: "postgres" });
    writeDatabase("databases/b/b.yaml", { name: "Twin", engine: "mysql" });
    expect(engineOf()("Twin")).toBe("postgres");
  });
});
