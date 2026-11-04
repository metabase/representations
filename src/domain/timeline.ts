import { z } from "zod";

import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function timeline<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    entity_id: EntityId,
    name: z.string(),
    icon: z.string().optional(),
    collection_id: z.nullish(ref("Collection")),
    creator_id: z.optional(ref("User")),
    events: z
      .array(
        z.looseObject({
          name: z.string().optional(),
          timestamp: z.iso.datetime({ offset: true }).optional(),
          icon: z.string().optional(),
          time_matters: z.boolean().optional(),
          timezone: z.string().optional(),
          creator_id: z.optional(ref("User")),
        }),
      )
      .optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A timeline in the portable form. */
export const PortableTimeline = portableEntity(
  ["Timeline"],
  timeline(portableRef),
);
export type PortableTimeline = z.infer<typeof PortableTimeline>;

/** A timeline in the instance form. */
export const InstanceTimeline = instanceEntity(
  ["Timeline"],
  timeline(instanceRef),
);
export type InstanceTimeline = z.infer<typeof InstanceTimeline>;
