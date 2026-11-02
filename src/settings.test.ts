import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { loadDocs } from "./documents.js";
import { loadSchemas } from "./schemas.js";
import {
  CONFIG_FILE,
  LintSetupError,
  parseDefaultSchemas,
  readSettingsFile,
} from "./settings.js";

describe("readSettingsFile", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "representations-settings-"));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const write = (text: string) =>
    writeFileSync(join(folder, CONFIG_FILE), text);

  it("gives no settings when the folder has no settings file", () => {
    expect(readSettingsFile(folder)).toEqual({
      defaultSchemas: {},
      engines: {},
    });
  });

  it("reads each key, and takes an absent one as empty", () => {
    write('{"defaultSchemas": {"Warehouse": "public", "Legacy": null}}');
    expect(readSettingsFile(folder)).toEqual({
      defaultSchemas: { Warehouse: "public", Legacy: null },
      engines: {},
    });
  });

  it.each([
    ["text that is not JSON", "{not json", "does not parse as JSON: "],
    ["JSON that is not an object", "[]", "is not a JSON object"],
    [
      "an unknown key",
      '{"defaultSchema": {}}',
      'has unknown keys: "defaultSchema"',
    ],
    [
      "a default schema that is not a string or null",
      '{"defaultSchemas": {"Warehouse": 5}}',
      "defaultSchemas must map each database name to a schema name or null",
    ],
    [
      "an engine that is not a string",
      '{"engines": {"Warehouse": null}}',
      "engines must map each database name to an engine name",
    ],
  ])("refuses %s, saying why", (_, text, message) => {
    write(text);
    expect(() => readSettingsFile(folder)).toThrow(LintSetupError);
    expect(() => readSettingsFile(folder)).toThrow(message);
  });

  it("refuses a settings file that links to a FIFO, without waiting for a writer", () => {
    // A read that blocks would block this process, so a child process reads.
    const readInChild = () => {
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `import { readSettingsFile } from ${JSON.stringify(join(import.meta.dirname, "settings.ts"))};
           try {
             console.log(JSON.stringify(readSettingsFile(${JSON.stringify(folder)})));
           } catch (e) {
             console.log(e.name);
           }`,
        ],
        timeout: 5_000,
      });
      return {
        stdout: child.stdout.toString().trim(),
        signalCode: child.signalCode ?? null,
      };
    };
    write('{"engines": {"Warehouse": "postgres"}}');
    expect(readInChild()).toEqual({
      stdout: '{"defaultSchemas":{},"engines":{"Warehouse":"postgres"}}',
      signalCode: null,
    });

    rmSync(join(folder, CONFIG_FILE));
    const fifo = join(folder, "fifo");
    expect(Bun.spawnSync({ cmd: ["mkfifo", fifo] }).exitCode).toBe(0);
    symlinkSync(fifo, join(folder, CONFIG_FILE));
    expect(readInChild()).toEqual({
      stdout: "LintSetupError",
      signalCode: null,
    });
  }, 20_000);

  it("refuses a settings file that is a symbolic link to a regular file", () => {
    const target = join(folder, "settings.json");
    writeFileSync(target, '{"engines": {"Warehouse": "postgres"}}');
    symlinkSync(target, join(folder, CONFIG_FILE));
    expect(() => readSettingsFile(folder)).toThrow(
      new LintSetupError(
        `${CONFIG_FILE} is not a regular file; replace it with a file`,
      ),
    );
  });
});

describe("parseDefaultSchemas", () => {
  it("reads DATABASE= as a database with no schemas", () => {
    expect(parseDefaultSchemas(["db="])).toEqual({ db: null });
  });

  it("splits a pair at its last =", () => {
    expect(parseDefaultSchemas(["a=b=c"])).toEqual({ "a=b": "c" });
  });

  it("refuses a database named twice", () => {
    expect(() => parseDefaultSchemas(["db=x", "db=y"])).toThrow(
      new LintSetupError("--default-schema names db twice"),
    );
  });

  it("refuses a pair with no database", () => {
    expect(() => parseDefaultSchemas(["=x"])).toThrow(
      new LintSetupError(
        "Invalid --default-schema: =x (expected DATABASE=SCHEMA)",
      ),
    );
  });
});

describe("the examples", () => {
  const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

  /** Each list in `value`, at any depth, that names a table: a database, a schema and a name. */
  const tableNames = (value: unknown): unknown[][] =>
    Array.isArray(value)
      ? [
          ...(value.length === 3 &&
          typeof value[0] === "string" &&
          typeof value[2] === "string"
            ? [value]
            : []),
          ...value.flatMap(tableNames),
        ]
      : typeof value === "object" && value !== null
        ? Object.values(value).flatMap(tableNames)
        : [];

  it("name each table of a database with no schemas by a null schema", () => {
    const { defaultSchemas } = readSettingsFile(EXAMPLES);
    const noSchemas = Object.keys(defaultSchemas).filter(
      (database) => defaultSchemas[database] === null,
    );
    const { docs } = loadDocs(EXAMPLES, loadSchemas());
    const named = docs.flatMap((doc) =>
      tableNames(doc.body)
        .filter(([database]) => noSchemas.includes(String(database)))
        .map((name) => ({ file: doc.file, name })),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(({ name }) => name[1] !== null)).toEqual([]);
  });
});
