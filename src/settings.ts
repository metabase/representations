import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { isRecord } from "./values.js";

/** The file, at the root of the linted folder, that gives the lint's settings. */
export const CONFIG_FILE = ".metabase-lint.json";

/** The lint cannot run: its settings are missing or invalid. */
export class LintSetupError extends Error {
  override name = "LintSetupError";
}

/** What `CONFIG_FILE` gives, each by database name. */
export type LintSettings = {
  /** Each database's default schema; null for a database with no schemas. */
  defaultSchemas: Readonly<Record<string, string | null>>;
  /** Each database's engine, Metabase's driver name, such as `postgres`. */
  engines: Readonly<Record<string, string>>;
};

const isMapOf = <T>(
  value: unknown,
  isValue: (v: unknown) => v is T,
): value is Readonly<Record<string, T>> =>
  isRecord(value) && Object.values(value).every(isValue);

const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

const SETTINGS_KEYS = new Set(["defaultSchemas", "engines"]);

/**
 * The settings `CONFIG_FILE` in `folder` gives; none when there is no such
 * file. Throws a `LintSetupError` when the file is not a JSON object of the
 * form `{"defaultSchemas": {"<database>": "<schema>" | null}, "engines":
 * {"<database>": "<engine>"}}`, each key optional.
 */
export function readSettingsFile(folder: string): LintSettings {
  const path = resolve(folder, CONFIG_FILE);
  if (!existsSync(path)) {
    return { defaultSchemas: {}, engines: {} };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
    // eslint-disable-next-line no-restricted-syntax -- wraps reading a file only
  } catch (e) {
    throw new LintSetupError(
      `${CONFIG_FILE} does not parse as JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(settings)) {
    throw new LintSetupError(`${CONFIG_FILE} is not a JSON object`);
  }
  const unknownKeys = Object.keys(settings).filter(
    (key) => !SETTINGS_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new LintSetupError(
      `${CONFIG_FILE} has unknown keys: ${unknownKeys.join(", ")}`,
    );
  }
  const { defaultSchemas = {}, engines = {} } = settings;
  if (!isMapOf(defaultSchemas, isStringOrNull)) {
    throw new LintSetupError(
      `${CONFIG_FILE}: defaultSchemas must map each database name to a schema name or null`,
    );
  }
  if (!isMapOf(engines, isString)) {
    throw new LintSetupError(
      `${CONFIG_FILE}: engines must map each database name to an engine name`,
    );
  }
  return { defaultSchemas, engines };
}
