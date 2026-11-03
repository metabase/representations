import type { RefModel } from "./refs.js";
import type { SchemaName } from "./schemas/index.js";

/** The kinds of entity the package validates and converts. */
export const KINDS = [
  "action",
  "card",
  "collection",
  "dashboard",
  "document",
  "measure",
  "pythonLibrary",
  "query",
  "segment",
  "snippet",
  "transform",
  "transformJob",
  "transformTag",
  "transformTest",
] as const;

/** A kind of entity, such as `card` or `dashboard`. */
export type Kind = (typeof KINDS)[number];

/** How a kind of entity is stored: its schema, its `serdes/meta` model, and the ref model of its own id. */
export interface KindSpec {
  schema: SchemaName;
  serdesModel: string | null;
  refModel: RefModel | null;
}

/** The {@link KindSpec} of each kind. */
export const KIND_SPECS: Readonly<Record<Kind, KindSpec>> = {
  action: { schema: "action.json", serdesModel: "Action", refModel: "actions" },
  card: { schema: "card.json", serdesModel: "Card", refModel: "cards" },
  collection: {
    schema: "collection.json",
    serdesModel: "Collection",
    refModel: "collections",
  },
  dashboard: {
    schema: "dashboard.json",
    serdesModel: "Dashboard",
    refModel: "dashboards",
  },
  document: {
    schema: "document.json",
    serdesModel: "Document",
    refModel: "documents",
  },
  measure: {
    schema: "measure.json",
    serdesModel: "Measure",
    refModel: "measures",
  },
  pythonLibrary: {
    schema: "python_library.json",
    serdesModel: "PythonLibrary",
    refModel: "pythonLibraries",
  },
  query: { schema: "common/query.json", serdesModel: null, refModel: null },
  segment: {
    schema: "segment.json",
    serdesModel: "Segment",
    refModel: "segments",
  },
  snippet: {
    schema: "snippet.json",
    serdesModel: "NativeQuerySnippet",
    refModel: "snippets",
  },
  transform: {
    schema: "transform.json",
    serdesModel: "Transform",
    refModel: "transforms",
  },
  transformJob: {
    schema: "transform_job.json",
    serdesModel: "TransformJob",
    refModel: "transformJobs",
  },
  transformTag: {
    schema: "transform_tag.json",
    serdesModel: "TransformTag",
    refModel: "transformTags",
  },
  transformTest: {
    schema: "transform_test.json",
    serdesModel: "TransformTest",
    refModel: "transformTests",
  },
};
