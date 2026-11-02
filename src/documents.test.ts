import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  asValid,
  type Doc,
  isQueryTransformDoc,
  loadDocs,
  queryDatabaseOf,
  type SchemaStatus,
  targetDatabaseOf,
} from "./documents.js";
import { loadSchemas } from "./schemas.js";

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
    expect(asValid(doc, "TransformTest")).toBeNull();
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

describe("queryDatabaseOf and targetDatabaseOf", () => {
  const validTransform = (body: Record<string, unknown>) => {
    const valid = asValid(
      {
        file: "collections/transforms/t.yaml",
        model: "Transform",
        schema: { status: "passed" },
        nonStringKeys: [],
        body: { name: "T", source_database_id: "Source DB", ...body },
      },
      "Transform",
    );
    if (valid === null) {
      throw new Error("not a valid transform");
    }
    return valid;
  };

  it("takes a query transform's databases from its query, not its source database or target", () => {
    const transform = validTransform({
      source: { type: "query", query: { database: "Query DB" } },
      target: { database: "Target DB", type: "table", name: "t" },
    });
    if (!isQueryTransformDoc(transform)) {
      throw new Error("not a query transform");
    }
    expect(queryDatabaseOf(transform)).toBe("Query DB");
    expect(targetDatabaseOf(transform)).toBe("Query DB");
  });

  it("takes another transform's target database from its target, or none", () => {
    const python = (target: Record<string, unknown>) =>
      validTransform({
        source: { type: "python", body: "", "source-tables": [] },
        target: { type: "table", name: "t", ...target },
      });
    expect(targetDatabaseOf(python({ database: "Target DB" }))).toBe(
      "Target DB",
    );
    expect(targetDatabaseOf(python({}))).toBeNull();
  });
});

describe("loadDocs", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-documents-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const writeCollection = (content: string | Uint8Array) => {
    mkdirSync(join(workdir, "collections"), { recursive: true });
    writeFileSync(join(workdir, "collections", "c.yaml"), content);
  };
  const META = "serdes/meta:\n  - model: Collection\n";

  it("reads a file that is not valid UTF-8 with U+FFFD, and names it", () => {
    writeCollection(
      new Uint8Array([
        ...new TextEncoder().encode("name: caf"),
        0xe9,
        ...new TextEncoder().encode(`\n${META}`),
      ]),
    );
    const { docs, invalidUtf8 } = loadDocs(workdir, loadSchemas());
    expect(invalidUtf8).toEqual([join("collections", "c.yaml")]);
    expect(docs.map((d) => d.body.name)).toEqual(["caf\ufffd"]);
  });

  it("keeps the last value of a key written twice, and names the key", () => {
    writeCollection(`name: A\nname: B\n${META}`);
    const { docs, duplicatedKeys } = loadDocs(workdir, loadSchemas());
    expect(docs.map((d) => d.body.name)).toEqual(["B"]);
    expect(
      duplicatedKeys.map(({ doc, keys }) => ({
        file: doc.file,
        keys: keys.map(({ source, line }) => ({ source, line })),
      })),
    ).toEqual([
      {
        file: join("collections", "c.yaml"),
        keys: [{ source: "name", line: 2 }],
      },
    ]);
  });

  it("reads a file with a time Metabase cannot read as unreadable, not as a document", () => {
    mkdirSync(join(workdir, "collections"), { recursive: true });
    writeFileSync(
      join(workdir, "collections", "c.yaml"),
      "name: C\ncreated_at: nope\nserdes/meta:\n  - model: Collection\n",
    );
    const { docs, unreadable } = loadDocs(workdir, loadSchemas());
    expect(docs).toEqual([]);
    expect(unreadable).toEqual([
      {
        file: join("collections", "c.yaml"),
        reason:
          'fails to load: Metabase cannot read created_at as a time: "nope"',
      },
    ]);
  });

  it("throws the error of a file it cannot read", () => {
    mkdirSync(join(workdir, "collections"), { recursive: true });
    const file = join(workdir, "collections", "c.yaml");
    writeFileSync(file, "name: C\nserdes/meta:\n  - model: Collection\n");
    chmodSync(file, 0o000);
    try {
      expect(() => loadDocs(workdir, loadSchemas())).toThrow(/^EACCES/);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("throws the error of a folder it cannot read", () => {
    const folder = join(workdir, "collections", "locked");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "c.yaml"),
      "name: C\nserdes/meta:\n  - model: Collection\n",
    );
    chmodSync(folder, 0o000);
    try {
      expect(() => loadDocs(workdir, loadSchemas())).toThrow(/^EACCES/);
    } finally {
      chmodSync(folder, 0o755);
    }
  });
});
