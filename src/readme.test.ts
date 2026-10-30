import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { LINT_RULE_SEVERITY } from "./findings.js";
import { isRecord } from "./values.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const README = resolve(REPO_ROOT, "README.md");
const RULES_HEADING = "### Lint rules";

/** The README's text under `RULES_HEADING`, up to the next heading. */
function rulesSection(readme: string): string {
  const start = readme.indexOf(`\n${RULES_HEADING}\n`);
  if (start === -1) {
    throw new Error(`README.md has no "${RULES_HEADING}" heading`);
  }
  const body = readme.slice(start + RULES_HEADING.length + 2);
  const end = body.search(/^#/m);
  return end === -1 ? body : body.slice(0, end);
}

/** Each row of the section's rule table, as `[rule, severity]`, in order. */
function ruleRows(section: string): (readonly [string, string])[] {
  return section.split("\n").flatMap((line) => {
    const row = /^\| `([^`]+)` \| ([^|]+?) \|/.exec(line);
    return row === null ? [] : [[row[1], row[2]] as const];
  });
}

describe("README rule table", () => {
  const rows = ruleRows(rulesSection(readFileSync(README, "utf8")));
  const severities: Readonly<Record<string, string>> = LINT_RULE_SEVERITY;

  it("has a row for every rule", () => {
    const documented = new Set(rows.map(([rule]) => rule));
    expect(
      Object.keys(severities).filter((rule) => !documented.has(rule)),
    ).toEqual([]);
  });

  it("has no row for a rule the lint does not have", () => {
    expect(rows.filter(([rule]) => !Object.hasOwn(severities, rule))).toEqual(
      [],
    );
  });

  it("gives each rule its severity", () => {
    expect(
      rows.filter(
        ([rule, severity]) =>
          Object.hasOwn(severities, rule) && severities[rule] !== severity,
      ),
    ).toEqual([]);
  });

  it("has one row per rule", () => {
    expect(rows.length).toBe(new Set(rows.map(([rule]) => rule)).size);
  });
});

describe("Pyodide install command", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
  );
  const pinned =
    isRecord(manifest) && isRecord(manifest.peerDependencies)
      ? manifest.peerDependencies.pyodide
      : undefined;

  it.each(["README.md", "docs/lint.md"])(
    "%s names the version package.json pins",
    (file) => {
      expect(typeof pinned).toBe("string");
      const named = [
        ...readFileSync(resolve(REPO_ROOT, file), "utf8").matchAll(
          /(?:npm install|-p) pyodide@(\S+?)[`\s]/g,
        ),
      ].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((version) => version !== pinned)).toEqual([]);
    },
  );
});
