import { describe, expect, it } from "bun:test";

import { createEngineOf, databasesOf } from "./databases.js";
import type { Doc } from "./documents.js";
import type { DataSources } from "./query-sources.js";
import { sqlTable } from "./tables.js";

describe("createEngineOf", () => {
  it("takes each database's engine from the settings, by name", () => {
    const engineOf = createEngineOf({
      Warehouse: "postgres",
      Legacy: "mysql",
    });
    expect(engineOf("Warehouse")).toBe("postgres");
    expect(engineOf("Legacy")).toBe("mysql");
  });

  it("knows no engine for a database the settings do not name, or no database", () => {
    const engineOf = createEngineOf({ Warehouse: "postgres" });
    expect(engineOf("Other")).toBeNull();
    expect(engineOf(null)).toBeNull();
  });
});

describe("databasesOf", () => {
  it("collects the databases of the tables and native queries a document names, each once", () => {
    const doc: Doc = {
      file: "collections/dashboards/d.yaml",
      model: "Dashboard",
      schema: { status: "unchecked" },
      nonStringKeys: [],
      body: {},
    };
    const native = (database: string | null) => ({
      sql: "SELECT 1",
      database,
      valuedTags: new Set<string>(),
      snippetIds: new Map<string, string>(),
      tableTags: new Map(),
      cardTags: new Map<string, string>(),
      hasTemplateTags: false,
    });
    const sources: DataSources = {
      tables: [
        sqlTable("Tables", { schema: "public", name: "a" }),
        sqlTable("Tables", { schema: "public", name: "b" }),
      ],
      tagTables: [
        {
          tag: "c",
          type: "dimension",
          table: sqlTable("Tags", { schema: null, name: "c" }),
        },
      ],
      fields: [],
      entities: [],
      natives: [native("Natives"), native(null)],
    };
    expect(databasesOf(doc, () => sources)).toEqual([
      "Tables",
      "Tags",
      "Natives",
    ]);
  });
});
