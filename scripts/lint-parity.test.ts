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
 * Whether `expectations` is the probe that locates an unremapped-reference
 * refusal: one expectation that reads no table.
 */
const isLocateProbe = (expectations: unknown) =>
  Array.isArray(expectations) &&
  expectations.length === 1 &&
  isRecord(expectations[0]) &&
  expectations[0].sql === "SELECT 1 WHERE 1 = 0";

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
            ? refusal(400, "transform-test.unparseable-source", {
                message: "Could not parse the SQL.",
              })
            : missingInputs(t),
      });
      expect(output).toContain(
        'Product Revenue Report (collections/transforms/native_transform.yaml): Metabase refused the probe with transform-test.unparseable-source ("Could not parse the SQL."), which the lint does not explain',
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
    "fails when Metabase cannot remap the transform's own SQL",
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
        `FAIL  test collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml: Metabase refuses it with transform-test.unremapped-reference on the transform (${JSON.stringify(message)}), which no lint rule predicts\n`,
      );
      expect(exitCode).toBe(1);
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
    "fails when the probe that locates an unremapped reference does not run",
    async () => {
      const message = "reference(s) remain: orders.";
      const { exitCode, output } = await runParity({
        testProbe: (t, expectations) =>
          t.name !== "Daily Order Summary"
            ? { status: 200, body: { id: 999 } }
            : isLocateProbe(expectations)
              ? { status: 500, body: { message: "Server error" } }
              : unremapped(message),
      });
      expect(output).toContain(
        `FAIL  test collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml: Metabase refused it with transform-test.unremapped-reference (${JSON.stringify(message)}), and answered the probe that locates the refusal 500 {"message":"Server error"}\n`,
      );
      expect(output).not.toContain(
        "OK    test collections/transforms/daily_order_summary/",
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  it(
    "fails when the probe that locates an unremapped reference is refused with another code",
    async () => {
      const { exitCode, output } = await runParity({
        folder: mutated("expectation-reads-other-table"),
        testProbe: (_t, expectations) =>
          isLocateProbe(expectations)
            ? refusal(400, "transform-test.missing-inputs")
            : readsTable(expectations, "people")
              ? unremapped("people")
              : { status: 200, body: { id: 999 } },
      });
      expect(output).toContain(
        'FAIL  test collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml: Metabase refused it with transform-test.unremapped-reference ("people"), and answered the probe that locates the refusal a refusal with transform-test.missing-inputs ("transform-test.missing-inputs")\n',
      );
      expect(exitCode).toBe(1);
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
