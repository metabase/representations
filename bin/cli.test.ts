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

/** The version of Pyodide, an optional dependency, in `package.json`. */
function pinnedPyodide(): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  );
  return isRecord(manifest) && isRecord(manifest.optionalDependencies)
    ? manifest.optionalDependencies.pyodide
    : undefined;
}

// A lint of a folder with SQL loads the SQL parser in the new process, which
// takes seconds; a test that runs one or two such lints gets this timeout.
const LINT_PROCESS_TIMEOUT_MS = 30_000;

const UUID_REGEX = /^[0-9a-f-]{36}$/i;
const NANOID_REGEX = /^[\w-]{21}$/;

describe("cli", () => {
  describe("help", () => {
    it("prints help and exits 1 with no args", () => {
      const { stdout, exitCode } = runCli([]);
      expect(stdout).toContain("Usage: representations");
      expect(exitCode).toBe(1);
    });

    it("prints help and exits 0 with --help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      expect(stdout).toContain("Usage: representations");
      expect(exitCode).toBe(0);
    });

    it("errors on an unknown command", () => {
      const { stderr, exitCode } = runCli(["bogus"]);
      expect(stderr).toContain("Unknown command: bogus");
      expect(exitCode).toBe(1);
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
      expect(exitCode).toBe(1);
    });

    it("rejects non-integer --count", () => {
      const { stderr, exitCode } = runCli([
        "generate-entity-id",
        "--count",
        "abc",
      ]);
      expect(stderr).toContain("Invalid --count");
      expect(exitCode).toBe(1);
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

    it("errors when the folder has no YAML files", () => {
      const empty = mkdtempSync(join(tmpdir(), "representations-cli-empty-"));
      try {
        const { stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          empty,
        ]);
        expect(exitCode).toBe(1);
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

    it(
      "exits 0 on the bundled examples, printing no finding",
      () => {
        const { stdout, stderr, exitCode } = runCli([
          "lint",
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
        const { stdout, exitCode } = runCli(["lint", "--folder", workdir]);
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
        const refused = runCli(["lint", "--folder", workdir]);
        expect(refused.stdout).toBe("");
        expect(refused.stderr).toContain(
          "Sample Database: names ORDERS without a schema",
        );
        expect(refused.exitCode).toBe(2);

        const given = runCli([
          "lint",
          "--folder",
          workdir,
          "--default-schema",
          "Sample Database=PUBLIC",
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
          ["lint", "--folder", EXAMPLES],
          workdir,
        );
        expect(stdout).toBe("");
        expect(stderr.trimEnd().split("\n")).toEqual([
          `The SQL parser could not start: the optional package pyodide is not installed. Install it with: npm install pyodide@${pinnedPyodide()}`,
        ]);
        expect(exitCode).toBe(2);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it("errors when the folder has no YAML files", () => {
      const { stderr, exitCode } = runCli(["lint", "--folder", workdir]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("No YAML files found");
    });
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
      // documentation; Pyodide comes as an optional dependency, pinned
      // exactly.
      const pack = Bun.spawnSync({
        cmd: ["npm", "pack", "--dry-run", "--json"],
        cwd: REPO_ROOT,
      });
      const packed: unknown = JSON.parse(pack.stdout.toString());
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

      // The built package's lint runs under Node.
      const broken = mkdtempSync(join(tmpdir(), "representations-cli-dist-"));
      try {
        mutateExamples("dangling-transform-id", broken);
        const linted = Bun.spawnSync({
          cmd: [
            "node",
            "--input-type=module",
            "-e",
            `import { lint } from "./dist/src/index.js"; const { findings } = await lint({ folder: ${JSON.stringify(broken)} }); console.log(JSON.stringify(findings.map((f) => f.rule)));`,
          ],
          cwd: REPO_ROOT,
        });
        expect(linted.stderr.toString()).toBe("");
        expect(JSON.parse(linted.stdout.toString())).toEqual([
          "dangling-transform-id",
        ]);
      } finally {
        rmSync(broken, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
