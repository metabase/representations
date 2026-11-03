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

const userRef = ref("users");

const walkResultMetadata = items(
  fields({
    id: ref("fields"),
    table_id: ref("tables"),
    fk_target_field_id: ref("fields"),
    field_ref: walkMbql,
  }),
);

const walkDashboard = byObject((dashboard) =>
  entity("dashboards", {
    collection_id: ref("collections"),
    creator_id: userRef,
    made_public_by_id: userRef,
    parameters: items(walkParameter),
    tabs: items(entity("dashboardTabs", {})),
    dashcards: items(
      entity("dashboardCards", {
        card_id: ref("cards"),
        action_id: ref("actions"),
        dashboard_tab_id: dashboardTabRef(dashboard.entity_id),
        parameter_mappings: items(walkParameterMapping),
        series: items(fields({ card_id: ref("cards") })),
        visualization_settings: walkVisualizationSettings,
      }),
    ),
  }),
);

const walkIncrementalStrategy = fields({
  "checkpoint-filter-field-id": ref("fields"),
});

const walkTransformSource = fields({
  query: walkQuery,
  "source-tables": items(
    fields({ database_id: ref("databases"), table_id: ref("tables") }),
  ),
  "source-database": ref("databases"),
  "source-incremental-strategy": walkIncrementalStrategy,
});

const walkTransformTags = items(fields({ tag_id: ref("transformTags") }));

export const KIND_WALKS: Readonly<Record<Kind, Walk>> = {
  action: entity("actions", {
    collection_id: ref("collections"),
    model_id: ref("cards"),
    creator_id: userRef,
    made_public_by_id: userRef,
    implicit: items(fields({ table_id: ref("tables") })),
    query: items(
      fields({ database_id: ref("databases"), dataset_query: walkQuery }),
    ),
    parameters: items(walkParameter),
    parameter_mappings: items(walkParameterMapping),
    visualization_settings: walkVisualizationSettings,
  }),
  card: entity("cards", {
    database_id: ref("databases"),
    collection_id: ref("collections"),
    dashboard_id: ref("dashboards"),
    document_id: ref("documents"),
    creator_id: userRef,
    made_public_by_id: userRef,
    dataset_query: walkQuery,
    parameters: items(walkParameter),
    parameter_mappings: items(walkParameterMapping),
    visualization_settings: walkVisualizationSettings,
    result_metadata: walkResultMetadata,
  }),
  collection: entity("collections", {
    parent_id: ref("collections"),
    personal_owner_id: userRef,
  }),
  dashboard: walkDashboard,
  document: entity("documents", {
    collection_id: ref("collections"),
    creator_id: userRef,
    made_public_by_id: userRef,
    document: walkProseMirror,
  }),
  measure: entity("measures", {
    creator_id: userRef,
    table_id: ref("tables"),
    definition: walkQuery,
  }),
  pythonLibrary: entity("pythonLibraries", {}),
  query: walkQuery,
  segment: entity("segments", {
    creator_id: userRef,
    table_id: ref("tables"),
    definition: walkQuery,
  }),
  snippet: entity("snippets", {
    collection_id: ref("collections"),
    creator_id: userRef,
    template_tags: values(walkTemplateTag),
  }),
  transform: entity("transforms", {
    source_database_id: ref("databases"),
    source: walkTransformSource,
    target: fields({ database: ref("databases") }),
    collection_id: ref("collections"),
    creator_id: userRef,
    owner_user_id: userRef,
    tags: walkTransformTags,
  }),
  transformJob: entity("transformJobs", { job_tags: walkTransformTags }),
  transformTag: entity("transformTags", {}),
  transformTest: entity("transformTests", {
    transform_id: ref("transforms"),
    creator_id: userRef,
  }),
};
