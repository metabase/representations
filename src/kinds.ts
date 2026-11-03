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

export type Kind = (typeof KINDS)[number];

export const KIND_SCHEMAS: Readonly<Record<Kind, string>> = {
  action: "action.json",
  card: "card.json",
  collection: "collection.json",
  dashboard: "dashboard.json",
  document: "document.json",
  measure: "measure.json",
  pythonLibrary: "python_library.json",
  query: "common/query.json",
  segment: "segment.json",
  snippet: "snippet.json",
  transform: "transform.json",
  transformJob: "transform_job.json",
  transformTag: "transform_tag.json",
  transformTest: "transform_test.json",
};

export const KIND_MODELS: Readonly<Record<Kind, string | null>> = {
  action: "Action",
  card: "Card",
  collection: "Collection",
  dashboard: "Dashboard",
  document: "Document",
  measure: "Measure",
  pythonLibrary: "PythonLibrary",
  query: null,
  segment: "Segment",
  snippet: "NativeQuerySnippet",
  transform: "Transform",
  transformJob: "TransformJob",
  transformTag: "TransformTag",
  transformTest: "TransformTest",
};
