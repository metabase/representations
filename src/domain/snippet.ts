import { z } from "zod";

import { templateTag } from "./query.js";
import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function snippet<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    creator_id: ref("User"),
    content: z.string(),
    archived: z.boolean().optional(),
    collection_id: z.nullish(ref("Collection")),
    template_tags: z.record(z.string(), templateTag(ref)).optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A native query snippet in the portable form. */
export const PortableNativeQuerySnippet = portableEntity(
  ["NativeQuerySnippet"],
  snippet(portableRef),
);
export type PortableNativeQuerySnippet = z.infer<
  typeof PortableNativeQuerySnippet
>;

/** A native query snippet in the instance form. */
export const InstanceNativeQuerySnippet = instanceEntity(
  ["NativeQuerySnippet"],
  snippet(instanceRef),
);
export type InstanceNativeQuerySnippet = z.infer<
  typeof InstanceNativeQuerySnippet
>;
