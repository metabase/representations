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

function measure<R extends Refs>(ref: Ref<R>) {
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
          aggregation: z.array(expression(ref)).length(1),
        }),
      ]),
    }),
    archived: z.boolean().optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A measure in the portable form. */
export const PortableMeasure = portableEntity(
  ["Measure"],
  measure(portableRef),
);
export type PortableMeasure = z.infer<typeof PortableMeasure>;

/** A measure in the instance form. */
export const InstanceMeasure = instanceEntity(
  ["Measure"],
  measure(instanceRef),
);
export type InstanceMeasure = z.infer<typeof InstanceMeasure>;
