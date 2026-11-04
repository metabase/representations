import { z } from "zod";

const SerdesPath = z.looseObject({
  "serdes/meta": z.array(z.looseObject({ model: z.string() })).min(1),
});

/** The model a parsed portable entity's `serdes/meta` ends with, such as `Card`, or null. */
export function getPortableModel(value: unknown): string | null {
  const result = SerdesPath.safeParse(value);
  return result.success
    ? (result.data["serdes/meta"].at(-1)?.model ?? null)
    : null;
}
