import { z } from "zod";

import { parameterTarget } from "./parameter.js";
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

function action<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    type: z.enum(["implicit", "query"]),
    collection_id: z.nullish(ref("Collection")),
    model_id: z.nullish(ref("Card")),
    creator_id: z.nullish(ref("User")),
    archived: z.boolean().optional(),
    archived_directly: z.boolean().optional(),
    implicit: z
      .array(
        z.looseObject({
          kind: z.enum([
            "row/create",
            "row/update",
            "row/delete",
            "bulk/create",
            "bulk/update",
            "bulk/delete",
          ]),
          table_id: z.nullish(ref("Table")),
        }),
      )
      .max(1)
      .optional(),
    query: z
      .array(
        z.looseObject({
          database_id: z.optional(ref("Database")),
          dataset_query: query(ref),
        }),
      )
      .max(1)
      .optional(),
    parameters: z
      .array(
        z.looseObject({
          id: z.string().min(1),
          name: z.string().optional(),
          slug: z.string().optional(),
          type: z.string(),
          required: z.boolean().optional(),
          target: parameterTarget(ref).optional(),
        }),
      )
      .optional(),
    parameter_mappings: z.array(z.unknown()).nullish(),
    visualization_settings: z.looseObject({}).nullish(),
    public_uuid: z.guid().nullish(),
    made_public_by_id: z.nullish(ref("User")),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

interface ActionDefinition {
  type: "implicit" | "query";
  model_id?: unknown;
  implicit?: { table_id?: unknown }[];
  query?: unknown[];
}

function checkDefinition(action: ActionDefinition, ctx: z.RefinementCtx) {
  if (action.type === "query" && !action.query?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["query"],
      message: "A query action needs its query",
    });
  }
  if (action.type !== "implicit") {
    return;
  }
  if (!action.implicit?.length) {
    ctx.addIssue({
      code: "custom",
      path: ["implicit"],
      message: "An implicit action needs its definition",
    });
  } else if (
    action.model_id == null &&
    action.implicit.some((item) => item.table_id == null)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["implicit"],
      message: "An implicit action needs a model_id or a table_id",
    });
  }
}

/** An action in the portable form. */
export const PortableAction = portableEntity(
  ["Action"],
  action(portableRef),
).superRefine(checkDefinition);
export type PortableAction = z.infer<typeof PortableAction>;

/** An action in the instance form. */
export const InstanceAction = instanceEntity(
  ["Action"],
  action(instanceRef),
).superRefine(checkDefinition);
export type InstanceAction = z.infer<typeof InstanceAction>;
