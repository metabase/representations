// Sets each corpus case's `known` to the differences the lint now gives
// against the case's recorded answers, after a change to the lint. It never
// changes the answers: those come only from Metabase (record-corpus.ts).
// Review the diff: a `known` that grows is a new disagreement.
//
//   bun run scripts/refresh-known.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  caseFiles,
  compare,
  materialize,
  readCase,
  writeCase,
} from "./corpus.js";

const scratch = mkdtempSync(join(tmpdir(), "corpus-refresh-"));
try {
  for (const file of caseFiles()) {
    const c = readCase(file);
    const folder = join(scratch, "case");
    materialize(c.edits, folder);
    const differences = await compare(folder, c.observation);
    const known = differences.length === 0 ? null : differences.join("\n");
    if (known !== c.known) {
      writeCase(file, { ...c, known });
      console.log(
        `${basename(file)}: ${known === null ? "agrees now" : known}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
