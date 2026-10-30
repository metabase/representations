import type { ValidateFunction } from "ajv/dist/2020.js";
import { lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { globSync } from "glob";
import { dirname, resolve } from "path";

import { loadSchemas, type Schemas } from "./schemas.js";
import {
  errorMessage,
  isJavaBlank,
  isRecord,
  isUnknownArray,
  stringOrNull,
} from "./values.js";
import { decodeUtf8, readYaml, type YamlDocument } from "./yaml.js";

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
 * Metabase's file and commit that `importedModels` in `vendor/sources.json`
 * records, except `Setting`, which Metabase reads from `settings.yaml` alone.
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
 * Names match in their exact case, on any platform. A file whose name starts
 * with a dot is skipped; a folder whose name does is not. A file inside a
 * folder that is a symbolic link is skipped, though Metabase follows such a
 * folder; a symbolic link to a file is followed, and one to nothing is
 * skipped, as Metabase skips what is not a regular file.
 */
export function entityFiles(folder: string): string[] {
  const linked = createLinkedFolderCheck(folder);
  // Listed, not globbed by name: on a file system that ignores case, a glob
  // of `transforms/` also finds `TRANSFORMS/`.
  const tops =
    statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true
      ? readdirSync(folder)
      : [];
  return globSync(
    [
      ...tops
        .filter((top) => ENTITY_FOLDERS.includes(top))
        .map((top) => `${top}/**/[!.]*.yaml`),
      ...(tops.includes("data_apps") ? ["data_apps/**/data_app.yaml"] : []),
    ],
    { cwd: folder, dot: true, nodir: true, nocase: false },
  )
    .filter(
      (file) =>
        !linked(dirname(file)) &&
        statSync(resolve(folder, file), { throwIfNoEntry: false })?.isFile() ===
          true,
    )
    .sort();
}

/**
 * Returns whether a folder, by its path relative to `folder`, is a symbolic
 * link or lies inside one.
 */
function createLinkedFolderCheck(folder: string): (dir: string) => boolean {
  const known = new Map<string, boolean>([[".", false]]);
  const linked = (dir: string): boolean => {
    let answer = known.get(dir);
    if (answer === undefined) {
      answer =
        lstatSync(resolve(folder, dir)).isSymbolicLink() ||
        linked(dirname(dir));
      known.set(dir, answer);
    }
    return answer;
  };
  return linked;
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
  // Metabase cannot read the file: it cannot parse a time the file holds.
  | { status: "bad-timestamp"; key: string; message: string }
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
  if (!isUnknownArray(meta) || meta.length === 0) {
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

// The text Metabase's `u.date/parse` reads (`src/metabase/util/date_2/parse.clj`
// `formatter`), approximately: an optional date, `T` or a space, an optional
// time, and an optional offset and zone. Field ranges are checked, but not a
// day past its month's end. A zone must be one JavaScript knows, which differs
// from Java's list: `EST` passes here and fails in Metabase; `UT` and
// `UTC+01:00` fail here and pass in Metabase.
// A year of more than four digits needs a sign.
const DATE =
  "(?:\\d{4}|\\+\\d{5,9}|-\\d{4,9})(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?)?";
// 24:00 is midnight at the day's end.
const TIME =
  "(?:(?:[01]\\d|2[0-3])(?::[0-5]\\d(?::[0-5]\\d(?:\\.\\d{0,9})?)?)?|24(?::00(?::00(?:\\.0{0,9})?)?)?)";
// Java's offsets run from -18:00 to +18:00.
const OFFSET_HOURS =
  "(?:(?:0\\d|1[0-7])(?::[0-5]\\d(?::[0-5]\\d)?|[0-5]\\d)?|18(?::00(?::00)?|00)?)";
const OFFSET = ` ?(?:Z|[+-]${OFFSET_HOURS})?(?:\\[?(?<zone>[A-Za-z][A-Za-z0-9~/._+-]*)\\]?)?`;
const TIMESTAMP_TEXT = new RegExp(
  `^(?:${DATE}T? ?(?:${TIME})?|T? ?${TIME})${OFFSET}$`,
  "i",
);

/** Whether `zone` names a time zone. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
    // eslint-disable-next-line no-restricted-syntax -- reads no SQL
  } catch {
    return false;
  }
}

/**
 * The first top-level key of `doc` whose value Metabase's import cannot read
 * as a time, with why; null when there is none. Metabase reads each key that
 * ends in `_at`, and `last_analyzed`, with `u.date/parse`, which takes null,
 * a blank string, or a date or time in text; on anything else, such as an
 * unquoted YAML timestamp or a number, the file fails to load.
 */
function badTimestamp(doc: unknown): { key: string; message: string } | null {
  if (!isRecord(doc)) {
    return null;
  }
  for (const [key, value] of Object.entries(doc)) {
    if (!key.endsWith("_at") && key !== "last_analyzed") {
      continue;
    }
    if (value === null || (typeof value === "string" && isJavaBlank(value))) {
      continue;
    }
    if (typeof value !== "string") {
      return {
        key,
        message: `${key} is not text, which Metabase reads as a time; quote it`,
      };
    }
    const zone = TIMESTAMP_TEXT.exec(value)?.groups?.zone;
    if (zone === undefined ? !TIMESTAMP_TEXT.test(value) : !isTimeZone(zone)) {
      return {
        key,
        message: `Metabase cannot read ${key} as a time: ${JSON.stringify(value)}`,
      };
    }
  }
  return null;
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
  const text = decodeUtf8(readFileSync(resolve(folder, file)));
  if (text === null) {
    return { file, status: "fail", errors: rootError("not valid UTF-8") };
  }
  let read: YamlDocument;
  try {
    read = readYaml(text);
    const [duplicate] = read.duplicateKeys;
    if (duplicate !== undefined) {
      return {
        file,
        status: "fail",
        errors: rootError(
          `invalid YAML: duplicated mapping key (${duplicate.line}:${duplicate.column})`,
        ),
      };
    }
    // eslint-disable-next-line no-restricted-syntax -- wraps reading a file only
  } catch (e) {
    return {
      file,
      status: "fail",
      errors: rootError(`invalid YAML: ${errorMessage(e)}`),
    };
  }
  const check = checkSchema(read, schemas);
  switch (check.status) {
    case "bad-timestamp":
      return {
        file,
        status: "fail",
        errors: [{ path: `/${check.key}`, message: check.message }],
      };
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

const ENTITY_ID_PATTERN = "common/id.yaml#/$defs/entity_id/pattern";

/** The value at the JSON pointer `pointer` in `doc`, or undefined. */
function valueAt(doc: unknown, pointer: string): unknown {
  let value = doc;
  for (const part of pointer.split("/").slice(1)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    value = isRecord(value)
      ? value[key]
      : isUnknownArray(value)
        ? value[Number(key)]
        : undefined;
  }
  return value;
}

/**
 * Why `value`, at `pointer`, is not an entity id; for the file's own
 * `entity_id`, also how to make one.
 */
function entityIdMessage(value: unknown, pointer: string): string {
  const got =
    typeof value === "string" && value.length !== 21
      ? `got ${value.length} characters`
      : "got a character outside them";
  const message = `must be an entity id: 21 characters of A-Z, a-z, 0-9, _ and -; ${got}`;
  // A fresh id cannot repair a reference to another entity.
  return pointer === "/entity_id"
    ? `${message}. Run "representations generate-entity-id" for a new one`
    : message;
}

// Stands in for a YAML timestamp, which Ajv would take as an object: a
// symbol fails every JSON type.
const TIMESTAMP = Symbol("YAML timestamp");

/** `value` with each `Date` in it replaced by `TIMESTAMP`. */
function withoutDates(value: unknown): unknown {
  if (value instanceof Date) {
    return TIMESTAMP;
  }
  if (isUnknownArray(value)) {
    return value.map(withoutDates);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withoutDates(v)]),
    );
  }
  return value;
}

/** The ways `doc` fails `validate`, in Ajv's order; empty when it passes. */
function validationErrors(
  validate: ValidateFunction,
  doc: unknown,
): ValidationError[] {
  return validate(withoutDates(doc))
    ? []
    : (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "/",
        message:
          e.schemaPath === ENTITY_ID_PATTERN
            ? entityIdMessage(valueAt(doc, e.instancePath), e.instancePath)
            : (e.message ?? ""),
      }));
}

/**
 * How a parsed representation file stands as Metabase imports it, and the
 * ways it fails the schema of its `serdes/meta` model, in Ajv's order.
 */
export function checkSchema(
  { value: doc, nonStringKeys }: Pick<YamlDocument, "value" | "nonStringKeys">,
  { ajv, models }: Schemas,
): SchemaCheck {
  // Metabase's import takes the name of each top-level key to find its times,
  // which fails on a key that is not text.
  const topLevel = nonStringKeys.find((k) => k.path.length === 0);
  if (topLevel !== undefined) {
    return {
      status: "bad-timestamp",
      key: topLevel.source,
      message: `the top-level key ${topLevel.source} is not text, which Metabase requires; quote it`,
    };
  }
  const timestamp = badTimestamp(doc);
  if (timestamp !== null) {
    return { status: "bad-timestamp", ...timestamp };
  }
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
