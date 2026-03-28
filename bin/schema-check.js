#!/usr/bin/env bun

import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { globSync } from "glob";
import yaml from "js-yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMAS_DIR = resolve(ROOT, "core-spec/v1/schemas");
const EXAMPLES_DIR = resolve(ROOT, "examples/v1");

function extractModel(schema) {
  const items = schema?.properties?.["serdes/meta"]?.items;
  const props = items?.properties ?? items?.items?.properties;
  return props?.model?.const ?? null;
}

// Load all schemas from the schemas folder, keyed by model name
const schemas = {};
for (const file of globSync("*.yaml", { cwd: SCHEMAS_DIR })) {
  const raw = yaml.load(readFileSync(resolve(SCHEMAS_DIR, file), "utf8"));
  const model = extractModel(raw);
  if (model) {
    schemas[model] = raw;
  } else {
    console.error(`ERROR schemas/${file} — could not extract model name`);
    process.exit(1);
  }
}

function getModel(doc) {
  const meta = doc?.["serdes/meta"];
  if (!Array.isArray(meta) || meta.length === 0) return null;
  return meta[meta.length - 1]?.model ?? null;
}

// Find all YAML example files
const files = globSync("**/*.yaml", { cwd: EXAMPLES_DIR });

let passed = 0;
let failed = 0;

for (const file of files.sort()) {
  const fullPath = resolve(EXAMPLES_DIR, file);
  const relPath = relative(ROOT, fullPath);

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
process.exit(failed > 0 ? 1 : 0);
