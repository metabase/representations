import { z } from "zod";

import { query } from "./query.js";
import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  serdesMeta,
  type Ref,
  type Refs,
} from "./reference.js";

function transform<R extends Refs>(ref: Ref<R>) {
  const incrementalStrategy = z.looseObject({
    "checkpoint-filter-field-id": z.optional(ref("Field")),
  });
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    source_database_id: ref("Database"),
    source: z.discriminatedUnion("type", [
      z.looseObject({
        type: z.literal("query"),
        query: query(ref),
        "source-incremental-strategy": incrementalStrategy.optional(),
      }),
      z.looseObject({
        type: z.literal("python"),
        body: z.string(),
        "source-tables": z.array(
          z.looseObject({
            alias: z.string(),
            database_id: ref("Database"),
            schema: z.string().nullish(),
            table: z.string().optional(),
            table_id: z.optional(ref("Table")),
          }),
        ),
        "source-database": z.optional(ref("Database")),
        "source-incremental-strategy": incrementalStrategy.optional(),
      }),
    ]),
    target: z.looseObject({
      database: z.optional(ref("Database")),
      type: z.enum(["table", "table-incremental"]),
      schema: z.string().nullish(),
      name: z.string(),
      "target-incremental-strategy": z
        .looseObject({
          type: z.enum(["append", "merge"]).optional(),
          "unique-key": z
            .array(
              z.looseObject({
                name: z.string().optional(),
                "field-id": z.nullish(ref("Field")),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
    creator_id: ref("User"),
    owner_user_id: z.nullish(ref("User")),
    collection_id: z.nullish(ref("Collection")),
    tags: z
      .array(
        z.looseObject({
          entity_id: EntityId.optional(),
          tag_id: z.optional(ref("TransformTag")),
          position: z.int().optional(),
          "serdes/meta": serdesMeta(["TransformTransformTag"]).optional(),
        }),
      )
      .optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A transform in the portable form. */
export const PortableTransform = portableEntity(
  ["Transform"],
  transform(portableRef),
);
export type PortableTransform = z.infer<typeof PortableTransform>;

/** A transform in the instance form. */
export const InstanceTransform = instanceEntity(
  ["Transform"],
  transform(instanceRef),
);
export type InstanceTransform = z.infer<typeof InstanceTransform>;
