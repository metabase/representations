import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "path";

import { loadDocs, validDocsOf } from "../src/documents.js";
import { transformReads } from "../src/lint.js";
import { isRecord } from "../src/values.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = resolve(ROOT, "examples", "v1");

const TRANSFORMS = transformReads({ folder: EXAMPLES }).map((t, i) => ({
  ...t,
  id: i + 1,
}));
const transformByEntityId = new Map(
  TRANSFORMS.map((t) => [t.entity_id ?? "", t]),
);
const TESTS = validDocsOf(loadDocs(EXAMPLES).docs, "TransformTest").map(
  (doc, i) => ({
    id: 100 + i,
    entity_id: doc.body.entity_id,
    transform_id: transformByEntityId.get(doc.body.transform_id)?.id ?? 0,
    inputs: doc.body.inputs,
    expectations: doc.body.expectations,
  }),
);

type Transform = (typeof TRANSFORMS)[number];
type Reply = { status: number; body: unknown };

const refusal = (status: number, code: string, extra: object = {}): Reply => ({
  status,
  body: { "error-code": code, message: code, ...extra },
});

/** Metabase's answer to a test of `transform`: the tables the lint reads, qualified as compiled SQL names them. */
const missingInputs = (transform: Transform): Reply =>
  transform.queryTransform
    ? (transform.tables ?? []).length === 0
      ? { status: 200, body: { id: 999 } }
      : refusal(400, "transform-test.missing-inputs", {
          tables: (transform.tables ?? []).map((t) =>
            t.schema === null ? `PUBLIC.${t.name}` : `${t.schema}.${t.name}`,
          ),
        })
    : refusal(422, "transform-test.unsupported-transform");

type Fake = {
  /** The answer to creating a test with no inputs, the probe of a transform's reads. */
  readsProbe?: (transform: Transform) => Reply;
  /** The answer to creating a copy of an imported test. */
  testProbe?: (transform: Transform) => Reply;
};

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** Runs lint-parity.ts against a fake Metabase that imported the examples. */
async function runParity({
  readsProbe = missingInputs,
  testProbe = () => ({ status: 200, body: { id: 999 } }),
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
        return Response.json(TESTS);
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
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
          isReadsProbe ? readsProbe(transform) : testProbe(transform),
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
      EXAMPLES,
      "--default-schema",
      "Sample Database=PUBLIC",
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
  it("passes when Metabase reads what the lint reads and accepts every test", async () => {
    const { exitCode, output } = await runParity({});
    expect(output).not.toContain("FAIL");
    expect(exitCode).toBe(0);
  });

  it("fails when it compared nothing, every probe refused for the database", async () => {
    const unsupported = () => refusal(422, "transform-test.unsupported-driver");
    const { exitCode, output } = await runParity({
      readsProbe: (t) =>
        t.queryTransform
          ? unsupported()
          : refusal(422, "transform-test.unsupported-transform"),
      testProbe: unsupported,
    });
    expect(output).toContain("FAIL  compared no transform with Metabase");
    expect(output).toContain("FAIL  compared no transform test with Metabase");
    expect(exitCode).toBe(1);
  });

  it("prints Metabase's message with each refusal it skips", async () => {
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
  });

  it("fails on a refusal the lint does not explain", async () => {
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
  });

  it("compares schemas where both sides name one", async () => {
    const { exitCode, output } = await runParity({
      readsProbe: (t) =>
        t.name === "Top Categories"
          ? refusal(400, "transform-test.missing-inputs", {
              tables: ["OTHER.product_revenue_report"],
            })
          : missingInputs(t),
    });
    expect(output).toContain(
      "only the lint reads TRANSFORMS.product_revenue_report; only Metabase reads OTHER.product_revenue_report",
    );
    expect(exitCode).toBe(1);
  });

  it("fails when Metabase refuses a test the lint finds nothing wrong with", async () => {
    const { exitCode, output } = await runParity({
      testProbe: (t) =>
        t.name === "Daily Order Summary"
          ? refusal(400, "transform-test.unused-inputs", { tables: ["ORDERS"] })
          : { status: 200, body: { id: 999 } },
    });
    expect(output).toContain(
      "Metabase refuses it with transform-test.unused-inputs; the lint reports no unused-input",
    );
    expect(exitCode).toBe(1);
  });
});
