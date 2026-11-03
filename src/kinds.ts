import { isJsonArray, isJsonObject } from "./json.js";
import type { SchemaName } from "./schemas/index.js";

/** The kinds of entity the package validates and converts, spelled as their `serdes/meta` model. */
export const KINDS = [
  "Action",
  "Card",
  "Collection",
  "Dashboard",
  "Document",
  "Measure",
  "NativeQuerySnippet",
  "PythonLibrary",
  "Query",
  "Segment",
  "Transform",
  "TransformJob",
  "TransformTag",
  "TransformTest",
] as const;

/** A kind of entity, such as `Card` or `Dashboard`. */
export type Kind = (typeof KINDS)[number];

/** The schema of each kind. */
export const KIND_SCHEMAS: Readonly<Record<Kind, SchemaName>> = {
  Action: "action.json",
  Card: "card.json",
  Collection: "collection.json",
  Dashboard: "dashboard.json",
  Document: "document.json",
  Measure: "measure.json",
  NativeQuerySnippet: "snippet.json",
  PythonLibrary: "python_library.json",
  Query: "common/query.json",
  Segment: "segment.json",
  Transform: "transform.json",
  TransformJob: "transform_job.json",
  TransformTag: "transform_tag.json",
  TransformTest: "transform_test.json",
};

/** The kind of a parsed portable entity, the model its `serdes/meta` ends with, or null. */
export function getPortableKind(value: unknown): Kind | null {
  const meta = isJsonObject(value) ? value["serdes/meta"] : undefined;
  const last = isJsonArray(meta) ? meta[meta.length - 1] : undefined;
  const model = isJsonObject(last) ? last.model : undefined;
  return KINDS.find((kind) => kind !== "Query" && kind === model) ?? null;
}
