// Compares the tables the lint finds for each transform with the tables Metabase
// says a test of it must stand in for. Metabase has no endpoint for that list:
// creating a test with no inputs is refused with transform-test.missing-inputs,
// and the refusal lists the tables. Nothing is saved on a refusal; a test that
// is created (a transform that reads no table) is deleted again.
//
//   bun run scripts/lint-parity.ts --url URL --api-key KEY --folder examples/v1
//
// Exits 1 when any transform's two lists differ by table name.
import { parseArgs } from "node:util";

import { transformReads } from "../src/lint.js";

type Probe =
  | { kind: "tables"; tables: string[] }
  | { kind: "refused"; status: number; code: string }
  | { kind: "none" };

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "api-key": { type: "string" },
    folder: { type: "string" },
  },
});
const url = values.url;
const apiKey = values["api-key"];
const folder = values.folder;
if (!url || !apiKey || !folder) {
  console.error(
    "usage: bun run scripts/lint-parity.ts --url URL --api-key KEY --folder DIR",
  );
  process.exit(2);
}

const headers = { "X-API-Key": apiKey, "Content-Type": "application/json" };

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function probe(transformId: number): Promise<Probe> {
  const { status, json } = await api("POST", "/api/ee/transform-test", {
    name: "lint parity probe",
    transform_id: transformId,
    inputs: [],
    expectations: [
      { type: "empty", name: "probe", sql: "SELECT 1 WHERE 1 = 0" },
    ],
  });
  const code = json?.["error-code"] ?? json?.error_code;
  if (status === 400 && code === "transform-test.missing-inputs") {
    return { kind: "tables", tables: json.tables };
  }
  if (status === 200 && typeof json?.id === "number") {
    await api("DELETE", `/api/ee/transform-test/${json.id}`);
    return { kind: "none" };
  }
  return {
    kind: "refused",
    status,
    code: String(code ?? json?.message ?? json ?? ""),
  };
}

// A label is "schema.name" or "name"; compare by name, ignoring case, because
// the representation format may leave a schema out where the compiled SQL names it.
const names = (labels: string[]) =>
  [
    ...new Set(labels.map((l) => l.split(".").at(-1)?.toLowerCase() ?? "")),
  ].sort();

const listed = await api("GET", "/api/transform");
if (listed.status !== 200) {
  console.error(`GET /api/transform answered ${listed.status}`);
  process.exit(1);
}
const idByEntityId = new Map<string, number>(
  listed.json.map((t: { entity_id: string; id: number }) => [
    t.entity_id,
    t.id,
  ]),
);

let failed = false;
for (const transform of transformReads({ folder })) {
  const label = `${transform.name ?? transform.file} (${transform.file})`;
  const id = transform.entity_id
    ? idByEntityId.get(transform.entity_id)
    : undefined;
  if (id === undefined) {
    console.log(`FAIL  ${label}: not imported into Metabase`);
    failed = true;
    continue;
  }
  const answer = await probe(id);
  const lintTables =
    transform.tables === null
      ? null
      : names(
          transform.tables.map((t) =>
            t.schema ? `${t.schema}.${t.name}` : t.name,
          ),
        );
  if (answer.kind === "refused") {
    console.log(
      `SKIP  ${label}: Metabase refused the probe, ${answer.status} ${answer.code}`,
    );
    continue;
  }
  const metabaseTables = answer.kind === "none" ? [] : names(answer.tables);
  if (lintTables === null) {
    console.log(
      `FAIL  ${label}: the lint could not read it; Metabase reads ${metabaseTables.join(", ")}`,
    );
    failed = true;
  } else if (lintTables.join(",") !== metabaseTables.join(",")) {
    console.log(
      `FAIL  ${label}: lint reads ${lintTables.join(", ") || "nothing"}; Metabase reads ${metabaseTables.join(", ") || "nothing"}`,
    );
    failed = true;
  } else {
    console.log(`OK    ${label}: ${lintTables.join(", ") || "nothing"}`);
  }
}
process.exit(failed ? 1 : 0);
