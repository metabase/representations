import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function fieldValues<R extends Refs>(ref: Ref<R>) {
  return {
    field_id: z.optional(ref("Field")),
    values: z.array(z.unknown()),
    human_readable_values: z.array(z.unknown()).optional(),
    has_more_values: z.boolean().optional(),
    type: z.enum(["full", "sandbox"]).optional(),
    hash_key: z.string().nullish(),
    created_at: z.iso.datetime({ offset: true }).optional(),
    last_used_at: z.iso.datetime({ offset: true }).nullish(),
  };
}

/** The values of a field in the portable form. */
export const PortableFieldValues = portableEntity(
  ["Database", "Schema", "Table", "Field", "FieldValues"],
  fieldValues(portableRef),
);
export type PortableFieldValues = z.infer<typeof PortableFieldValues>;

/** The values of a field in the instance form. */
export const InstanceFieldValues = instanceEntity(
  ["Database", "Schema", "Table", "Field", "FieldValues"],
  fieldValues(instanceRef),
);
export type InstanceFieldValues = z.infer<typeof InstanceFieldValues>;
