import {
  displayName,
  type Doc,
  isQuerySource,
  type QuerySource,
  validDocsOf,
} from "./documents.js";
import type { Report } from "./findings.js";
import {
  type DefaultSchemaOf,
  sameTable,
  tableLabel,
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
    const collection = byEntityId.get(id)?.[0];
    if (collection === undefined) {
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
function nativeOnlyStage(
  source: QuerySource,
): Readonly<Record<string, unknown>> | null {
  const { stages } = source.query;
  return stages.length === 1 && stages[0]["lib/type"] === NATIVE_STAGE
    ? stages[0]
    : null;
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
    const { source, target } = transform.body;
    if (target.type !== "table-incremental" || !isQuerySource(source)) {
      continue;
    }
    const stage = nativeOnlyStage(source);
    if (stage === null) {
      continue;
    }
    const tableTags = templateTagsOf(stage["template-tags"]).filter(
      (tag) => tag.type === "table",
    );
    const checkpointTable = tableOfRef(
      source["source-incremental-strategy"]?.["checkpoint-filter-field-id"],
    );
    if (tableTags.length === 0) {
      report(
        "missing-incremental-table-tag",
        transform,
        "the incremental native query has no table template tag for Metabase to put its range filter in",
      );
    } else if (
      checkpointTable !== null &&
      !tableTags.some((tag) => {
        const table = tableOfRef(tag["table-id"]);
        return (
          table !== null && sameTable(table, checkpointTable, defaultSchemaOf)
        );
      })
    ) {
      report(
        "missing-incremental-table-tag",
        transform,
        `no table template tag names ${tableLabel(checkpointTable)}, the table of the checkpoint field, for Metabase to put the incremental range filter in`,
      );
    }
  }
}
