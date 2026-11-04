import { z } from "zod";

import {
  instanceEntity,
  instanceRef,
  portableEntity,
  portableRef,
  type Ref,
  type Refs,
} from "./reference.js";

const HttpDetails = z.strictObject({
  url: z.url(),
  "auth-method": z.enum(["none", "header", "query-param", "request-body"]),
  "auth-info": z.looseObject({}).optional(),
  "fe-form-type": z.enum(["api-key", "bearer", "basic", "none"]).optional(),
  method: z.enum(["get", "post", "put"]).optional(),
});

const EmailDetails = z.looseObject({
  host: z.string().optional(),
  port: z.int().optional(),
  security: z.enum(["none", "ssl", "tls", "starttls"]).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  "from-address": z.string().optional(),
  "from-name": z.string().optional(),
  "reply-to": z.string().optional(),
});

function channel<R extends Refs>(ref: Ref<R>) {
  const common = {
    ...ref("ownId"),
    name: z.string(),
    description: z.string().nullish(),
    active: z.boolean().optional(),
    created_at: z.iso.datetime({ offset: true }).optional(),
  };
  return {
    http: {
      ...common,
      type: z.literal("channel/http"),
      details: HttpDetails.optional(),
    },
    email: {
      ...common,
      type: z.literal("channel/email"),
      details: EmailDetails.optional(),
    },
  };
}

const portableChannel = channel(portableRef);
const instanceChannel = channel(instanceRef);

/** A notification channel in the portable form. */
export const PortableChannel = z.discriminatedUnion("type", [
  portableEntity(["Channel"], portableChannel.http),
  portableEntity(["Channel"], portableChannel.email),
]);
export type PortableChannel = z.infer<typeof PortableChannel>;

/** A notification channel in the instance form. */
export const InstanceChannel = z.discriminatedUnion("type", [
  instanceEntity(["Channel"], instanceChannel.http),
  instanceEntity(["Channel"], instanceChannel.email),
]);
export type InstanceChannel = z.infer<typeof InstanceChannel>;
