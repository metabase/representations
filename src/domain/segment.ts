import { z } from "zod";

import { expression } from "./query.js";
import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function segment<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    creator_id: ref("User"),
    table_id: z.optional(ref("Table")),
    definition: z.looseObject({
      "lib/type": z.literal("mbql/query"),
      database: ref("Database"),
      stages: z.tuple([
        z.strictObject({
          "lib/type": z.literal("mbql.stage/mbql"),
          "source-table": ref("Table"),
          filters: z.array(expression(ref)),
        }),
      ]),
    }),
    archived: z.boolean().optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A segment in the portable form. */
export const PortableSegment = portableEntity(
  ["Segment"],
  segment(portableRef),
);
export type PortableSegment = z.infer<typeof PortableSegment>;

/** A segment in the instance form. */
export const InstanceSegment = instanceEntity(
  ["Segment"],
  segment(instanceRef),
);
export type InstanceSegment = z.infer<typeof InstanceSegment>;
