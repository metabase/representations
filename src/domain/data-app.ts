import { z } from "zod";

import {
  EntityId,
  instanceEntity,
  instanceRef,
  NonBlankString,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function dataApp<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: NonBlankString,
    slug: z
      .string()
      .regex(/^(?!(?:repo-status|sandbox-host)$)[a-z0-9]+(?:-[a-z0-9]+)*$/),
    entity_id: EntityId,
    description: z.string().nullish(),
    version: z.int().min(1).optional(),
    path: z.string().regex(/^\s*(?!(?:.*\/)?\.\.(?:\/|$))\S/),
    collection: ref("Collection"),
    allowed_hosts: z
      .array(
        z
          .string()
          .regex(
            /^\s*[Hh][Tt][Tt][Pp][Ss]?:\/\/(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]+)?\/*\s*$/,
          ),
      )
      .optional(),
  };
}

/** A data app manifest in the portable form. */
export const PortableDataApp = portableEntity(
  ["DataApp"],
  dataApp(portableRef),
);
export type PortableDataApp = z.infer<typeof PortableDataApp>;

/** A data app manifest in the instance form. */
export const InstanceDataApp = instanceEntity(
  ["DataApp"],
  dataApp(instanceRef),
);
export type InstanceDataApp = z.infer<typeof InstanceDataApp>;
