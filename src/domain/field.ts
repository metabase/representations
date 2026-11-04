import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function field<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    display_name: z.string().nullish(),
    description: z.string().nullish(),
    base_type: z.string(),
    effective_type: z.string().nullish(),
    database_type: z.string(),
    semantic_type: z.string().nullish(),
    coercion_strategy: z.string().nullish(),
    table_id: ref("Table"),
    fk_target_field_id: z.nullish(ref("Field")),
    parent_id: z.nullish(ref("Field")),
    active: z.boolean().optional(),
    settings: z.looseObject({}).nullish(),
    dimensions: z.array(z.looseObject({})).optional(),
  };
}

/** A field in the portable form. */
export const PortableField = portableEntity(
  ["Database", "Schema", "Table", "Field"],
  field(portableRef),
);
export type PortableField = z.infer<typeof PortableField>;

/** A field in the instance form. */
export const InstanceField = instanceEntity(
  ["Database", "Schema", "Table", "Field"],
  field(instanceRef),
);
export type InstanceField = z.infer<typeof InstanceField>;
