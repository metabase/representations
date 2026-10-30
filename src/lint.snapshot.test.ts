import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { lint } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./test-support/lint-mutations.js";
import { loadSqlParser } from "./sql-parser.js";

function applyMutation(name: string, folder: string): void {
  const mutation = MUTATIONS.find((m) => m.name === name);
  if (mutation === undefined) {
    throw new Error(`Unknown mutation: ${name}`);
  }
  mutation.apply(folder);
}

// One tree per rule, and one tree with several rules,
// which pins the order of findings. A deliberate change to the output is
// recorded with `bun test --update-snapshots` and reviewed in the diff.
const TREES: [string, (folder: string) => void][] = [
  ["schema", (f) => mutateExamples("invalid-test", f)],
  ["skipped by metabase", (f) => mutateExamples("skipped-by-metabase", f)],
  [
    "duplicate entity id and target",
    (f) => mutateExamples("copied-transform", f),
  ],
  ["dangling transform id", (f) => mutateExamples("dangling-transform-id", f)],
  [
    "wrong-type transform id",
    (f) => mutateExamples("wrong-type-transform-id", f),
  ],
  ["transform cycle", (f) => mutateExamples("transform-cycle", f)],
  ["transform collection", (f) => mutateExamples("transform-collection", f)],
  [
    "missing incremental table tag",
    (f) => mutateExamples("missing-incremental-table-tag", f),
  ],
  [
    "missing target database",
    (f) => mutateExamples("missing-target-database", f),
  ],
  ["missing target schema", (f) => mutateExamples("missing-target-schema", f)],
  [
    "unsupported transform engine",
    (f) => mutateExamples("unsupported-transform-engine", f),
  ],
  ["missing input", (f) => mutateExamples("missing-input", f)],
  ["unused input", (f) => mutateExamples("unused-input", f)],
  ["null schema reference", (f) => mutateExamples("null-schema-reference", f)],
  ["broken table file", (f) => mutateExamples("broken-table-file", f)],
  ["untestable transform", (f) => mutateExamples("python-transform-test", f)],
  ["untestable engine", (f) => mutateExamples("untestable-engine", f)],
  ["duplicate input", (f) => mutateExamples("duplicate-input", f)],
  [
    "expectation reads another table",
    (f) => mutateExamples("expectation-reads-other-table", f),
  ],
  ["row columns mismatch", (f) => mutateExamples("row-columns-mismatch", f)],
  [
    "duplicate expectation name",
    (f) => mutateExamples("duplicate-expectation-name", f),
  ],
  ["no expectations", (f) => mutateExamples("no-expectations", f)],
  ["reads not checked", (f) => mutateExamples("missing-snippet", f)],
  [
    "several rules",
    (f) => {
      mutateExamples("transform-cycle", f);
      applyMutation("copied-transform", f);
      applyMutation("missing-snippet", f);
    },
  ],
];

// Loads the SQL parser under a hook's timeout, so that no test's own timeout
// bears the load.
beforeAll(async () => {
  await loadSqlParser();
}, 60_000);

describe("lint output", () => {
  describe("on a broken copy of the examples", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-snapshot-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it.each(TREES)("matches the recording: %s", async (_, build) => {
      build(workdir);
      expect((await lint({ folder: workdir })).findings).toMatchSnapshot();
    });
  });
});
