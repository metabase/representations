import type { Kind } from "../kinds.js";
import {
  byObject,
  entity,
  fields,
  items,
  ref,
  values,
  type Walk,
} from "./core.js";
import { walkProseMirror } from "./document.js";
import { walkMbql, walkQuery, walkTemplateTag } from "./mbql.js";
import { walkParameter, walkParameterMapping } from "./parameters.js";
import { dashboardTabRef } from "./paths.js";
import { walkVisualizationSettings } from "./visualization-settings.js";

const userRef = ref("User");

const walkResultMetadata = items(
  fields({
    id: ref("Field"),
    table_id: ref("Table"),
    fk_target_field_id: ref("Field"),
    field_ref: walkMbql,
  }),
);

const walkDashboard = byObject((dashboard) =>
  entity("Dashboard", {
    collection_id: ref("Collection"),
    creator_id: userRef,
    made_public_by_id: userRef,
    parameters: items(walkParameter),
    tabs: items(entity("DashboardTab", {})),
    dashcards: items(
      entity("DashboardCard", {
        card_id: ref("Card"),
        action_id: ref("Action"),
        dashboard_tab_id: dashboardTabRef(dashboard.entity_id),
        parameter_mappings: items(walkParameterMapping),
        series: items(fields({ card_id: ref("Card") })),
        visualization_settings: walkVisualizationSettings,
      }),
    ),
  }),
);

const walkIncrementalStrategy = fields({
  "checkpoint-filter-field-id": ref("Field"),
});

const walkTransformSource = fields({
  query: walkQuery,
  "source-tables": items(
    fields({ database_id: ref("Database"), table_id: ref("Table") }),
  ),
  "source-database": ref("Database"),
  "source-incremental-strategy": walkIncrementalStrategy,
});

const walkTransformTarget = fields({
  database: ref("Database"),
  "target-incremental-strategy": fields({
    "unique-key": items(fields({ "field-id": ref("Field") })),
  }),
});

const walkTransformTags = items(fields({ tag_id: ref("TransformTag") }));

export const KIND_WALKS: Readonly<Record<Kind, Walk>> = {
  Action: entity("Action", {
    collection_id: ref("Collection"),
    model_id: ref("Card"),
    creator_id: userRef,
    made_public_by_id: userRef,
    implicit: items(fields({ table_id: ref("Table") })),
    query: items(
      fields({ database_id: ref("Database"), dataset_query: walkQuery }),
    ),
    parameters: items(walkParameter),
    parameter_mappings: items(walkParameterMapping),
    visualization_settings: walkVisualizationSettings,
  }),
  Card: entity("Card", {
    database_id: ref("Database"),
    collection_id: ref("Collection"),
    dashboard_id: ref("Dashboard"),
    document_id: ref("Document"),
    creator_id: userRef,
    made_public_by_id: userRef,
    dataset_query: walkQuery,
    parameters: items(walkParameter),
    parameter_mappings: items(walkParameterMapping),
    visualization_settings: walkVisualizationSettings,
    result_metadata: walkResultMetadata,
  }),
  Collection: entity("Collection", {
    parent_id: ref("Collection"),
    personal_owner_id: userRef,
  }),
  Dashboard: walkDashboard,
  Document: entity("Document", {
    collection_id: ref("Collection"),
    creator_id: userRef,
    made_public_by_id: userRef,
    document: walkProseMirror,
  }),
  Measure: entity("Measure", {
    creator_id: userRef,
    table_id: ref("Table"),
    definition: walkQuery,
  }),
  PythonLibrary: entity("PythonLibrary", {}),
  Query: walkQuery,
  Segment: entity("Segment", {
    creator_id: userRef,
    table_id: ref("Table"),
    definition: walkQuery,
  }),
  NativeQuerySnippet: entity("NativeQuerySnippet", {
    collection_id: ref("Collection"),
    creator_id: userRef,
    template_tags: values(walkTemplateTag),
  }),
  Transform: entity("Transform", {
    source_database_id: ref("Database"),
    source: walkTransformSource,
    target: walkTransformTarget,
    collection_id: ref("Collection"),
    creator_id: userRef,
    owner_user_id: userRef,
    tags: walkTransformTags,
  }),
  TransformJob: entity("TransformJob", { job_tags: walkTransformTags }),
  TransformTag: entity("TransformTag", {}),
  TransformTest: entity("TransformTest", {
    transform_id: ref("Transform"),
    creator_id: userRef,
  }),
};
