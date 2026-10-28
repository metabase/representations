import { readFileSync } from "fs";
import { resolve } from "path";

import { isRecord } from "./values.js";

/** The folder of files copied from elsewhere: SQLGlot's wheel and Metabase's `sql_tools.py`. */
export const VENDOR_DIR = resolve(import.meta.dirname, "..", "vendor");

/** Where each vendored file comes from, as `vendor/sources.json` records it. */
export type VendorSources = {
  /** `sql_tools.py`, copied unchanged from `path` in Metabase's repository at `commit`. */
  sqlTools: { repository: string; path: string; commit: string };
  /** The SQLGlot wheel: the version Metabase pins in `pin`, its file and its SHA-256. */
  sqlglot: { version: string; wheel: string; sha256: string; pin: string };
};

const hasStrings = <K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, string> =>
  isRecord(value) && keys.every((key) => typeof value[key] === "string");

/** `vendor/sources.json`. Throws when it does not have the form `VendorSources` gives. */
export function readVendorSources(): VendorSources {
  const sources: unknown = JSON.parse(
    readFileSync(resolve(VENDOR_DIR, "sources.json"), "utf8"),
  );
  if (
    isRecord(sources) &&
    hasStrings(sources.sqlTools, ["repository", "path", "commit"]) &&
    hasStrings(sources.sqlglot, ["version", "wheel", "sha256", "pin"])
  ) {
    return { sqlTools: sources.sqlTools, sqlglot: sources.sqlglot };
  }
  throw new Error(`${VENDOR_DIR}/sources.json does not name its sources`);
}
