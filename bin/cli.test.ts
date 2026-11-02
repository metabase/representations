import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = "bin/cli.ts";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd: REPO_ROOT,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  };
}

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
    }, 120_000);
  });
});
