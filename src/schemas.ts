import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFileSync } from "fs";
import { globSync } from "glob";
import { createRequire } from "node:module";
import { resolve } from "path";
import { parse } from "yaml";

import { isRecord, stringOrNull } from "./values.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

const SCHEMAS_DIR = resolve(import.meta.dirname, "..", "core-spec/v1/schemas");

export type Schemas = {
  ajv: Ajv2020;
  /** Each schema file's body, keyed by its path under `core-spec/v1/schemas`. */
  files: Map<string, unknown>;
  /** The schema file of each entity model, keyed by the model in `serdes/meta`. */
  models: Map<string, string>;
};

/** The model a schema's `serdes/meta` items fix by `const`, or null. */
function extractModel(schema: unknown): string | null {
  const propertyOf = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;
  const items = propertyOf(
    propertyOf(propertyOf(schema, "properties"), "serdes/meta"),
    "items",
  );
  const props =
    propertyOf(items, "properties") ??
    propertyOf(propertyOf(items, "items"), "properties");
  return stringOrNull(propertyOf(propertyOf(props, "model"), "const"));
}

/**
 * Loads every schema file into one Ajv instance, each under its path, so that
 * `ajv.getSchema("common/query.yaml#/$defs/stage")` addresses any node.
 */
export function loadSchemas(): Schemas {
  const ajv = new Ajv2020({
    allErrors: true,
    strictTuples: false,
    allowUnionTypes: true,
    // Nodes compiled on their own, such as an `if` with `prefixItems` and no
    // `type`, are valid but fail this check.
    strictTypes: false,
  });
  addFormats(ajv);

  const files = new Map<string, unknown>();
  const models = new Map<string, string>();
  for (const file of globSync(["common/*.yaml", "*.yaml"], {
    cwd: SCHEMAS_DIR,
  }).sort()) {
    const raw: unknown = parse(
      readFileSync(resolve(SCHEMAS_DIR, file), "utf8"),
    );
    // Every bundled schema file is a YAML map.
    const { $schema: _$schema, ...body } = raw as Record<string, unknown>;
    files.set(file, body);
    ajv.addSchema(body, file);
    const model = extractModel(raw);
    if (model) {
      models.set(model, file);
    }
  }
  return { ajv, files, models };
}
