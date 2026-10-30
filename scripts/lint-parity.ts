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
// Transform rules, with --probe-transforms: for each mutation of
// TRANSFORM_PROBES, each transform it changes is created anew, once as
// Metabase imported it and once with the mutated file's target and
// incremental strategy. Metabase's answer to each, accepted or refused with a
// message, must match the lint's errors on that transform in the folder and
// in its mutated copy. The mutations edit examples/v1's files by path, so the
// folder must be examples/v1 or a copy of it.
// Metabase's transform API refuses with a message and no error code, and the
// comparison matches the English message, so these probes need a Metabase
// whose API-key user reads English (site locale "en").
//
// Nothing is saved on a refusal; a test or transform that is created is
// deleted again, and a deletion of a test that Metabase refuses fails the run.
//
//   bun run scripts/lint-parity.ts --url URL --api-key KEY --folder DIR \
//     [--default-schema DATABASE=SCHEMA ...] [--probe-transforms]
//
// Exits 1 when any comparison differs, when Metabase refuses a probe for a
// reason the lint does not explain, or when nothing could be compared.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadDocs, validDocsOf, type ValidDoc } from "../src/documents.js";
import type { LintFinding, LintRule } from "../src/findings.js";
import { lint, transformReads } from "../src/lint.js";
import { loadSchemas } from "../src/schemas.js";
import { columnOfRef } from "../src/tables.js";
import { mutateExamples } from "../src/test-support/lint-mutations.js";
import { isRecord } from "../src/values.js";
import {
  describeRefusal,
  ENVIRONMENT_REFUSALS,
  changedTransforms,
  readsDiffer,
  type TestRefusal,
  testVerdictDiffers,
  transformVerdictDiffers,
} from "./parity.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "api-key": { type: "string" },
    folder: { type: "string" },
    "default-schema": { type: "string", multiple: true },
    "probe-transforms": { type: "boolean" },
  },
});
const url = values.url;
const apiKey = values["api-key"];
// Typed string so that the function declarations below, which run after the
// usage check, see it narrowed.
const folder: string = values.folder ?? "";
if (!url || !apiKey || !folder) {
  console.error(
    "usage: bun run scripts/lint-parity.ts --url URL --api-key KEY --folder DIR [--default-schema DATABASE=SCHEMA ...] [--probe-transforms]\n" +
      "--probe-transforms needs DIR to be examples/v1 or a copy of it.",
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

/**
 * The mutations whose rule Metabase's transform API enforces and an import
 * does not; each mutation has its rule's name.
 */
const TRANSFORM_PROBES = [
  "missing-target-schema",
  "missing-incremental-table-tag",
  "missing-target-database",
] as const satisfies readonly LintRule[];

/** The table every probe transform writes, which no transform of the folder writes. */
const PROBE_TARGET_TABLE = "lint_parity_probe";

/** Metabase's answer to creating a transform. */
type TransformProbe =
  | { kind: "accepted" }
  /** Refused with status 400 and this message. */
  | { kind: "refused"; message: string }
  /** Refused with status 402: the token lacks the feature for this kind of transform. */
  | { kind: "unlicensed"; answer: string }
  /** Anything else, such as a 403, or a transform created and not deleted. */
  | { kind: "failed"; answer: string };

async function probeTransform(body: unknown): Promise<TransformProbe> {
  const answer = await api("POST", "/api/transform", body);
  const json = isRecord(answer.json) ? answer.json : {};
  if (answer.status === 200 && typeof json.id === "number") {
    const deleted = await api("DELETE", `/api/transform/${json.id}`);
    return deleted.status === 204
      ? { kind: "accepted" }
      : {
          kind: "failed",
          answer: `created transform ${json.id}, then answered its deletion ${describe(deleted)}`,
        };
  }
  if (answer.status === 400) {
    // A failed check answers its message as plain text; a body that fails the
    // endpoint's schema answers JSON, which the whole text describes.
    const message =
      typeof answer.json === "string" ? answer.json : answer.text.trim();
    return { kind: "refused", message };
  }
  if (answer.status === 402) {
    return { kind: "unlicensed", answer: describe(answer) };
  }
  return { kind: "failed", answer: describe(answer) };
}

/** Resolves the names a transform file uses to Metabase's ids. */
function createIdResolver(databaseIdByName: ReadonlyMap<string, number>) {
  const metadata = new Map<number, Promise<Answer>>();
  return {
    database: (name: string) => databaseIdByName.get(name) ?? null,
    /**
     * The id of the field a `[database, schema, table, field]` reference
     * names, or why there is none: Metabase has no such field, or its
     * metadata request failed.
     */
    field: async (ref: unknown): Promise<number | string> => {
      const noField = `Metabase has no field ${JSON.stringify(ref)}`;
      const column = columnOfRef(ref);
      const databaseId =
        column?.table.database == null
          ? undefined
          : databaseIdByName.get(column.table.database);
      if (column === null || databaseId === undefined) {
        return noField;
      }
      let request = metadata.get(databaseId);
      if (request === undefined) {
        request = api("GET", `/api/database/${databaseId}/metadata`);
        metadata.set(databaseId, request);
      }
      const answer = await request;
      if (answer.status !== 200 || !isRecord(answer.json)) {
        return `GET /api/database/${databaseId}/metadata answered ${describe(answer)}`;
      }
      const table = asRecords(answer.json.tables).find(
        (t) => t.schema === column.table.schema && t.name === column.table.name,
      );
      const field = asRecords(table?.fields).find(
        (f) => f.name === column.column,
      );
      return typeof field?.id === "number" ? field.id : noField;
    },
  };
}

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/**
 * The body that creates `imported`, Metabase's transform, anew, with the
 * target and the source's incremental strategy of `doc`, its file, and a
 * target table no transform writes. Metabase's API takes ids where a file
 * names databases and fields; the transform's query or Python body comes from
 * `imported`, where the import has already resolved it. A string names what
 * could not be resolved.
 */
async function transformRequest(
  imported: Readonly<Record<string, unknown>>,
  doc: ValidDoc<"Transform">,
  ids: ReturnType<typeof createIdResolver>,
): Promise<Record<string, unknown> | string> {
  const { target } = doc.body;
  const database =
    target.database === undefined ? null : ids.database(target.database);
  if (target.database !== undefined && database === null) {
    return `Metabase has no database ${target.database}`;
  }
  const source: Record<string, unknown> = isRecord(imported.source)
    ? { ...imported.source }
    : {};
  delete source["source-incremental-strategy"];
  const fileSource: unknown = doc.body.source;
  const strategy = isRecord(fileSource)
    ? fileSource["source-incremental-strategy"]
    : undefined;
  if (isRecord(strategy)) {
    const fieldRef = strategy["checkpoint-filter-field-id"];
    const field = fieldRef === undefined ? null : await ids.field(fieldRef);
    if (typeof field === "string") {
      return field;
    }
    source["source-incremental-strategy"] = {
      ...strategy,
      ...(field === null ? {} : { "checkpoint-filter-field-id": field }),
    };
  }
  return {
    name: `lint parity probe: ${doc.body.name}`,
    source,
    target: {
      type: target.type,
      name: PROBE_TARGET_TABLE,
      // Metabase's endpoint schema refuses a blank schema before its own
      // check that a schema is given, which is the check the lint predicts.
      ...(typeof target.schema === "string" && target.schema.trim() !== ""
        ? { schema: target.schema }
        : {}),
      ...(database === null ? {} : { database }),
      // Metabase's API requires a strategy for an incremental target, which
      // a transform file need not give.
      ...(target.type === "table-incremental"
        ? { "target-incremental-strategy": { type: "append" } }
        : {}),
    },
    collection_id: imported.collection_id ?? null,
  };
}

/**
 * Compares Metabase's answer to each shape of each transform the mutations of
 * TRANSFORM_PROBES change with the lint's errors on it, and fails each rule
 * for which it compared no answer.
 */
async function compareTransformProbes(): Promise<void> {
  const databases = await api("GET", "/api/database");
  if (!isRecord(databases.json) || databases.status !== 200) {
    fail(`GET /api/database answered ${describe(databases)}`);
    return;
  }
  const ids = createIdResolver(
    new Map(
      asRecords(databases.json.data).flatMap((d) =>
        typeof d.name === "string" && typeof d.id === "number"
          ? [[d.name, d.id] as const]
          : [],
      ),
    ),
  );
  for (const name of TRANSFORM_PROBES) {
    let compared = 0;
    const workdir = mkdtempSync(join(tmpdir(), "lint-parity-"));
    try {
      const mutatedFolder = join(workdir, "repo");
      try {
        mutateExamples(name, mutatedFolder, folder);
      } catch (e) {
        fail(
          `probe ${name}: --probe-transforms needs --folder to be examples/v1 or a copy of it: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      const changed = changedTransforms(folder, mutatedFolder);
      if (changed.length === 0) {
        fail(`probe ${name}: the mutation changes no transform`);
        continue;
      }
      const mutatedFindings = (
        await lint({ folder: mutatedFolder, defaultSchemas })
      ).findings;
      for (const pair of changed) {
        if (!pair.carried) {
          fail(
            `probe ${name}: the mutation changes transform ${pair.clean.file} beyond its target's type, schema and database and its incremental strategy, which no probe carries`,
          );
          continue;
        }
        compared += await compareTransformProbe(name, pair.clean, ids, [
          { shape: "as imported", doc: pair.clean, findings },
          { shape: "as mutated", doc: pair.mutated, findings: mutatedFindings },
        ]);
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    // A rule whose probes all failed or were skipped was not compared.
    if (compared === 0) {
      fail(
        `probe ${name}: compared no answer with Metabase: every probe failed or was skipped`,
      );
    }
  }
}

/**
 * Compares Metabase's answer to each of `shapes`, a file of `clean`'s
 * transform with the findings of its folder, with those findings. Returns how
 * many answers it compared.
 */
async function compareTransformProbe(
  name: string,
  clean: ValidDoc<"Transform">,
  ids: ReturnType<typeof createIdResolver>,
  shapes: {
    shape: string;
    doc: ValidDoc<"Transform">;
    findings: readonly LintFinding[];
  }[],
): Promise<number> {
  const label = `probe ${name}, transform ${clean.body.name} (${clean.file})`;
  const id = transformIdByEntityId.get(clean.body.entity_id);
  if (id === undefined) {
    fail(`${label}: not imported into Metabase`);
    return 0;
  }
  const imported = await api("GET", `/api/transform/${id}`);
  if (imported.status !== 200 || !isRecord(imported.json)) {
    fail(`${label}: GET /api/transform/${id} answered ${describe(imported)}`);
    return 0;
  }
  let compared = 0;
  for (const { shape, doc, findings: shapeFindings } of shapes) {
    const request = await transformRequest(imported.json, doc, ids);
    if (typeof request === "string") {
      fail(`${label}, ${shape}: ${request}`);
      continue;
    }
    const answer = await probeTransform(request);
    if (answer.kind === "failed") {
      fail(`${label}, ${shape}: Metabase answered the probe ${answer.answer}`);
      continue;
    }
    if (answer.kind === "unlicensed") {
      console.log(
        `SKIP  ${label}, ${shape}: Metabase answered the probe ${answer.answer}`,
      );
      continue;
    }
    compared++;
    const refusal = answer.kind === "refused" ? answer.message : null;
    const difference = transformVerdictDiffers(
      refusal,
      shapeFindings.filter((f) => f.entity.entity_id === doc.body.entity_id),
    );
    if (difference === null) {
      console.log(
        `OK    ${label}, ${shape}: ${refusal === null ? "accepted" : `refused (${JSON.stringify(refusal)})`}`,
      );
    } else {
      fail(`${label}, ${shape}: ${difference}`);
    }
  }
  return compared;
}

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

// Transform rules: Metabase's answer to saving each transform a mutation
// changes, as imported and as mutated, against the lint's errors on it.
if (values["probe-transforms"]) {
  await compareTransformProbes();
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
