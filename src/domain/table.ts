import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function table<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    display_name: z.string().nullish(),
    description: z.string().nullish(),
    db_id: ref("Database"),
    schema: z.string().nullish(),
    active: z.boolean().optional(),
  };
}

/** A table in the portable form. */
export const PortableTable = portableEntity(
  ["Database", "Schema", "Table"],
  table(portableRef),
);
export type PortableTable = z.infer<typeof PortableTable>;

/** A table in the instance form. */
export const InstanceTable = instanceEntity(
  ["Database", "Schema", "Table"],
  table(instanceRef),
);
export type InstanceTable = z.infer<typeof InstanceTable>;
