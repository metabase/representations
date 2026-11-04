import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function fieldUserSettings<R extends Refs>(ref: Ref<R>) {
  return { field_id: z.optional(ref("Field")) };
}

/** The user settings of a field in the portable form. */
export const PortableFieldUserSettings = portableEntity(
  ["Database", "Schema", "Table", "Field", "FieldUserSettings"],
  fieldUserSettings(portableRef),
);
export type PortableFieldUserSettings = z.infer<
  typeof PortableFieldUserSettings
>;

/** The user settings of a field in the instance form. */
export const InstanceFieldUserSettings = instanceEntity(
  ["Database", "Schema", "Table", "Field", "FieldUserSettings"],
  fieldUserSettings(instanceRef),
);
export type InstanceFieldUserSettings = z.infer<
  typeof InstanceFieldUserSettings
>;
