import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { DIALECTS } from "../src/sql-parser.js";
import { IMPORTED_MODELS } from "../src/validate-schema.js";
import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const ROOT = resolve(import.meta.dirname, "..");
const SQL_TOOLS = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
const { sqlTools, sqlglot, importedModels, dialects } = readVendorSources();

/**
 * Metabase's sql_tools/sqlglot/core.clj, in its shape on master, whose
 * driver->dialect maps each driver of `mapped` to its dialect, and each of
 * `same` to its own name.
 */
const coreClj = (
  mapped: Readonly<Record<string, string | null>> = DIALECTS,
  same: readonly string[] = ["postgres", "mysql", "clickhouse"],
): string => {
  const clause = (driver: string, dialect: string | null) =>
    `    :${driver} ${dialect === null ? "nil" : JSON.stringify(dialect)}`;
  return [
    "(ns metabase.sql-tools.sqlglot.core)",
    "",
    "(defn driver->dialect",
    '  "Map a Metabase driver keyword to a SQLGlot dialect string."',
    "  [driver]",
    "  (case driver",
    "    nil                  nil",
    ...same.map((driver) => clause(driver, driver)),
    ...Object.entries(mapped).map(([driver, dialect]) =>
      clause(driver, dialect),
    ),
    "    ;; Default: try using the driver name as dialect",
    "    (name driver)))",
    "",
    ";;;; Tables",
    "",
    "(defn- referenced-tables [driver query])",
    "",
  ].join("\n");
};

const CORE_CLJ = coreClj();
const DIALECTS_STEP =
  "Copy Metabase's driver->dialect into DIALECTS in src/sql-parser.ts, and record the Metabase commit in vendor/sources.json.";

/**
 * Metabase's models.clj, in its shape on master, with `exported` split over
 * two `def`s and the `concat` of `exported-models`, which adds `Setting`.
 */
const modelsClj = (exported: readonly string[]): string => {
  const vector = (models: readonly string[]) =>
    `[${models.map((m) => `"${m}"`).join("\n   ")}]`;
  return [
    '(ns metabase-enterprise.serialization.v2.models\n  "See [[metabase.models.serialization]] for documentation.")',
    `(def data-model\n  "Schema model types"\n  ${vector(exported.slice(0, 2))})`,
    `(def content\n  "Content model types"\n  ${vector(exported.slice(2, 4))})`,
    `(def exported-models\n  "The list of all models exported by serialization by default. Used for production code and by tests."\n  (concat data-model\n          content\n          ${vector([...exported.slice(4), "Setting"])}))`,
    `(def inlined-models\n  "Models inlined into their parent's file."\n  ${vector(["DashboardCard"])})`,
    "",
  ].join("\n\n");
};

const MODELS_CLJ = modelsClj(IMPORTED_MODELS);
const MODELS_STEP =
  "Copy Metabase's exported-models, without Setting, into IMPORTED_MODELS in src/validate-schema.ts, and record the Metabase commit in vendor/sources.json.";

const DOCS_STEP =
  'Then update the "Metabase versions" section of docs/lint.md, which names the Metabase versions the parser matches.';

const pyproject = (pin: string) =>
  `[project]\ndependencies = [\n    "sqlglot==${pin}",\n]\n`;

/** PyPI's JSON record of the vendored SQLGlot version, listing `wheels` with their SHA-256. */
const pypiRecord = (wheels: Record<string, string>) => ({
  urls: Object.entries(wheels).map(([filename, sha256]) => ({
    filename,
    digests: { sha256 },
  })),
});

const PYPI_RECORD = pypiRecord({ [sqlglot.wheel]: sqlglot.sha256 });

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

type Files = Record<string, Uint8Array | string>;

/**
 * Runs the check against a fake raw.githubusercontent.com serving `files` at master and
 * `recorded` at each commit vendor/sources.json records, and a fake PyPI serving `pypi` as the
 * record of the vendored SQLGlot version.
 */
async function runCheck(
  files: Files,
  {
    pypi = PYPI_RECORD,
    recorded = files,
  }: { pypi?: unknown; recorded?: Files } = {},
): Promise<{ exitCode: number; output: string }> {
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/pypi/sqlglot/${sqlglot.version}/json`) {
        return Response.json(pypi);
      }
      const served = (ref: string, refFiles: Files) => {
        const prefix = `/${sqlTools.repository}/${ref}/`;
        return path.startsWith(prefix)
          ? refFiles[path.slice(prefix.length)]
          : undefined;
      };
      const file =
        served("master", files) ??
        served(sqlTools.commit, recorded) ??
        served(importedModels.commit, recorded) ??
        served(dialects.commit, recorded);
      return file === undefined
        ? new Response("404: Not Found", { status: 404 })
        : new Response(file);
    },
  });
  const child = Bun.spawn(
    [
      "bun",
      "run",
      resolve(ROOT, "scripts/check-metabase-sources.ts"),
      "--base-url",
      `http://localhost:${server.port}`,
      "--pypi-url",
      `http://localhost:${server.port}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: output + errors };
}

describe("check-metabase-sources", () => {
  it("passes when sql_tools.py, the SQLGlot pin and the model list equal Metabase's", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ,
    });
    expect(output).not.toContain("FAIL");
    expect(output).toContain(
      "OK    IMPORTED_MODELS is Metabase's exported-models\n",
    );
    expect(output).toContain(
      `OK    IMPORTED_MODELS is Metabase's exported-models ${MODELS_RECORDED}\n`,
    );
    expect(output).toContain("OK    DIALECTS is Metabase's driver->dialect\n");
    expect(output).toContain(
      `OK    DIALECTS is Metabase's driver->dialect ${DIALECTS_RECORDED}\n`,
    );
    expect(exitCode).toBe(0);
  });

  const DIALECTS_RECORDED = `at ${dialects.commit}, the commit vendor/sources.json records`;

  it.each([
    [
      "maps a driver to another dialect",
      coreClj({ ...DIALECTS, sqlserver: "tsql2" }),
      'sqlserver: Metabase "tsql2", DIALECTS "tsql"',
    ],
    [
      "maps a driver the copy lacks",
      coreClj({ ...DIALECTS, oracle: "oracle12" }),
      'oracle: Metabase "oracle12", DIALECTS "oracle"',
    ],
    [
      "no longer maps a driver of the copy",
      coreClj(
        Object.fromEntries(
          Object.entries(DIALECTS).filter(([driver]) => driver !== "vertica"),
        ),
      ),
      'vertica: Metabase "vertica", DIALECTS null',
    ],
  ])(
    "fails when Metabase %s, on master and at the recorded commit",
    async (_, core, difference) => {
      const files = {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
        [dialects.path]: core,
      };
      const { exitCode, output } = await runCheck(files);
      expect(output).toContain(
        `FAIL  DIALECTS differs from Metabase's driver->dialect on master: ${difference}. ${DIALECTS_STEP}`,
      );
      expect(output).toContain(
        `FAIL  DIALECTS differs from Metabase's driver->dialect ${DIALECTS_RECORDED}: ${difference}. ${DIALECTS_STEP}`,
      );
      expect(exitCode).toBe(1);
    },
  );

  it("fails when core.clj holds no driver->dialect it can read", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ.replace("(name driver)))", "(lookup driver)))"),
    });
    expect(output).toContain(
      `FAIL  ${dialects.path} defines no driver->dialect the check can read\n`,
    );
    expect(exitCode).toBe(1);
  });

  it("fails when sql_tools.py differs from Metabase's by one byte", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: new Uint8Array([...SQL_TOOLS, 0x0a]),
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ,
    });
    expect(output).toContain(
      "FAIL  vendor/sql_tools.py differs from Metabase's",
    );
    expect(output).toContain(
      'Run "bun run scripts/update-metabase-sources.ts", which copies the file and records the Metabase commit in vendor/sources.json.',
    );
    expect(output).toContain(DOCS_STEP);
    expect(exitCode).toBe(1);
  });

  it("fails when Metabase pins another SQLGlot", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject("99.0.0"),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ,
    });
    expect(output).toContain(
      `FAIL  Metabase pins sqlglot 99.0.0; vendor/ holds ${sqlglot.version}`,
    );
    expect(output).toContain(DOCS_STEP);
    expect(exitCode).toBe(1);
  });

  const RECORDED = `at ${sqlTools.commit}, the commit vendor/sources.json records`;
  const MODELS_RECORDED = `at ${importedModels.commit}, the commit vendor/sources.json records`;

  it("fails when sql_tools.py differs from Metabase's at the recorded commit, though master's matches", async () => {
    const files = {
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ,
    };
    const { exitCode, output } = await runCheck(files, {
      recorded: {
        ...files,
        [sqlTools.path]: new Uint8Array([...SQL_TOOLS, 0x0a]),
      },
    });
    expect(output).toContain(
      `OK    vendor/sql_tools.py is Metabase's ${sqlTools.path}\n`,
    );
    expect(output).toContain(
      `FAIL  vendor/sql_tools.py differs from Metabase's ${sqlTools.path} ${RECORDED}. Run "bun run scripts/update-metabase-sources.ts", which copies the file and records its commit.`,
    );
    expect(exitCode).toBe(1);
  });

  it.each([
    ["another SQLGlot", pyproject("99.0.0"), "sqlglot 99.0.0"],
    ["no SQLGlot", "[project]\n", "no sqlglot"],
  ])(
    "fails when Metabase's pin at the recorded commit is %s, though master's matches",
    async (_, recordedPyproject, pinned) => {
      const files = {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
        [dialects.path]: CORE_CLJ,
      };
      const { exitCode, output } = await runCheck(files, {
        recorded: { ...files, [sqlglot.pin]: recordedPyproject },
      });
      expect(output).toContain(
        `OK    vendor/ holds sqlglot ${sqlglot.version}, Metabase's pin\n`,
      );
      expect(output).toContain(
        `FAIL  ${sqlglot.pin} ${RECORDED}, pins ${pinned}; vendor/ holds ${sqlglot.version}. Vendor sql_tools.py and the SQLGlot wheel from one Metabase commit, and record that commit in vendor/sources.json.`,
      );
      expect(exitCode).toBe(1);
    },
  );

  it("fails when the vendored wheel's SHA-256 differs from PyPI's", async () => {
    const other = "0".repeat(64);
    const { exitCode, output } = await runCheck(
      {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
      },
      { pypi: pypiRecord({ [sqlglot.wheel]: other }) },
    );
    expect(output).toContain(
      `FAIL  vendor/${sqlglot.wheel} has SHA-256 ${sqlglot.sha256}; PyPI records ${other}`,
    );
    expect(exitCode).toBe(1);
  });

  it("fails when PyPI lists no file of the vendored wheel's name", async () => {
    const { exitCode, output } = await runCheck(
      {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
      },
      { pypi: pypiRecord({ "sqlglot-other.whl": sqlglot.sha256 }) },
    );
    expect(output).toContain(
      `FAIL  PyPI lists no ${sqlglot.wheel} for sqlglot ${sqlglot.version}`,
    );
    expect(exitCode).toBe(1);
  });

  it("fails when sql_tools.py is not found or the pin is missing", async () => {
    const { exitCode, output } = await runCheck({
      [sqlglot.pin]: "[project]\n",
    });
    expect(output).toContain(`FAIL  ${sqlTools.path}: 404`);
    expect(output).toContain(`FAIL  ${sqlglot.pin} pins no sqlglot`);
    expect(output).toContain(`FAIL  ${importedModels.path}: 404`);
    expect(output).toContain(
      `FAIL  ${sqlTools.path} at ${sqlTools.commit}: 404`,
    );
    expect(output).toContain(
      `FAIL  ${sqlglot.pin} ${RECORDED}, pins no sqlglot`,
    );
    expect(output).toContain(
      `FAIL  ${importedModels.path} at ${importedModels.commit}: 404`,
    );
    expect(output).not.toContain(DOCS_STEP);
    expect(exitCode).toBe(1);
  });

  it.each([
    [
      "exports a model the copied list lacks",
      [...IMPORTED_MODELS, "Widget"],
      "missing Widget",
    ],
    [
      "no longer exports a model of the copied list",
      IMPORTED_MODELS.filter((m) => m !== "Action"),
      "extra Action",
    ],
  ])("fails when Metabase %s", async (_, exported, difference) => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: modelsClj(exported),
    });
    expect(output).toContain(
      `FAIL  IMPORTED_MODELS differs from Metabase's exported-models on master: ${difference}. ${MODELS_STEP}`,
    );
    expect(exitCode).toBe(1);
  });

  it.each([
    [
      "exports a model the copied list lacks",
      [...IMPORTED_MODELS, "Widget"],
      "missing Widget",
    ],
    [
      "no longer exports a model of the copied list",
      IMPORTED_MODELS.filter((m) => m !== "Action"),
      "extra Action",
    ],
  ])(
    "fails when Metabase at the recorded commit %s, though master's matches",
    async (_, exported, difference) => {
      const files = {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
        [dialects.path]: CORE_CLJ,
      };
      const { exitCode, output } = await runCheck(files, {
        recorded: { ...files, [importedModels.path]: modelsClj(exported) },
      });
      expect(output).toContain(
        "OK    IMPORTED_MODELS is Metabase's exported-models\n",
      );
      expect(output).toContain(
        `FAIL  IMPORTED_MODELS differs from Metabase's exported-models ${MODELS_RECORDED}: ${difference}. ${MODELS_STEP}`,
      );
      expect(exitCode).toBe(1);
    },
  );

  it("fails when models.clj at the recorded commit holds no exported-models it can read", async () => {
    const files = {
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
      [dialects.path]: CORE_CLJ,
    };
    const { exitCode, output } = await runCheck(files, {
      recorded: {
        ...files,
        [importedModels.path]: MODELS_CLJ.replace(
          "(concat data-model",
          "(concat (other-models)",
        ),
      },
    });
    expect(output).toContain(
      "OK    IMPORTED_MODELS is Metabase's exported-models\n",
    );
    expect(output).toContain(
      `FAIL  ${importedModels.path} ${MODELS_RECORDED}, defines no exported-models the check can read`,
    );
    expect(exitCode).toBe(1);
  });

  it.each([
    [
      "a call it cannot read",
      MODELS_CLJ.replace("(concat data-model", "(concat (other-models)"),
    ],
    [
      "an empty vector",
      MODELS_CLJ.replace(
        /\(def exported-models\n[\s\S]*?\)\)\n/,
        '(def exported-models\n  "None."\n  [])\n',
      ),
    ],
  ])(
    "fails on master and at the recorded commit when exported-models is %s",
    async (_, models) => {
      const { exitCode, output } = await runCheck({
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: models,
      });
      expect(models).not.toBe(MODELS_CLJ);
      expect(output).toContain(
        `FAIL  ${importedModels.path} defines no exported-models the check can read\n`,
      );
      expect(output).toContain(
        `FAIL  ${importedModels.path} ${MODELS_RECORDED}, defines no exported-models the check can read\n`,
      );
      expect(exitCode).toBe(1);
    },
  );

  // Byte for byte on every run: a pull request that edits sql_tools.py fails.
  it("runs, with no condition, on pull requests, pushes to main and daily", () => {
    const workflow = readFileSync(
      resolve(ROOT, ".github/workflows/metabase-sources.yml"),
      "utf8",
    );
    expect(workflow).toContain("  push:\n    branches: [main]\n");
    expect(workflow).toContain("  pull_request:\n");
    expect(workflow).toContain("  schedule:\n");
    expect(workflow).not.toMatch(/^\s+if:/m);
    expect(workflow).toContain(
      "        run: bun run scripts/check-metabase-sources.ts\n",
    );
  });
});
