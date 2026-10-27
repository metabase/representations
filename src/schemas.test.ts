import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

import { loadSchemas } from "./schemas.js";
import { isRecord } from "./values.js";

const SCHEMAS_DIR = resolve(import.meta.dirname, "..", "core-spec/v1/schemas");

const at = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

describe("loadSchemas", () => {
  test("every model constant in a schema's serdes/meta is a string", () => {
    const files = globSync(["common/*.yaml", "*.yaml"], { cwd: SCHEMAS_DIR });
    const constants = files.flatMap((file) => {
      const schema = yaml.load(
        readFileSync(resolve(SCHEMAS_DIR, file), "utf8"),
      );
      const items = at(at(at(schema, "properties"), "serdes/meta"), "items");
      const props =
        at(items, "properties") ?? at(at(items, "items"), "properties");
      const constant = at(at(props, "model"), "const");
      return constant === undefined ? [] : [constant];
    });
    expect(constants.length).toBeGreaterThan(0);
    expect(constants.every((c) => typeof c === "string")).toBe(true);
    expect([...loadSchemas().models.keys()].sort()).toEqual(
      constants.map(String).sort(),
    );
  });
});
