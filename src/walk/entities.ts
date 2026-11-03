import { isJsonArray, isJsonObject, type JsonValue } from "../json.js";
import type { Kind } from "../kinds.js";
import { convertRef, entity, fields, items, ref, type Walk } from "./core.js";
import { walkProseMirror } from "./document.js";
import { walkMbql, walkQuery } from "./mbql.js";
import { walkParameter, walkParameterMapping } from "./parameters.js";
import { walkVisualizationSettings } from "./visualization-settings.js";

const user = ref("users");

const walkResultMetadata = items(
  fields({
    id: ref("fields"),
    table_id: ref("tables"),
    fk_target_field_id: ref("fields"),
    field_ref: walkMbql,
  }),
);

function dashboardTabRef(dashboardEntityId: JsonValue | undefined): Walk {
  return (value, visitor) => {
    if (visitor.direction === "toInstance") {
      const tabEntityId = isJsonArray(value) ? value[1] : undefined;
      return tabEntityId === undefined
        ? value
        : convertRef(visitor, "dashboardTabs", tabEntityId);
    }
    const converted = convertRef(visitor, "dashboardTabs", value);
    return converted === value ? value : [dashboardEntityId ?? null, converted];
  };
}

const walkDashboard: Walk = (value, visitor) => {
  const dashboardEntityId = isJsonObject(value) ? value.entity_id : undefined;
  return entity("dashboards", {
    collection_id: ref("collections"),
    creator_id: user,
    made_public_by_id: user,
    parameters: items(walkParameter),
    tabs: items(entity("dashboardTabs", {})),
    dashcards: items(
      entity("dashboardCards", {
        card_id: ref("cards"),
        dashboard_tab_id: dashboardTabRef(dashboardEntityId),
        parameter_mappings: items(walkParameterMapping),
        series: items(fields({ card_id: ref("cards") })),
        visualization_settings: walkVisualizationSettings,
      }),
    ),
  })(value, visitor);
};

const walkTransformSource = fields({
  query: walkQuery,
  "source-tables": items(
    fields({ database_id: ref("databases"), table_id: ref("tables") }),
  ),
  "source-database": ref("databases"),
});

const transformTags = items(fields({ tag_id: ref("transformTags") }));

export const KIND_WALKS: Readonly<Record<Kind, Walk>> = {
  action: entity("actions", {
    collection_id: ref("collections"),
    model_id: ref("cards"),
    creator_id: user,
    made_public_by_id: user,
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
    creator_id: user,
    made_public_by_id: user,
    dataset_query: walkQuery,
    parameters: items(walkParameter),
    parameter_mappings: items(walkParameterMapping),
    visualization_settings: walkVisualizationSettings,
    result_metadata: walkResultMetadata,
  }),
  collection: entity("collections", {
    parent_id: ref("collections"),
    personal_owner_id: user,
  }),
  dashboard: walkDashboard,
  document: entity("documents", {
    collection_id: ref("collections"),
    creator_id: user,
    made_public_by_id: user,
    document: walkProseMirror,
  }),
  measure: entity("measures", {
    creator_id: user,
    table_id: ref("tables"),
    definition: walkQuery,
  }),
  pythonLibrary: entity("pythonLibraries", {}),
  query: walkQuery,
  segment: entity("segments", {
    creator_id: user,
    table_id: ref("tables"),
    definition: walkQuery,
  }),
  snippet: entity("snippets", {
    collection_id: ref("collections"),
    creator_id: user,
  }),
  transform: entity("transforms", {
    source_database_id: ref("databases"),
    source: walkTransformSource,
    target: fields({ database: ref("databases") }),
    collection_id: ref("collections"),
    creator_id: user,
    tags: transformTags,
  }),
  transformJob: entity("transformJobs", { job_tags: transformTags }),
  transformTag: entity("transformTags", {}),
  transformTest: entity("transformTests", {
    transform_id: ref("transforms"),
    creator_id: user,
  }),
};
