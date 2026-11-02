import { readFileSync } from "fs";
import { resolve } from "path";

import { isRecord } from "./values.js";

/** The folder of files copied from elsewhere, SQLGlot's wheel and Metabase's `sql_tools.py`, and the record of their sources. */
export const VENDOR_DIR = resolve(import.meta.dirname, "..", "vendor");

/** Where each vendored file comes from, as `vendor/sources.json` records it. */
type VendorSources = {
  /** `sql_tools.py`, copied unchanged from `path` in Metabase's repository at `commit`. */
  sqlTools: { repository: string; path: string; commit: string };
  /** `IMPORTED_MODELS`, copied from `exported-models` in `path` in Metabase's repository at `commit`. */
  importedModels: { repository: string; path: string; commit: string };
  /** `DIALECTS` in `src/sql-parser.ts`, copied from `driver->dialect` in `path` in Metabase's repository at `commit`. */
  dialects: { repository: string; path: string; commit: string };
  /** The SQLGlot wheel: the version Metabase pins in `pin`, its file and its SHA-256. */
  sqlglot: { version: string; wheel: string; sha256: string; pin: string };
};

/** Whether `value` is a map with a string at each of `keys`. */
const hasStrings = <K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, string> =>
  isRecord(value) && keys.every((key) => typeof value[key] === "string");

const SOURCE_KEYS = ["repository", "path", "commit"] as const;

/**
 * `sources.json` in `vendorDir`, with any keys it holds beside those of
 * `VendorSources`. Throws when the file cannot be read, is not JSON, or lacks
 * a string that `VendorSources` names.
 */
export function readVendorSources(
  vendorDir: string = VENDOR_DIR,
): VendorSources & Record<string, unknown> {
  const file = resolve(vendorDir, "sources.json");
  const sources: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(sources)) {
    throw new Error(`${file} is not a JSON map`);
  }
  const { sqlTools, importedModels, dialects, sqlglot } = sources;
  if (
    !hasStrings(sqlTools, SOURCE_KEYS) ||
    !hasStrings(importedModels, SOURCE_KEYS) ||
    !hasStrings(dialects, SOURCE_KEYS) ||
    !hasStrings(sqlglot, ["version", "wheel", "sha256", "pin"])
  ) {
    throw new Error(
      `${file} does not record the sources of sqlTools, importedModels, dialects and sqlglot`,
    );
  }
  return { ...sources, sqlTools, importedModels, dialects, sqlglot };
}
