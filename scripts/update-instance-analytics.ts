// Writes vendor/instance-analytics.json: the entity id and model of each
// entity in Metabase's instance analytics content
// (resources/instance_analytics), which Metabase EE loads at startup, so
// every instance has it and a reference to it needs no file.
//
//   bun run scripts/update-instance-analytics.ts <metabase checkout> <commit>
//
// Reads the checkout's files as they are; `commit` is recorded, not checked
// out. Not part of check-metabase-sources.ts yet.
import { globSync } from "glob";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

import { isRecord, isUnknownArray } from "../src/values.js";
import { VENDOR_DIR } from "../src/vendor-sources.js";

const PATH = "resources/instance_analytics";

const [checkout, commit] = process.argv.slice(2);
if (checkout === undefined || commit === undefined) {
  console.log(
    "Usage: bun run scripts/update-instance-analytics.ts <metabase checkout> <commit>",
  );
  process.exit(1);
}

const entities: Record<string, string> = {};
for (const file of globSync("**/*.yaml", {
  cwd: resolve(checkout, PATH),
}).sort()) {
  const body: unknown = parse(
    readFileSync(resolve(checkout, PATH, file), "utf8"),
  );
  const meta = isRecord(body) ? body["serdes/meta"] : undefined;
  const last = isUnknownArray(meta) ? meta[meta.length - 1] : undefined;
  if (
    isRecord(body) &&
    typeof body.entity_id === "string" &&
    isRecord(last) &&
    typeof last.model === "string"
  ) {
    entities[body.entity_id] = last.model;
  }
}
const sorted = Object.fromEntries(
  Object.entries(entities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
writeFileSync(
  resolve(VENDOR_DIR, "instance-analytics.json"),
  `${JSON.stringify({ repository: "metabase/metabase", path: PATH, commit, entities: sorted }, null, 2)}\n`,
);
console.log(
  `Wrote ${Object.keys(sorted).length} entities from ${PATH} at ${commit}`,
);
