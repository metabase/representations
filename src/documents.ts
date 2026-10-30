import { readFileSync } from "fs";
import { resolve } from "path";

import type { Schemas } from "./schemas.js";
import {
  checkSchema,
  entityFiles,
  type SchemaCheck,
  type ValidationError,
} from "./validate-schema.js";
import { errorMessage, isRecord, stringOrNull } from "./values.js";
import {
  decodeUtf8,
  type NonStringKey,
  readYaml,
  type YamlDocument,
  YamlReadError,
} from "./yaml.js";

/** A file of `entityFiles` that parses to a YAML map whose `serdes/meta` names a model. */
export type Doc = {
  file: string;
  model: string;
  body: Record<string, unknown>;
  /** How the file stands against its model's schema. */
  schema: SchemaStatus;
  /** The keys of `body`'s maps that Metabase reads as something other than a string. */
  nonStringKeys: readonly NonStringKey[];
};

/**
 * How a file stands against its model's schema: it passes, it fails (with
 * the first way it does), or no schema describes its model.
 */
export type SchemaStatus =
  | { status: "passed" }
  | { status: "failed"; error: ValidationError }
  | { status: "unchecked" };

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
  query: {
    database: string;
    stages: readonly Readonly<Record<string, unknown>>[];
  };
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
  default_schema?: string | null;
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

/**
 * `doc` as a schema-valid document of `model`, or null when it is of another
 * model, or did not pass its schema: it failed, or no schema checked it.
 */
export function asValid<M extends keyof ValidBodies>(
  doc: Doc,
  model: M,
): ValidDoc<M> | null {
  // The body passed the schema of `model`, and ValidBodies declares only
  // fields that schema requires or types.
  return doc.model === model && doc.schema.status === "passed"
    ? (doc as ValidDoc<M>)
    : null;
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

/** A schema-valid transform whose source is a query. */
export type QueryTransformDoc = ValidDoc<"Transform"> & {
  body: { source: QuerySource };
};

/** Whether a schema-valid transform's source is a query. */
export function isQueryTransformDoc(
  transform: ValidDoc<"Transform">,
): transform is QueryTransformDoc {
  return isQuerySource(transform.body.source);
}

/**
 * The database a query transform runs on, and with it each of its tests:
 * its query's database, as Metabase's `transform-source-database` finds it.
 * Its `source_database_id` may name another database: Metabase keeps it when
 * the query changes.
 */
export function queryDatabaseOf(transform: QueryTransformDoc): string {
  return transform.body.source.query.database;
}

/**
 * The database a transform writes its target to, as Metabase's
 * `target-db-id` finds it. For a query transform, the database it runs on
 * (`queryDatabaseOf`). For another transform, the database its target names,
 * or null when it names none: `source_database_id` never stands in for it.
 */
export function targetDatabaseOf(
  transform: ValidDoc<"Transform">,
): string | null {
  return isQueryTransformDoc(transform)
    ? queryDatabaseOf(transform)
    : (transform.body.target.database ?? null);
}

/** The document's name, or its file when it has none. */
export function displayName(doc: Doc): string {
  return stringOrNull(doc.body.name) ?? doc.file;
}

/** How a checked file stands against its schema. */
function schemaStatusOf(check: SchemaCheck): SchemaStatus {
  if (check.status !== "checked") {
    return { status: "unchecked" };
  }
  const [error] = check.errors;
  return error === undefined
    ? { status: "passed" }
    : { status: "failed", error };
}

/** A file `loadDocs` could not read as an entity, and why. */
export type UnreadableFile = { file: string; reason: string };

/**
 * Each of `entityFiles(folder)`, in path order: as documents, as files
 * Metabase skips for having no `serdes/meta`, or as unreadable files, which
 * do not parse to a YAML map, or whose `serdes/meta` names no model or a model
 * Metabase does not import.
 */
export function loadDocs(
  folder: string,
  schemas: Schemas,
): {
  docs: Doc[];
  skipped: string[];
  unreadable: UnreadableFile[];
} {
  const docs: Doc[] = [];
  const skipped: string[] = [];
  const unreadable: UnreadableFile[] = [];
  for (const file of entityFiles(folder)) {
    const text = decodeUtf8(readFileSync(resolve(folder, file)));
    if (text === null) {
      unreadable.push({ file, reason: "is not valid UTF-8" });
      continue;
    }
    let read: YamlDocument;
    try {
      read = readYaml(text);
      // eslint-disable-next-line no-restricted-syntax -- wraps reading a file only
    } catch (e) {
      const reason = e instanceof YamlReadError ? e.reason : errorMessage(e);
      unreadable.push({ file, reason: `does not parse as YAML: ${reason}` });
      continue;
    }
    const { value: body, nonStringKeys } = read;
    const check = checkSchema(body, schemas);
    if (check.status === "bad-timestamp") {
      unreadable.push({ file, reason: `fails to load: ${check.message}` });
    } else if (check.status === "skipped") {
      skipped.push(file);
    } else if (!isRecord(body)) {
      unreadable.push({ file, reason: "is not a YAML map" });
    } else if (check.status === "no-model") {
      unreadable.push({ file, reason: "names no model in serdes/meta" });
    } else if (check.status === "unknown-model") {
      unreadable.push({
        file,
        reason: `names the model "${check.model}", which Metabase does not import`,
      });
    } else {
      docs.push({
        file,
        model: check.model,
        body,
        schema: schemaStatusOf(check),
        nonStringKeys,
      });
    }
  }
  return { docs, skipped, unreadable };
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
