import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "glob";
import yaml from "js-yaml";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

const IMPORT_PATHS = [
  "collections/**/*.yaml",
  "databases/**/segments/**/*.yaml",
  "databases/**/measures/**/*.yaml",
  "python_libraries/**/*.yaml",
  "python-libraries/**/*.yaml",
  "transforms/**/*.yaml",
];

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

export function validateSchema({ folder }) {
  const schemasDir = resolve(PACKAGE_ROOT, "core-spec/v1/schemas");

  const ajv = new Ajv({ allErrors: true, strictTuples: false, allowUnionTypes: true });
  addFormats(ajv);

  // Load common schemas (non-entity schemas referenced via common/ prefix)
  for (const file of globSync("common/*.yaml", { cwd: schemasDir })) {
    const raw = yaml.load(readFileSync(resolve(schemasDir, file), "utf8"));
    const { $schema, ...body } = raw;
    ajv.addSchema(body, file);
  }

  // Load entity schemas
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

  const validators = {};
  for (const [model, schema] of Object.entries(schemas)) {
    validators[model] = ajv.compile(schema);
  }

  const files = globSync(IMPORT_PATHS, { cwd: folder });

  if (files.length === 0) {
    return { results: [], passed: 0, failed: 0 };
  }

  const results = [];

  for (const file of files.sort()) {
    const fullPath = resolve(folder, file);

    let doc;
    try {
      doc = yaml.load(readFileSync(fullPath, "utf8"));
    } catch (e) {
      results.push({ file, status: "fail", errors: [{ path: "/", message: `invalid YAML: ${e.message}` }] });
      continue;
    }

    const model = getModel(doc);
    if (!model) {
      results.push({ file, status: "fail", errors: [{ path: "/", message: "missing serdes/meta or model" }] });
      continue;
    }

    const validate = validators[model];
    if (!validate) {
      results.push({ file, status: "fail", errors: [{ path: "/", message: `unknown model "${model}"` }] });
      continue;
    }

    if (validate(doc)) {
      results.push({ file, model, status: "ok" });
    } else {
      const errors = validate.errors.map((e) => ({
        path: e.instancePath || "/",
        message: e.message,
      }));
      results.push({ file, model, status: "fail", errors });
    }
  }

  return {
    results,
    passed: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
  };
}
