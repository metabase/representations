import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { createRequire } from "node:module";
import { resolve } from "path";

import { isJsonArray, isJsonObject } from "../src/json.js";
import { portableSchemas } from "../src/schemas/index.js";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

const ajv = new Ajv2020({
  allErrors: true,
  strictTuples: false,
  allowUnionTypes: true,
});
addFormats(ajv);
for (const [name, schema] of Object.entries(portableSchemas)) {
  ajv.addSchema(schema, name);
}

const schemaByModel = new Map(
  Object.entries(portableSchemas).flatMap(([name, schema]) => {
    const model = serdesModel(schema);
    return model === null ? [] : [[model, name]];
  }),
);

function serdesModel(schema: unknown): string | null {
  const properties = isJsonObject(schema) ? schema.properties : null;
  const meta = isJsonObject(properties) ? properties["serdes/meta"] : null;
  const items = isJsonObject(meta) ? meta.items : null;
  const itemProperties = isJsonObject(items) ? items.properties : null;
  const model = isJsonObject(itemProperties) ? itemProperties.model : null;
  return isJsonObject(model) && typeof model.const === "string"
    ? model.const
    : null;
}

function documentModel(document: unknown): string | null {
  const meta = isJsonObject(document) ? document["serdes/meta"] : null;
  const last = isJsonArray(meta) ? meta[meta.length - 1] : null;
  return isJsonObject(last) && typeof last.model === "string"
    ? last.model
    : null;
}

let failed = 0;
const files = globSync("**/*.yaml", { cwd: EXAMPLES }).sort();
for (const file of files) {
  const document: unknown = yaml.load(
    readFileSync(resolve(EXAMPLES, file), "utf8"),
  );
  const model = documentModel(document);
  const schema = model === null ? undefined : schemaByModel.get(model);
  const validate = schema === undefined ? undefined : ajv.getSchema(schema);
  if (validate === undefined) {
    failed++;
    console.error(`FAIL  ${file}: no schema for model ${model}`);
  } else if (!validate(document)) {
    failed++;
    console.error(`FAIL  ${file}`);
    for (const error of validate.errors ?? []) {
      console.error(`      ${error.instancePath || "/"} ${error.message}`);
    }
  }
}

console.log(`${files.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
