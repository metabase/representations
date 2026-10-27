import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { createRequire } from "node:module";
import { resolve } from "path";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

const SCHEMAS_DIR = resolve(import.meta.dirname, "..", "core-spec/v1/schemas");

export type Schemas = {
  ajv: Ajv2020;
  /** Each schema file's body, keyed by its path under `core-spec/v1/schemas`. */
  files: Map<string, any>;
  /** The schema file of each entity model, keyed by the model in `serdes/meta`. */
  models: Map<string, string>;
};

function extractModel(schema: any): string | null {
  const items = schema?.properties?.["serdes/meta"]?.items;
  const props = items?.properties ?? items?.items?.properties;
  return props?.model?.const ?? null;
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

  const files = new Map<string, any>();
  const models = new Map<string, string>();
  for (const file of globSync(["common/*.yaml", "*.yaml"], {
    cwd: SCHEMAS_DIR,
  }).sort()) {
    const raw = yaml.load(readFileSync(resolve(SCHEMAS_DIR, file), "utf8"));
    const { $schema: _$schema, ...body } = raw as any;
    files.set(file, body);
    ajv.addSchema(body, file);
    const model = extractModel(raw);
    if (model) {
      models.set(model, file);
    }
  }
  return { ajv, files, models };
}
