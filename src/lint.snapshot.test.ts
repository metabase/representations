import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { lint } from "./lint.js";
import { MUTATIONS, mutateExamples } from "./lint-mutations.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

function writeOrdersTable(folder: string): void {
  const dir = join(folder, "databases/sample_database/tables/orders");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "orders.yaml"),
    yaml.dump({
      name: "ORDERS",
      db_id: "Sample Database",
      schema: null,
      "serdes/meta": [{ model: "Table" }],
    }),
  );
}

function applyMutation(name: string, folder: string): void {
  const mutation = MUTATIONS.find((m) => m.name === name);
  if (mutation === undefined) {
    throw new Error(`Unknown mutation: ${name}`);
  }
  mutation.apply(folder);
}

// One tree per rule, the clean examples, and one tree with several rules,
// which pins the order of findings. A deliberate change to the output is
// recorded with `bun test --update-snapshots` and reviewed in the diff.
const TREES: [string, (folder: string) => void][] = [
  ["schema", (f) => mutateExamples("invalid-test", f)],
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
  ["missing input", (f) => mutateExamples("missing-input", f)],
  ["unused input", (f) => mutateExamples("unused-input", f)],
  [
    "unknown table",
    (f) => {
      mutateExamples("unused-input", f);
      writeOrdersTable(f);
    },
  ],
  ["broken table file", (f) => mutateExamples("broken-table-file", f)],
  ["untestable transform", (f) => mutateExamples("python-transform-test", f)],
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

describe("lint output", () => {
  it("is empty for the bundled examples", async () => {
    expect(await lint({ folder: EXAMPLES })).toMatchSnapshot();
  });

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
      expect(await lint({ folder: workdir })).toMatchSnapshot();
    });
  });
});
