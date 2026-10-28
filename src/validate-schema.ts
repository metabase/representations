import type { ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "fs";
import { globSync } from "glob";
import { resolve } from "path";

import { loadSchemas, type Schemas } from "./schemas.js";
import { errorMessage, isRecord, stringOrNull } from "./values.js";
import { readYaml } from "./yaml.js";

/** The top-level folders whose `.yaml` files Metabase imports, other than `data_apps`. */
const ENTITY_FOLDERS = [
  "actions",
  "channels",
  "collections",
  "custom_viz_plugins",
  "databases",
  "embedding_themes",
  "glossary",
  "metabots",
  "osi_ai_context",
  "python_libraries",
  "python-libraries",
  "snippets",
  "transforms",
];

/**
 * The models whose entity files Metabase imports: `exported-models` in
 * `metabase-enterprise.serialization.v2.models`, at the Metabase commit
 * `vendor/sources.json` records, except `Setting`, which Metabase reads from
 * `settings.yaml` alone.
 */
export const IMPORTED_MODELS = [
  "Action",
  "Card",
  "Channel",
  "Collection",
  "CustomVizPlugin",
  "Dashboard",
  "DataApp",
  "Database",
  "Dimension",
  "Document",
  "EmbeddingTheme",
  "Field",
  "FieldUserSettings",
  "FieldValues",
  "Glossary",
  "Measure",
  "Metabot",
  "NativeQuerySnippet",
  "OsiAiContext",
  "PythonLibrary",
  "Segment",
  "Table",
  "TableUserSettings",
  "Timeline",
  "Transform",
  "TransformJob",
  "TransformTag",
  "TransformTest",
] as const;

const IMPORTED = new Set<string>(IMPORTED_MODELS);

/**
 * The files of `folder` that Metabase imports, in path order: each `.yaml`
 * file at any depth under an `ENTITY_FOLDERS` folder, and each
 * `data_app.yaml` under `data_apps`, whose other files are a data app's own.
 * A file whose name starts with a dot is skipped; a folder whose name does is
 * not.
 */
export function entityFiles(folder: string): string[] {
  return globSync(
    [
      ...ENTITY_FOLDERS.map((top) => `${top}/**/[!.]*.yaml`),
      "data_apps/**/data_app.yaml",
    ],
    { cwd: folder, dot: true, nodir: true },
  ).sort();
}

export type ValidateSchemaOptions = {
  folder: string;
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { file: string; model: string; status: "ok" }
  // A model Metabase imports and no schema describes.
  | { file: string; model: string; status: "unchecked" }
  // A file Metabase skips without an error, and why.
  | { file: string; status: "skipped"; warning: string }
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
  skipped: number;
  unchecked: number;
};

/** How a parsed file stands as Metabase imports it, and against the schema of its model. */
export type SchemaCheck =
  // Metabase skips the file without an error: it has no `serdes/meta`.
  | { status: "skipped" }
  // Metabase reads the file and cannot load it: its `serdes/meta` names no model.
  | { status: "no-model" }
  // Metabase reads the file and cannot load it: it imports no such model.
  | { status: "unknown-model"; model: string }
  // Metabase imports the model, and no schema describes it.
  | { status: "unchecked"; model: string }
  | { status: "checked"; model: string; errors: ValidationError[] };

/**
 * The `model` of the last `serdes/meta` entry, or null when there is none or
 * it is not a string.
 */
function getModel(doc: unknown): string | null {
  const meta = isRecord(doc) ? doc["serdes/meta"] : undefined;
  if (!Array.isArray(meta) || meta.length === 0) {
    return null;
  }
  const last: unknown = meta[meta.length - 1];
  return isRecord(last) ? stringOrNull(last.model) : null;
}

/**
 * Whether Metabase skips `doc`, a parsed file, without an error: the file is
 * empty, or a map whose `serdes/meta` is absent or null.
 */
function skippedByMetabase(doc: unknown): boolean {
  return (
    doc === null || (isRecord(doc) && (doc["serdes/meta"] ?? null) === null)
  );
}

/** One error at the root of the file. */
const rootError = (message: string): ValidationError[] => [
  { path: "/", message },
];

/**
 * Checks each of `entityFiles(folder)`, in path order, against the schema of
 * its model. A file Metabase skips, with no `serdes/meta`, is skipped with a
 * warning. A file of a model Metabase imports and no schema describes is not
 * checked. A file that does not parse as YAML, has no model, or names a model
 * Metabase does not import fails with one error at "/".
 */
export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  const schemas = loadSchemas();
  const results = entityFiles(folder).map((file) =>
    validateFile(folder, file, schemas),
  );
  const count = (status: ValidationResult["status"]): number =>
    results.filter((r) => r.status === status).length;
  return {
    results,
    passed: count("ok"),
    failed: count("fail"),
    skipped: count("skipped"),
    unchecked: count("unchecked"),
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
  const check = checkSchema(doc, schemas);
  switch (check.status) {
    case "skipped":
      return {
        file,
        status: "skipped",
        warning: "Metabase skips this file because it has no serdes/meta",
      };
    case "no-model":
      return {
        file,
        status: "fail",
        errors: rootError("missing serdes/meta or model"),
      };
    case "unknown-model":
      return {
        file,
        model: check.model,
        status: "fail",
        errors: rootError(`unknown model "${check.model}"`),
      };
    case "unchecked":
      return { file, model: check.model, status: "unchecked" };
    case "checked": {
      const { model, errors } = check;
      return errors.length === 0
        ? { file, model, status: "ok" }
        : { file, model, status: "fail", errors };
    }
  }
}

/** The ways `doc` fails `validate`, in Ajv's order; empty when it passes. */
function validationErrors(
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
 * How `doc`, a parsed representation file, stands as Metabase imports it, and
 * the ways it fails the schema of its `serdes/meta` model, in Ajv's order.
 */
export function checkSchema(
  doc: unknown,
  { ajv, models }: Schemas,
): SchemaCheck {
  if (skippedByMetabase(doc)) {
    return { status: "skipped" };
  }
  const model = getModel(doc);
  if (model === null) {
    return { status: "no-model" };
  }
  const file = models.get(model);
  const validate = file === undefined ? undefined : ajv.getSchema(file);
  if (validate !== undefined) {
    return {
      status: "checked",
      model,
      errors: validationErrors(validate, doc),
    };
  }
  return IMPORTED.has(model)
    ? { status: "unchecked", model }
    : { status: "unknown-model", model };
}
