import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { loadDocs, validDocsOf } from "../src/documents.js";
import { transformReads } from "../src/lint.js";
import { loadSchemas } from "../src/schemas.js";
import { mutateExamples } from "../src/test-support/lint-mutations.js";
import { isRecord } from "../src/values.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = resolve(ROOT, "examples", "v1");

const TRANSFORMS = (await transformReads({ folder: EXAMPLES })).map((t, i) => ({
  ...t,
  id: i + 1,
}));
const transformByEntityId = new Map(
  TRANSFORMS.map((t) => [t.entity_id ?? "", t]),
);
/** The transform tests of `folder`, as Metabase lists them once imported. */
const testsOf = (folder: string) =>
  validDocsOf(loadDocs(folder, loadSchemas()).docs, "TransformTest").map(
    (doc, i) => ({
      id: 100 + i,
      entity_id: doc.body.entity_id,
      transform_id: transformByEntityId.get(doc.body.transform_id)?.id ?? 0,
      inputs: doc.body.inputs,
      expectations: doc.body.expectations,
    }),
  );

// Each parity run lints the examples in a new process, which loads the SQL
// parser and takes seconds.
const PARITY_PROCESS_TIMEOUT_MS = 30_000;

type Transform = (typeof TRANSFORMS)[number];
type Reply = { status: number; body: unknown };

const refusal = (status: number, code: string, extra: object = {}): Reply => ({
  status,
  body: { "error-code": code, message: code, ...extra },
});

/** Metabase's answer to a test of `transform`: the tables the lint reads, labelled as the SQL names them. */
const missingInputs = (transform: Transform): Reply =>
  transform.queryTransform
    ? (transform.tables ?? []).length === 0
      ? { status: 200, body: { id: 999 } }
      : refusal(400, "transform-test.missing-inputs", {
          tables: (transform.tables ?? []).map((t) =>
            t.schema === null ? t.name : `${t.schema}.${t.name}`,
          ),
        })
    : refusal(422, "transform-test.unsupported-transform");

type Fake = {
  /** The answer to creating a test with no inputs, the probe of a transform's reads. */
  readsProbe?: (transform: Transform) => Reply;
  /** The answer to creating a test with inputs, given the test's expectations. */
  testProbe?: (transform: Transform, expectations: unknown) => Reply;
  /** The folder Metabase imported. */
  folder?: string;
  /** The answer to deleting a test. */
  deleted?: Reply;
};

let server: ReturnType<typeof Bun.serve> | undefined;
let workdir: string | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (workdir !== undefined) {
    rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

/** `examples/v1` with the named mutation applied, in a new folder. */
function mutated(name: string): string {
  workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
  const folder = join(workdir, "repo");
  mutateExamples(name, folder);
  return folder;
}

/** Whether an expectation in `expectations` has SQL that reads `table`. */
const readsTable = (expectations: unknown, table: string) =>
  Array.isArray(expectations) &&
  expectations.some(
    (e) =>
      isRecord(e) &&
      typeof e.sql === "string" &&
      new RegExp(`\\b${table}\\b`, "i").test(e.sql),
  );

/**
 * Metabase's unremapped-reference refusal. Its body carries the code and the
 * message only: Metabase keeps the rest of the refusal's data on the server.
 */
const unremapped = (message: string): Reply =>
  refusal(400, "transform-test.unremapped-reference", { message });

/** Runs lint-parity.ts against a fake Metabase that imported the examples. */
async function runParity({
  readsProbe = missingInputs,
  testProbe = () => ({ status: 200, body: { id: 999 } }),
  folder = EXAMPLES,
  deleted = { status: 204, body: null },
}: Fake): Promise<{ exitCode: number; output: string }> {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const reply = (r: Reply) => Response.json(r.body, { status: r.status });
      if (request.method === "GET" && path === "/api/transform") {
        return Response.json(
          TRANSFORMS.map((t) => ({ id: t.id, entity_id: t.entity_id })),
        );
      }
      if (request.method === "GET" && path === "/api/ee/transform-test") {
        return Response.json(testsOf(folder));
      }
      if (request.method === "DELETE") {
        return deleted.body === null
          ? new Response(null, { status: deleted.status })
          : reply(deleted);
      }
      if (request.method === "POST" && path === "/api/ee/transform-test") {
        const body: unknown = await request.json();
        const transform = TRANSFORMS.find(
          (t) => isRecord(body) && t.id === body.transform_id,
        );
        if (!isRecord(body) || transform === undefined) {
          return new Response("Not found.", { status: 404 });
        }
        const isReadsProbe =
          Array.isArray(body.inputs) && body.inputs.length === 0;
        return reply(
          isReadsProbe
            ? readsProbe(transform)
            : testProbe(transform, body.expectations),
        );
      }
      return new Response("Not found.", { status: 404 });
    },
  });
  const child = Bun.spawn(
    [
      "bun",
      "run",
      resolve(ROOT, "scripts/lint-parity.ts"),
      "--url",
      `http://localhost:${server.port}`,
      "--api-key",
      "key",
      "--folder",
      folder,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: output + errors };
}

describe("lint-parity", () => {
  it(
    "passes when Metabase reads what the lint reads and accepts every test",
    async () => {
      const { exitCode, output } = await runParity({});
      expect(output).not.toContain("FAIL");
      expect(exitCode).toBe(0);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when it compared nothing, every probe refused for the database",
    async () => {
      const unsupported = () =>
        refusal(422, "transform-test.unsupported-driver");
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.queryTransform
            ? unsupported()
            : refusal(422, "transform-test.unsupported-transform"),
        testProbe: unsupported,
      });
      expect(output).toContain("FAIL  compared no transform with Metabase");
      expect(output).toContain(
        "FAIL  compared no transform test with Metabase",
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails on a folder that holds no transform and no transform test",
    async () => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
      const { exitCode, output } = await runParity({ folder: workdir });
      expect(output).toContain(
        `FAIL  compared no transform with Metabase: ${workdir} holds none`,
      );
      expect(output).toContain(
        `FAIL  compared no transform test with Metabase: ${workdir} holds none`,
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails on a folder that does not exist",
    async () => {
      workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
      const folder = join(workdir, "no-such-folder");
      const { exitCode, output } = await runParity({ folder });
      expect(output).toContain(`FAIL  no such folder: ${folder}`);
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "prints Metabase's message with each refusal it skips",
    async () => {
      const unsupported = () =>
        refusal(422, "transform-test.unsupported-driver", {
          message:
            "The sqlite database of this transform does not support transform testing.",
        });
      const { output } = await runParity({
        readsProbe: (t) =>
          t.name === "Top Categories" ? unsupported() : missingInputs(t),
        testProbe: (t) =>
          t.name === "Top Categories"
            ? refusal(422, "transform-test.unsupported-driver", {
                message: undefined,
              })
            : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        'SKIP  transform Top Categories (collections/transforms/top_categories.yaml): Metabase refused the probe with transform-test.unsupported-driver ("The sqlite database of this transform does not support transform testing.")\n',
      );
      // A refusal with no message names the code alone.
      expect(output).toContain(
        "SKIP  test collections/transforms/top_categories/top_categories__three_highest.yaml: Metabase refused the probe with transform-test.unsupported-driver\n",
      );
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails on a refusal the lint does not explain",
    async () => {
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.name === "Product Revenue Report"
            ? refusal(400, "transform-test.other-failure", {
                message: "Something else.",
              })
            : missingInputs(t),
      });
      expect(output).toContain(
        'Product Revenue Report (collections/transforms/native_transform.yaml): Metabase refused the probe with transform-test.other-failure ("Something else."), which the lint does not explain',
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "compares schemas where both sides name one",
    async () => {
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.name === "Top Categories"
            ? refusal(400, "transform-test.missing-inputs", {
                tables: ["OTHER.product_revenue_report"],
              })
            : missingInputs(t),
      });
      expect(output).toContain(
        "only the lint reads transforms.product_revenue_report; only Metabase reads OTHER.product_revenue_report",
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when Metabase refuses a test the lint finds nothing wrong with",
    async () => {
      const { exitCode, output } = await runParity({
        testProbe: (t) =>
          t.name === "Daily Order Summary"
            ? refusal(400, "transform-test.unused-inputs", {
                message:
                  "Test input(s) declared for table(s) the transform does not read: ORDERS. Remove them.",
                tables: ["ORDERS"],
              })
            : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        'Metabase refuses it with transform-test.unused-inputs ("Test input(s) declared for table(s) the transform does not read: ORDERS. Remove them."); the lint reports no unused-input',
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "agrees with Metabase on an expectation that reads a table the test does not stand in for",
    async () => {
      const message =
        'Expectation "no negative revenue" reads table(s) this test does not stand in for: people. An expectation may only read the transform\'s output and its declared inputs.';
      const { exitCode, output } = await runParity({
        folder: mutated("expectation-reads-other-table"),
        testProbe: (_t, expectations) =>
          readsTable(expectations, "people")
            ? unremapped(message)
            : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        `OK    test collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml: transform-test.unremapped-reference (${JSON.stringify(message)})\n`,
      );
      expect(exitCode).toBe(0);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "agrees when Metabase refuses the transform's own SQL after the inputs pass",
    async () => {
      const message =
        "The transform test could not fully remap the source to test tables; these reference(s) remain: orders.";
      const { exitCode, output } = await runParity({
        testProbe: (t) =>
          t.name === "Daily Order Summary"
            ? unremapped(message)
            : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        `OK    test collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml: transform-test.unremapped-reference (${JSON.stringify(message)})\n`,
      );
      expect(exitCode).toBe(0);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when Metabase cannot test a transform the lint takes for a query transform",
    async () => {
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.name === "Product Summary"
            ? refusal(422, "transform-test.unsupported-transform")
            : missingInputs(t),
      });
      expect(output).toContain(
        "Product Summary (collections/transforms/product_summary.yaml): Metabase cannot test it; the lint takes it for a query transform\n",
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when Metabase tests a transform the lint takes for one it cannot test",
    async () => {
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.queryTransform
            ? missingInputs(t)
            : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        "Python Hello World (collections/transforms/python_hello_world.yaml): Metabase tests it; the lint takes it for a transform Metabase cannot test\n",
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "skips, and does not count, a test Metabase refuses for SQL it cannot parse",
    async () => {
      const message =
        'Expectation "no negative revenue" has SQL that could not be parsed: Invalid expression / Unexpected token.';
      const TEST =
        "test collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml";
      const skip = `SKIP  ${TEST}: Metabase refuses it with transform-test.unparseable-source (${JSON.stringify(message)}), which says nothing of its inputs\n`;
      const testProbe = (t: Transform): Reply =>
        t.name === "Monthly Order Summary"
          ? refusal(400, "transform-test.unparseable-source", { message })
          : { status: 200, body: { id: 999 } };
      // With the lint's unparseable-test-sql, and without it.
      for (const folder of [mutated("unparseable-test-sql"), EXAMPLES]) {
        const { exitCode, output } = await runParity({ folder, testProbe });
        expect(output).toContain(skip);
        expect(output).not.toContain("FAIL");
        expect(exitCode).toBe(0);
      }
      const none = await runParity({
        testProbe: () =>
          refusal(400, "transform-test.unparseable-source", { message }),
      });
      expect(none.output).toContain(
        "FAIL  compared no transform test with Metabase: every probe was refused or failed\n",
      );
      expect(none.exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "compares the tables a refusal of the inputs lists with the lint's",
    async () => {
      const TEST =
        "test collections/transforms/native_transform/product_revenue_report__category_totals.yaml";
      const run = (tables: string[]) =>
        runParity({
          folder: mutated("missing-input"),
          testProbe: (t) =>
            t.name === "Product Revenue Report"
              ? refusal(400, "transform-test.missing-inputs", { tables })
              : { status: 200, body: { id: 999 } },
        });
      const agrees = await run(["products"]);
      expect(agrees.output).toContain(
        `OK    ${TEST}: transform-test.missing-inputs`,
      );
      expect(agrees.exitCode).toBe(0);
      const differs = await run(["orders"]);
      expect(differs.output).toContain(
        `FAIL  ${TEST}: Metabase refuses it with transform-test.missing-inputs ("transform-test.missing-inputs") for orders; the lint reports missing-input for products\n`,
      );
      expect(differs.exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "skips a transform whose SQL Metabase cannot parse for a test, which the lint does not predict",
    async () => {
      const { exitCode, output } = await runParity({
        readsProbe: (t) =>
          t.name === "Product Revenue Report"
            ? refusal(400, "transform-test.unparseable-source")
            : missingInputs(t),
      });
      expect(output).toContain(
        "SKIP  transform Product Revenue Report (collections/transforms/native_transform.yaml): Metabase cannot parse its SQL for a test, which the lint does not predict\n",
      );
      expect(exitCode).toBe(0);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when Metabase does not delete a test it created",
    async () => {
      const { exitCode, output } = await runParity({
        deleted: {
          status: 403,
          body: "You don't have permissions to do that.",
        },
      });
      expect(output).toContain(
        `FAIL  test collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml: Metabase answered the probe 200, but the created test was not deleted: DELETE /api/ee/transform-test/999 answered 403 "You don't have permissions to do that."\n`,
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );
});

describe("--default-schema", () => {
  /** The exit code and the output of `script` run with `args`. */
  async function run(
    script: string,
    args: readonly string[],
  ): Promise<{ exitCode: number; output: string }> {
    const child = Bun.spawn(["bun", "run", resolve(ROOT, script), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: output + errors };
  }

  const withPairs = (pairs: readonly string[]) =>
    pairs.flatMap((p) => ["--default-schema", p]);
  const lintWith = (pairs: readonly string[]) =>
    run("bin/cli.ts", [
      "lint",
      "--experimental",
      "--folder",
      EXAMPLES,
      ...withPairs(pairs),
    ]);
  // A URL on port 1 refuses every connection, so the parity script stops at
  // its first request to Metabase.
  const parityWith = (pairs: readonly string[]) =>
    run("scripts/lint-parity.ts", [
      "--url",
      "http://127.0.0.1:1",
      "--api-key",
      "key",
      "--folder",
      EXAMPLES,
      ...withPairs(pairs),
    ]);

  it(
    "is refused by the lint and the parity script for a pair with no database",
    async () => {
      for (const command of [lintWith, parityWith]) {
        const { exitCode, output } = await command(["=x"]);
        expect(output).toContain(
          "Invalid --default-schema: =x (expected DATABASE=SCHEMA)",
        );
        expect(exitCode).toBe(2);
      }
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "is refused by the lint and the parity script for a database given twice",
    async () => {
      for (const command of [lintWith, parityWith]) {
        const { exitCode, output } = await command(["db=x", "db=y"]);
        expect(output).toContain("--default-schema names db twice");
        expect(exitCode).toBe(2);
      }
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );
});
