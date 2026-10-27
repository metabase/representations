import { readFileSync } from "fs";
import { globSync } from "glob";
import yaml from "js-yaml";
import { resolve } from "path";

import { getModel, IMPORT_PATHS, validateSchema } from "./validate-schema.js";
import { isRecord, stringOrNull } from "./values.js";

/** A representation file or table file that parses to a YAML map. */
export type Doc = {
  file: string;
  model: string | null;
  body: Record<string, any>;
  /** False when `validateSchema` refuses the file; always true for a table file, which it does not check. */
  schemaValid: boolean;
};

/** The table files of a folder. They are not imported, so `validateSchema` does not check them. */
export const TABLE_PATHS = ["databases/**/tables/**/*.yaml"];

/** The documents of one model that match their schema. */
export function validDocsOf(docs: readonly Doc[], model: string): Doc[] {
  return docs.filter((d) => d.model === model && d.schemaValid);
}

/** The document's name, or its file when it has none. */
export function displayName(doc: Doc): string {
  return stringOrNull(doc.body.name) ?? doc.file;
}

/**
 * Every representation file and table file in `folder` that parses to a YAML
 * map, in path order. Files that do not parse, or parse to something else, are
 * left out.
 */
export function loadDocs(folder: string): Doc[] {
  const invalid = new Set(
    validateSchema({ folder })
      .results.filter((r) => r.status === "fail")
      .map((r) => r.file),
  );
  const docs: Doc[] = [];
  const files = new Set(
    globSync([...IMPORT_PATHS, ...TABLE_PATHS], { cwd: folder }),
  );
  for (const file of [...files].sort()) {
    let body: unknown;
    try {
      body = yaml.load(readFileSync(resolve(folder, file), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(body)) {
      continue;
    }
    docs.push({
      file,
      model: stringOrNull(getModel(body)),
      body,
      schemaValid: !invalid.has(file),
    });
  }
  return docs;
}

/** The `type` of the document's `source`, such as `"query"` or `"python"`; undefined when it has no source. */
export function sourceTypeOf(doc: Doc): unknown {
  return doc.body.source?.type;
}

/** Every document with an entity_id, keyed by it; several when the id is duplicated. */
export function indexByEntityId(docs: readonly Doc[]): Map<string, Doc[]> {
  const byEntityId = new Map<string, Doc[]>();
  for (const doc of docs) {
    const id = stringOrNull(doc.body.entity_id);
    if (id !== null) {
      byEntityId.set(id, [...(byEntityId.get(id) ?? []), doc]);
    }
  }
  return byEntityId;
}
