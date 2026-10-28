import { readFileSync } from "fs";
import { globSync } from "glob";
import { resolve } from "path";

import type { Schemas } from "./schemas.js";
import { getModel, IMPORT_PATHS, validateFolder } from "./validate-schema.js";
import { errorMessage, isRecord, stringOrNull } from "./values.js";
import {
  type NonStringKey,
  readYaml,
  type YamlDocument,
  YamlReadError,
} from "./yaml.js";

/** A representation file or table file that parses to a YAML map. */
export type Doc = {
  file: string;
  model: string | null;
  body: Record<string, unknown>;
  /** False when the file fails its model's schema; true when it passes, or when its model has no schema. */
  schemaValid: boolean;
  /** The keys of `body`'s maps that Metabase reads as something other than a string. */
  nonStringKeys: readonly NonStringKey[];
};

/** The table files of a folder. They are not imported, so `validateSchema` does not check them. */
export const TABLE_PATHS = ["databases/**/tables/**/*.yaml"];

/** The Database files of a folder. They are not imported, so `validateSchema` does not check them. */
export const DATABASE_PATHS = ["databases/*/*.yaml"];

/**
 * Returns a check of a file that `validateSchema` does not see against its
 * model's schema: `table.yaml` for a Table, which has no `serdes/meta` model
 * constant to find it by. True when the model has no schema.
 */
function createUnimportedFileCheck(
  schemas: Schemas,
): (model: string | null, body: unknown) => boolean {
  return (model, body) => {
    if (model === null) {
      return true;
    }
    const file = model === "Table" ? "table.yaml" : schemas.models.get(model);
    const validate =
      file === undefined ? undefined : schemas.ajv.getSchema(file);
    return validate === undefined || validate(body) === true;
  };
}

/** A Python source table, from `transform.yaml#/$defs/python_source`. */
type PythonSourceTable = {
  alias: string;
  database_id: string;
  schema?: string | null;
  table?: string;
  /** `[database, schema, table]`, from `common/id.yaml#/$defs/table_id`. */
  table_id?: readonly [string, string | null, string];
};

/** A schema-valid Python source, from `transform.yaml#/$defs/python_source`. */
export type PythonSource = {
  type: "python";
  "source-tables": readonly PythonSourceTable[];
};

/** A schema-valid query source, from `transform.yaml#/$defs/query_source`. */
export type QuerySource = {
  type: "query";
  /** From `common/query.yaml`, which requires each stage's `lib/type` but not its type. */
  query: { stages: readonly Readonly<Record<string, unknown>>[] };
  /** The schema types it only as an object. */
  "source-incremental-strategy"?: Readonly<Record<string, unknown>>;
};

/**
 * A schema-valid transform's source. `transform.yaml` requires a `type` and
 * checks the rest only when the type is "query" or "python".
 */
type TransformSource = PythonSource | QuerySource | { type: unknown };

/** The fields the lint reads from a schema-valid Transform, as `transform.yaml` types them. */
type TransformBody = {
  name: string;
  entity_id: string;
  source_database_id: string;
  source: TransformSource;
  target: {
    type: "table" | "table-incremental";
    name: string;
    schema?: string | null;
    database?: string;
  };
  /** A collection's entity id; null or absent for the root collection. */
  collection_id?: string | null;
};

/** Test data written out as rows, from `transform_test.yaml`. */
export type RowsData = {
  format: "rows";
  columns: readonly { name: string; cast_type: string }[];
  /** Each row by column name. */
  rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
};

/** Test data returned by a SQL query, from `transform_test.yaml`. */
type SqlData = { format: "sql"; sql: string };

type TestInput = {
  table: { schema?: string | null; name: string };
} & (RowsData | SqlData);

type TestExpectation = { name: string } & (
  | { type: "empty"; sql: string }
  | ({ type: "equals" } & (RowsData | SqlData))
);

/** The fields the lint reads from a schema-valid TransformTest, as `transform_test.yaml` types them. */
type TransformTestBody = {
  name: string;
  entity_id: string;
  transform_id: string;
  inputs: readonly TestInput[];
  expectations: readonly TestExpectation[];
};

/** The fields the lint reads from a schema-valid Table, as `table.yaml` types them. */
type TableBody = {
  name: string;
  db_id: string;
  schema?: string | null;
};

/** The fields the lint reads from a schema-valid Database, as `database.yaml` types them. */
type DatabaseBody = {
  name: string;
  engine?: string;
};

/** The fields the lint reads from a schema-valid snippet, as `snippet.yaml` types them. */
type SnippetBody = {
  name: string;
  content: string;
};

type ValidBodies = {
  NativeQuerySnippet: SnippetBody;
  Transform: TransformBody;
  TransformTest: TransformTestBody;
  Table: TableBody;
  Database: DatabaseBody;
};

/** A document of model `M` that matches its schema, with the body that schema guarantees. */
export type ValidDoc<M extends keyof ValidBodies> = Doc & {
  model: M;
  body: ValidBodies[M];
};

/** `doc` as a schema-valid document of `model`, or null when it is of another model or fails its schema. */
export function asValid<M extends keyof ValidBodies>(
  doc: Doc,
  model: M,
): ValidDoc<M> | null {
  // The body passed the schema of `model`, and ValidBodies declares only
  // fields that schema requires or types.
  return doc.model === model && doc.schemaValid ? (doc as ValidDoc<M>) : null;
}

/** The documents of one model that match their schema. */
export function validDocsOf<M extends keyof ValidBodies>(
  docs: readonly Doc[],
  model: M,
): ValidDoc<M>[] {
  return docs.flatMap((doc) => asValid(doc, model) ?? []);
}

/** Whether a schema-valid transform's source is a Python source. */
export function isPythonSource(
  source: TransformSource,
): source is PythonSource {
  // A source of type "python" passed `python_source`, which PythonSource follows.
  return source.type === "python";
}

/** Whether a schema-valid transform's source is a query, the only kind Metabase can test. */
export function isQuerySource(source: TransformSource): source is QuerySource {
  // A source of type "query" passed `query_source`, which QuerySource follows.
  return source.type === "query";
}

/** The document's name, or its file when it has none. */
export function displayName(doc: Doc): string {
  return stringOrNull(doc.body.name) ?? doc.file;
}

/** A file `loadDocs` could not read as a YAML map, and why. */
export type UnreadableFile = { file: string; reason: string };

/**
 * Every representation file, table file and Database file in `folder`, in path
 * order: those that parse to a YAML map as documents, and the others as
 * unreadable files.
 */
export function loadDocs(
  folder: string,
  schemas: Schemas,
): {
  docs: Doc[];
  unreadable: UnreadableFile[];
} {
  const invalid = new Set(
    validateFolder(folder, schemas)
      .results.filter((r) => r.status === "fail")
      .map((r) => r.file),
  );
  const imported = new Set(globSync(IMPORT_PATHS, { cwd: folder }));
  const matchesSchema = createUnimportedFileCheck(schemas);
  const docs: Doc[] = [];
  const unreadable: UnreadableFile[] = [];
  const files = new Set([
    ...imported,
    ...globSync([...TABLE_PATHS, ...DATABASE_PATHS], { cwd: folder }),
  ]);
  for (const file of [...files].sort()) {
    let read: YamlDocument;
    try {
      read = readYaml(readFileSync(resolve(folder, file), "utf8"));
    } catch (e) {
      const reason = e instanceof YamlReadError ? e.reason : errorMessage(e);
      unreadable.push({ file, reason: `does not parse as YAML: ${reason}` });
      continue;
    }
    const { value: body, nonStringKeys } = read;
    if (!isRecord(body)) {
      unreadable.push({ file, reason: "is not a YAML map" });
      continue;
    }
    const model = getModel(body);
    docs.push({
      file,
      model,
      body,
      schemaValid: imported.has(file)
        ? !invalid.has(file)
        : matchesSchema(model, body),
      nonStringKeys,
    });
  }
  return { docs, unreadable };
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

/**
 * The document an entity_id names: of the files that hold it, the first in
 * path order. Null when no file holds it.
 */
export function holderOf(
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  id: string,
): Doc | null {
  return byEntityId.get(id)?.[0] ?? null;
}
