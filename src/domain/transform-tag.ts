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

function transformTag<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    entity_id: EntityId,
    name: z.string(),
    built_in_type: z.enum(["hourly", "daily", "weekly", "monthly"]).nullish(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A transform tag in the portable form. */
export const PortableTransformTag = portableEntity(
  ["TransformTag"],
  transformTag(portableRef),
);
export type PortableTransformTag = z.infer<typeof PortableTransformTag>;

/** A transform tag in the instance form. */
export const InstanceTransformTag = instanceEntity(
  ["TransformTag"],
  transformTag(instanceRef),
);
export type InstanceTransformTag = z.infer<typeof InstanceTransformTag>;
