import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

function glossary<R extends Refs>(ref: Ref<R>) {
  return { ...ref("ownId"), term: z.string() };
}

/** A glossary term in the portable form. */
export const PortableGlossary = portableEntity(
  ["Glossary"],
  glossary(portableRef),
);
export type PortableGlossary = z.infer<typeof PortableGlossary>;

/** A glossary term in the instance form. */
export const InstanceGlossary = instanceEntity(
  ["Glossary"],
  glossary(instanceRef),
);
export type InstanceGlossary = z.infer<typeof InstanceGlossary>;
