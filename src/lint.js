import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { globSync } from "glob";
import yaml from "js-yaml";
import Ajv from "ajv";
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

  // Load all schemas, keyed by model name
  const schemas = {};
  for (const file of globSync("*.yaml", { cwd: schemasDir })) {
    const raw = yaml.load(readFileSync(resolve(schemasDir, file), "utf8"));
    const model = extractModel(raw);
    if (model) {
      schemas[model] = raw;
    } else {
      console.error(`ERROR schemas/${file} — could not extract model name`);
      process.exit(1);
    }
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

    const schema = schemas[model];
    if (!schema) {
      console.error(`FAIL  ${relPath} — unknown model "${model}"`);
      failed++;
      continue;
    }

    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const { $schema, ...schemaBody } = schema;
    const validate = ajv.compile(schemaBody);
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
