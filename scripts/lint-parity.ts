// Compares the lint with Metabase, on a Metabase that imported the folder.
//
// Transforms: for each transform, the tables the lint finds against the tables
// Metabase says a test of it must stand in for. Metabase has no endpoint for
// that list: creating a test with no inputs is refused with
// transform-test.missing-inputs, and the refusal lists the tables.
//
// Tests: each transform test Metabase imported is created again, as it is.
// Metabase's answer, accepted or refused with an error code, must match the
// lint's errors on that test's file.
//
// Nothing is saved on a refusal; a test that is created is deleted again, and
// a deletion Metabase refuses fails the run.
//
//   bun run scripts/lint-parity.ts --url URL --api-key KEY --folder DIR \
//     [--default-schema DATABASE=SCHEMA ...]
//
// Exits 1 when any comparison differs, when Metabase refuses a probe for a
// reason the lint does not explain, or when nothing could be compared.
import { parseArgs } from "node:util";

import { loadDocs, validDocsOf } from "../src/documents.js";
import { lint, transformReads } from "../src/lint.js";
import { loadSchemas } from "../src/schemas.js";
import { isRecord } from "../src/values.js";
import {
  describeRefusal,
  ENVIRONMENT_REFUSALS,
  readsDiffer,
  type TestRefusal,
  testVerdictDiffers,
} from "./parity.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "api-key": { type: "string" },
    folder: { type: "string" },
    "default-schema": { type: "string", multiple: true },
  },
});
const url = values.url;
const apiKey = values["api-key"];
const folder = values.folder;
if (!url || !apiKey || !folder) {
  console.error(
    "usage: bun run scripts/lint-parity.ts --url URL --api-key KEY --folder DIR [--default-schema DATABASE=SCHEMA ...]",
  );
  process.exit(2);
}
const defaultSchemas: Record<string, string> = {};
for (const pair of values["default-schema"] ?? []) {
  const at = pair.indexOf("=");
  if (at <= 0) {
    console.error(
      `Invalid --default-schema: ${pair} (expected DATABASE=SCHEMA)`,
    );
    process.exit(2);
  }
  defaultSchemas[pair.slice(0, at)] = pair.slice(at + 1);
}

const headers = { "X-API-Key": apiKey, "Content-Type": "application/json" };

/**
 * Metabase's answer: its status, and its body parsed as JSON, or undefined when
 * the body is not JSON. Metabase answers some refusals, such as a 403, in plain
 * text, which `text` keeps.
 */
type Answer = { status: number; json: unknown; text: string };

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/** The answer as a failure message names it: its status and its body. */
const describe = (answer: Answer) =>
  `${answer.status} ${answer.text.trim() || "(empty body)"}`;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Metabase's answer to creating a transform test. */
type Probe =
  | { kind: "accepted" }
  /**
   * Refused with a transform-test error code; `tables` when the refusal lists
   * them. Metabase names the query an unremapped-reference refusal is about
   * only in its localized message, so `refusal.onTransform` is false until
   * locateRefusal sets it.
   */
  | { kind: "refused"; refusal: TestRefusal; tables: string[] | null }
  /** Anything else, such as a 403: the probe did not run. */
  | { kind: "failed"; answer: string };

/** Metabase's answer to deleting a test, or null when it deleted it. */
async function deleteTest(id: number): Promise<string | null> {
  const answer = await api("DELETE", `/api/ee/transform-test/${id}`);
  return answer.status >= 200 && answer.status < 300
    ? null
    : `DELETE /api/ee/transform-test/${id} answered ${describe(answer)}`;
}

async function probe(test: {
  transform_id: number;
  inputs: unknown;
  expectations: unknown;
}): Promise<Probe> {
  const answer = await api("POST", "/api/ee/transform-test", {
    name: "lint parity probe",
    ...test,
  });
  const json = isRecord(answer.json) ? answer.json : {};
  if (answer.status === 200 && typeof json.id === "number") {
    const refused = await deleteTest(json.id);
    return refused === null
      ? { kind: "accepted" }
      : {
          kind: "failed",
          answer: `200, but the created test was not deleted: ${refused}`,
        };
  }
  const code = json["error-code"] ?? json.error_code;
  if (typeof code === "string" && code.startsWith("transform-test.")) {
    return {
      kind: "refused",
      refusal: {
        code,
        message: typeof json.message === "string" ? json.message : null,
        onTransform: false,
      },
      tables: isStringArray(json.tables) ? json.tables : null,
    };
  }
  return { kind: "failed", answer: describe(answer) };
}

/** An expectation whose SQL reads no table, which no test is refused for. */
const NO_TABLE_EXPECTATION = {
  type: "empty",
  name: "probe",
  sql: "SELECT 1 WHERE 1 = 0",
};

/** `refusal` with `onTransform` set, or the answer of a locate probe that did not run. */
type Located =
  | { kind: "located"; refusal: TestRefusal }
  | { kind: "failed"; answer: string };

/**
 * `refusal` of `test`, located on the transform or on an expectation. Metabase
 * checks the transform's SQL before the expectations', and names the query an
 * unremapped-reference refusal is about only in its localized message. The
 * test with only an expectation that reads no table tells: Metabase refuses it
 * with the same code when the transform's SQL is at fault, and accepts it when
 * an expectation is. Any other answer is a failure.
 */
async function locateRefusal(
  refusal: TestRefusal,
  test: { transform_id: number; inputs: unknown },
): Promise<Located> {
  if (refusal.code !== "transform-test.unremapped-reference") {
    return { kind: "located", refusal };
  }
  const answer = await probe({ ...test, expectations: [NO_TABLE_EXPECTATION] });
  if (answer.kind === "accepted") {
    return { kind: "located", refusal };
  }
  if (answer.kind === "refused" && answer.refusal.code === refusal.code) {
    return { kind: "located", refusal: { ...refusal, onTransform: true } };
  }
  return {
    kind: "failed",
    answer:
      answer.kind === "failed"
        ? answer.answer
        : `a refusal with ${describeRefusal(answer.refusal)}`,
  };
}

let failed = false;
const fail = (line: string) => {
  console.log(`FAIL  ${line}`);
  failed = true;
};

const listed = await api("GET", "/api/transform");
if (listed.status !== 200 || !Array.isArray(listed.json)) {
  console.error(`GET /api/transform answered ${describe(listed)}`);
  process.exit(1);
}
const transformIdByEntityId = new Map<string, number>(
  listed.json.flatMap((t: unknown) =>
    isRecord(t) && typeof t.entity_id === "string" && typeof t.id === "number"
      ? [[t.entity_id, t.id] as const]
      : [],
  ),
);

// Transforms: the tables each one reads.
const transforms = await transformReads({ folder });
let transformsCompared = 0;
for (const transform of transforms) {
  const label = `transform ${transform.name ?? transform.file} (${transform.file})`;
  const id = transform.entity_id
    ? transformIdByEntityId.get(transform.entity_id)
    : undefined;
  if (id === undefined) {
    fail(`${label}: not imported into Metabase`);
    continue;
  }
  const answer = await probe({
    transform_id: id,
    inputs: [],
    expectations: [NO_TABLE_EXPECTATION],
  });
  if (answer.kind === "failed") {
    fail(`${label}: Metabase answered the probe ${answer.answer}`);
    continue;
  }
  if (
    answer.kind === "refused" &&
    ENVIRONMENT_REFUSALS.has(answer.refusal.code)
  ) {
    console.log(
      `SKIP  ${label}: Metabase refused the probe with ${describeRefusal(answer.refusal)}`,
    );
    continue;
  }
  if (
    answer.kind === "refused" &&
    answer.refusal.code === "transform-test.unsupported-transform"
  ) {
    if (transform.queryTransform) {
      fail(
        `${label}: Metabase cannot test it; the lint takes it for a query transform`,
      );
    } else {
      // Agreed, but no reads were compared.
      console.log(
        `OK    ${label}: not a query transform, which Metabase cannot test`,
      );
    }
    continue;
  }
  let metabaseTables: string[];
  if (answer.kind === "accepted") {
    metabaseTables = [];
  } else if (
    answer.refusal.code === "transform-test.missing-inputs" &&
    answer.tables !== null
  ) {
    metabaseTables = answer.tables;
  } else {
    fail(
      `${label}: Metabase refused the probe with ${describeRefusal(answer.refusal)}, which the lint does not explain`,
    );
    continue;
  }
  transformsCompared++;
  if (!transform.queryTransform) {
    fail(
      `${label}: Metabase tests it; the lint takes it for a transform Metabase cannot test`,
    );
  } else if (transform.tables === null) {
    fail(
      `${label}: the lint could not read it; Metabase reads ${metabaseTables.join(", ") || "nothing"}`,
    );
  } else {
    const difference = readsDiffer(transform.tables, metabaseTables);
    if (difference === null) {
      console.log(`OK    ${label}: ${metabaseTables.join(", ") || "nothing"}`);
    } else {
      fail(`${label}: ${difference}`);
    }
  }
}

// Tests: Metabase's verdict on each test against the lint's errors on it.
const testFiles = new Map(
  validDocsOf(loadDocs(folder, loadSchemas()).docs, "TransformTest").map(
    (d) => [d.body.entity_id, d.file],
  ),
);
const { findings } = await lint({ folder, defaultSchemas });
const tests = await api("GET", "/api/ee/transform-test");
if (tests.status !== 200 || !Array.isArray(tests.json)) {
  console.error(`GET /api/ee/transform-test answered ${describe(tests)}`);
  process.exit(1);
}
const metabaseTests = new Map(
  tests.json.flatMap((t: unknown) =>
    isRecord(t) &&
    typeof t.entity_id === "string" &&
    typeof t.transform_id === "number"
      ? [
          [
            t.entity_id,
            {
              transform_id: t.transform_id,
              inputs: t.inputs,
              expectations: t.expectations,
            },
          ] as const,
        ]
      : [],
  ),
);
let testsCompared = 0;
for (const [entityId, file] of testFiles) {
  const label = `test ${file}`;
  const test = metabaseTests.get(entityId);
  if (test === undefined) {
    fail(`${label}: not imported into Metabase`);
    continue;
  }
  const answer = await probe(test);
  if (answer.kind === "failed") {
    fail(`${label}: Metabase answered the probe ${answer.answer}`);
    continue;
  }
  if (
    answer.kind === "refused" &&
    ENVIRONMENT_REFUSALS.has(answer.refusal.code)
  ) {
    console.log(
      `SKIP  ${label}: Metabase refused the probe with ${describeRefusal(answer.refusal)}`,
    );
    continue;
  }
  let refusal: TestRefusal | null = null;
  if (answer.kind === "refused") {
    const located = await locateRefusal(answer.refusal, test);
    if (located.kind === "failed") {
      fail(
        `${label}: Metabase refused it with ${describeRefusal(answer.refusal)}, and answered the probe that locates the refusal ${located.answer}`,
      );
      continue;
    }
    refusal = located.refusal;
  }
  testsCompared++;
  const difference = testVerdictDiffers(
    refusal,
    findings.filter((f) => f.entity.entity_id === entityId),
  );
  if (difference === null) {
    console.log(
      `OK    ${label}: ${refusal === null ? "accepted" : describeRefusal(refusal)}`,
    );
  } else {
    fail(`${label}: ${difference}`);
  }
}

// A run that compared nothing proves nothing.
if (transforms.length > 0 && transformsCompared === 0) {
  fail(
    "compared no transform with Metabase: every probe was refused or failed",
  );
}
if (testFiles.size > 0 && testsCompared === 0) {
  fail(
    "compared no transform test with Metabase: every probe was refused or failed",
  );
}
process.exit(failed ? 1 : 0);
