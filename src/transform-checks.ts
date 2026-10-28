import {
  displayName,
  type Doc,
  holderOf,
  isQuerySource,
  type QuerySource,
  targetDatabaseOf,
  validDocsOf,
  type ValidDoc,
} from "./documents.js";
import type { Report } from "./findings.js";
import {
  type DefaultSchemaOf,
  sameTable,
  tableLabel,
  type TableKey,
  tableOfRef,
} from "./tables.js";
import { stringOrNull, templateTagsOf } from "./values.js";

const TRANSFORMS_NAMESPACE = "transforms";
const NATIVE_STAGE = "mbql.stage/native";

/**
 * Reports each transform whose collection is not a collection of the
 * transforms namespace, the only one Metabase puts a transform in; a
 * collection with no namespace is in the default one. Also reports a
 * transform whose collection is not in the folder: every transform's
 * collection must be in the repository. A transform in the root collection
 * (collection_id null or absent) has nothing to check. Of several files with
 * the collection's entity id, the first in path order is the collection.
 */
export function reportCollectionNamespaces(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    const id = transform.body.collection_id;
    if (id === undefined || id === null) {
      continue;
    }
    const collection = holderOf(byEntityId, id);
    if (collection === null) {
      report(
        "transform-collection",
        transform,
        `collection ${id} is not in the folder; a transform's collection must be in the repository`,
      );
    } else if (collection.model !== "Collection") {
      report(
        "transform-collection",
        transform,
        `collection_id ${id} names a ${collection.model ?? "file with no model"}, not a Collection`,
        [collection.file],
      );
    } else {
      const namespace = stringOrNull(collection.body.namespace);
      if (namespace !== TRANSFORMS_NAMESPACE) {
        report(
          "transform-collection",
          transform,
          `collection ${displayName(collection)} is in the ${namespace ?? "default"} namespace; Metabase puts a transform only in a collection of the ${TRANSFORMS_NAMESPACE} namespace`,
          [collection.file],
        );
      }
    }
  }
}

/** The single native stage of a native-only query, as Metabase defines one, or null. */
export function nativeOnlyStage(
  source: QuerySource,
): Readonly<Record<string, unknown>> | null {
  const { stages } = source.query;
  return stages.length === 1 && stages[0]["lib/type"] === NATIVE_STAGE
    ? stages[0]
    : null;
}

/**
 * What an incremental transform with a native-only query names for its range
 * filter: for each table template tag, the table it names, or null when its
 * `table-id` is not a table reference; and the checkpoint field's table, or
 * null. Null for any other transform.
 */
export function incrementalFilterTables(transform: ValidDoc<"Transform">): {
  tagTables: (TableKey | null)[];
  checkpointTable: TableKey | null;
} | null {
  const { source, target } = transform.body;
  if (target.type !== "table-incremental" || !isQuerySource(source)) {
    return null;
  }
  const stage = nativeOnlyStage(source);
  if (stage === null) {
    return null;
  }
  return {
    tagTables: templateTagsOf(stage["template-tags"])
      .filter((tag) => tag.type === "table")
      .map((tag) => tableOfRef(tag["table-id"])),
    checkpointTable: tableOfRef(
      source["source-incremental-strategy"]?.["checkpoint-filter-field-id"],
    ),
  };
}

/**
 * Reports each transform that writes an incremental table from a native-only
 * query with no table template tag for Metabase to put the incremental range
 * filter in: a tag naming the checkpoint field's table, or any table tag when
 * the checkpoint field is not set or is not a field reference (an id
 * exported as a number, its field deleted). Metabase's API refuses such a
 * transform; an import accepts it, and every run fails.
 */
export function reportIncrementalTags(
  docs: readonly Doc[],
  defaultSchemaOf: DefaultSchemaOf,
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    const filter = incrementalFilterTables(transform);
    if (filter === null) {
      continue;
    }
    const { tagTables, checkpointTable } = filter;
    if (tagTables.length === 0) {
      report(
        "missing-incremental-table-tag",
        transform,
        "the incremental native query has no table template tag for Metabase to put its range filter in",
      );
    } else if (
      checkpointTable !== null &&
      !tagTables.some(
        (table) =>
          table !== null && sameTable(table, checkpointTable, defaultSchemaOf),
      )
    ) {
      report(
        "missing-incremental-table-tag",
        transform,
        `no table template tag names ${tableLabel(checkpointTable)}, the table of the checkpoint field, for Metabase to put the incremental range filter in`,
      );
    }
  }
}

/**
 * Reports each transform with no target database: a transform whose source is
 * not a query and whose target names no database. Metabase's API refuses such
 * a transform, and cannot run it; an import accepts it.
 */
export function reportMissingTargetDatabases(
  docs: readonly Doc[],
  report: Report,
): void {
  for (const transform of validDocsOf(docs, "Transform")) {
    if (targetDatabaseOf(transform) === null) {
      report(
        "missing-target-database",
        transform,
        "the target names no database, which Metabase requires unless the source is a query",
      );
    }
  }
}
