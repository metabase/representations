// Records lint-parity corpus cases (corpus.ts) from a real Metabase.
//
// Each case is committed to a branch of its own in REPO, the git repository
// the Metabase at URL syncs from, imported, and probed as lint-parity.ts
// probes: every transform with a test that has no inputs, and every transform
// test created again as Metabase imported it. Metabase's answers are the
// case's expected answers.
//
// --runs N generates N cases from --seed (corpus-gen.ts). A case where the
// lint disagrees is shrunk to the fewest edits that still disagree, and
// written with `known` set; an agreeing case is written when no case
// already written has its tags and answers. --findings records the cases of
// corpus-findings.ts, each written whether or not the lint agrees.
//
//   bun run scripts/record-corpus.ts --url URL --api-key KEY --repo DIR \
//     [--runs N --seed S] [--findings]
//   bun run scripts/record-corpus.ts --url URL --api-key KEY --repo DIR --check
//
// --check writes nothing: it records each case of corpus/cases again, and
// exits 1 when Metabase now answers any of them differently, so a change in
// Metabase that moves the lint's target shows up in CI.
//
// Metabase must sync from REPO and hold a warehouse named as corpus/base's
// Database file names it. The recorder enables transforms and switches git
// sync to read-write.
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";

import { isRecord } from "../src/values.js";
import {
  CASES,
  type Case,
  caseFiles,
  readCase,
  compare,
  materialize,
  type Observation,
  type TestAnswer,
  type TransformAnswer,
  writeCase,
} from "./corpus.js";
import { FINDING_CASES } from "./corpus-findings.js";
import {
  applyOps,
  caseArbitrary,
  createKeeper,
  type Op,
  tagsOf,
} from "./corpus-gen.js";
import {
  createMetabase,
  describe,
  NO_TABLE_EXPECTATION,
  type Probe,
} from "./metabase-api.js";
import { ENVIRONMENT_REFUSALS } from "./parity.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "api-key": { type: "string" },
    repo: { type: "string" },
    runs: { type: "string" },
    seed: { type: "string" },
    findings: { type: "boolean" },
    check: { type: "boolean" },
  },
});
const url = values.url;
const apiKey = values["api-key"];
const repo = values.repo;
if (!url || !apiKey || !repo) {
  console.error(
    "usage: bun run scripts/record-corpus.ts --url URL --api-key KEY --repo DIR [--runs N --seed S] [--findings] [--check]",
  );
  process.exit(2);
}
const metabase = createMetabase(url, apiKey);

// Transforms are off on a new instance, and creating a transform test needs
// read-write git sync. Both settings may be set already.
const enabled = await metabase.api("PUT", "/api/setting/transforms-enabled", {
  value: true,
});
// Metabase answers a string setting as plain text.
const syncUrl = await metabase.api("GET", "/api/setting/remote-sync-url");
if (syncUrl.status !== 200 || syncUrl.text.trim() === "") {
  console.error(
    `Metabase syncs from no repository: GET /api/setting/remote-sync-url answered ${describe(syncUrl)}`,
  );
  process.exit(1);
}
const readWrite = await metabase.api("PUT", "/api/ee/remote-sync/settings", {
  "remote-sync-url": syncUrl.text.trim(),
  "remote-sync-type": "read-write",
});
for (const answer of [enabled, readWrite]) {
  if (answer.status < 200 || answer.status >= 300) {
    console.error(`Setting up Metabase failed: ${describe(answer)}`);
    process.exit(1);
  }
}

const properties = await metabase.api("GET", "/api/session/properties");
const version =
  isRecord(properties.json) && isRecord(properties.json.version)
    ? `${properties.json.version.tag} (${properties.json.version.hash})`
    : "unknown";

function git(args: string[], env: Record<string, string> = {}): string {
  const run = spawnSync("git", ["--git-dir", join(repo!, ".git"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }
  return run.stdout.trim();
}

/** Commits `folder` as the only commit of a new branch, and answers the branch. */
let branches = 0;
function commitBranch(folder: string): string {
  const index = join(folder, "..", "index");
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  git(["--work-tree", folder, "add", "-A", "."], env);
  const tree = git(["write-tree"], env);
  const commit = git([
    "-c",
    "user.name=corpus",
    "-c",
    "user.email=corpus@example.com",
    "commit-tree",
    tree,
    "-m",
    "corpus case",
  ]);
  const branch = `corpus-${Date.now()}-${branches++}`;
  git(["update-ref", `refs/heads/${branch}`, commit]);
  return branch;
}

/** The entity_id of each file of `model` in `folder`, by entity_id. */
function filesByEntityId(folder: string, model: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith(".yaml")) {
        let doc: unknown;
        try {
          doc = parse(readFileSync(path, "utf8"));
        } catch {
          continue;
        }
        const meta =
          isRecord(doc) && Array.isArray(doc["serdes/meta"])
            ? doc["serdes/meta"].at(-1)
            : null;
        if (
          isRecord(doc) &&
          isRecord(meta) &&
          meta.model === model &&
          typeof doc.entity_id === "string"
        ) {
          files.set(doc.entity_id, relative(folder, path));
        }
      }
    }
  };
  walk(folder);
  return files;
}

/**
 * A server error, as a refusal coded `http`: its status, and the message of
 * its JSON body without the stack trace, or its whole body. Any other answer
 * that is no transform-test answer, such as a 403, says the environment is
 * wrong, and stops the recording rather than become a case's answer.
 */
function httpRefusal(answer: string): { refused: string; message: string } {
  if (!/^5\d\d /.test(answer)) {
    throw new Error(`Metabase answered a probe ${answer}`);
  }
  const space = answer.indexOf(" ");
  let message = answer;
  try {
    const json: unknown = JSON.parse(answer.slice(space + 1));
    if (isRecord(json) && typeof json.message === "string") {
      message = `${answer.slice(0, space)} ${json.message}`;
    }
  } catch {
    // Not JSON: keep the whole answer.
  }
  return { refused: "http", message };
}

const failedAsRefusal = (p: Extract<Probe, { kind: "failed" }>) =>
  httpRefusal(p.answer);

type ProbeTest = Parameters<typeof metabase.probe>[0];

/**
 * Metabase's answer to `test`, asked again when it is a server error: a
 * server error becomes a case's answer only when Metabase gives it twice.
 */
async function stableProbe(test: ProbeTest): Promise<Probe> {
  const first = await metabase.probe(test);
  if (first.kind !== "failed") {
    return first;
  }
  const again = await metabase.probe(test);
  if (
    again.kind !== "failed" ||
    httpRefusal(again.answer).message !== httpRefusal(first.answer).message
  ) {
    throw new Error(
      `Metabase answered a probe ${first.answer}, and then differently`,
    );
  }
  return first;
}

async function transformAnswer(id: number): Promise<TransformAnswer> {
  const p = await stableProbe({
    transform_id: id,
    inputs: [],
    expectations: [NO_TABLE_EXPECTATION],
  });
  if (p.kind === "accepted") {
    return { reads: [] };
  }
  if (p.kind === "failed") {
    return failedAsRefusal(p);
  }
  if (ENVIRONMENT_REFUSALS.has(p.refusal.code)) {
    return { skipped: p.refusal.code };
  }
  if (p.refusal.code === "transform-test.unsupported-transform") {
    return { untestable: true };
  }
  if (p.refusal.code === "transform-test.missing-inputs" && p.tables !== null) {
    return { reads: p.tables };
  }
  return { refused: p.refusal.code, message: p.refusal.message };
}

async function testAnswer(test: {
  transform_id: number;
  inputs: unknown;
  expectations: unknown;
}): Promise<TestAnswer> {
  const p = await stableProbe(test);
  if (p.kind === "accepted") {
    return { accepted: true };
  }
  if (p.kind === "failed") {
    return { ...failedAsRefusal(p), on_transform: false };
  }
  if (ENVIRONMENT_REFUSALS.has(p.refusal.code)) {
    return { skipped: p.refusal.code };
  }
  const located = await metabase.locateRefusal(p.refusal, test);
  if (located.kind === "failed") {
    return { ...httpRefusal(located.answer), on_transform: false };
  }
  return {
    refused: located.refusal.code,
    message: located.refusal.message,
    on_transform: located.refusal.onTransform,
  };
}

async function list(path: string): Promise<Record<string, unknown>[]> {
  const answer = await metabase.api("GET", path);
  if (answer.status !== 200 || !Array.isArray(answer.json)) {
    throw new Error(`GET ${path} answered ${describe(answer)}`);
  }
  return answer.json.filter(isRecord);
}

async function observe(folder: string): Promise<Observation> {
  const branch = commitBranch(folder);
  const imported = await metabase.importBranch(branch);
  // The import has read the branch; the probes below do not need it.
  git(["update-ref", "-d", `refs/heads/${branch}`]);
  if (imported.status === "failed") {
    return {
      metabase: version,
      import: { status: "failed", message: imported.message },
      transforms: {},
      tests: {},
    };
  }
  const transformFiles = filesByEntityId(folder, "Transform");
  const testFiles = filesByEntityId(folder, "TransformTest");
  const transforms: Record<string, TransformAnswer> = {};
  for (const t of await list("/api/transform")) {
    const file =
      typeof t.entity_id === "string"
        ? transformFiles.get(t.entity_id)
        : undefined;
    if (file !== undefined && typeof t.id === "number") {
      transforms[file] = await transformAnswer(t.id);
    }
  }
  const tests: Record<string, TestAnswer> = {};
  for (const t of await list("/api/ee/transform-test")) {
    const file =
      typeof t.entity_id === "string" ? testFiles.get(t.entity_id) : undefined;
    if (file !== undefined && typeof t.transform_id === "number") {
      tests[file] = await testAnswer({
        transform_id: t.transform_id,
        inputs: t.inputs,
        expectations: t.expectations,
      });
    }
  }
  return {
    metabase: version,
    import: { status: "successful" },
    transforms,
    tests,
  };
}

const scratch = mkdtempSync(join(tmpdir(), "corpus-"));
const folder = join(scratch, "case");

async function evaluate(edits: Record<string, string | null>) {
  materialize(edits, folder);
  const observation = await observe(folder);
  return { observation, differences: await compare(folder, observation) };
}

/** The fewest of `ops` whose case still disagrees on the same files. */
async function shrink(
  ops: Op[],
  differences: string[],
): Promise<{ ops: Op[]; observation: Observation; differences: string[] }> {
  const filesOf = (ds: string[]) =>
    ds
      .map((d) => d.split(":")[0])
      .sort()
      .join();
  let best = { ops, observation: null as Observation | null, differences };
  for (let i = 0; i < best.ops.length && best.ops.length > 1; ) {
    const fewer = best.ops.filter((_, j) => j !== i);
    const r = await evaluate(applyOps(fewer));
    if (
      r.differences.length > 0 &&
      filesOf(r.differences) === filesOf(differences)
    ) {
      best = { ops: fewer, ...r };
    } else {
      i++;
    }
  }
  if (best.observation === null) {
    const r = await evaluate(applyOps(best.ops));
    best = { ops: best.ops, ...r };
  }
  return best as { ops: Op[]; observation: Observation; differences: string[] };
}

const keeper = createKeeper();
for (const file of caseFiles()) {
  keeper.prime(readCase(file));
}
let written = 0;
let disagreements = 0;
function write(name: string, c: Case): void {
  writeCase(join(CASES, `${name}.yaml`), c);
  written++;
  console.log(
    `${c.known === null ? "AGREE   " : "DIFFERS "} ${name}: ${c.description}${c.known === null ? "" : `\n         ${c.known}`}`,
  );
}

/**
 * `o` without the Metabase that answered, with its keys sorted, for comparing
 * answers across versions. Metabase's messages are compared too: the probes
 * run in English, and a reworded refusal is worth a look.
 */
const answers = (o: Observation) =>
  JSON.stringify({ ...o, metabase: null }, (_, v: unknown) =>
    isRecord(v) && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

try {
  if (values.check) {
    let changed = 0;
    for (const file of caseFiles()) {
      const c = readCase(file);
      const { observation } = await evaluate(c.edits);
      if (answers(observation) === answers(c.observation)) {
        console.log(`SAME     ${basename(file)}`);
      } else {
        changed++;
        console.log(
          `CHANGED  ${basename(file)}\n  recorded (${c.observation.metabase}): ${answers(c.observation)}\n  now (${observation.metabase}): ${answers(observation)}`,
        );
      }
    }
    process.exitCode = changed > 0 ? 1 : 0;
  }
  if (values.findings) {
    for (const f of FINDING_CASES) {
      const { observation, differences } = await evaluate(f.edits());
      write(f.name, {
        description: f.description,
        origin: f.origin,
        known: differences.length === 0 ? null : differences.join("\n"),
        edits: f.edits(),
        observation,
      });
    }
  }
  const runs = Number(values.runs ?? 0);
  const seed = Number(values.seed ?? 1);
  for (const [k, ops] of fc
    .sample(caseArbitrary, { numRuns: runs, seed })
    .entries()) {
    const { observation, differences } = await evaluate(applyOps(ops));
    if (differences.length > 0) {
      disagreements++;
      const small = await shrink(ops, differences);
      if (!keeper.keepDisagreeing(tagsOf(small.ops), small.differences)) {
        continue;
      }
      write(`gen-${seed}-${k}`, {
        description: tagsOf(small.ops).join(", "),
        origin: `corpus-gen.ts, seed ${seed}, case ${k}, shrunk to ${small.ops.length} of ${ops.length} edits`,
        known: small.differences.join("\n"),
        edits: applyOps(small.ops),
        observation: small.observation,
      });
    } else if (keeper.keepAgreeing(tagsOf(ops), observation)) {
      write(`gen-${seed}-${k}`, {
        description: tagsOf(ops).join(", "),
        origin: `corpus-gen.ts, seed ${seed}, case ${k}`,
        known: null,
        edits: applyOps(ops),
        observation,
      });
    }
  }
  if (runs > 0 || values.findings) {
    console.log(
      `${written} cases written; ${disagreements} of ${runs} generated cases disagreed before shrinking`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
