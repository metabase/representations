// The lint-parity corpus: folders, each the base folder with some files
// changed, and what a real Metabase did with each. corpus.test.ts lints every
// case and compares the lint with Metabase's recorded answers, offline, with
// the comparisons lint-parity.ts makes live, plus a check of failed imports. record-corpus.ts writes the cases;
// nothing else may, so the expected answers always come from Metabase.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

import { loadDocs, validDocsOf } from "../src/documents.js";
import { lint, transformReads } from "../src/lint.js";
import { loadSchemas } from "../src/schemas.js";
import {
  readsDiffer,
  TEST_RULE_ORDER,
  type TestRefusal,
  testVerdictDiffers,
} from "./parity.js";

export const CORPUS = resolve(import.meta.dirname, "..", "corpus");
export const BASE = join(CORPUS, "base");
export const CASES = join(CORPUS, "cases");

/** Metabase's answer to a probe test of a transform with no inputs. */
export type TransformAnswer =
  /** Accepted, or refused for missing inputs: the tables Metabase reads. */
  | { reads: string[] }
  /** Refused as not a query transform. */
  | { untestable: true }
  /** Refused with any other code: the lint explains none of these. */
  | { refused: string; message: string | null }
  /** Refused for the environment, such as the driver: nothing compared. */
  | { skipped: string };

/** Metabase's answer to creating a transform test again, as it imported it. */
export type TestAnswer =
  | { accepted: true }
  | { refused: string; message: string | null; on_transform: boolean }
  | { skipped: string };

export type Observation = {
  /** The Metabase that answered: its version, as /api/session/properties gives it. */
  metabase: string;
  /** Whether Metabase imported the folder, and its message when it did not. */
  import:
    | { status: "successful" }
    | { status: "failed"; message: string | null };
  /** By transform file. Empty when the import failed. */
  transforms: Record<string, TransformAnswer>;
  /** By transform test file. Empty when the import failed. */
  tests: Record<string, TestAnswer>;
};

export type Case = {
  description: string;
  /** Where the case came from: a generator seed, or a review finding. */
  origin: string;
  /**
   * Set when the lint disagrees with Metabase on this case: the difference,
   * as compare gave it when the case was recorded. The test of such a case is
   * expected to fail, so fixing the lint fails it until `known` is removed.
   */
  known: string | null;
  /** New contents by file, relative to the base; null deletes the file. */
  edits: Record<string, string | null>;
  observation: Observation;
};

export function readCase(file: string): Case {
  return parse(readFileSync(file, "utf8")) as Case;
}

export function writeCase(file: string, c: Case): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    stringify(c, {
      blockQuote: "literal",
      lineWidth: 0,
      aliasDuplicateObjects: false,
    }),
  );
}

export function caseFiles(): string[] {
  return readdirSync(CASES)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => join(CASES, f));
}

/** Writes the base folder with `edits` applied to `folder`, replacing it. */
export function materialize(
  edits: Readonly<Record<string, string | null>>,
  folder: string,
): void {
  rmSync(folder, { recursive: true, force: true });
  cpSync(BASE, folder, { recursive: true });
  for (const [file, content] of Object.entries(edits)) {
    const path = join(folder, file);
    if (content === null) {
      rmSync(path, { force: true });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

/** The entity_ids Metabase's import message names, each written as `id`. */
const entityIdsIn = (message: string | null) =>
  [...(message ?? "").matchAll(/`([\w-]{21})`/g)].map((m) => m[1]!);

/**
 * The differences between the lint of `folder` and Metabase's answers on it,
 * empty when they agree. A failed import must come with a lint error that is
 * not a transform test's rule (those are refused when a test is created, not
 * imported), on an entity the import's message names when it names one. After
 * an import, no file may have a schema error, each transform's reads and each test's verdict are compared as
 * lint-parity.ts compares them, and every transform and test must have an
 * answer that was not skipped.
 */
export async function compare(
  folder: string,
  observation: Observation,
): Promise<string[]> {
  const differences: string[] = [];
  const { findings } = await lint({ folder });
  if (observation.import.status === "failed") {
    const named = entityIdsIn(observation.import.message);
    const explains = findings.some(
      (f) =>
        f.severity === "error" &&
        !TEST_RULE_ORDER.includes(f.rule) &&
        (named.length === 0 ||
          (f.entity.entity_id !== null && named.includes(f.entity.entity_id))),
    );
    if (!explains) {
      differences.push(
        `Metabase refuses the import (${JSON.stringify(observation.import.message)}); the lint reports no error that explains it`,
      );
    }
    return differences;
  }
  // An error is a refusal (findings.ts); a schema error says Metabase
  // refuses the file at import, and Metabase imported the folder.
  for (const f of findings) {
    if (f.severity === "error" && f.rule === "schema") {
      differences.push(
        `${f.file}: Metabase imports it; the lint reports schema: ${f.message}`,
      );
    }
  }
  const reads = new Map(
    (await transformReads({ folder })).map((t) => [t.file, t]),
  );
  let compared = 0;
  for (const [file, answer] of Object.entries(observation.transforms)) {
    const transform = reads.get(file);
    if ("skipped" in answer) {
      continue;
    }
    compared++;
    if (transform === undefined) {
      differences.push(
        `${file}: Metabase has the transform; the lint does not read it`,
      );
    } else if ("untestable" in answer) {
      if (transform.queryTransform) {
        differences.push(
          `${file}: Metabase cannot test it; the lint takes it for a query transform`,
        );
      }
    } else if ("refused" in answer) {
      differences.push(
        `${file}: Metabase refuses the probe with ${answer.refused}, which the lint does not explain`,
      );
    } else if (!transform.queryTransform) {
      differences.push(
        `${file}: Metabase tests it; the lint takes it for a transform Metabase cannot test`,
      );
    } else if (transform.tables === null) {
      differences.push(
        `${file}: the lint could not read it; Metabase reads ${answer.reads.join(", ") || "nothing"}`,
      );
    } else {
      const difference = readsDiffer(transform.tables, answer.reads);
      if (difference !== null) {
        differences.push(`${file}: ${difference}`);
      }
    }
  }
  for (const file of reads.keys()) {
    if (!(file in observation.transforms)) {
      differences.push(
        `${file}: the lint reads a transform Metabase did not import`,
      );
    }
  }
  for (const [file, answer] of Object.entries(observation.tests)) {
    if ("skipped" in answer) {
      continue;
    }
    compared++;
    const refusal: TestRefusal | null =
      "accepted" in answer
        ? null
        : {
            code: answer.refused,
            message: answer.message,
            onTransform: answer.on_transform,
          };
    const difference = testVerdictDiffers(
      refusal,
      findings.filter((f) => f.file === file),
    );
    if (difference !== null) {
      differences.push(`${file}: ${difference}`);
    }
  }
  for (const file of testFilesOf(folder)) {
    if (!(file in observation.tests)) {
      differences.push(`${file}: Metabase did not import this transform test`);
    }
  }
  if (compared === 0) {
    differences.push("compared nothing: every answer was skipped");
  }
  return differences;
}

/** The transform test files the lint loads from `folder`. */
function testFilesOf(folder: string): string[] {
  return validDocsOf(loadDocs(folder, loadSchemas()).docs, "TransformTest").map(
    (d) => d.file,
  );
}
