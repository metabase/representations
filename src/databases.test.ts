import { describe, expect, it } from "bun:test";

import { createEngineOf } from "./databases.js";

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
