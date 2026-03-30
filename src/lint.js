import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { globSync } from "glob";
import yaml from "js-yaml";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

function extractModel(schema) {
  const items = schema?.properties?.["serdes/meta"]?.items;
  const props = items?.properties ?? items?.items?.properties;
  return props?.model?.const ?? null;
}

function getModel(doc) {
  const meta = doc?.["serdes/meta"];
  if (!Array.isArray(meta) || meta.length === 0) return null;
  return meta[meta.length - 1]?.model ?? null;
}

export function lint({ version, folder }) {
  const schemasDir = resolve(PACKAGE_ROOT, `core-spec/${version}/schemas`);

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  // Load all schemas — entity schemas (with serdes/meta model) are keyed by
  // model name; shared sub-schemas (query.yaml, parameter.yaml, etc.) are
  // registered by filename for $ref resolution.
  const schemas = {};
  for (const file of globSync("*.yaml", { cwd: schemasDir })) {
    const raw = yaml.load(readFileSync(resolve(schemasDir, file), "utf8"));
    const { $schema, ...body } = raw;
    const model = extractModel(raw);
    if (model) {
      schemas[model] = body;
    } else {
      ajv.addSchema(body, file);
    }
  }

  // Pre-compile validators for each entity schema
  const validators = {};
  for (const [model, schema] of Object.entries(schemas)) {
    validators[model] = ajv.compile(schema);
  }

  // Find all YAML files in folder
  const files = globSync("**/*.yaml", { cwd: folder });

  if (files.length === 0) {
    console.error(`No YAML files found in ${folder}`);
    return 1;
  }

  let passed = 0;
  let failed = 0;

  for (const file of files.sort()) {
    const fullPath = resolve(folder, file);
    const relPath = relative(process.cwd(), fullPath);

    let doc;
    try {
      doc = yaml.load(readFileSync(fullPath, "utf8"));
    } catch (e) {
      console.error(`FAIL  ${relPath} — invalid YAML: ${e.message}`);
      failed++;
      continue;
    }

    const model = getModel(doc);
    if (!model) {
      console.error(`FAIL  ${relPath} — missing serdes/meta or model`);
      failed++;
      continue;
    }

    const validate = validators[model];
    if (!validate) {
      console.error(`FAIL  ${relPath} — unknown model "${model}"`);
      failed++;
      continue;
    }

    const valid = validate(doc);

    if (valid) {
      console.log(`OK    ${relPath} (${model})`);
      passed++;
    } else {
      console.error(`FAIL  ${relPath} (${model})`);
      for (const err of validate.errors) {
        console.error(`      ${err.instancePath || "/"} ${err.message}`);
      }
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}
