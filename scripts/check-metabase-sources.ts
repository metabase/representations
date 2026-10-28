// Checks that the vendored SQL parser is still Metabase's: vendor/sql_tools.py
// byte-identical to Metabase's on master, and the vendored SQLGlot wheel the
// version Metabase pins. Reads Metabase's files from GitHub.
//
//   bun run scripts/check-metabase-sources.ts [--base-url URL]
//
// Exits 1 on any difference, and when a file cannot be read.
import { readFileSync } from "fs";
import { parseArgs } from "node:util";
import { resolve } from "path";

import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const { values } = parseArgs({
  options: { "base-url": { type: "string" } },
});
const baseUrl = values["base-url"] ?? "https://raw.githubusercontent.com";
const { sqlTools, sqlglot } = readVendorSources();

const README_STEP =
  'Then update the "Metabase version" section of README.md, which names the Metabase versions the parser matches.';

let failed = false;
const fail = (line: string) => {
  console.log(`FAIL  ${line}`);
  failed = true;
};

/** A file of Metabase's repository on master, or null after a failure. */
async function metabaseFile(path: string): Promise<Uint8Array | null> {
  const response = await fetch(
    `${baseUrl}/${sqlTools.repository}/master/${path}`,
  );
  if (!response.ok) {
    fail(`${path}: ${response.status} ${response.statusText}`);
    return null;
  }
  return new Uint8Array(await response.arrayBuffer());
}

const [metabaseSqlTools, pyproject] = await Promise.all([
  metabaseFile(sqlTools.path),
  metabaseFile(sqlglot.pin),
]);

if (metabaseSqlTools !== null) {
  const vendored = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
  if (Buffer.compare(vendored, metabaseSqlTools) === 0) {
    console.log(`OK    vendor/sql_tools.py is Metabase's ${sqlTools.path}`);
  } else {
    fail(
      `vendor/sql_tools.py differs from Metabase's ${sqlTools.path} on master. ` +
        "Copy it unchanged, and record the Metabase commit in vendor/sources.json. " +
        README_STEP,
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
        README_STEP,
    );
  }
}

process.exit(failed ? 1 : 0);
