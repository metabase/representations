import { describe, expect, it } from "bun:test";
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
      "1.6.1-alpha.br-galdre-reference-lint.sha-70fe3a4",
      "alpha-galdre-reference-lint",
    ],
    [
      "a SHA of digits with a leading zero",
      "main",
      "0123456",
      "1.6.1-alpha.br-main.sha-0123456",
      "alpha-main",
    ],
    [
      "a branch of digits with a leading zero",
      "0123",
      "abc1234",
      "1.6.1-alpha.br-0123.sha-abc1234",
      "alpha-0123",
    ],
    [
      "a branch with no letter or digit",
      "_/_",
      "abc1234",
      "1.6.1-alpha.br-unnamed.sha-abc1234",
      "alpha-unnamed",
    ],
    [
      "a branch holding shell syntax",
      "a$(id)`id`",
      "abc1234",
      "1.6.1-alpha.br-a-id-id.sha-abc1234",
      "alpha-a-id-id",
    ],
  ])("gives a valid version for %s", (_, branch, sha, version, tag) => {
    const outputs = alphaVersion(branch, sha);
    expect(outputs.version).toMatch(SEMVER);
    expect(outputs).toEqual({ version, tag });
  });
});
