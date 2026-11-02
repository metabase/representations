import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { globSync } from "glob";
import { dirname, resolve } from "path";

import { JAVA_ZONE_REGION_IDS } from "./java-zone-ids.js";
import { loadSchemas, type Schemas } from "./schemas.js";
import {
  errorMessage,
  isJavaBlank,
  isRecord,
  isUnknownArray,
  stringOrNull,
  unescapePointer,
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
 * The files of `folder` that Metabase imports, in path order (their paths
 * relative to `folder`, by UTF-16 code unit, as remote sync's git source sorts
 * them): each `.yaml` file at any depth under an `ENTITY_FOLDERS` folder, and
 * each `data_app.yaml` under `data_apps`, whose other files are a data app's
 * own.
 * Names match in their exact case, on any platform. A file whose name starts
 * with a dot is skipped; a folder whose name does is not. A symbolic link of
 * such a name is listed, whatever it points to, as remote sync lists it; a
 * file inside a folder that is a symbolic link is not, as remote sync does not
 * descend into it. Anything else that is not a regular file is skipped.
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
    .filter((file) => {
      const stats = lstatSync(resolve(folder, file), { throwIfNoEntry: false });
      return (
        !linked(dirname(file)) &&
        (stats?.isFile() === true || stats?.isSymbolicLink() === true)
      );
    })
    .sort();
}

/** A folder `unreadableFolders` could not list, and the error listing it threw. */
export type UnreadableFolder = { folder: string; error: unknown };

/**
 * The folders under the top-level folders `entityFiles` reads whose entries
 * the file system refused to list, by their paths relative to `folder`, in
 * path order. `entityFiles` lists no file inside one. A symbolic link to a
 * folder is not entered.
 */
export function unreadableFolders(folder: string): UnreadableFolder[] {
  const found: UnreadableFolder[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(resolve(folder, dir), { withFileTypes: true });
    } catch (error) {
      found.push({ folder: dir, error });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        visit(`${dir}/${entry.name}`);
      }
    }
  };
  const tops =
    statSync(folder, { throwIfNoEntry: false })?.isDirectory() === true
      ? readdirSync(folder, { withFileTypes: true })
      : [];
  for (const top of tops) {
    if (
      top.isDirectory() &&
      (ENTITY_FOLDERS.includes(top.name) || top.name === "data_apps")
    ) {
      visit(top.name);
    }
  }
  return found.sort((a, b) =>
    a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
  );
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
  // Metabase reads the file and cannot load it: it is not a YAML map.
  | { status: "not-a-map" }
  // Metabase reads the file and cannot load it: its `serdes/meta` names no model.
  | { status: "no-model" }
  // The model is not one of `IMPORTED_MODELS`.
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
 * empty, an empty list or an empty string, or a map whose `serdes/meta` is
 * absent or null.
 */
function skippedByMetabase(doc: unknown): boolean {
  return (
    doc === null ||
    doc === "" ||
    (isUnknownArray(doc) && doc.length === 0) ||
    (isRecord(doc) && (doc["serdes/meta"] ?? null) === null)
  );
}

// The text Metabase's `u.date/parse` reads (`src/metabase/util/date_2/parse.clj`
// `formatter`), approximately: an optional date, `T` or a space, an optional
// time, an optional offset, and the rest, a zone or nothing
// (`javaZoneIdEnd`). Field ranges are checked; Metabase reads a day past its
// month's end as the month's last day. A year of more than four digits needs
// a sign.
const DATE =
  "(?:\\d{4}|\\+\\d{5,9}|-\\d{4,9})(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\\d|3[01]))?)?";
// 24:00 is midnight at the day's end.
const TIME =
  "(?:(?:[01]\\d|2[0-3])(?::[0-5]\\d(?::[0-5]\\d(?:\\.\\d{0,9})?)?)?|24(?::00(?::00(?:\\.0{0,9})?)?)?)";
// Java's offsets run from -18:00 to +18:00.
const OFFSET_HOURS =
  "(?:(?:0\\d|1[0-7])(?::[0-5]\\d(?::[0-5]\\d)?|[0-5]\\d)?|18(?::00(?::00)?|00)?)";
const TIMESTAMP_TEXT = new RegExp(
  `^(?:${DATE}T? ?(?:${TIME})?|T? ?${TIME}) ?(?:Z|[+-]${OFFSET_HOURS})?(?<zone>.*)$`,
  "is",
);

// An offset as Java's `+HH:MM:ss` pattern reads it strictly, within -18:00
// to +18:00: two digits of hours, then optional minutes and seconds, each
// after a colon.
const STRICT_OFFSET = /^[+-](\d\d)(?::([0-5]\d)(?::([0-5]\d))?)?/;

/**
 * Where Java's strict `+HH:MM:ss` offset at `from` in `text` ends; null when
 * there is none, or it is past 18 hours.
 */
function offsetEnd(text: string, from: number): number | null {
  const match = STRICT_OFFSET.exec(text.slice(from));
  if (match === null) {
    return null;
  }
  const [hours, minutes = "0", seconds = "0"] = match.slice(1);
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total > 18 * 3600 ? null : from + match[0].length;
}

/**
 * Where a zone that `UTC`, `GMT` or `UT` starts ends, its prefix ending at
 * `from`: after the offset that follows the prefix, or after the prefix alone
 * when no offset follows. Null for an offset past 18 hours.
 */
function prefixedZoneEnd(text: string, from: number): number | null {
  const next = text[from];
  if (next !== "+" && next !== "-") {
    return from;
  }
  return STRICT_OFFSET.test(text.slice(from)) ? offsetEnd(text, from) : from;
}

/** `JAVA_ZONE_REGION_IDS` in lower case, longest first. */
const REGION_IDS_FOLDED = JAVA_ZONE_REGION_IDS.map((id) =>
  id.toLowerCase(),
).sort((a, b) => b.length - a.length);

/**
 * Where the zone id at the start of `text` ends, as Java's
 * `DateTimeFormatterBuilder.appendZoneRegionId` parses it in Metabase's
 * formatter, which reads it ignoring case: an offset after `+` or `-`; `UTC`,
 * `GMT` or `UT`, each with an optional offset, or `GMT0`; the longest region
 * id of `JAVA_ZONE_REGION_IDS` that starts the text; else `Z`. Null when none
 * of these starts it.
 */
function javaZoneIdEnd(text: string): number | null {
  const folded = text.toLowerCase();
  if (folded.startsWith("+") || folded.startsWith("-")) {
    return offsetEnd(text, 0);
  }
  if (folded.startsWith("utc")) {
    return prefixedZoneEnd(text, 3);
  }
  if (folded.startsWith("ut")) {
    return prefixedZoneEnd(text, 2);
  }
  if (folded.startsWith("gmt")) {
    return text[3] === "0" ? 4 : prefixedZoneEnd(text, 3);
  }
  const region = REGION_IDS_FOLDED.find((id) => folded.startsWith(id));
  if (region !== undefined) {
    return region.length;
  }
  return folded.startsWith("z") ? 1 : null;
}

/**
 * Whether `rest`, the text after a timestamp's date, time and offset, is
 * what Metabase reads there: nothing, or a zone id (`javaZoneIdEnd`), which
 * may be written in square brackets, either of them optional.
 */
function isZoneText(rest: string): boolean {
  if (rest === "") {
    return true;
  }
  const zone = rest.startsWith("[") ? rest.slice(1) : rest;
  const end = javaZoneIdEnd(zone);
  return end !== null && (zone.slice(end) === "" || zone.slice(end) === "]");
}

/**
 * `text` as Metabase's `u.date/parse` normalizes it before parsing: a
 * trailing offset `+HHmm` gets a colon, `+HH:mm`, and a trailing offset
 * `+HH` right after a time gets minutes, `+HH:00`.
 */
function normalizeTimestamp(text: string): string {
  return text
    .replace(/([+-][0-2]\d)([0-5]\d)$/, "$1:$2")
    .replace(
      /([0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?[+-][0-2]\d$)/,
      "$1:00",
    );
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
    const zone = TIMESTAMP_TEXT.exec(normalizeTimestamp(value))?.groups?.zone;
    if (zone === undefined || !isZoneText(zone)) {
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
 * checked. A file that is not valid UTF-8, does not parse as YAML, holds a
 * key twice in one map, is not a map, has no model, or names a model outside
 * `IMPORTED_MODELS` fails with one error at "/". So does a file or a folder
 * (`unreadableFolders`) the file system refuses to read; the others are
 * checked.
 */
export function validateSchema({
  folder,
}: ValidateSchemaOptions): ValidateSchemaResult {
  const schemas = loadSchemas();
  const results = [
    ...unreadableFolders(folder).map(
      ({ folder: file, error }): ValidationResult => ({
        file,
        status: "fail",
        errors: rootError(cannotRead(error, "folder")),
      }),
    ),
    ...entityFiles(folder).map((file) => validateFile(folder, file, schemas)),
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
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

/** Why a symbolic link fails, and what to do. */
export const SYMBOLIC_LINK =
  "a symbolic link: remote sync reads the link's text, not the file it points to; replace the link with the file";

/** An entity file as `readEntityFile` reads it. */
export type EntityFileRead =
  // Remote sync reads a symbolic link's text, the path it holds, and fails.
  | { status: "symbolic-link" }
  // The file system refused to give the file's bytes.
  | { status: "unreadable"; error: unknown }
  | { status: "unparsed"; invalidUtf8: boolean; error: unknown }
  | {
      status: "parsed";
      invalidUtf8: boolean;
      read: YamlDocument;
      check: SchemaCheck;
    };

/**
 * The file `file` of `folder`, one of `entityFiles(folder)`, as Metabase reads
 * it: its bytes decoded as UTF-8 (`decodeUtf8`), the text parsed as YAML
 * (`readYaml`) and checked against its model's schema (`checkSchema`).
 * `invalidUtf8` says whether the bytes held an invalid byte sequence.
 * An `unparsed` file holds the error `readYaml` threw, and an `unreadable`
 * one the error reading its bytes threw. A symbolic link is not read.
 */
export function readEntityFile(
  folder: string,
  file: string,
  schemas: Schemas,
): EntityFileRead {
  const path = resolve(folder, file);
  if (lstatSync(path).isSymbolicLink()) {
    return { status: "symbolic-link" };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { status: "unreadable", error };
  }
  const { text, invalidUtf8 } = decodeUtf8(bytes);
  let read: YamlDocument;
  try {
    read = readYaml(text);
  } catch (error) {
    return { status: "unparsed", invalidUtf8, error };
  }
  return {
    status: "parsed",
    invalidUtf8,
    read,
    check: checkSchema(read, schemas),
  };
}

/**
 * Why a file or folder could not be read: the system error's code, such as
 * `EACCES`, which names no path, or else the error's message.
 */
function cannotRead(error: unknown, what: "file" | "folder" = "file"): string {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return code === null
    ? `cannot read the ${what}: ${errorMessage(error)}`
    : `cannot read the ${what} (${code})`;
}

// This command checks the format: it fails a file with an invalid byte
// sequence or a key written twice, where `lint` warns that Metabase reads
// the file.
function validateFile(
  folder: string,
  file: string,
  schemas: Schemas,
): ValidationResult {
  const entity = readEntityFile(folder, file, schemas);
  if (entity.status === "symbolic-link") {
    return { file, status: "fail", errors: rootError(SYMBOLIC_LINK) };
  }
  if (entity.status === "unreadable") {
    return {
      file,
      status: "fail",
      errors: rootError(cannotRead(entity.error)),
    };
  }
  if (entity.invalidUtf8) {
    return { file, status: "fail", errors: rootError("not valid UTF-8") };
  }
  if (entity.status === "unparsed") {
    return {
      file,
      status: "fail",
      errors: rootError(`invalid YAML: ${errorMessage(entity.error)}`),
    };
  }
  const [duplicate] = entity.read.duplicateKeys;
  if (duplicate !== undefined) {
    return {
      file,
      status: "fail",
      errors: rootError(
        `invalid YAML: duplicated mapping key (${duplicate.line}:${duplicate.column})`,
      ),
    };
  }
  const { check } = entity;
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
    case "not-a-map":
      return { file, status: "fail", errors: rootError("not a YAML map") };
    case "no-model":
      return {
        file,
        status: "fail",
        errors: rootError("serdes/meta names no model"),
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

// A schema names `common/id.yaml` by a path relative to its own file.
const ENTITY_ID_PATTERN = "#/$defs/entity_id/pattern";

/** The value at the JSON pointer `pointer` in `doc`, or undefined. */
function valueAt(doc: unknown, pointer: string): unknown {
  let value = doc;
  for (const part of pointer.split("/").slice(1)) {
    const key = unescapePointer(part);
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
        message: e.schemaPath.endsWith(ENTITY_ID_PATTERN)
          ? entityIdMessage(valueAt(doc, e.instancePath), e.instancePath)
          : `${e.message ?? ""}${allowedValuesOf(e)}`,
      }));
}

/** The values an `enum` or `const` error allows, as `: "a", "b"`; empty for any other error. */
function allowedValuesOf(error: ErrorObject): string {
  const allowed: unknown =
    error.keyword === "enum"
      ? error.params.allowedValues
      : error.keyword === "const"
        ? [error.params.allowedValue]
        : undefined;
  return isUnknownArray(allowed)
    ? `: ${allowed.map((v) => JSON.stringify(v)).join(", ")}`
    : "";
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
  if (!isRecord(doc)) {
    return { status: "not-a-map" };
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
