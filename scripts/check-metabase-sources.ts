// Checks that the vendored SQL parser is still Metabase's: vendor/sql_tools.py
// byte-identical to Metabase's on master, and the vendored SQLGlot wheel the
// version Metabase pins, with the SHA-256 PyPI records for it. Reads Metabase's
// files from GitHub and the wheel's record from PyPI.
//
//   bun run scripts/check-metabase-sources.ts [--base-url URL] [--pypi-url URL]
//
// Exits 1 on any difference, and when a file cannot be read.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { parseArgs } from "node:util";
import { resolve } from "path";

import { isRecord } from "../src/values.js";
import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "pypi-url": { type: "string" },
  },
});
const baseUrl = values["base-url"] ?? "https://raw.githubusercontent.com";
const pypiUrl = values["pypi-url"] ?? "https://pypi.org";
const { sqlTools, sqlglot } = readVendorSources();

const DOCS_STEP =
  'Then update the "Metabase versions" section of docs/lint.md, which names the Metabase versions the parser matches.';

let failed = false;
const fail = (line: string) => {
  console.log(`FAIL  ${line}`);
  failed = true;
};

/** The answer to a GET of `url`, or null after a failure, which names `label`. */
async function fetched(url: string, label: string): Promise<Response | null> {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`${label}: ${response.status} ${response.statusText}`);
    return null;
  }
  return response;
}

/** A file of Metabase's repository on master, or null after a failure. */
async function metabaseFile(path: string): Promise<Uint8Array | null> {
  const response = await fetched(
    `${baseUrl}/${sqlTools.repository}/master/${path}`,
    path,
  );
  return response && new Uint8Array(await response.arrayBuffer());
}

/** PyPI's JSON record of the vendored SQLGlot version, or null after a failure. */
async function pypiRecord(): Promise<unknown> {
  const response = await fetched(
    `${pypiUrl}/pypi/sqlglot/${sqlglot.version}/json`,
    `PyPI's record of sqlglot ${sqlglot.version}`,
  );
  return response && response.json();
}

/** The SHA-256 that a PyPI version `record` gives for `filename`, or null when it lists none. */
function pypiSha256(record: unknown, filename: string): string | null {
  const files: unknown[] =
    isRecord(record) && Array.isArray(record.urls) ? record.urls : [];
  const file = files.find(
    (entry) => isRecord(entry) && entry.filename === filename,
  );
  return isRecord(file) &&
    isRecord(file.digests) &&
    typeof file.digests.sha256 === "string"
    ? file.digests.sha256
    : null;
}

const [metabaseSqlTools, pyproject, pypi] = await Promise.all([
  metabaseFile(sqlTools.path),
  metabaseFile(sqlglot.pin),
  pypiRecord(),
]);

if (metabaseSqlTools !== null) {
  const vendored = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
  if (Buffer.compare(vendored, metabaseSqlTools) === 0) {
    console.log(`OK    vendor/sql_tools.py is Metabase's ${sqlTools.path}`);
  } else {
    fail(
      `vendor/sql_tools.py differs from Metabase's ${sqlTools.path} on master. ` +
        "Copy it unchanged, and record the Metabase commit in vendor/sources.json. " +
        DOCS_STEP,
    );
  }
}

if (pyproject !== null) {
  // Metabase's own build reads the pin with a regex, from a line of the form
  // "sqlglot==X.Y.Z".
  const pin = /"sqlglot==([^"]+)"/.exec(new TextDecoder().decode(pyproject));
  if (pin === null) {
    fail(`${sqlglot.pin} pins no sqlglot`);
  } else if (pin[1] === sqlglot.version) {
    console.log(
      `OK    vendor/ holds sqlglot ${sqlglot.version}, Metabase's pin`,
    );
  } else {
    fail(
      `Metabase pins sqlglot ${pin[1]}; vendor/ holds ${sqlglot.version}. ` +
        "Vendor that wheel from PyPI, and update vendor/sources.json. " +
        DOCS_STEP,
    );
  }
}

if (pypi !== null) {
  const recorded = pypiSha256(pypi, sqlglot.wheel);
  const vendored = createHash("sha256")
    .update(readFileSync(resolve(VENDOR_DIR, sqlglot.wheel)))
    .digest("hex");
  if (recorded === null) {
    fail(`PyPI lists no ${sqlglot.wheel} for sqlglot ${sqlglot.version}`);
  } else if (recorded === vendored) {
    console.log(`OK    vendor/${sqlglot.wheel} has PyPI's SHA-256`);
  } else {
    fail(
      `vendor/${sqlglot.wheel} has SHA-256 ${vendored}; PyPI records ${recorded}. ` +
        "Download the wheel from PyPI again, and update vendor/sources.json.",
    );
  }
}

process.exit(failed ? 1 : 0);
