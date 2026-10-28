import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { globSync } from "glob";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { parseDocument } from "yaml";

import type { LintFinding } from "./findings.js";
import { DEFECTS, inject, InjectError, type Injection } from "./inject.js";
import { lint } from "./lint.js";
import { CONFIG_FILE } from "./settings.js";
import { loadSqlParser } from "./sql-parser.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

const NATIVE = "collections/transforms/native_transform.yaml";
const NATIVE_TEST =
  "collections/transforms/native_transform/product_revenue_report__category_totals.yaml";
const NATIVE_TEST_ID = "aRvM7DLesF1fOV4kRHidq";
const MBQL = "collections/transforms/mbql_transform.yaml";
const MBQL_TEST =
  "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml";
const TOP_CATEGORIES = "collections/transforms/top_categories.yaml";
const TOP_CATEGORIES_TEST =
  "collections/transforms/top_categories/top_categories__three_highest.yaml";

/** Copies `files` of the examples, and the settings file, to `folder`. */
function copyExamples(folder: string, files: readonly string[]): void {
  for (const file of [CONFIG_FILE, ...files]) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    cpSync(join(EXAMPLES, file), join(folder, file));
  }
}

/** Sets the value at `path` in the YAML file `file` of `folder`. */
function setIn(
  folder: string,
  file: string,
  path: readonly (string | number)[],
  value: unknown,
): void {
  const doc = parseDocument(readFileSync(join(folder, file), "utf8"));
  doc.setIn(path, value);
  writeFileSync(join(folder, file), doc.toString());
}

/** Replaces `from`, which must be in the file, with `to`. */
function replaceIn(
  folder: string,
  file: string,
  from: string,
  to: string,
): void {
  const text = readFileSync(join(folder, file), "utf8");
  expect(text).toContain(from);
  writeFileSync(join(folder, file), text.replace(from, to));
}

/** Every file of `folder` with its text. */
function contents(folder: string): Record<string, string> {
  return Object.fromEntries(
    globSync("**/*", { cwd: folder, dot: true, nodir: true })
      .sort()
      .map((file) => [file, readFileSync(join(folder, file), "utf8")]),
  );
}

const findingKey = (f: LintFinding): string =>
  JSON.stringify([f.rule, f.file, f.message]);

/** The findings of `after` that `before` lacks, counting repeats. */
function added(
  before: readonly LintFinding[],
  after: readonly LintFinding[],
): string[] {
  const left = before.map(findingKey);
  return after.map(findingKey).filter((key) => {
    const at = left.indexOf(key);
    if (at === -1) {
      return true;
    }
    left.splice(at, 1);
    return false;
  });
}

const examples = (folder: string) =>
  cpSync(EXAMPLES, folder, { recursive: true });
const nativeOnly = (folder: string) =>
  copyExamples(folder, [NATIVE, NATIVE_TEST]);
const mbqlOnly = (folder: string) => copyExamples(folder, [MBQL, MBQL_TEST]);
const topCategoriesOnly = (folder: string) =>
  copyExamples(folder, [TOP_CATEGORIES, TOP_CATEGORIES_TEST]);
const nativeTransformOnly = (folder: string) => copyExamples(folder, [NATIVE]);
const nativeTestOnly = (folder: string) => copyExamples(folder, [NATIVE_TEST]);
const nativeTestWithSqlInputs = (folder: string) => {
  nativeOnly(folder);
  setIn(folder, NATIVE_TEST, ["inputs", 0], {
    table: { name: "orders" },
    format: "sql",
    sql: "SELECT 1 AS id, 1 AS product_id, 10.0 AS total",
  });
};
const nativeTestWithoutExpectations = (folder: string) => {
  nativeOnly(folder);
  setIn(folder, NATIVE_TEST, ["expectations"], []);
};

// Each defect, with a folder where the injector finds a place for it, and a
// folder that lacks what it needs, by a little where one can.
const CASES: [
  string,
  { hit: (folder: string) => void; miss: (folder: string) => void },
][] = [
  ["schema", { hit: examples, miss: nativeTestWithoutExpectations }],
  ["duplicate-entity-id", { hit: examples, miss: nativeTransformOnly }],
  [
    "dangling-transform-id",
    {
      hit: examples,
      miss: (folder) => {
        nativeOnly(folder);
        setIn(folder, NATIVE_TEST, ["inputs"], "none");
      },
    },
  ],
  // The test and its transform hold the only entity ids.
  ["wrong-type-transform-id", { hit: examples, miss: nativeOnly }],
  ["transform-cycle", { hit: examples, miss: mbqlOnly }],
  ["transform-collection", { hit: examples, miss: nativeTestOnly }],
  ["missing-incremental-table-tag", { hit: examples, miss: mbqlOnly }],
  [
    "missing-target-schema",
    // No engine says whether the database has schemas.
    { hit: examples, miss: nativeOnly },
  ],
  ["unsupported-transform-engine", { hit: examples, miss: nativeOnly }],
  ["untestable-engine", { hit: examples, miss: nativeOnly }],
  [
    "missing-input",
    {
      hit: examples,
      // Removing either input also leaves an expectation reading a table
      // that is no input.
      miss: (folder) => {
        nativeOnly(folder);
        replaceIn(
          folder,
          NATIVE_TEST,
          "FROM transforms.product_revenue_report GROUP BY",
          "FROM transforms.product_revenue_report JOIN orders ON 1 = 1 JOIN products ON 1 = 1 GROUP BY",
        );
      },
    },
  ],
  [
    "unused-input",
    {
      hit: examples,
      // With a table file for the database, an input for a table no file
      // defines is also an unknown table.
      miss: (folder) => {
        nativeOnly(folder);
        const file = "databases/sample_postgres/tables/orders/orders.yaml";
        mkdirSync(dirname(join(folder, file)), { recursive: true });
        writeFileSync(
          join(folder, file),
          "name: orders\ndb_id: Sample Postgres\nschema: public\nserdes/meta:\n- model: Table\n",
        );
      },
    },
  ],
  ["untestable-transform", { hit: examples, miss: nativeOnly }],
  [
    "duplicate-input",
    {
      hit: examples,
      miss: (folder) => {
        nativeOnly(folder);
        setIn(folder, NATIVE_TEST, ["inputs"], []);
      },
    },
  ],
  // Its one expectation is rows, with no SQL.
  ["expectation-reads-other-table", { hit: examples, miss: topCategoriesOnly }],
  [
    "row-columns-mismatch",
    {
      hit: examples,
      miss: (folder) => {
        nativeOnly(folder);
        setIn(folder, NATIVE_TEST, ["inputs", 0, "rows"], []);
        setIn(folder, NATIVE_TEST, ["expectations", 0, "rows"], []);
      },
    },
  ],
  // Its test has one expectation.
  ["duplicate-expectation-name", { hit: examples, miss: topCategoriesOnly }],
  ["no-expectations", { hit: examples, miss: nativeTestWithoutExpectations }],
  ["reads-not-checked", { hit: examples, miss: mbqlOnly }],
  [
    "input-missing-read-column",
    { hit: examples, miss: nativeTestWithSqlInputs },
  ],
  ["live-sql-input", { hit: examples, miss: nativeTestWithSqlInputs }],
  ["duplicate-target", { hit: examples, miss: nativeTestOnly }],
];

beforeAll(async () => {
  await loadSqlParser();
}, 60_000);

describe("inject", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "representations-inject-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("lists each defect once, and a case here for each", () => {
    const names = DEFECTS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(CASES.map(([name]) => name).sort()).toEqual([...names].sort());
  });

  describe.each(CASES)("%s", (defect, { hit, miss }) => {
    it("plants the defect, and the lint then reports that rule alone", async () => {
      hit(workdir);
      const before = (await lint({ folder: workdir })).findings;
      const injection = await inject({ folder: workdir, defect });
      const after = (await lint({ folder: workdir })).findings;
      expect(injection.findings.length).toBeGreaterThan(0);
      expect(injection.findings.filter((f) => f.rule !== defect)).toEqual([]);
      expect(added(before, after)).toEqual(injection.findings.map(findingKey));
    });

    it("refuses, and changes nothing, where the folder lacks what it needs", async () => {
      miss(workdir);
      const before = contents(workdir);
      let error: unknown;
      try {
        await inject({ folder: workdir, defect });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(InjectError);
      expect(contents(workdir)).toEqual(before);
    });
  });

  describe("on the examples", () => {
    beforeEach(() => examples(workdir));

    it("removes one input for missing-input, and reports one finding", async () => {
      const injection = await inject({
        folder: workdir,
        defect: "missing-input",
        entity: NATIVE_TEST_ID,
      });
      expect(injection.file).toBe(NATIVE_TEST);
      expect(injection.change).toBe("removed the input for orders");
      expect(injection.files).toEqual([NATIVE_TEST]);
      expect(injection.findings.map((f) => f.message)).toEqual([
        "no input for orders, which transform Product Revenue Report reads",
      ]);
    });

    it("chooses the same place in two copies of a folder", async () => {
      const other = mkdtempSync(join(tmpdir(), "representations-inject-"));
      try {
        examples(other);
        const first: Injection = await inject({
          folder: workdir,
          defect: "row-columns-mismatch",
        });
        const second: Injection = await inject({
          folder: other,
          defect: "row-columns-mismatch",
        });
        expect(second).toEqual(first);
        expect(contents(other)).toEqual(contents(workdir));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("plants only in the entity --entity names", async () => {
      const first = await inject({
        folder: workdir,
        defect: "no-expectations",
      });
      expect(first.entity.entity_id).not.toBe(NATIVE_TEST_ID);
      rmSync(workdir, { recursive: true, force: true });
      examples(workdir);
      const chosen = await inject({
        folder: workdir,
        defect: "no-expectations",
        entity: NATIVE_TEST_ID,
      });
      expect(chosen.entity.entity_id).toBe(NATIVE_TEST_ID);
      expect(chosen.file).toBe(NATIVE_TEST);
    });

    it("refuses an unknown defect, and an entity id no file holds", async () => {
      const refusal = async (
        defect: string,
        entity?: string,
      ): Promise<string> => {
        try {
          await inject({ folder: workdir, defect, entity });
        } catch (e) {
          return e instanceof InjectError ? e.message : `not refused: ${e}`;
        }
        return "not refused";
      };
      expect(await refusal("no-such-defect")).toContain(
        "Unknown defect: no-such-defect",
      );
      expect(await refusal("missing-input", "NoSuchEntity000000000")).toBe(
        "No file in the folder has entity_id NoSuchEntity000000000",
      );
    });
  });
});
