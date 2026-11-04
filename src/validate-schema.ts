import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { existsSync, readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "path";

const addFormats: FormatsPlugin = createRequire(import.meta.url)("ajv-formats");

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

const IMPORT_PATHS = [
  "actions/**/*.yaml",
  "channels/**/*.yaml",
  "collections/**/*.yaml",
  "custom_viz_plugins/*/custom_viz_plugin.yaml",
  "data_apps/*/data_app.yaml",
  "databases/**/segments/**/*.yaml",
  "databases/**/measures/**/*.yaml",
  "metabots/**/*.yaml",
  "python_libraries/**/*.yaml",
  "python-libraries/**/*.yaml",
  "transforms/**/*.yaml",
];

export type ValidateSchemaOptions = {
  folder: string;
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { file: string; model: string; status: "ok" }
  | {
      file: string;
      model?: string;
      status: "fail";
      errors: ValidationError[];
    };

export type ValidateSchemaResult = {
  results: ValidationResult[];
  passed: number;
  failed: number;
};

// Rules a schema can't express because they reach outside the file: its
// path, or a sibling file. Keyed by model, like the validators.
type Check = (doc: any, fullPath: string) => ValidationError[];

const CHECKS: Record<string, Check> = {
  CustomVizPlugin(doc, fullPath) {
    const errors: ValidationError[] = [];
    const dir = dirname(fullPath);
    const directory = basename(dir);
    if (doc.identifier !== directory) {
      errors.push({
        path: "/identifier",
        message: `must equal the directory's name "${directory}"`,
      });
    }
    if (!existsSync(resolve(dir, "dist", "index.js"))) {
      errors.push({
        path: "/",
        message: "missing dist/index.js beside the entity",
      });
    }

    const manifestPath = resolve(dir, "metabase-plugin.json");
    if (!existsSync(manifestPath)) {
      errors.push({
        path: "/",
        message: "missing metabase-plugin.json beside the entity",
      });
      return errors;
    }
    let name: unknown;
    try {
      name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
    } catch (e: any) {
      errors.push({
        path: "/",
        message: `invalid metabase-plugin.json: ${e.message}`,
      });
      return errors;
    }
    if (name === undefined) {
      errors.push({ path: "/", message: "metabase-plugin.json has no name" });
    } else if (name !== doc.identifier) {
      errors.push({
        path: "/identifier",
        message: `must equal the manifest's name ${JSON.stringify(name)}`,
      });
    }
    return errors;
  },
};

function extractModel(schema: any): string | null {
  const items = schema?.properties?.["serdes/meta"]?.items;
  const props = items?.properties ?? items?.items?.properties;
  return props?.model?.const ?? null;
}

function getModel(doc: any): string | null {
  const meta = doc?.["serdes/meta"];
  if (!Array.isArray(meta) || meta.length === 0) {
    return null;
  }
  return meta[meta.length - 1]?.model ?? null;
}

export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  const schemasDir = resolve(PACKAGE_ROOT, "core-spec/v1/schemas");

  const ajv = new Ajv2020({
    allErrors: true,
    strictTuples: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  for (const file of globSync("common/*.yaml", { cwd: schemasDir })) {
    const raw = yaml.load(
      readFileSync(resolve(schemasDir, file), "utf8"),
    ) as any;
    const { $schema: _$schema, ...body } = raw;
    ajv.addSchema(body, file);
  }

  const schemas: Record<string, any> = {};
  for (const file of globSync("*.yaml", { cwd: schemasDir })) {
    const raw = yaml.load(
      readFileSync(resolve(schemasDir, file), "utf8"),
    ) as any;
    const { $schema: _$schema, ...body } = raw;
    const model = extractModel(raw);
    if (model) {
      schemas[model] = body;
    } else {
      ajv.addSchema(body, file);
    }
  }

  const validators: Record<string, ValidateFunction> = {};
  for (const [model, schema] of Object.entries(schemas)) {
    validators[model] = ajv.compile(schema);
  }

  const files = globSync(IMPORT_PATHS, { cwd: folder });

  if (files.length === 0) {
    return { results: [], passed: 0, failed: 0 };
  }

  const results: ValidationResult[] = [];

  for (const file of files.sort()) {
    const fullPath = resolve(folder, file);

    let doc: any;
    try {
      doc = yaml.load(readFileSync(fullPath, "utf8"));
    } catch (e: any) {
      results.push({
        file,
        status: "fail",
        errors: [{ path: "/", message: `invalid YAML: ${e.message}` }],
      });
      continue;
    }

    const model = getModel(doc);
    if (!model) {
      results.push({
        file,
        status: "fail",
        errors: [{ path: "/", message: "missing serdes/meta or model" }],
      });
      continue;
    }

    const validate = validators[model];
    if (!validate) {
      results.push({
        file,
        status: "fail",
        errors: [{ path: "/", message: `unknown model "${model}"` }],
      });
      continue;
    }

    const errors: ValidationError[] = validate(doc)
      ? []
      : (validate.errors ?? []).map((e) => ({
          path: e.instancePath || "/",
          message: e.message ?? "",
        }));
    errors.push(...(CHECKS[model]?.(doc, fullPath) ?? []));

    results.push(
      errors.length === 0
        ? { file, model, status: "ok" }
        : { file, model, status: "fail", errors },
    );
  }

  return {
    results,
    passed: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
  };
}
