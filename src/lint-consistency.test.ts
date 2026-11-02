import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { lint } from "./lint.js";
import { loadSqlParser } from "./sql-parser.js";
import { isRecord } from "./values.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = resolve(ROOT, "examples", "v1");
const PYTHON_HELLO_WORLD = "collections/transforms/python_hello_world.yaml";
const PYTHON_HELLO_WORLD_ENTITY_ID = "g2cRYwopfoL1BW9Y4n3wb";
const MBQL_TRANSFORM = "collections/transforms/mbql_transform.yaml";
const OTHER_DB = "Other DB";

/** Loads the YAML map in `file` under `folder`, applies `change`, and writes it back. */
function edit(
  folder: string,
  file: string,
  change: (doc: Record<string, unknown>) => void,
): void {
  const path = join(folder, file);
  const doc: unknown = yaml.load(readFileSync(path, "utf8"));
  if (!isRecord(doc)) {
    throw new Error(`${file} is not a YAML map`);
  }
  change(doc);
  writeFileSync(path, yaml.dump(doc, { lineWidth: -1 }));
}

/** Sets the Python transform's source tables to `sourceTables`. */
function pythonReadsFrom(folder: string, sourceTables: unknown[]): void {
  edit(folder, PYTHON_HELLO_WORLD, (doc) => {
    const { source } = doc;
    if (!isRecord(source)) {
      throw new Error("the Python transform has no source map");
    }
    source["source-tables"] = sourceTables;
  });
}

/** Sets the first stage of the MBQL transform to read the card `entityId`. */
function mbqlReadsCard(folder: string, entityId: string): void {
  edit(folder, MBQL_TRANSFORM, (doc) => {
    const { source } = doc;
    const query = isRecord(source) ? source.query : undefined;
    const stages = isRecord(query) ? query.stages : undefined;
    const stage: unknown = Array.isArray(stages) ? stages[0] : undefined;
    if (!isRecord(stage)) {
      throw new Error("the MBQL transform has no first stage");
    }
    delete stage["source-table"];
    stage["source-card"] = entityId;
  });
}

beforeAll(async () => {
  await loadSqlParser();
}, 60_000);

describe("lint", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-consistency-"));
    cpSync(EXAMPLES, workdir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  /** The databases `unknown-engine` names, and `LintResult.databases`, for `workdir`. */
  async function unknownEngineDatabases(): Promise<{
    named: string[];
    unknown: string[];
  }> {
    const { databases, findings } = await lint({
      folder: workdir,
      defaultSchemas: { [OTHER_DB]: "public" },
    });
    const unknown = findings
      .filter((f) => f.rule === "unknown-engine")
      .map((f) => /of database (.+?), /.exec(f.message)?.[1] ?? f.message);
    return { named: databases, unknown };
  }

  it("LintResult.databases holds a database a Python source table names by table_id, as unknown-engine does", async () => {
    pythonReadsFrom(workdir, [
      {
        alias: "src",
        database_id: OTHER_DB,
        table_id: [OTHER_DB, "public", "src"],
      },
    ]);
    const { named, unknown } = await unknownEngineDatabases();
    expect(unknown).toEqual([OTHER_DB]);
    expect(named).toContain(OTHER_DB);
  });

  it("LintResult.databases holds a database a Python source table names by database_id, as unknown-engine does", async () => {
    pythonReadsFrom(workdir, [
      { alias: "src", database_id: OTHER_DB, schema: "public", table: "src" },
    ]);
    const { named, unknown } = await unknownEngineDatabases();
    expect(unknown).toEqual([OTHER_DB]);
    expect(named).toContain(OTHER_DB);
  });

  describe("on a source-card that names no Card", () => {
    const readsMessages = async () =>
      (await lint({ folder: workdir })).findings
        .filter((f) => f.file === MBQL_TRANSFORM)
        .map((f) => `${f.rule}: ${f.message}`);

    it("says the card is not in the folder when no file holds its id", async () => {
      mbqlReadsCard(workdir, "NoSuchCard00000000001");
      expect(await readsMessages()).toEqual([
        "reads-not-checked: could not find the tables this transform reads: source Card NoSuchCard00000000001 is not in the folder",
      ]);
    });

    it("names the model of the file that holds the id, not that the card is missing", async () => {
      mbqlReadsCard(workdir, PYTHON_HELLO_WORLD_ENTITY_ID);
      const messages = await readsMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        `${PYTHON_HELLO_WORLD_ENTITY_ID} names a Transform, not a Card`,
      );
      expect(messages[0]).not.toContain("is not in the folder");
    });
  });
});
