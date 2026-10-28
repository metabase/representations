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

/** One error at the root of the file. */
const rootError = (message: string): ValidationError[] => [
  { path: "/", message },
];

/**
 * Checks each file of `folder` under `IMPORT_PATHS`, in path order, against
 * the schema of its model. A file that does not parse as YAML, has no model,
 * or names a model with no schema fails with one error at "/".
 */
export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  const schemas = loadSchemas();
  const results = globSync(IMPORT_PATHS, { cwd: folder })
    .sort()
    .map((file) => validateFile(folder, file, schemas));
  return {
    results,
    passed: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
  };
}

function validateFile(
  folder: string,
  file: string,
  schemas: Schemas,
): ValidationResult {
  let doc: unknown;
  try {
    doc = readYaml(readFileSync(resolve(folder, file), "utf8")).value;
    // eslint-disable-next-line no-restricted-syntax -- wraps reading a file only
  } catch (e) {
    return {
      file,
      status: "fail",
      errors: rootError(`invalid YAML: ${errorMessage(e)}`),
    };
  }
  const model = getModel(doc);
  const errors = schemaErrors(doc, schemas);
  if (model === null) {
    return { file, status: "fail", errors };
  }
  return errors.length === 0
    ? { file, model, status: "ok" }
    : { file, model, status: "fail", errors };
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

/**
 * The ways `doc`, a parsed representation file, fails the schema of its
 * `serdes/meta` model, in Ajv's order: empty when it passes, one error at "/"
 * when it has no model or its model has no schema.
 */
export function schemaErrors(
  doc: unknown,
  { ajv, models }: Schemas,
): ValidationError[] {
  const model = getModel(doc);
  if (model === null) {
    return rootError("missing serdes/meta or model");
  }
  const file = models.get(model);
  const validate = file === undefined ? undefined : ajv.getSchema(file);
  return validate === undefined
    ? rootError(`unknown model "${model}"`)
    : validationErrors(validate, doc);
}
