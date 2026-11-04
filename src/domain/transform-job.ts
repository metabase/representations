import { z } from "zod";

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

function transformJob<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    entity_id: EntityId,
    name: z.string(),
    description: z.string().nullish(),
    schedule: z.string(),
    built_in_type: z.enum(["hourly", "daily", "weekly", "monthly"]).nullish(),
    ui_display_type: z.enum(["cron/builder"]).nullish(),
    job_tags: z
      .array(
        z.looseObject({
          tag_id: z.optional(ref("TransformTag")),
          position: z.int().optional(),
          entity_id: EntityId.optional(),
          "serdes/meta": serdesMeta(["TransformJobTransformTag"]).optional(),
        }),
      )
      .optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A transform job in the portable form. */
export const PortableTransformJob = portableEntity(
  ["TransformJob"],
  transformJob(portableRef),
);
export type PortableTransformJob = z.infer<typeof PortableTransformJob>;

/** A transform job in the instance form. */
export const InstanceTransformJob = instanceEntity(
  ["TransformJob"],
  transformJob(instanceRef),
);
export type InstanceTransformJob = z.infer<typeof InstanceTransformJob>;
