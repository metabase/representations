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

const Table = z.strictObject({
  schema: NonBlankString.nullish(),
  name: NonBlankString,
});

const Columns = z
  .array(z.strictObject({ name: NonBlankString, cast_type: NonBlankString }))
  .min(1);

const Rows = z.array(
  z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
);

const Input = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("rows"),
    table: Table,
    columns: Columns,
    rows: Rows,
  }),
  z.strictObject({
    format: z.literal("sql"),
    table: Table,
    sql: NonBlankString,
  }),
]);

const Expectation = z.union([
  z.strictObject({
    type: z.literal("equals"),
    name: NonBlankString,
    format: z.literal("rows"),
    columns: Columns,
    rows: Rows,
  }),
  z.strictObject({
    type: z.literal("equals"),
    name: NonBlankString,
    format: z.literal("sql"),
    sql: NonBlankString,
  }),
  z.strictObject({
    type: z.literal("empty"),
    name: NonBlankString,
    sql: NonBlankString,
  }),
]);

function transformTest<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: NonBlankString,
    entity_id: EntityId,
    description: z.string().nullish(),
    transform_id: ref("Transform"),
    creator_id: ref("User"),
    inputs: z.array(Input),
    expectations: z.array(Expectation),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A transform test in the portable form. */
export const PortableTransformTest = portableEntity(
  ["TransformTest"],
  transformTest(portableRef),
);
export type PortableTransformTest = z.infer<typeof PortableTransformTest>;

/** A transform test in the instance form. */
export const InstanceTransformTest = instanceEntity(
  ["TransformTest"],
  transformTest(instanceRef),
);
export type InstanceTransformTest = z.infer<typeof InstanceTransformTest>;
