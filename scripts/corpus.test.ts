import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { caseFiles, compare, materialize, readCase } from "./corpus.js";

// Each case's answers were recorded from a real Metabase (record-corpus.ts).
// A case the lint agrees with must keep agreeing. A case marked `known` is one
// it disagrees with, and must keep giving exactly the differences `known`
// holds: a fix, or a new difference, fails the test until the case is
// recorded again.
const scratch = mkdtempSync(join(tmpdir(), "corpus-test-"));
const known = caseFiles().filter((f) => readCase(f).known !== null);
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  // Their tests pass, so say so where CI shows it: these are open lint bugs.
  console.log(
    `corpus: ${known.length} cases hold a known difference from Metabase: ${known.map((f) => basename(f, ".yaml")).join(", ")}`,
  );
});

describe("the lint agrees with Metabase on the corpus", () => {
  for (const file of caseFiles()) {
    const c = readCase(file);
    // A known difference is an open bug in the lint, though its test passes.
    const name = `${c.known === null ? "" : "KNOWN DIFFERENCE: "}${basename(file, ".yaml")}: ${c.description}`;
    it(name, async () => {
      const folder = join(scratch, basename(file, ".yaml"));
      materialize(c.edits, folder);
      const differences = await compare(folder, c.observation);
      expect(differences.join("\n")).toEqual(c.known ?? "");
    });
  }
});
