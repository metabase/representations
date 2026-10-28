import { readFileSync } from "fs";
import { resolve } from "path";

/** The folder of files copied from elsewhere: SQLGlot's wheel and Metabase's `sql_tools.py`. */
export const VENDOR_DIR = resolve(import.meta.dirname, "..", "vendor");

/** Where each vendored file comes from, as `vendor/sources.json` records it. */
export type VendorSources = {
  /** `sql_tools.py`, copied unchanged from `path` in Metabase's repository at `commit`. */
  sqlTools: { repository: string; path: string; commit: string };
  /** The SQLGlot wheel: the version Metabase pins in `pin`, its file and its SHA-256. */
  sqlglot: { version: string; wheel: string; sha256: string; pin: string };
};

/** `vendor/sources.json`. */
export function readVendorSources(): VendorSources {
  return JSON.parse(
    readFileSync(resolve(VENDOR_DIR, "sources.json"), "utf8"),
  ) as VendorSources;
}
