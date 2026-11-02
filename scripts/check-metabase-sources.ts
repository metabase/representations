// Checks that what this package copies from Metabase is still Metabase's:
// vendor/sql_tools.py byte-identical to Metabase's on master and at the commit
// vendor/sources.json records, the vendored SQLGlot wheel the version Metabase
// pins at both, with the SHA-256 PyPI records for it, and IMPORTED_MODELS
// equal to Metabase's exported-models on master without Setting.
// Reads Metabase's files from GitHub and the wheel's record from PyPI.
//
//   bun run scripts/check-metabase-sources.ts [--base-url URL] [--pypi-url URL]
//
// Exits 1 on any difference, and when a file cannot be read.
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { parseArgs } from "node:util";
import { resolve } from "path";

import { IMPORTED_MODELS } from "../src/validate-schema.js";
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
const { sqlTools, sqlglot, importedModels } = readVendorSources();

const DOCS_STEP =
  'Then update the "Metabase versions" section of docs/lint.md, which names the Metabase versions the parser matches.';

const UPDATE_COMMAND = "bun run scripts/update-metabase-sources.ts";

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

/**
 * A file of Metabase's repository at `ref`, a branch or a commit, or null
 * after a failure.
 */
async function metabaseFile(
  path: string,
  ref = "master",
): Promise<Uint8Array | null> {
  const response = await fetched(
    `${baseUrl}/${sqlTools.repository}/${ref}/${path}`,
    ref === "master" ? path : `${path} at ${ref}`,
  );
  return response && new Uint8Array(await response.arrayBuffer());
}

/** The SQLGlot version a Metabase pyproject.toml pins, or null when it pins none. */
function pinnedSqlglot(pyproject: Uint8Array): string | null {
  // Metabase's own build reads the pin with a regex, from a line of the form
  // "sqlglot==X.Y.Z".
  return (
    /"sqlglot==([^"]+)"/.exec(new TextDecoder().decode(pyproject))?.[1] ?? null
  );
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

/**
 * The string vector a `def` of `source`, a Clojure file, evaluates to, when it
 * is a vector of strings or a `concat` of such vectors and of other such
 * `def`s; null otherwise.
 */
function stringVectorDef(source: string, name: string): string[] | null {
  // A top-level form starts at the start of a line; its docstring comes first.
  const form = source
    .split(/^(?=\()/m)
    .find(
      (f) => f.startsWith(`(def ${name}\n`) || f.startsWith(`(def ${name} `),
    );
  if (form === undefined) {
    return null;
  }
  const body = form
    .slice(`(def ${name}`.length)
    .trimStart()
    .replace(/^"(?:[^"\\]|\\.)*"/, "");
  const values: string[] = [];
  for (const [, string, symbol] of body.matchAll(
    /"([^"\\]*)"|([^\s"()[\]]+)/g,
  )) {
    if (string !== undefined) {
      values.push(string);
    } else if (symbol !== "concat") {
      const named = stringVectorDef(source, symbol);
      if (named === null) {
        return null;
      }
      values.push(...named);
    }
  }
  return values;
}

/**
 * How the copied list differs from `exported`, Metabase's exported-models:
 * the models it lacks and the models it holds besides, ignoring `Setting`,
 * which Metabase reads from settings.yaml alone.
 */
function modelDifferences(exported: readonly string[]): string[] {
  const copied = new Set<string>(IMPORTED_MODELS);
  const metabase = new Set(exported.filter((m) => m !== "Setting"));
  return [
    ...[...metabase].filter((m) => !copied.has(m)).map((m) => `missing ${m}`),
    ...[...copied].filter((m) => !metabase.has(m)).map((m) => `extra ${m}`),
  ];
}

const [
  metabaseSqlTools,
  pyproject,
  modelsClj,
  pypi,
  recordedSqlTools,
  recordedPyproject,
] = await Promise.all([
  metabaseFile(sqlTools.path),
  metabaseFile(sqlglot.pin),
  metabaseFile(importedModels.path),
  pypiRecord(),
  metabaseFile(sqlTools.path, sqlTools.commit),
  metabaseFile(sqlglot.pin, sqlTools.commit),
]);

const RECORDED = `at ${sqlTools.commit}, the commit vendor/sources.json records`;

if (metabaseSqlTools !== null) {
  const vendored = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
  if (Buffer.compare(vendored, metabaseSqlTools) === 0) {
    console.log(`OK    vendor/sql_tools.py is Metabase's ${sqlTools.path}`);
  } else {
    fail(
      `vendor/sql_tools.py differs from Metabase's ${sqlTools.path} on master. ` +
        `Run "${UPDATE_COMMAND}", which copies the file and records the Metabase commit in vendor/sources.json. ` +
        DOCS_STEP,
    );
  }
}

if (recordedSqlTools !== null) {
  const vendored = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
  if (Buffer.compare(vendored, recordedSqlTools) === 0) {
    console.log(
      `OK    vendor/sql_tools.py is Metabase's ${sqlTools.path} ${RECORDED}`,
    );
  } else {
    fail(
      `vendor/sql_tools.py differs from Metabase's ${sqlTools.path} ${RECORDED}. ` +
        `Run "${UPDATE_COMMAND}", which copies the file and records its commit.`,
    );
  }
}

if (pyproject !== null) {
  const pin = pinnedSqlglot(pyproject);
  if (pin === null) {
    fail(`${sqlglot.pin} pins no sqlglot`);
  } else if (pin === sqlglot.version) {
    console.log(
      `OK    vendor/ holds sqlglot ${sqlglot.version}, Metabase's pin`,
    );
  } else {
    fail(
      `Metabase pins sqlglot ${pin}; vendor/ holds ${sqlglot.version}. ` +
        "Vendor that wheel from PyPI, and update vendor/sources.json. " +
        DOCS_STEP,
    );
  }
}

if (recordedPyproject !== null) {
  const pin = pinnedSqlglot(recordedPyproject);
  if (pin === sqlglot.version) {
    console.log(
      `OK    vendor/ holds sqlglot ${sqlglot.version}, Metabase's pin ${RECORDED}`,
    );
  } else {
    fail(
      `${sqlglot.pin} ${RECORDED}, pins ${pin === null ? "no sqlglot" : `sqlglot ${pin}`}; vendor/ holds ${sqlglot.version}. ` +
        "Vendor sql_tools.py and the SQLGlot wheel from one Metabase commit, and record that commit in vendor/sources.json.",
    );
  }
}

if (modelsClj !== null) {
  const exported = stringVectorDef(
    new TextDecoder().decode(modelsClj),
    "exported-models",
  );
  if (exported === null || exported.length === 0) {
    fail(
      `${importedModels.path} defines no exported-models the check can read`,
    );
  } else {
    const differences = modelDifferences(exported);
    if (differences.length === 0) {
      console.log("OK    IMPORTED_MODELS is Metabase's exported-models");
    } else {
      fail(
        `IMPORTED_MODELS differs from Metabase's exported-models on master: ${differences.join(", ")}. ` +
          "Copy Metabase's exported-models, without Setting, into IMPORTED_MODELS in src/validate-schema.ts, " +
          "and record the Metabase commit in vendor/sources.json.",
      );
    }
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
