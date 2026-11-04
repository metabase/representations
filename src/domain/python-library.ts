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

function pythonLibrary<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    entity_id: EntityId,
    path: z.string(),
    source: z.string(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A Python library in the portable form. */
export const PortablePythonLibrary = portableEntity(
  ["PythonLibrary"],
  pythonLibrary(portableRef),
);
export type PortablePythonLibrary = z.infer<typeof PortablePythonLibrary>;

/** A Python library in the instance form. */
export const InstancePythonLibrary = instanceEntity(
  ["PythonLibrary"],
  pythonLibrary(instanceRef),
);
export type InstancePythonLibrary = z.infer<typeof InstancePythonLibrary>;
