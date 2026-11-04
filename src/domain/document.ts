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

const PLAIN_NODE_TYPES = [
  "doc",
  "paragraph",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "hardBreak",
] as const;

const Mark = z.looseObject({
  type: z.string(),
  attrs: z.looseObject({ href: z.string().optional() }).optional(),
});

function node<R extends Refs>(ref: Ref<R>): z.ZodType {
  const self: z.ZodType = z.lazy(() => {
    const common = {
      content: z.array(self).optional(),
      marks: z.array(Mark).optional(),
    };
    return z.discriminatedUnion("type", [
      z.looseObject({
        ...common,
        type: z.enum(PLAIN_NODE_TYPES),
        attrs: z.looseObject({}).optional(),
      }),
      z.looseObject({ ...common, type: z.literal("text"), text: z.string() }),
      z.looseObject({
        ...common,
        type: z.literal("heading"),
        attrs: z.looseObject({ level: z.int().min(1).max(6) }),
      }),
      z.looseObject({
        ...common,
        type: z.literal("image"),
        attrs: z.looseObject({
          src: z.string(),
          alt: z.string().nullish(),
          title: z.string().nullish(),
        }),
      }),
      z.looseObject({
        ...common,
        type: z.literal("cardEmbed"),
        attrs: z.looseObject({
          id: ref("CardPath"),
          name: z.string().nullish(),
        }),
      }),
      z.looseObject({
        ...common,
        type: z.literal("smartLink"),
        attrs: z.looseObject({
          entityId: ref("EntityPath"),
          model: z.string(),
        }),
      }),
    ]);
  });
  return self;
}

function document<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    creator_id: ref("User"),
    document: node(ref),
    content_type: z.literal("application/json+vnd.prose-mirror").optional(),
    collection_id: z.nullish(ref("Collection")),
    collection_position: z.int().nullish(),
    archived: z.boolean().optional(),
    archived_directly: z.boolean().optional(),
    public_uuid: z.guid().nullish(),
    made_public_by_id: z.nullish(ref("User")),
    view_count: z.int().optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A document in the portable form. */
export const PortableDocument = portableEntity(
  ["Document"],
  document(portableRef),
);
export type PortableDocument = z.infer<typeof PortableDocument>;

/** A document in the instance form. */
export const InstanceDocument = instanceEntity(
  ["Document"],
  document(instanceRef),
);
export type InstanceDocument = z.infer<typeof InstanceDocument>;
