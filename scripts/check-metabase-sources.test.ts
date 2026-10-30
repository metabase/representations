import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { IMPORTED_MODELS } from "../src/validate-schema.js";
import { readVendorSources, VENDOR_DIR } from "../src/vendor-sources.js";

const ROOT = resolve(import.meta.dirname, "..");
const SQL_TOOLS = readFileSync(resolve(VENDOR_DIR, "sql_tools.py"));
const { sqlTools, sqlglot, importedModels } = readVendorSources();

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

/**
 * Runs the check against a fake raw.githubusercontent.com serving `files` at master, and a fake
 * PyPI serving `pypi` as the record of the vendored SQLGlot version.
 */
async function runCheck(
  files: Record<string, Uint8Array | string>,
  pypi: unknown = PYPI_RECORD,
  flags: readonly string[] = [],
): Promise<{ exitCode: number; output: string }> {
  server?.stop(true);
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === `/pypi/sqlglot/${sqlglot.version}/json`) {
        return Response.json(pypi);
      }
      const prefix = `/${sqlTools.repository}/master/`;
      const file = path.startsWith(prefix)
        ? files[path.slice(prefix.length)]
        : undefined;
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
      ...flags,
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
    });
    expect(output).not.toContain("FAIL");
    expect(exitCode).toBe(0);
  });

  it("fails when sql_tools.py differs from Metabase's by one byte", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: new Uint8Array([...SQL_TOOLS, 0x0a]),
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
    });
    expect(output).toContain(
      "FAIL  vendor/sql_tools.py differs from Metabase's",
    );
    expect(output).toContain(
      'The "Metabase versions" section of docs/lint.md says which Metabase versions the copy matches.',
    );
    expect(output).toContain(DOCS_STEP);
    expect(exitCode).toBe(1);
  });

  it("with --skip-sql-tools, passes over a different sql_tools.py and still checks the rest", async () => {
    const files = {
      [sqlTools.path]: new Uint8Array([...SQL_TOOLS, 0x0a]),
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ,
    };
    const skipped = await runCheck(files, PYPI_RECORD, ["--skip-sql-tools"]);
    expect(skipped.output).toContain(
      "SKIP  vendor/sql_tools.py is not compared with Metabase's",
    );
    expect(skipped.output).not.toContain("FAIL");
    expect(skipped.exitCode).toBe(0);

    const pinned = await runCheck(
      { ...files, [sqlglot.pin]: pyproject("99.0.0") },
      PYPI_RECORD,
      ["--skip-sql-tools"],
    );
    expect(pinned.output).toContain("FAIL  Metabase pins sqlglot 99.0.0");
    expect(pinned.exitCode).toBe(1);
  });

  it("fails when Metabase pins another SQLGlot", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject("99.0.0"),
      [importedModels.path]: MODELS_CLJ,
    });
    expect(output).toContain(
      `FAIL  Metabase pins sqlglot 99.0.0; vendor/ holds ${sqlglot.version}`,
    );
    expect(output).toContain(DOCS_STEP);
    expect(exitCode).toBe(1);
  });

  it("fails when the vendored wheel's SHA-256 differs from PyPI's", async () => {
    const other = "0".repeat(64);
    const { exitCode, output } = await runCheck(
      {
        [sqlTools.path]: SQL_TOOLS,
        [sqlglot.pin]: pyproject(sqlglot.version),
        [importedModels.path]: MODELS_CLJ,
      },
      pypiRecord({ [sqlglot.wheel]: other }),
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
      pypiRecord({ "sqlglot-other.whl": sqlglot.sha256 }),
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

  it("fails when models.clj holds no exported-models it can read", async () => {
    const { exitCode, output } = await runCheck({
      [sqlTools.path]: SQL_TOOLS,
      [sqlglot.pin]: pyproject(sqlglot.version),
      [importedModels.path]: MODELS_CLJ.replace(
        "(concat data-model",
        "(concat (other-models)",
      ),
    });
    expect(output).toContain(
      `FAIL  ${importedModels.path} defines no exported-models the check can read`,
    );
    expect(exitCode).toBe(1);
  });
});
