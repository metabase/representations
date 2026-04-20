import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

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
});
