import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function database<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    description: z.string().nullish(),
    engine: z.string().optional(),
  };
}

/** A database in the portable form. */
export const PortableDatabase = portableEntity(
  ["Database"],
  database(portableRef),
);
export type PortableDatabase = z.infer<typeof PortableDatabase>;

/** A database in the instance form. */
export const InstanceDatabase = instanceEntity(
  ["Database"],
  database(instanceRef),
);
export type InstanceDatabase = z.infer<typeof InstanceDatabase>;
