import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import YAML from "yaml";

import { loadDocs, validDocsOf } from "../src/documents.js";
import { lint, transformReads } from "../src/lint.js";
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
// A run that probes transforms also lints a mutated copy of the examples for
// each probe.
const PROBE_PROCESS_TIMEOUT_MS = 60_000;

type Transform = (typeof TRANSFORMS)[number];
/** An answer of the stand-in Metabase: a string body goes as plain text, anything else as JSON. */
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

const POSTGRES_ID = 2;
const DATABASES = [
  { id: 1, name: "Sample Database", engine: "h2" },
  { id: POSTGRES_ID, name: "Sample Postgres", engine: "postgres" },
];
const ORDERS_CREATED_AT_ID = 77;
const POSTGRES_METADATA = {
  tables: [
    {
      schema: "public",
      name: "orders",
      fields: [
        { id: 76, name: "id" },
        { id: ORDERS_CREATED_AT_ID, name: "created_at" },
      ],
    },
  ],
};
const databaseIdOf = (name: unknown) =>
  DATABASES.find((d) => d.name === name)?.id ?? null;

/**
 * Each transform of the examples as Metabase answers GET /api/transform/:id
 * once it imported them: a database by its id.
 */
const IMPORTED_TRANSFORMS = new Map(
  validDocsOf(loadDocs(EXAMPLES, loadSchemas()).docs, "Transform").map(
    (doc) => {
      const id = transformByEntityId.get(doc.body.entity_id)?.id ?? 0;
      const source: Record<string, unknown> = { ...doc.body.source };
      if (isRecord(source.query)) {
        source.query = {
          ...source.query,
          database: databaseIdOf(source.query.database),
        };
      }
      const target: Record<string, unknown> = { ...doc.body.target };
      if (target.database !== undefined) {
        target.database = databaseIdOf(target.database);
      }
      return [
        id,
        { id, name: doc.body.name, source, target, collection_id: 10 },
      ] as const;
    },
  ),
);

const TARGET_DATABASE_NOT_FOUND = "The target database cannot be found.";
const TARGET_SCHEMA_REQUIRED = "A target schema is required for this database.";
const TABLE_VARIABLE_REQUIRED =
  "Incremental transform with a native query requires a table variable. Please add a table variable to the query and update the checkpoint field.";

/**
 * Metabase's answer to POST /api/transform: the checks its API makes, in
 * their order, each failed one answered 400 with its message as plain text,
 * and a body that fails the endpoint's schema answered 400 with JSON errors.
 */
function saveTransform(body: unknown): Reply {
  if (!isRecord(body) || !isRecord(body.source) || !isRecord(body.target)) {
    return { status: 400, body: { errors: { body: "invalid" } } };
  }
  const { source, target } = body;
  // The endpoint's schema takes a target schema only as a NonBlankString.
  if (typeof target.schema === "string" && target.schema.trim() === "") {
    return {
      status: 400,
      body: { errors: { target: "schema: should be a non-blank string" } },
    };
  }
  if (
    target.type === "table-incremental" &&
    !isRecord(target["target-incremental-strategy"])
  ) {
    return {
      status: 400,
      body: { errors: { target: "missing target-incremental-strategy" } },
    };
  }
  const query = isRecord(source.query) ? source.query : null;
  const databaseId =
    source.type === "query"
      ? (query?.database ?? target.database)
      : target.database;
  if (!DATABASES.some((d) => d.id === databaseId)) {
    return { status: 400, body: TARGET_DATABASE_NOT_FOUND };
  }
  const strategy = source["source-incremental-strategy"];
  if (
    isRecord(strategy) &&
    strategy["checkpoint-filter-field-id"] !== ORDERS_CREATED_AT_ID
  ) {
    return { status: 400, body: "Checkpoint field not found." };
  }
  if (databaseId === POSTGRES_ID && typeof target.schema !== "string") {
    return { status: 400, body: TARGET_SCHEMA_REQUIRED };
  }
  const stages = Array.isArray(query?.stages) ? query.stages : [];
  const nativeStage =
    stages.length === 1 &&
    isRecord(stages[0]) &&
    stages[0]["lib/type"] === "mbql.stage/native"
      ? stages[0]
      : null;
  const tags = isRecord(nativeStage?.["template-tags"])
    ? Object.values(nativeStage["template-tags"])
    : [];
  if (
    target.type === "table-incremental" &&
    nativeStage !== null &&
    !tags.some((tag) => isRecord(tag) && tag.type === "table")
  ) {
    return { status: 400, body: TABLE_VARIABLE_REQUIRED };
  }
  return { status: 200, body: { id: 500 } };
}

type Fake = {
  /** The answer to creating a test with no inputs, the probe of a transform's reads. */
  readsProbe?: (transform: Transform) => Reply;
  /** The answer to creating a test with inputs, given the test's expectations. */
  testProbe?: (transform: Transform, expectations: unknown) => Reply;
  /** The answer to creating a transform, given the request's body. */
  transformProbe?: (body: unknown) => Reply;
  /** The folder Metabase imported. */
  folder?: string;
  /** The answer to deleting a test. */
  deleteAnswer?: Reply;
  /** Whether to pass --probe-transforms. */
  probeTransforms?: boolean;
  /** The answer to GET /api/database/:id/metadata for Sample Postgres. */
  metadata?: Reply;
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

/**
 * Runs lint-parity.ts against a fake Metabase that imported the examples.
 * `created` and `deleted` count the transforms it created and deleted.
 */
async function runParity({
  readsProbe = missingInputs,
  testProbe = () => ({ status: 200, body: { id: 999 } }),
  transformProbe = saveTransform,
  folder = EXAMPLES,
  deleteAnswer = { status: 204, body: null },
  probeTransforms = false,
  metadata = { status: 200, body: POSTGRES_METADATA },
}: Fake): Promise<{
  exitCode: number;
  output: string;
  created: number;
  deleted: number;
}> {
  let created = 0;
  let deleted = 0;
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const reply = (r: Reply) =>
        typeof r.body === "string"
          ? new Response(r.body, { status: r.status })
          : Response.json(r.body, { status: r.status });
      if (request.method === "GET" && path === "/api/transform") {
        return Response.json(
          TRANSFORMS.map((t) => ({ id: t.id, entity_id: t.entity_id })),
        );
      }
      const transformPath = /^\/api\/transform\/(\d+)$/.exec(path);
      if (request.method === "GET" && transformPath !== null) {
        const transform = IMPORTED_TRANSFORMS.get(Number(transformPath[1]));
        return transform === undefined
          ? new Response("Not found.", { status: 404 })
          : Response.json(transform);
      }
      if (request.method === "POST" && path === "/api/transform") {
        const answer = transformProbe(await request.json());
        if (answer.status === 200) {
          created++;
        }
        return reply(answer);
      }
      if (request.method === "DELETE" && transformPath !== null) {
        deleted++;
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && path === "/api/database") {
        return Response.json({ data: DATABASES });
      }
      if (
        request.method === "GET" &&
        path === `/api/database/${POSTGRES_ID}/metadata`
      ) {
        return reply(metadata);
      }
      if (request.method === "GET" && path === "/api/ee/transform-test") {
        return Response.json(testsOf(folder));
      }
      if (request.method === "DELETE") {
        return deleteAnswer.body === null
          ? new Response(null, { status: deleteAnswer.status })
          : reply(deleteAnswer);
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
      ...(probeTransforms ? ["--probe-transforms"] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: output + errors, created, deleted };
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
        deleteAnswer: {
          status: 403,
          body: "You don't have permissions to do that.",
        },
      });
      expect(output).toContain(
        `FAIL  test collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml: Metabase answered the probe 200, but the created test was not deleted: DELETE /api/ee/transform-test/999 answered 403 You don't have permissions to do that.\n`,
      );
      expect(exitCode).toBe(1);
    },
    PARITY_PROCESS_TIMEOUT_MS,
  );

  describe("--probe-transforms", () => {
    const PYTHON =
      "transform Python Hello World (collections/transforms/python_hello_world.yaml)";
    const REPORT =
      "transform Product Revenue Report (collections/transforms/native_transform.yaml)";
    const isPython = (body: unknown) =>
      isRecord(body) && isRecord(body.source) && body.source.type === "python";

    it(
      "agrees with Metabase on each rule its transform API enforces, and deletes what it creates",
      async () => {
        const { exitCode, output, created, deleted } = await runParity({
          probeTransforms: true,
        });
        for (const line of [
          `OK    probe missing-target-schema, ${PYTHON}, as imported: accepted\n`,
          `OK    probe missing-target-schema, ${PYTHON}, as mutated: refused (${JSON.stringify(TARGET_SCHEMA_REQUIRED)})\n`,
          `OK    probe missing-incremental-table-tag, ${REPORT}, as imported: accepted\n`,
          `OK    probe missing-incremental-table-tag, ${REPORT}, as mutated: refused (${JSON.stringify(TABLE_VARIABLE_REQUIRED)})\n`,
          `OK    probe missing-target-database, ${PYTHON}, as imported: accepted\n`,
          `OK    probe missing-target-database, ${PYTHON}, as mutated: refused (${JSON.stringify(TARGET_DATABASE_NOT_FOUND)})\n`,
        ]) {
          expect(output).toContain(line);
        }
        expect(output).not.toContain("FAIL");
        expect(exitCode).toBe(0);
        expect(created).toBe(3);
        expect(deleted).toBe(created);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "fails when Metabase refuses a transform the lint finds nothing wrong with",
      async () => {
        const { exitCode, output } = await runParity({
          probeTransforms: true,
          transformProbe: (body) =>
            isPython(body)
              ? { status: 400, body: TARGET_SCHEMA_REQUIRED }
              : saveTransform(body),
        });
        expect(output).toContain(
          `FAIL  probe missing-target-schema, ${PYTHON}, as imported: Metabase refuses it with ${JSON.stringify(TARGET_SCHEMA_REQUIRED)}; the lint reports no missing-target-schema\n`,
        );
        expect(exitCode).toBe(1);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "fails when Metabase accepts a transform the lint calls an error",
      async () => {
        const { exitCode, output, created, deleted } = await runParity({
          probeTransforms: true,
          transformProbe: () => ({ status: 200, body: { id: 500 } }),
        });
        expect(output).toContain(
          `FAIL  probe missing-incremental-table-tag, ${REPORT}, as mutated: Metabase accepts it; the lint reports missing-incremental-table-tag\n`,
        );
        expect(exitCode).toBe(1);
        expect(deleted).toBe(created);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "fails when Metabase answers no probe",
      async () => {
        const { exitCode, output } = await runParity({
          probeTransforms: true,
          transformProbe: () => ({
            status: 403,
            body: "You don't have permissions to do that.",
          }),
        });
        expect(output).toContain(
          `FAIL  probe missing-target-database, ${PYTHON}, as mutated: Metabase answered the probe 403 You don't have permissions to do that.\n`,
        );
        for (const rule of [
          "missing-target-schema",
          "missing-incremental-table-tag",
          "missing-target-database",
        ]) {
          expect(output).toContain(
            `FAIL  probe ${rule}: compared no answer with Metabase: every probe failed or was skipped\n`,
          );
        }
        expect(exitCode).toBe(1);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "fails a probe whose field lookup Metabase does not answer, naming the answer",
      async () => {
        const { exitCode, output } = await runParity({
          probeTransforms: true,
          metadata: { status: 500, body: "Database unavailable" },
        });
        expect(output).toContain(
          `FAIL  probe missing-incremental-table-tag, ${REPORT}, as mutated: GET /api/database/${POSTGRES_ID}/metadata answered 500 Database unavailable\n`,
        );
        expect(exitCode).toBe(1);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "asks Metabase about a blank target schema as about a missing one",
      async () => {
        workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
        const folder = join(workdir, "repo");
        cpSync(EXAMPLES, folder, { recursive: true });
        const python = join(
          folder,
          "collections/transforms/python_hello_world.yaml",
        );
        writeFileSync(
          python,
          readFileSync(python, "utf8").replace(
            "schema: transforms",
            'schema: " "',
          ),
        );
        const { exitCode, output } = await runParity({
          folder,
          probeTransforms: true,
        });
        expect(output).toContain(
          `OK    probe missing-target-schema, ${PYTHON}, as imported: refused (${JSON.stringify(TARGET_SCHEMA_REQUIRED)})\n`,
        );
        expect(output).not.toContain("FAIL");
        expect(exitCode).toBe(0);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "compares each probe with the findings on its own transform only",
      async () => {
        workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
        const folder = join(workdir, "repo");
        cpSync(EXAMPLES, folder, { recursive: true });
        const summary = join(
          folder,
          "collections/transforms/product_summary.yaml",
        );
        const doc: unknown = YAML.parse(readFileSync(summary, "utf8"));
        if (!isRecord(doc) || !isRecord(doc.target)) {
          throw new Error("product_summary.yaml has no target");
        }
        delete doc.target.schema;
        writeFileSync(summary, YAML.stringify(doc));
        const { output } = await runParity({ folder, probeTransforms: true });
        // Premise: the folder's lint reports an error on Product Summary,
        // which no probe changes.
        const { findings } = await lint({ folder });
        expect(
          findings.some(
            (f) =>
              f.rule === "missing-target-schema" &&
              f.entity.name === "Product Summary",
          ),
        ).toBe(true);
        expect(output).toContain(
          `OK    probe missing-target-schema, ${PYTHON}, as imported: accepted\n`,
        );
        expect(output).not.toContain("FAIL  probe");
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "fails a probe whose mutation the folder cannot take",
      async () => {
        workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
        const folder = join(workdir, "repo");
        cpSync(EXAMPLES, folder, { recursive: true });
        rmSync(join(folder, "collections/transforms/python_hello_world.yaml"));
        const { exitCode, output } = await runParity({
          folder,
          probeTransforms: true,
        });
        expect(output).toContain(
          "FAIL  probe missing-target-schema: --probe-transforms needs --folder to be examples/v1 or a copy of it: ENOENT",
        );
        expect(output).toContain(
          `OK    probe missing-incremental-table-tag, ${REPORT}, as mutated:`,
        );
        expect(exitCode).toBe(1);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );

    it(
      "skips a transform the token is not licensed for, and fails each rule left with no answer",
      async () => {
        const unlicensed =
          "Premium features required for this transform type are not enabled.";
        const { exitCode, output } = await runParity({
          probeTransforms: true,
          transformProbe: (body) =>
            isPython(body)
              ? { status: 402, body: unlicensed }
              : saveTransform(body),
        });
        expect(output).toContain(
          `SKIP  probe missing-target-schema, ${PYTHON}, as imported: Metabase answered the probe 402 ${unlicensed}\n`,
        );
        // Both rules probe only the Python transform.
        for (const rule of [
          "missing-target-schema",
          "missing-target-database",
        ]) {
          expect(output).toContain(
            `FAIL  probe ${rule}: compared no answer with Metabase: every probe failed or was skipped\n`,
          );
        }
        expect(output).not.toContain(
          "FAIL  probe missing-incremental-table-tag",
        );
        expect(output).toContain(
          `OK    probe missing-incremental-table-tag, ${REPORT}, as mutated: refused (${JSON.stringify(TABLE_VARIABLE_REQUIRED)})\n`,
        );
        expect(exitCode).toBe(1);
      },
      PROBE_PROCESS_TIMEOUT_MS,
    );
  });
});

describe("mutateExamples", () => {
  it("copies the given source folder, not examples/v1, and mutates the copy", () => {
    workdir = mkdtempSync(join(tmpdir(), "representations-lint-parity-"));
    const source = join(workdir, "source");
    cpSync(EXAMPLES, source, { recursive: true });
    writeFileSync(join(source, "marker.txt"), "source\n");
    const fromSource = join(workdir, "from-source");
    const fromExamples = join(workdir, "from-examples");
    mutateExamples("missing-target-schema", fromSource, source);
    mutateExamples("missing-target-schema", fromExamples);
    expect(readFileSync(join(fromSource, "marker.txt"), "utf8")).toBe(
      "source\n",
    );
    expect(existsSync(join(fromExamples, "marker.txt"))).toBe(false);
    const python = YAML.parse(
      readFileSync(
        join(fromSource, "collections/transforms/python_hello_world.yaml"),
        "utf8",
      ),
    );
    expect(isRecord(python) && isRecord(python.target)).toBe(true);
    expect(python.target.schema).toBeUndefined();
  });
});
