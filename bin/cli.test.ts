import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { mutateExamples } from "../src/test-support/lint-mutations.js";
import { isRecord } from "../src/values.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = "bin/cli.ts";
const EXAMPLES = join(REPO_ROOT, "examples", "v1");
const TOP_CATEGORIES = "collections/transforms/top_categories.yaml";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runCli(args: string[], cwd = REPO_ROOT): RunResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  };
}

/** The version of Pyodide, an optional peer dependency, in `package.json`. */
function pinnedPyodide(): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  );
  return isRecord(manifest) && isRecord(manifest.peerDependencies)
    ? manifest.peerDependencies.pyodide
    : undefined;
}

// A lint of a folder with SQL loads the SQL parser in the new process, which
// takes seconds; a test that runs one or two such lints gets this timeout.
const LINT_PROCESS_TIMEOUT_MS = 30_000;

const UUID_REGEX = /^[0-9a-f-]{36}$/i;
const NANOID_REGEX = /^[\w-]{21}$/;

describe("cli", () => {
  describe("help", () => {
    it("prints help and exits 2 with no args", () => {
      const { stdout, exitCode } = runCli([]);
      expect(stdout).toContain("Usage: representations");
      expect(exitCode).toBe(2);
    });

    it("prints help and exits 0 with --help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      expect(stdout).toContain("Usage: representations");
      expect(stdout).toContain("--experimental");
      expect(exitCode).toBe(0);
    });

    it("exits 2 on a usage error, with the message and a pointer to the help", () => {
      for (const [args, message] of [
        [["bogus"], "Unknown command: bogus"],
        [["validate-schema", "--bogus"], "Unknown option '--bogus'"],
        [
          ["validate-schema", "--folder"],
          "Option '--folder <value>' argument missing",
        ],
        [["validate-schema", "extra"], "Unexpected argument: extra"],
      ] as const) {
        const { stdout, stderr, exitCode } = runCli([...args]);
        expect(stdout).toBe("");
        expect(stderr).toContain(message);
        expect(stderr).toContain("See representations --help.");
        expect(stderr).not.toContain("    at ");
        expect(exitCode).toBe(2);
      }
    });

    it("prints the exit codes the README lists", () => {
      const { stdout } = runCli(["--help"]);
      const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
      const readmeCodes = [...readme.matchAll(/^\| (\d) \| /gm)].map(
        (m) => m[1],
      );
      const helpCodes = [
        ...stdout.split("Exit codes:")[1].matchAll(/^ {2}(\d) {2}/gm),
      ].map((m) => m[1]);
      expect(helpCodes).toEqual(["0", "1", "2"]);
      expect(readmeCodes).toEqual(helpCodes);
    });
  });

  describe("generate-entity-id", () => {
    it("prints one NanoID by default", () => {
      const { stdout, exitCode } = runCli(["generate-entity-id"]);
      const lines = stdout.trim().split("\n");
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(NANOID_REGEX);
    });

    it("prints --count lines, each a unique NanoID", () => {
      const { stdout, exitCode } = runCli([
        "generate-entity-id",
        "--count",
        "5",
      ]);
      const lines = stdout.trim().split("\n");
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(5);
      for (const line of lines) {
        expect(line).toMatch(NANOID_REGEX);
      }
      expect(new Set(lines).size).toBe(5);
    });

    it("rejects --count 0", () => {
      const { stderr, exitCode } = runCli([
        "generate-entity-id",
        "--count",
        "0",
      ]);
      expect(stderr).toContain("Invalid --count");
      expect(exitCode).toBe(2);
    });

    it("rejects non-integer --count", () => {
      const { stderr, exitCode } = runCli([
        "generate-entity-id",
        "--count",
        "abc",
      ]);
      expect(stderr).toContain("Invalid --count");
      expect(exitCode).toBe(2);
    });
  });

  describe("generate-uuid", () => {
    it("prints one v4 UUID by default", () => {
      const { stdout, exitCode } = runCli(["generate-uuid"]);
      const lines = stdout.trim().split("\n");
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(UUID_REGEX);
    });

    it("prints --count lines, each a unique UUID", () => {
      const { stdout, exitCode } = runCli(["generate-uuid", "--count", "3"]);
      const lines = stdout.trim().split("\n");
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toMatch(UUID_REGEX);
      }
      expect(new Set(lines).size).toBe(3);
    });
  });

  describe("extract-spec", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-cli-spec-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("copies the spec to --file", () => {
      const target = join(workdir, "spec.md");
      const { stdout, exitCode } = runCli(["extract-spec", "--file", target]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Spec extracted to");
      expect(existsSync(target)).toBe(true);
    });
  });

  describe("extract-schema", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-cli-schema-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("copies schema files to --folder", () => {
      const target = join(workdir, "schemas");
      const { stdout, exitCode } = runCli([
        "extract-schema",
        "--folder",
        target,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Schemas extracted to");
      expect(existsSync(target)).toBe(true);
      expect(readdirSync(target).length).toBeGreaterThan(0);
    });
  });

  describe("validate-schema", () => {
    it("passes on the bundled examples", () => {
      const { stdout, exitCode } = runCli([
        "validate-schema",
        "--folder",
        "examples/v1",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/\d+ passed, 0 failed/);
    });

    it("passes a file Metabase skips, with a warning that names it", () => {
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-skip-"));
      try {
        mkdirSync(join(folder, "collections"));
        writeFileSync(
          join(folder, "collections", "notes.yaml"),
          "name: Notes\n",
        );
        const { stdout, stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          folder,
        ]);
        expect(exitCode).toBe(0);
        expect(stderr.trimEnd().split("\n")).toEqual([
          expect.stringMatching(/^WARN {2}\S*collections\/notes\.yaml$/),
          "      Metabase skips this file because it has no serdes/meta",
        ]);
        expect(stdout.trim()).toBe("0 passed, 0 failed, 1 skipped");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("counts a file of a model no schema describes as not checked", () => {
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-plugin-"));
      try {
        mkdirSync(join(folder, "custom_viz_plugins"));
        writeFileSync(
          join(folder, "custom_viz_plugins", "plugin.yaml"),
          "serdes/meta:\n- model: CustomVizPlugin\n",
        );
        const { stdout, stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          folder,
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(stdout.trim()).toBe("0 passed, 0 failed, 1 not checked");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("errors when the folder has no YAML files", () => {
      const empty = mkdtempSync(join(tmpdir(), "representations-cli-empty-"));
      try {
        const { stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          empty,
        ]);
        expect(exitCode).toBe(2);
        expect(stderr).toContain("No YAML files found");
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("lint", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-cli-lint-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("exits 2 without --experimental, printing no finding", () => {
      mutateExamples("missing-input", workdir);
      const { stdout, stderr, exitCode } = runCli([
        "lint",
        "--folder",
        workdir,
      ]);
      expect(stdout).toBe("");
      expect(stderr.trimEnd().split("\n")).toEqual([
        "lint is experimental: its rules, output and options can change in any release. Rerun with --experimental to run it.",
        "See representations --help.",
      ]);
      expect(exitCode).toBe(2);
    });

    it(
      "exits 0 on the bundled examples, printing no finding",
      () => {
        const { stdout, stderr, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          "examples/v1",
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toBe("");
        expect(stderr).toMatch(/\d+ files, 0 errors, 0 warnings/);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "exits 1 with one JSON line per finding on a broken tree",
      () => {
        mutateExamples("missing-input", workdir);
        const { stdout, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
        ]);
        const errors = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((finding) => finding.severity === "error");
        expect(exitCode).toBe(1);
        expect(errors.map((finding) => finding.rule)).toEqual([
          "missing-input",
        ]);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "exits 0 when two transforms write one table, and reports it as a warning",
      () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const text = readFileSync(join(workdir, TOP_CATEGORIES), "utf8");
        expect(text).toContain("entity_id: jf55MTi7z8cWQjPG2PEgz");
        writeFileSync(
          join(workdir, "collections/transforms/top_categories_copy.yaml"),
          text.replace(
            "entity_id: jf55MTi7z8cWQjPG2PEgz",
            "entity_id: TopCategoriesCopy000a",
          ),
        );
        const { stdout, stderr, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
        ]);
        const findings = stdout
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(findings).toEqual([
          expect.objectContaining({
            rule: "duplicate-target",
            severity: "warning",
          }),
          expect.objectContaining({
            rule: "duplicate-target",
            severity: "warning",
          }),
        ]);
        expect(stderr).toMatch(/ 0 errors, 2 warnings/);
        expect(exitCode).toBe(0);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "exits 2, printing no finding, when a database's default schema is unknown",
      () => {
        mutateExamples("missing-input", workdir);
        rmSync(join(workdir, ".metabase-lint.json"));
        const refused = runCli(["lint", "--experimental", "--folder", workdir]);
        expect(refused.stdout).toBe("");
        expect(refused.stderr.trimEnd().split("\n")).toEqual([
          "The default schema of 1 database(s) is unknown: the schema an unqualified table name resolves to. No check ran.",
          `Give it in .metabase-lint.json at the root of the folder, as {"defaultSchemas": {"<database>": "<schema>"}} (null for a database with no schemas).`,
          "  Sample Postgres: collections/transforms/daily_order_summary.yaml names orders without a schema, so it resolves to the default schema",
          'Or pass --default-schema "<database>=<schema>" for each, "<database>=" for no schemas.',
        ]);
        expect(refused.exitCode).toBe(2);

        const given = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
          "--default-schema",
          "Sample Postgres=public",
        ]);
        expect(given.exitCode).toBe(1);
        expect(
          given.stdout
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line)),
        ).toContainEqual(expect.objectContaining({ rule: "missing-input" }));
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "exits 2, saying why, when the SQL parser cannot start",
      () => {
        // A copy of the package whose dependencies lack pyodide.
        for (const dir of ["bin", "src", "core-spec", "vendor"]) {
          cpSync(join(REPO_ROOT, dir), join(workdir, dir), { recursive: true });
        }
        cpSync(join(REPO_ROOT, "package.json"), join(workdir, "package.json"));
        mkdirSync(join(workdir, "node_modules"));
        for (const name of readdirSync(join(REPO_ROOT, "node_modules"))) {
          if (name !== "pyodide") {
            symlinkSync(
              join(REPO_ROOT, "node_modules", name),
              join(workdir, "node_modules", name),
            );
          }
        }
        const { stdout, stderr, exitCode } = runCli(
          ["lint", "--experimental", "--folder", EXAMPLES],
          workdir,
        );
        expect(stdout).toBe("");
        expect(stderr.trimEnd().split("\n")).toEqual([
          `The SQL parser could not start: pyodide, an optional peer dependency, is not installed. Install pyodide@${pinnedPyodide()} where @metabase/representations is installed: npm install pyodide@${pinnedPyodide()}`,
        ]);
        expect(exitCode).toBe(2);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it("errors when the folder has no YAML files", () => {
      const { stderr, exitCode } = runCli([
        "lint",
        "--experimental",
        "--folder",
        workdir,
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("No YAML files found");
    });

    it("refuses a --default-schema with no database, and reads DATABASE= as no schemas", () => {
      const refused = runCli([
        "lint",
        "--experimental",
        "--folder",
        workdir,
        "--default-schema",
        "bad",
      ]);
      expect(refused.stderr).toContain(
        "Invalid --default-schema: bad (expected DATABASE=SCHEMA)",
      );
      expect(refused.exitCode).toBe(2);
    });

    it(
      "reads --default-schema DATABASE= as a database with no schemas",
      () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const dir = join(workdir, "databases/sample_postgres/tables/orders");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "orders.yaml"),
          [
            "name: orders",
            "db_id: Sample Postgres",
            "schema: null",
            "serdes/meta:",
            "- model: Table",
            "",
          ].join("\n"),
        );
        const { stdout } = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
          "--default-schema",
          "Sample Postgres=",
        ]);
        // The unqualified SQL read of orders is the table file's table with
        // no schema.
        expect(stdout).not.toContain(
          "table orders is defined by no table file",
        );
        expect(stdout).toContain("is defined by no table file");
      },
      LINT_PROCESS_TIMEOUT_MS,
    );
  });

  describe("build", () => {
    it("bundles the current schemas when rebuilt over an existing dist", () => {
      for (let i = 0; i < 2; i++) {
        const build = Bun.spawnSync({
          cmd: ["bun", "run", "build"],
          cwd: REPO_ROOT,
        });
        expect(build.exitCode).toBe(0);
      }

      const proc = Bun.spawnSync({
        cmd: [
          "node",
          "dist/bin/cli.js",
          "validate-schema",
          "--folder",
          "examples/v1",
        ],
        cwd: REPO_ROOT,
      });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(
        readdirSync(join(REPO_ROOT, "dist/core-spec/v1/schemas")).sort(),
      ).toEqual(readdirSync(join(REPO_ROOT, "core-spec/v1/schemas")).sort());

      // The published package carries the SQL parser's files and the lint's
      // documentation; Pyodide is an optional peer dependency, pinned exactly.
      const consumer = mkdtempSync(
        join(tmpdir(), "representations-cli-consumer-"),
      );
      const broken = mkdtempSync(join(tmpdir(), "representations-cli-dist-"));
      try {
        const pack = Bun.spawnSync({
          cmd: ["npm", "pack", "--json", "--pack-destination", consumer],
          cwd: REPO_ROOT,
        });
        expect(pack.exitCode).toBe(0);
        const packed: unknown = JSON.parse(pack.stdout.toString());
        const tarball =
          Array.isArray(packed) &&
          isRecord(packed[0]) &&
          typeof packed[0].filename === "string"
            ? packed[0].filename
            : undefined;
        const packedPaths =
          Array.isArray(packed) &&
          isRecord(packed[0]) &&
          Array.isArray(packed[0].files)
            ? packed[0].files.flatMap((f: unknown) =>
                isRecord(f) && typeof f.path === "string" ? [f.path] : [],
              )
            : [];
        expect(packedPaths).toEqual(
          expect.arrayContaining([
            "dist/src/experimental.js",
            "dist/src/experimental.d.ts",
            "dist/vendor/sources.json",
            "dist/vendor/sql_tools.py",
            "dist/vendor/sqlglot-30.20.0-py3-none-any.whl",
            "docs/lint.md",
          ]),
        );
        expect(pinnedPyodide()).toMatch(/^\d+\.\d+\.\d+$/);

        // The test mutations and the examples they copy stay out of the package.
        expect(
          packedPaths.filter(
            (path) =>
              path.startsWith("dist/examples/") ||
              path.includes("lint-mutations"),
          ),
        ).toEqual([]);

        // A plain install of the package leaves Pyodide out.
        expect(typeof tarball).toBe("string");
        writeFileSync(
          join(consumer, "package.json"),
          JSON.stringify({ name: "consumer", private: true, type: "module" }),
        );
        const npmInstall = (spec: string) =>
          Bun.spawnSync({
            cmd: [
              "npm",
              "install",
              "--prefer-offline",
              "--no-audit",
              "--no-fund",
              spec,
            ],
            cwd: consumer,
          });
        const installed = npmInstall(`./${tarball}`);
        expect(installed.exitCode).toBe(0);
        expect(existsSync(join(consumer, "node_modules", "pyodide"))).toBe(
          false,
        );

        // The main entry has no lint; the experimental entry has it, and its
        // lint runs under Node once the consumer installs Pyodide.
        const withPyodide = npmInstall(`pyodide@${pinnedPyodide()}`);
        expect(withPyodide.exitCode).toBe(0);
        mutateExamples("dangling-transform-id", broken);
        const linted = Bun.spawnSync({
          cmd: [
            "node",
            "--input-type=module",
            "-e",
            `const main = await import("@metabase/representations"); const { lint } = await import("@metabase/representations/experimental"); const { findings } = await lint({ folder: ${JSON.stringify(broken)} }); console.log(JSON.stringify({ mainHasLint: "lint" in main, mainHasValidateSchema: "validateSchema" in main, rules: findings.map((f) => f.rule) }));`,
          ],
          cwd: consumer,
        });
        expect(linted.stderr.toString()).toBe("");
        expect(JSON.parse(linted.stdout.toString())).toEqual({
          mainHasLint: false,
          mainHasValidateSchema: true,
          rules: ["dangling-transform-id"],
        });
      } finally {
        rmSync(consumer, { recursive: true, force: true });
        rmSync(broken, { recursive: true, force: true });
      }
    }, 300_000);
  });
});
