import { z } from "zod";

import { parameter } from "./parameter.js";
import { query } from "./query.js";
import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

const DISPLAYS = [
  "table",
  "bar",
  "line",
  "area",
  "row",
  "pie",
  "scalar",
  "smartscalar",
  "number",
  "combo",
  "pivot",
  "funnel",
  "map",
  "scatter",
  "waterfall",
  "progress",
  "gauge",
  "object",
  "list",
  "heading",
  "text",
  "link",
  "iframe",
  "action",
  "sankey",
  "boxplot",
] as const;

function card<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    display: z.enum(DISPLAYS),
    creator_id: ref("User"),
    database_id: z.nullish(ref("Database")),
    dataset_query: query(ref),
    visualization_settings: z.looseObject({}),
    description: z.string().nullish(),
    archived: z.boolean().optional(),
    archived_directly: z.boolean().optional(),
    type: z.enum(["question", "model", "metric"]).optional(),
    collection_id: z.nullish(ref("Collection")),
    collection_position: z.int().nullish(),
    collection_preview: z.boolean().optional(),
    dashboard_id: z.nullish(ref("Dashboard")),
    document_id: z.nullish(ref("Document")),
    parameters: z.array(parameter(ref)).optional(),
    parameter_mappings: z.array(z.unknown()).optional(),
    result_metadata: z.array(z.unknown()).nullish(),
    enable_embedding: z.boolean().optional(),
    embedding_params: z.looseObject({}).nullish(),
    embedding_type: z.enum(["static-legacy", "guest-embed"]).nullish(),
    public_uuid: z.guid().nullish(),
    made_public_by_id: z.nullish(ref("User")),
    metabase_version: z.string().nullish(),
    card_schema: z.int().nullish(),
    query_type: z.enum(["query", "native"]).nullish(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A card (question, model, or metric) in the portable form. */
export const PortableCard = portableEntity(["Card"], card(portableRef));
export type PortableCard = z.infer<typeof PortableCard>;

/** A card (question, model, or metric) in the instance form. */
export const InstanceCard = instanceEntity(["Card"], card(instanceRef));
export type InstanceCard = z.infer<typeof InstanceCard>;
