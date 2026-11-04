import { z } from "zod";

import { parameter, parameterMapping } from "./parameter.js";
import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
  serdesMeta,
} from "./reference.js";

function dashboardCard<R extends Refs>(ref: Ref<R>) {
  return z.looseObject({
    ...ref("ownId"),
    entity_id: EntityId,
    row: z.int().min(0),
    col: z.int().min(0).max(23),
    size_x: z.int().min(1).max(24),
    size_y: z.int().min(1),
    card_id: z.nullish(ref("Card")),
    action_id: z.nullish(ref("Action")),
    dashboard_tab_id: z.nullish(ref("DashboardTab")),
    inline_parameters: z.array(z.string()).optional(),
    parameter_mappings: z.array(parameterMapping(ref)).optional(),
    series: z
      .array(z.looseObject({ card_id: ref("Card"), position: z.int().min(0) }))
      .optional(),
    visualization_settings: z.looseObject({}).optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
    "serdes/meta": serdesMeta([
      "Dashboard",
      "DashboardTab",
      "DashboardCard",
    ]).optional(),
  });
}

function dashboard<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    creator_id: ref("User"),
    archived: z.boolean().optional(),
    archived_directly: z.boolean().optional(),
    collection_id: z.nullish(ref("Collection")),
    collection_position: z.int().nullish(),
    position: z.int().nullish(),
    auto_apply_filters: z.boolean().optional(),
    width: z.enum(["fixed", "full"]).optional(),
    enable_embedding: z.boolean().optional(),
    embedding_params: z.looseObject({}).nullish(),
    embedding_type: z.enum(["static-legacy", "guest-embed"]).nullish(),
    public_uuid: z.guid().nullish(),
    made_public_by_id: z.nullish(ref("User")),
    show_in_getting_started: z.boolean().optional(),
    caveats: z.string().nullish(),
    points_of_interest: z.string().nullish(),
    initially_published_at: z.iso.datetime({ offset: true }).nullish(),
    parameters: z.array(parameter(ref)).optional(),
    tabs: z
      .array(
        z.looseObject({
          ...ref("ownId"),
          entity_id: EntityId,
          name: z.string(),
          position: z.int().min(0),
        }),
      )
      .optional(),
    dashcards: z.array(dashboardCard(ref)).optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A dashboard in the portable form. */
export const PortableDashboard = portableEntity(
  ["Dashboard"],
  dashboard(portableRef),
);
export type PortableDashboard = z.infer<typeof PortableDashboard>;

/** A dashboard in the instance form. */
export const InstanceDashboard = instanceEntity(
  ["Dashboard"],
  dashboard(instanceRef),
);
export type InstanceDashboard = z.infer<typeof InstanceDashboard>;
