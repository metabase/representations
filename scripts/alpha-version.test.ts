import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { resolve } from "path";

const SCRIPT = resolve(import.meta.dirname, "alpha-version.sh");

// The grammar from semver.org, without build metadata. A prerelease
// identifier of digits alone must not start with 0, and none may be empty.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

function alphaVersion(
  branch: string,
  shortSha: string,
): { version: string; tag: string } {
  const proc = Bun.spawnSync({
    cmd: ["bash", SCRIPT, "1.6.1", branch, shortSha],
  });
  expect(proc.exitCode).toBe(0);
  const outputs = new Map(
    proc.stdout
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
  return {
    version: outputs.get("version") ?? "",
    tag: outputs.get("tag") ?? "",
  };
}

/** The branch's hash suffix: 7 hex digits of the SHA-256 of its name. */
const hashOf = (branch: string) =>
  createHash("sha256").update(branch).digest("hex").slice(0, 7);

describe("alpha-version.sh", () => {
  it("rejects what semver rejects (control for the grammar)", () => {
    expect("1.6.1-alpha.main.0123456").not.toMatch(SEMVER);
    expect("1.6.1-alpha..abc1234").not.toMatch(SEMVER);
    expect("1.6.1-alpha.main.abc1234").toMatch(SEMVER);
  });

  it.each([
    [
      "an ordinary branch",
      "galdre/Reference-Lint",
      "70fe3a4",
      "galdre-reference-lint",
    ],
    ["a SHA of digits with a leading zero", "main", "0123456", "main"],
    ["a branch of digits with a leading zero", "0123", "abc1234", "0123"],
    ["a branch with no letter or digit", "_/_", "abc1234", "unnamed"],
    ["a branch holding shell syntax", "a$(id)`id`", "abc1234", "a-id-id"],
    [
      "a branch whose slug is longer than 64 characters",
      `feature/${"a".repeat(240)}`,
      "abc1234",
      `feature-${"a".repeat(56)}`,
    ],
    [
      "a branch whose slug has a hyphen at character 64",
      `${"a".repeat(63)}/b`,
      "abc1234",
      "a".repeat(63),
    ],
  ])("gives a valid version for %s", (_, branch, sha, slug) => {
    const outputs = alphaVersion(branch, sha);
    expect(outputs.version).toMatch(SEMVER);
    const id = `${slug}-${hashOf(branch)}`;
    expect(outputs).toEqual({
      version: `1.6.1-alpha.br-${id}.sha-${sha}`,
      tag: `alpha-${id}`,
    });
  });

  it("hashes a fixed branch to known hex digits (control for the hash)", () => {
    // printf '%s' main | shasum -a 256
    expect(hashOf("main")).toBe("0d6e407");
  });

  it("gives branches with the same slug different dist-tags", () => {
    const tags = ["feat/x", "feat-x", "Feat_X"].map(
      (branch) => alphaVersion(branch, "abc1234").tag,
    );
    expect(tags.every((tag) => tag.startsWith("alpha-feat-x-"))).toBe(true);
    expect(new Set(tags).size).toBe(3);
  });

  it("refuses a base version that is not X.Y.Z, and prints no output", () => {
    const proc = Bun.spawnSync({
      cmd: ["bash", SCRIPT, "1.6.2\ntag=latest", "main", "abc1234"],
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.stderr.toString()).toContain("not of the form X.Y.Z");
  });
});
