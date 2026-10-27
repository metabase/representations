import type { ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

import { loadSchemas } from "./schemas.js";

/** The files of a folder that Metabase imports, as globs relative to the folder. */
export const IMPORT_PATHS = [
  "actions/**/*.yaml",
  "channels/**/*.yaml",
  "collections/**/*.yaml",
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

/**
 * The `model` of the last `serdes/meta` entry, or null when there is none.
 * Not checked to be a string.
 */
export function getModel(doc: any): string | null {
  const meta = doc?.["serdes/meta"];
  if (!Array.isArray(meta) || meta.length === 0) {
    return null;
  }
  return meta[meta.length - 1]?.model ?? null;
}

/** A failure of the whole file, before any schema check: no model, one error at the root. */
function fileFailure(file: string, message: string): ValidationResult {
  return { file, status: "fail", errors: [{ path: "/", message }] };
}

/**
 * Checks each file of `folder` under `IMPORT_PATHS`, in path order, against
 * the schema of its model. A file that does not parse as YAML, has no model,
 * or names a model with no schema fails with one error at "/".
 */
export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  const { ajv, models } = loadSchemas();

  const validators: Record<string, ValidateFunction> = {};
  for (const [model, file] of models) {
    const validate = ajv.getSchema(file);
    if (validate) {
      validators[model] = validate;
    }
  }

  const files = globSync(IMPORT_PATHS, { cwd: folder });

  if (files.length === 0) {
    return { results: [], passed: 0, failed: 0 };
  }

  const results: ValidationResult[] = [];

  for (const file of files.sort()) {
    const fullPath = resolve(folder, file);

    let doc: unknown;
    try {
      doc = yaml.load(readFileSync(fullPath, "utf8"));
    } catch (e: any) {
      results.push(fileFailure(file, `invalid YAML: ${e.message}`));
      continue;
    }

    const model = getModel(doc);
    if (!model) {
      results.push(fileFailure(file, "missing serdes/meta or model"));
      continue;
    }

    const validate = validators[model];
    if (!validate) {
      results.push(fileFailure(file, `unknown model "${model}"`));
      continue;
    }

    if (validate(doc)) {
      results.push({ file, model, status: "ok" });
    } else {
      const errors = (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "",
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
