import { z } from "zod";

import { legacyFieldRef } from "./query.js";
import type { Ref, Refs } from "./reference.js";

export function parameter<R extends Refs>(ref: Ref<R>) {
  return z.looseObject({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string(),
    type: z.string(),
    default: z.unknown().optional(),
    required: z.boolean().optional(),
    sectionId: z
      .enum([
        "string",
        "number",
        "date",
        "boolean",
        "temporal-unit",
        "id",
        "location",
      ])
      .optional(),
    temporal_units: z
      .array(
        z.enum(["minute", "hour", "day", "week", "month", "quarter", "year"]),
      )
      .optional(),
    values_query_type: z.enum(["list", "search", "none"]).optional(),
    values_source_type: z.enum(["card", "static-list"]).nullish(),
    values_source_config: z
      .looseObject({
        values: z.array(z.unknown()).optional(),
        card_id: z.optional(ref("Card")),
        value_field: z.unknown().optional(),
        label_field: z.unknown().optional(),
      })
      .optional(),
  });
}

const TemplateTagRef = z.tuple([z.literal("template-tag"), z.string()]);

export function parameterTarget<R extends Refs>(ref: Ref<R>) {
  const legacyExpressionRef = z.union([
    z.tuple([z.literal("expression"), z.string()]),
    z.tuple([
      z.literal("expression"),
      z.string(),
      z.looseObject({}).nullable(),
    ]),
  ]);
  const stageOptions = z
    .looseObject({ "stage-number": z.int().optional() })
    .nullable();
  return z.union([
    z.tuple([
      z.literal("dimension"),
      z.union([legacyFieldRef(ref), legacyExpressionRef, TemplateTagRef]),
    ]),
    z.tuple([
      z.literal("dimension"),
      z.union([legacyFieldRef(ref), legacyExpressionRef, TemplateTagRef]),
      stageOptions,
    ]),
    z.tuple([z.literal("variable"), TemplateTagRef]),
    z.tuple([z.literal("text-tag"), z.string()]),
  ]);
}

export function parameterMapping<R extends Refs>(ref: Ref<R>) {
  return z.looseObject({
    card_id: z.optional(ref("Card")),
    parameter_id: z.string(),
    target: parameterTarget(ref),
  });
}
