import type { ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "fs";
import { globSync } from "glob";
import { resolve } from "path";

import { loadSchemas, type Schemas } from "./schemas.js";
import { errorMessage, isRecord, stringOrNull } from "./values.js";
import { readYaml } from "./yaml.js";

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
 * The `model` of the last `serdes/meta` entry, or null when there is none or
 * it is not a string.
 */
export function getModel(doc: unknown): string | null {
  const meta = isRecord(doc) ? doc["serdes/meta"] : undefined;
  if (!Array.isArray(meta) || meta.length === 0) {
    return null;
  }
  const last: unknown = meta[meta.length - 1];
  return isRecord(last) ? stringOrNull(last.model) : null;
}

/** A failure of the whole file, before any schema check: one error at the root. */
function fileFailure(
  file: string,
  message: string,
  model?: string,
): ValidationResult {
  return {
    file,
    ...(model === undefined ? {} : { model }),
    status: "fail",
    errors: [{ path: "/", message }],
  };
}

/**
 * Checks each file of `folder` under `IMPORT_PATHS`, in path order, against
 * the schema of its model. A file that does not parse as YAML, has no model,
 * or names a model with no schema fails with one error at "/".
 */
export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  return validateFolder(folder, loadSchemas());
}

/** The ways `doc` fails `validate`, in Ajv's order; empty when it passes. */
export function validationErrors(
  validate: ValidateFunction,
  doc: unknown,
): ValidationError[] {
  return validate(doc)
    ? []
    : (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "/",
        message: e.message ?? "",
      }));
}

/** `validateSchema` against schemas the caller has loaded. */
export function validateFolder(
  folder: string,
  { ajv, models }: Schemas,
): ValidateSchemaResult {
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
      doc = readYaml(readFileSync(fullPath, "utf8")).value;
      // eslint-disable-next-line no-restricted-syntax -- wraps reading a file only
    } catch (e) {
      results.push(fileFailure(file, `invalid YAML: ${errorMessage(e)}`));
      continue;
    }

    const model = getModel(doc);
    if (!model) {
      results.push(fileFailure(file, "missing serdes/meta or model"));
      continue;
    }

    const validate = validators[model];
    if (!validate) {
      results.push(fileFailure(file, `unknown model "${model}"`, model));
      continue;
    }

    const errors = validationErrors(validate, doc);
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
