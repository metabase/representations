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

function collection<R extends Refs>(ref: Ref<R>) {
  return {
    ...ref("ownId"),
    name: z.string(),
    entity_id: EntityId,
    description: z.string().nullish(),
    slug: z.string().optional(),
    archived: z.boolean().optional(),
    archived_directly: z.boolean().nullish(),
    type: z
      .enum([
        "instance-analytics",
        "library",
        "library-data",
        "library-metrics",
        "library-dashboards",
        "trash",
        "tenant-specific-root-collection",
      ])
      .nullish(),
    namespace: z
      .enum([
        "transforms",
        "snippets",
        "data-actions",
        "data-apps",
        "shared-tenant-collection",
        "tenant-specific",
      ])
      .nullish(),
    authority_level: z.enum(["official"]).nullish(),
    archive_operation_id: z.string().nullish(),
    is_remote_synced: z.boolean().optional(),
    is_sample: z.boolean().optional(),
    parent_id: z.nullish(ref("Collection")),
    personal_owner_id: z.nullish(ref("User")),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
}

/** A collection in the portable form. */
export const PortableCollection = portableEntity(
  ["Collection"],
  collection(portableRef),
);
export type PortableCollection = z.infer<typeof PortableCollection>;

/** A collection in the instance form. */
export const InstanceCollection = instanceEntity(
  ["Collection"],
  collection(instanceRef),
);
export type InstanceCollection = z.infer<typeof InstanceCollection>;
