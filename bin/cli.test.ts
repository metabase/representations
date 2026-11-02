import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
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
import { join, relative, resolve } from "path";

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

    it("prints the exit codes and meanings the README lists", () => {
      const { stdout } = runCli(["--help"]);
      const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
      // Code formatting and line breaks aside, the two say the same.
      const normalized = (text: string) =>
        text.replace(/`/g, "").replace(/\s+/g, " ").trim();
      const readmeCodes = [...readme.matchAll(/^\| (\d) \| (.*) \|$/gm)].map(
        (m) => [m[1], normalized(m[2])],
      );
      const helpCodes = [
        ...stdout
          .split("Exit codes:")[1]
          .matchAll(/^ {2}(\d) {2}([\s\S]*?)(?=^ {2}\d {2}|(?![\s\S]))/gm),
      ].map((m) => [m[1], normalized(m[2])]);
      expect(helpCodes.map(([code]) => code)).toEqual(["0", "1", "2"]);
      expect(readmeCodes).toEqual(helpCodes);
    });

    it("links the README section that holds the finding fields and the rules", () => {
      const { stdout } = runCli(["--help"]);
      const anchor = /README\.md#([\w-]+)/.exec(stdout)?.[1];
      const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
      // GitHub's anchor for a heading: lower case, spaces as dashes.
      const sections = readme.split(/^(?=## )/m);
      const linked = sections.find(
        (s) =>
          /^## (.*)$/m.exec(s)?.[1].toLowerCase().replace(/ /g, "-") === anchor,
      );
      expect(linked).toContain("| Field | Value |");
      expect(linked).toContain("### Lint rules");
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

    it("lint exits 2, with the error, when it cannot read a file", () => {
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-unread-"));
      try {
        mkdirSync(join(folder, "collections"));
        const file = join(folder, "collections", "notes.yaml");
        writeFileSync(file, "name: Notes\n");
        chmodSync(file, 0o000);
        const { stdout, stderr, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          folder,
        ]);
        expect(stdout).toBe("");
        expect(stderr).toContain("EACCES");
        expect(exitCode).toBe(2);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("fails a folder it cannot read: validate-schema checks the rest, and lint exits 2", () => {
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-locked-"));
      const locked = join(folder, "collections", "locked");
      try {
        mkdirSync(locked, { recursive: true });
        writeFileSync(
          join(folder, "collections", "c.yaml"),
          "name: C\nserdes/meta:\n- model: Collection\n",
        );
        chmodSync(locked, 0o000);
        const validated = runCli(["validate-schema", "--folder", folder]);
        expect(validated.stderr).toContain("/ cannot read the folder (EACCES)");
        expect(validated.exitCode).toBe(1);
        const linted = runCli(["lint", "--experimental", "--folder", folder]);
        expect(linted.stdout).toBe("");
        expect(linted.stderr).toContain("EACCES");
        expect(linted.exitCode).toBe(2);
      } finally {
        chmodSync(locked, 0o755);
        rmSync(folder, { recursive: true, force: true });
      }
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

    it("escapes control and format characters from the folder on stderr", () => {
      // C0 with a workflow command after a line feed, DEL, C1, the line and
      // paragraph separators, and format characters, one outside the BMP.
      const unsafe =
        "\u001b[31m\u001b]0;x\u0007\r\t\n::error title=x::pwned\u007f\u0085\u009b\u2028\u2029\u202e\u200b\ufeff\u{e0001}";
      const escaped =
        "\\u001b[31m\\u001b]0;x\\u0007\\u000d\\u0009\\u000a::error title=x::pwned\\u007f\\u0085\\u009b\\u2028\\u2029\\u202e\\u200b\\ufeff\\udb40\\udc01";
      const kept = "é中😀\\ ";
      const inYaml = JSON.stringify(unsafe + kept).slice(1, -1);
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-escape-"));
      try {
        mkdirSync(join(folder, "collections"));
        const write = (name: string, text: string) =>
          writeFileSync(join(folder, "collections", name), text);
        write(
          `1${unsafe}${kept}.yaml`,
          `serdes/meta:\n- model: "M${inYaml}"\n`,
        );
        write(`2${unsafe}${kept}.yaml`, `"k${inYaml}_at": 1\n`);
        write(`3${unsafe}${kept}.yaml`, "name: Notes\n");
        const { stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          folder,
        ]);
        const at = relative(REPO_ROOT, join(folder, "collections"));
        const text = escaped + kept;
        expect(stderr.trimEnd().split("\n")).toEqual([
          `FAIL  ${at}/1${text}.yaml (M${text})`,
          `      / unknown model "M${text}"`,
          `FAIL  ${at}/2${text}.yaml`,
          `      /k${text}_at k${text}_at is not text, which Metabase reads as a time; quote it`,
          `WARN  ${at}/3${text}.yaml`,
          "      Metabase skips this file because it has no serdes/meta",
        ]);
        expect(exitCode).toBe(1);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("fails a file it cannot read, naming it escaped on stderr", () => {
      const unsafe = "\u001b]0;x\u0007\n::error::pwned";
      const escaped = "\\u001b]0;x\\u0007\\u000a::error::pwned";
      const folder = mkdtempSync(join(tmpdir(), "representations-cli-locked-"));
      const locked = join(folder, "collections", `a${unsafe}.yaml`);
      try {
        mkdirSync(join(folder, "collections"));
        writeFileSync(locked, "serdes/meta:\n- model: Collection\n");
        chmodSync(locked, 0o000);
        const { stdout, stderr, exitCode } = runCli([
          "validate-schema",
          "--folder",
          folder,
        ]);
        const at = relative(REPO_ROOT, join(folder, "collections"));
        expect(stderr.trimEnd().split("\n")).toEqual([
          `FAIL  ${at}/a${escaped}.yaml`,
          "      / cannot read the file (EACCES)",
        ]);
        expect(stdout.trim()).toBe("0 passed, 1 failed");
        expect(exitCode).toBe(1);
      } finally {
        chmodSync(locked, 0o644);
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

    it("says when the folder is missing, or is a file", () => {
      for (const command of [["validate-schema"], ["lint", "--experimental"]]) {
        const missing = runCli([...command, "--folder", "no/such/folder"]);
        expect(missing.stderr.trim()).toBe("No such folder: no/such/folder");
        expect(missing.exitCode).toBe(2);
        const file = runCli([...command, "--folder", "README.md"]);
        expect(file.stderr.trim()).toBe(
          "Not a folder: README.md. Pass the folder that holds the YAML files.",
        );
        expect(file.exitCode).toBe(2);
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

  // On macOS, Node writes to a pipe asynchronously: output still queued when
  // the process calls process.exit() is lost. The preload queues each line
  // the same way, so a command that exits before its output drains loses it.
  describe("output written after a delay", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-cli-delay-"));
      writeFileSync(
        join(workdir, "delay.ts"),
        [
          "for (const name of ['log', 'error'] as const) {",
          "  const write = console[name].bind(console);",
          "  console[name] = (...args: unknown[]) => {",
          "    setTimeout(() => write(...args), 10);",
          "  };",
          "}",
        ].join("\n"),
      );
      mkdirSync(join(workdir, "folder", "collections"), { recursive: true });
      for (const n of [1, 2, 3]) {
        writeFileSync(
          join(workdir, "folder", "collections", `bad${n}.yaml`),
          "name: [\n",
        );
      }
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    const runDelayed = (args: string[]): RunResult => {
      const proc = Bun.spawnSync({
        cmd: ["bun", "--preload", join(workdir, "delay.ts"), CLI, ...args],
        cwd: REPO_ROOT,
      });
      return {
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        exitCode: proc.exitCode ?? 0,
      };
    };

    it("prints every line before the command exits", () => {
      const folder = join(workdir, "folder");
      const lint = runDelayed(["lint", "--experimental", "--folder", folder]);
      expect(lint.stdout.trim().split("\n")).toHaveLength(3);
      expect(lint.stderr).toContain("3 files, 3 errors, 0 warnings");
      expect(lint.exitCode).toBe(1);

      const validate = runDelayed(["validate-schema", "--folder", folder]);
      expect(validate.stderr.match(/^FAIL /gm)).toHaveLength(3);
      expect(validate.stdout.trim()).toBe("0 passed, 3 failed");
      expect(validate.exitCode).toBe(1);

      const usage = runDelayed(["bogus"]);
      expect(usage.stderr).toContain("Unknown command: bogus");
      expect(usage.exitCode).toBe(2);

      const ids = runDelayed(["generate-uuid", "--count", "3"]);
      expect(ids.stdout.trim().split("\n")).toHaveLength(3);
      expect(ids.exitCode).toBe(0);
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
      "warns, and checks the rest, when a database's default schema is unknown",
      () => {
        mutateExamples("missing-input", workdir);
        rmSync(join(workdir, ".metabase-lint.json"));
        const unknown = runCli(["lint", "--experimental", "--folder", workdir]);
        expect(
          unknown.stdout
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line)),
        ).toEqual([
          expect.objectContaining({
            rule: "missing-default-schema",
            severity: "warning",
            file: "collections/transforms/daily_order_summary.yaml",
          }),
          // No default schema changes this comparison: no input names products.
          expect.objectContaining({
            rule: "missing-input",
            severity: "error",
            file: "collections/transforms/native_transform/product_revenue_report__category_totals.yaml",
          }),
        ]);
        expect(unknown.stderr).toMatch(/ 1 errors, 1 warnings/);
        expect(unknown.exitCode).toBe(1);

        const misspelled = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
          "--default-schema",
          "Sample postgres=public",
        ]);
        expect(misspelled.stderr.trimEnd().split("\n").slice(0, 2)).toEqual([
          '--default-schema: Sample postgres has the default schema "public"',
          "Warning: --default-schema names Sample postgres, which no file in the folder names",
        ]);
        expect(misspelled.exitCode).toBe(1);

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
          `The SQL parser could not start: pyodide, an optional peer dependency, is not installed. Install pyodide@${pinnedPyodide()} where @metabase/representations is installed: npm install pyodide@${pinnedPyodide()}. Under npx, name both packages: npx -p @metabase/representations -p pyodide@${pinnedPyodide()} representations lint --experimental`,
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

    it("refuses a --default-schema with no database name", () => {
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
      const noDatabase = runCli([
        "lint",
        "--experimental",
        "--folder",
        workdir,
        "--default-schema",
        "=public",
      ]);
      expect(noDatabase.stderr).toContain(
        "Invalid --default-schema: =public (expected DATABASE=SCHEMA)",
      );
      expect(noDatabase.exitCode).toBe(2);
    });

    it("refuses a database given twice by --default-schema", () => {
      const { stderr, exitCode } = runCli([
        "lint",
        "--experimental",
        "--folder",
        EXAMPLES,
        "--default-schema",
        "Sample Postgres=public",
        "--default-schema",
        "Sample Postgres=other",
      ]);
      expect(stderr).toContain("--default-schema names Sample Postgres twice");
      expect(exitCode).toBe(2);
    });

    it(
      "echoes each --default-schema and what it overrides, and warns on a database no file names",
      () => {
        const { stderr, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          EXAMPLES,
          "--default-schema",
          "Sample Postgres=public",
          "--default-schema",
          "Sample postgres=",
        ]);
        expect(stderr.trimEnd().split("\n")).toEqual([
          '--default-schema: Sample Postgres has the default schema "public", over "public" in .metabase-lint.json',
          "--default-schema: Sample postgres has the default schema none (no schemas)",
          "Warning: --default-schema names Sample postgres, which no file in the folder names",
          expect.stringMatching(/^\d+ files, 0 errors, 0 warnings$/),
        ]);
        expect(exitCode).toBe(0);
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it("says only that a folder has no YAML files, with --default-schema", () => {
      const { stderr, exitCode } = runCli([
        "lint",
        "--experimental",
        "--folder",
        workdir,
        "--default-schema",
        "Foo=public",
      ]);
      expect(stderr.trimEnd().split("\n")).toEqual([
        `No YAML files found in ${workdir}: Metabase imports only the .yaml files under collections/, databases/, transforms/ and its other top-level folders`,
      ]);
      expect(exitCode).toBe(2);
    });

    it(
      "reads --default-schema DATABASE= as a database with no schemas",
      () => {
        // Product Summary reads products by a reference with a null schema.
        // Only a database with no schemas has such a table, so only a null
        // default schema silences null-schema-reference.
        mutateExamples("null-schema-reference", workdir);
        const lintWith = (defaultSchema: string) => {
          const { stdout, exitCode } = runCli([
            "lint",
            "--experimental",
            "--folder",
            workdir,
            "--default-schema",
            `Sample Postgres=${defaultSchema}`,
          ]);
          return {
            exitCode,
            nullSchemaReference: stdout.includes('"null-schema-reference"'),
          };
        };
        expect(lintWith("public")).toEqual({
          exitCode: 1,
          nullSchemaReference: true,
        });
        expect(lintWith("")).toEqual({
          exitCode: 0,
          nullSchemaReference: false,
        });
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "prints no workflow command and no ESC byte from names in the folder",
      () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const daily = join(
          workdir,
          "collections/transforms/daily_order_summary.yaml",
        );
        const text = readFileSync(daily, "utf8");
        expect(text).toContain("Sample Postgres");
        writeFileSync(
          daily,
          text.replaceAll(
            "Sample Postgres",
            '"Sample Postgres\\n::error title=x::pwned"',
          ),
        );
        writeFileSync(
          join(workdir, "collections/transforms/daily_order_summary_esc.yaml"),
          text
            .replace("7XqqzlsonSq4KFyOvtrAm", "DailyOrderSummaryEsc0")
            .replaceAll("Sample Postgres", '"Esc \\e]0;x\\a"'),
        );
        const names = runCli(["lint", "--experimental", "--folder", workdir]);
        expect(names.stdout).toContain("missing-default-schema");
        expect(names.exitCode).toBe(0);

        cpSync(EXAMPLES, join(workdir, "keys"), { recursive: true });
        writeFileSync(
          join(workdir, "keys", ".metabase-lint.json"),
          JSON.stringify({ "k\n::error title=x::pwned\u001b]0;x\u0007": 1 }),
        );
        const keys = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "keys"),
        ]);
        expect(keys.stderr).toContain("has unknown keys");
        expect(keys.exitCode).toBe(2);

        cpSync(EXAMPLES, join(workdir, "values"), { recursive: true });
        writeFileSync(
          join(workdir, "values", ".metabase-lint.json"),
          JSON.stringify({
            defaultSchemas: {
              "Sample Postgres":
                "public\n::error title=x::pwned\u001b]0;x\u0007",
            },
          }),
        );
        const values = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "values"),
          "--default-schema",
          "Sample Postgres=public",
        ]);
        expect(values.stderr).toContain("over ");

        const unsafe = ({ stdout, stderr }: RunResult) => ({
          workflowCommand: /(^|[\n\r])::/.test(stdout + stderr),
          esc: (stdout + stderr).includes("\u001b"),
        });
        expect({
          names: unsafe(names),
          keys: unsafe(keys),
          values: unsafe(values),
        }).toEqual({
          names: { workflowCommand: false, esc: false },
          keys: { workflowCommand: false, esc: false },
          values: { workflowCommand: false, esc: false },
        });
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "escapes control and format characters from the folder in its output",
      () => {
        // C0 with a workflow command after a line feed, DEL, C1, the line and
        // paragraph separators, and format characters, one outside the BMP.
        const unsafe =
          "\u001b]0;x\u0007\r\t\n::error title=x::pwned\u007f\u0085\u009b\u2028\u2029\u202e\u200b\ufeff\u{e0001}\u00e9";
        const escaped =
          "\\u001b]0;x\\u0007\\r\\t\\n::error title=x::pwned\\u007f\\u0085\\u009b\\u2028\\u2029\\u202e\\u200b\\ufeff\\udb40\\udc01\u00e9";
        // The same text outside a JSON string.
        const escapedRaw =
          "\\u001b]0;x\\u0007\\u000d\\u0009\\u000a::error title=x::pwned\\u007f\\u0085\\u009b\\u2028\\u2029\\u202e\\u200b\\ufeff\\udb40\\udc01\u00e9";
        const inYaml = JSON.stringify(unsafe).slice(1, -1);
        // Each line of the output, as it splits on a line feed, holds no
        // control or format character, and none starts a workflow command.
        const unsafeLines = (output: string) =>
          output
            .split("\n")
            .filter(
              (line) =>
                /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line) ||
                line.startsWith("::"),
            );

        cpSync(EXAMPLES, join(workdir, "names"), { recursive: true });
        const daily = join(
          workdir,
          "names/collections/transforms/daily_order_summary.yaml",
        );
        const text = readFileSync(daily, "utf8");
        expect(text).toContain("Sample Postgres");
        writeFileSync(
          daily,
          text.replaceAll("Sample Postgres", `"Sample Postgres${inYaml}"`),
        );
        const names = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "names"),
        ]);

        cpSync(EXAMPLES, join(workdir, "keys"), { recursive: true });
        writeFileSync(
          join(workdir, "keys", ".metabase-lint.json"),
          JSON.stringify({ [`k${unsafe}`]: 1 }),
        );
        const keys = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "keys"),
        ]);

        cpSync(EXAMPLES, join(workdir, "values"), { recursive: true });
        writeFileSync(
          join(workdir, "values", ".metabase-lint.json"),
          JSON.stringify({ defaultSchemas: { "Sample Postgres": unsafe } }),
        );
        const values = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "values"),
          "--default-schema",
          "Sample Postgres=public",
        ]);

        // A finding names the transform; two transforms that write one table
        // give two duplicate-target warnings.
        cpSync(EXAMPLES, join(workdir, "findings"), { recursive: true });
        const top = readFileSync(
          join(workdir, "findings", TOP_CATEGORIES),
          "utf8",
        );
        expect(top).toContain("entity_id: jf55MTi7z8cWQjPG2PEgz");
        expect(top).toContain("name: Top Categories");
        writeFileSync(
          join(workdir, "findings/collections/transforms/top_copy.yaml"),
          top
            .replace(
              "entity_id: jf55MTi7z8cWQjPG2PEgz",
              "entity_id: TopCategoriesCopy000a",
            )
            .replace("name: Top Categories", `name: "top${inYaml}"`),
        );
        const findings = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "findings"),
        ]);

        // An unexpected error names the file it could not read.
        cpSync(EXAMPLES, join(workdir, "unread"), { recursive: true });
        const unread = join(
          workdir,
          "unread",
          "collections",
          `n${unsafe}.yaml`,
        );
        writeFileSync(unread, "name: Notes\n");
        chmodSync(unread, 0o000);
        const unreadable = runCli([
          "lint",
          "--experimental",
          "--folder",
          join(workdir, "unread"),
        ]);

        // A database name the warning quotes keeps its value.
        const namedDatabase = names.stdout
          .trim()
          .split("\n")
          .filter((line) => line !== "")
          .map((line): unknown => JSON.parse(line))
          .some(
            (f) =>
              isRecord(f) &&
              f.rule === "missing-default-schema" &&
              typeof f.message === "string" &&
              f.message.includes(JSON.stringify(`Sample Postgres${unsafe}`)),
          );

        // The finding keeps its value: a JSON escape stands for the character.
        const findingNames = findings.stdout
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line))
          .map((f) =>
            isRecord(f) && isRecord(f.entity) ? f.entity.name : null,
          );
        expect({
          names: {
            exitCode: names.exitCode,
            named: namedDatabase,
            unsafe: unsafeLines(names.stdout + names.stderr),
          },
          keys: {
            exitCode: keys.exitCode,
            escaped: keys.stderr.includes(`has unknown keys: "k${escaped}"`),
            unsafe: unsafeLines(keys.stderr),
          },
          values: {
            echo: values.stderr.split("\n")[0],
            unsafe: unsafeLines(values.stderr),
          },
          findings: {
            escaped: findings.stdout.includes(`"name":"top${escaped}"`),
            read: findingNames.includes(`top${unsafe}`),
            unsafe: unsafeLines(findings.stdout + findings.stderr),
          },
          unreadable: {
            exitCode: unreadable.exitCode,
            escaped: unreadable.stderr.includes(`n${escapedRaw}.yaml`),
            unsafe: unsafeLines(unreadable.stderr),
          },
        }).toEqual({
          names: { exitCode: 0, named: true, unsafe: [] },
          keys: { exitCode: 2, escaped: true, unsafe: [] },
          values: {
            echo: `--default-schema: Sample Postgres has the default schema "public", over "${escaped}" in .metabase-lint.json`,
            unsafe: [],
          },
          findings: { escaped: true, read: true, unsafe: [] },
          unreadable: { exitCode: 2, escaped: true, unsafe: [] },
        });
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "reports a self-referencing alias in a transform as an error on that file",
      () => {
        cpSync(EXAMPLES, workdir, { recursive: true });
        const file = "collections/transforms/native_transform.yaml";
        writeFileSync(
          join(workdir, file),
          `${readFileSync(join(workdir, file), "utf8")}x: &c {y: *c}\n`,
        );
        const { stdout, stderr, exitCode } = runCli([
          "lint",
          "--experimental",
          "--folder",
          workdir,
        ]);
        expect({
          exitCode,
          stackOverflow: stderr.includes("Maximum call stack size exceeded"),
        }).toEqual({ exitCode: 1, stackOverflow: false });
        expect(
          stdout
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line)),
        ).toContainEqual(expect.objectContaining({ severity: "error", file }));
      },
      LINT_PROCESS_TIMEOUT_MS,
    );

    it(
      "reports a transform file that is a symbolic link as an error, and does not lint its target",
      () => {
        const folder = join(workdir, "repo");
        cpSync(EXAMPLES, folder, { recursive: true });
        const linked = "collections/transforms/linked.yaml";
        const text = readFileSync(join(folder, TOP_CATEGORIES), "utf8")
          .replace("jf55MTi7z8cWQjPG2PEgz", "LinkedTransform000000")
          .replace("name: top_categories", "name: linked_categories");
        expect(text).toContain("LinkedTransform000000");
        expect(text).toContain("name: linked_categories");
        const lintFindings = () => {
          const { stdout, exitCode } = runCli([
            "lint",
            "--experimental",
            "--folder",
            folder,
          ]);
          return {
            exitCode,
            findings: stdout
              .trim()
              .split("\n")
              .filter((line) => line !== "")
              .map((line): unknown => JSON.parse(line)),
          };
        };
        writeFileSync(join(folder, linked), text);
        expect(lintFindings()).toEqual({ exitCode: 0, findings: [] });

        rmSync(join(folder, linked));
        writeFileSync(join(workdir, "outside.yaml"), text);
        symlinkSync(join(workdir, "outside.yaml"), join(folder, linked));
        expect(lintFindings()).toEqual({
          exitCode: 1,
          findings: [
            {
              rule: "schema",
              severity: "error",
              file: linked,
              entity: { model: null, entity_id: null, name: null },
              message:
                "the file is a symbolic link: remote sync reads the link's text, not the file it points to; replace the link with the file",
              related: [],
            },
          ],
        });
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
