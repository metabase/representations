// Copies Metabase's sql_tools.py on master into vendor/, unchanged, records the
// Metabase commit it came from in vendor/sources.json, and prints what changed.
// Reads the commit from GitHub's API, then the file at that commit.
//
//   bun run scripts/update-metabase-sources.ts [--vendor-dir DIR] [--base-url URL] [--api-url URL]
//
// Exits 1 when Metabase's commit or file cannot be read; vendor/ is then unchanged.
import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "node:util";
import { resolve } from "path";

import { isRecord } from "../src/values.js";
import { VENDOR_DIR } from "../src/vendor-sources.js";

const { values } = parseArgs({
  options: {
    "vendor-dir": { type: "string" },
    "base-url": { type: "string" },
    "api-url": { type: "string" },
  },
});
const vendorDir = values["vendor-dir"] ?? VENDOR_DIR;
const baseUrl = values["base-url"] ?? "https://raw.githubusercontent.com";
const apiUrl = values["api-url"] ?? "https://api.github.com";

const sourcesPath = resolve(vendorDir, "sources.json");
const sources: unknown = JSON.parse(readFileSync(sourcesPath, "utf8"));
const sqlTools = isRecord(sources) ? sources.sqlTools : undefined;
if (
  !isRecord(sources) ||
  !isRecord(sqlTools) ||
  typeof sqlTools.repository !== "string" ||
  typeof sqlTools.path !== "string" ||
  typeof sqlTools.commit !== "string"
) {
  console.error(
    `${sourcesPath} records no sqlTools repository, path and commit`,
  );
  process.exit(1);
}
const { repository, path, commit: recorded } = sqlTools;

/** The body of a GET of `url`; exits 1, naming `label`, when it fails. */
async function get(
  url: string,
  label: string,
  accept?: string,
): Promise<Response> {
  const response = await fetch(
    url,
    accept === undefined ? {} : { headers: { accept } },
  );
  if (!response.ok) {
    console.error(`${label}: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  return response;
}

const commit = (
  await (
    await get(
      `${apiUrl}/repos/${repository}/commits/master`,
      `${repository}'s master commit`,
      "application/vnd.github.sha",
    )
  ).text()
).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`${repository}'s master commit is not a commit id: ${commit}`);
  process.exit(1);
}
const copied = new Uint8Array(
  await (
    await get(`${baseUrl}/${repository}/${commit}/${path}`, path)
  ).arrayBuffer(),
);

const vendoredPath = resolve(vendorDir, "sql_tools.py");
const vendored = readFileSync(vendoredPath);
if (Buffer.compare(vendored, copied) === 0) {
  console.log(
    `vendor/sql_tools.py: unchanged, Metabase's ${path} at ${commit}`,
  );
} else {
  writeFileSync(vendoredPath, copied);
  console.log(
    `vendor/sql_tools.py: copied Metabase's ${path} at ${commit} (${vendored.length} bytes before, ${copied.length} after)`,
  );
}
if (commit === recorded) {
  console.log(`vendor/sources.json: sqlTools.commit unchanged, ${commit}`);
} else {
  writeFileSync(
    sourcesPath,
    `${JSON.stringify({ ...sources, sqlTools: { ...sqlTools, commit } }, null, 2)}\n`,
  );
  console.log(`vendor/sources.json: sqlTools.commit ${recorded} -> ${commit}`);
}
console.log(
  'Review the change with "git diff vendor/", run the tests, and update the "Metabase versions" section of docs/lint.md if the versions it names no longer match.',
);
