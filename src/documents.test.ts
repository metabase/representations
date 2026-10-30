import { describe, expect, it } from "bun:test";

import { asValid, type Doc, type SchemaStatus } from "./documents.js";

const transformWith = (schema: SchemaStatus): Doc => ({
  file: "collections/transforms/t.yaml",
  model: "Transform",
  schema,
  nonStringKeys: [],
  body: { name: "T" },
});

describe("asValid", () => {
  it("gives a document of the model that passed its schema", () => {
    const doc = transformWith({ status: "passed" });
    expect(asValid(doc, "Transform")?.file).toBe(doc.file);
    expect(asValid(doc, "Table")).toBeNull();
  });

  it("refuses a document that failed its schema, or that no schema checked", () => {
    expect(
      asValid(
        transformWith({
          status: "failed",
          error: { path: "/name", message: "must be string" },
        }),
        "Transform",
      ),
    ).toBeNull();
    expect(
      asValid(transformWith({ status: "unchecked" }), "Transform"),
    ).toBeNull();
  });
});
