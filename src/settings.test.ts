import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { CONFIG_FILE, LintSetupError, readSettingsFile } from "./settings.js";

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
      "has unknown keys: defaultSchema",
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
});
