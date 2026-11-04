import { z } from "zod";

import {
  EntityId,
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
  serdesMeta,
} from "./reference.js";

function metabot<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    entity_id: EntityId,
    name: z.string(),
    description: z.string().nullish(),
    collection_id: z.nullish(ref("Collection")),
    use_verified_content: z.boolean().optional(),
    prompts: z
      .array(
        z.looseObject({
          ...ref("ownId"),
          entity_id: EntityId,
          prompt: z.string(),
          model: z.enum(["model", "question", "metric"]),
          card_id: ref("Card"),
          created_at: z.iso.datetime({ offset: true }).optional(),
          updated_at: z.iso.datetime({ offset: true }).optional(),
          "serdes/meta": serdesMeta(["Metabot", "MetabotPrompt"]).optional(),
        }),
      )
      .optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
    updated_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A Metabot in the portable form. */
export const PortableMetabot = portableEntity(
  ["Metabot"],
  metabot(portableRef),
);
export type PortableMetabot = z.infer<typeof PortableMetabot>;

/** A Metabot in the instance form. */
export const InstanceMetabot = instanceEntity(
  ["Metabot"],
  metabot(instanceRef),
);
export type InstanceMetabot = z.infer<typeof InstanceMetabot>;
