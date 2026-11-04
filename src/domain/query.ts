import { z } from "zod";

import { instanceRef, portableRef, type Ref, type Refs } from "./reference.js";

const TRUNCATION_UNITS = [
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;

const EXTRACTION_UNITS = [
  "second-of-minute",
  "minute-of-hour",
  "hour-of-day",
  "day-of-week",
  "day-of-week-iso",
  "day-of-month",
  "day-of-year",
  "week-of-year",
  "week-of-year-iso",
  "week-of-year-us",
  "week-of-year-instance",
  "month-of-year",
  "quarter-of-year",
  "year-of-era",
] as const;

const OPERATORS = [
  "+",
  "-",
  "*",
  "/",
  "and",
  "or",
  "not",
  "=",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "in",
  "not-in",
  "between",
  "inside",
  "is-null",
  "not-null",
  "is-empty",
  "not-empty",
  "contains",
  "does-not-contain",
  "starts-with",
  "ends-with",
  "time-interval",
  "relative-time-interval",
  "now",
  "today",
  "interval",
  "abs",
  "ceil",
  "floor",
  "round",
  "sqrt",
  "exp",
  "log",
  "power",
  "length",
  "trim",
  "ltrim",
  "rtrim",
  "upper",
  "lower",
  "host",
  "domain",
  "subdomain",
  "path",
  "get-year",
  "get-quarter",
  "get-month",
  "get-day",
  "get-hour",
  "get-minute",
  "get-second",
  "get-day-of-week",
  "get-week",
  "text",
  "integer",
  "float",
  "day-name",
  "month-name",
  "quarter-name",
  "date",
  "datetime",
  "replace",
  "split-part",
  "substring",
  "collate",
  "regex-match-first",
  "concat",
  "coalesce",
  "datetime-add",
  "datetime-subtract",
  "datetime-diff",
  "convert-timezone",
  "temporal-extract",
  "count",
  "cum-count",
  "sum",
  "avg",
  "min",
  "max",
  "distinct",
  "stddev",
  "var",
  "median",
  "cum-sum",
  "percentile",
  "count-where",
  "share",
  "sum-where",
  "distinct-where",
  "offset",
  "asc",
  "desc",
] as const;

const Options = z.looseObject({
  "base-type": z.string().optional(),
  "effective-type": z.string().optional(),
  "lib/uuid": z.guid().optional(),
  "lib/expression-name": z.string().optional(),
});

const TemporalUnit = z.enum([
  "default",
  ...TRUNCATION_UNITS,
  ...EXTRACTION_UNITS,
]);

const Binning = z.discriminatedUnion("strategy", [
  z.looseObject({ strategy: z.literal("default") }),
  z.looseObject({
    strategy: z.literal("num-bins"),
    "num-bins": z.int().min(1),
  }),
  z.looseObject({
    strategy: z.literal("bin-width"),
    "bin-width": z.number().positive(),
  }),
]);

function fieldOptions<R extends Refs>(ref: Ref<R>) {
  return Options.extend({
    "temporal-unit": TemporalUnit.optional(),
    "join-alias": z.string().optional(),
    binning: Binning.optional(),
    "source-field": z.optional(ref("Field")),
    "source-field-name": z.string().optional(),
    "source-field-join-alias": z.string().optional(),
  });
}

export function fieldRef<R extends Refs>(ref: Ref<R>) {
  return z.tuple([
    z.literal("field"),
    fieldOptions(ref),
    z.union([ref("Field"), z.string()]),
  ]);
}

export function legacyFieldRef<R extends Refs>(ref: Ref<R>) {
  return z.tuple([
    z.literal("field"),
    z.union([ref("Field"), z.string()]),
    fieldOptions(ref).nullable(),
  ]);
}

export function expression<R extends Refs>(ref: Ref<R>): z.ZodType {
  const self: z.ZodType = z.lazy(() =>
    z.union([
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
      fieldRef(ref),
      z.tuple([z.literal("expression"), Options, z.string()]),
      z.tuple([z.literal("aggregation"), Options, z.guid()]),
      z.tuple([z.literal("metric"), Options, ref("Card")]),
      z.tuple([z.literal("measure"), Options, ref("Measure")]),
      z.tuple([z.literal("segment"), Options, ref("Segment")]),
      z.tuple([
        z.literal("value"),
        Options,
        z.union([z.string(), z.number(), z.boolean()]),
      ]),
      z.tuple(
        [z.enum(["case", "if"]), Options, z.array(z.tuple([self, self]))],
        self,
      ),
      z.tuple([z.enum(OPERATORS), Options], self),
    ]),
  );
  return self;
}

export function templateTag<R extends Refs>(ref: Ref<R>) {
  const common = {
    name: z.string(),
    id: z.string().regex(/\S/),
    "display-name": z.string().optional(),
    default: z.unknown().optional(),
    required: z.boolean().optional(),
  };
  return z.discriminatedUnion("type", [
    z.looseObject({
      ...common,
      type: z.enum(["text", "number", "date", "boolean"]),
    }),
    z.looseObject({
      ...common,
      type: z.literal("dimension"),
      dimension: expression(ref),
      "widget-type": z.string(),
      options: z.looseObject({}).optional(),
      alias: z.string().optional(),
    }),
    z.looseObject({
      ...common,
      type: z.literal("temporal-unit"),
      dimension: expression(ref),
      alias: z.string().optional(),
    }),
    z.looseObject({
      ...common,
      type: z.literal("card"),
      "card-id": ref("Card"),
    }),
    z.looseObject({
      ...common,
      type: z.literal("snippet"),
      "snippet-name": z.string(),
      "snippet-id": z.optional(ref("NativeQuerySnippet")),
    }),
    z.looseObject({
      ...common,
      type: z.literal("table"),
      "table-id": ref("Table"),
      "emit-alias": z.boolean().optional(),
    }),
  ]);
}

function stage<R extends Refs>(ref: Ref<R>): z.ZodType {
  const self: z.ZodType = z.lazy(() =>
    z.discriminatedUnion("lib/type", [
      z.looseObject({
        "lib/type": z.literal("mbql.stage/mbql"),
        "source-table": z.optional(ref("Table")),
        "source-card": z.optional(ref("Card")),
        joins: z
          .array(
            z.looseObject({
              stages: z.array(self).min(1),
              conditions: z.array(expression(ref)).min(1),
              alias: z.string(),
              strategy: z
                .enum(["left-join", "right-join", "inner-join", "full-join"])
                .optional(),
              fields: z
                .union([z.enum(["all", "none"]), z.array(expression(ref))])
                .optional(),
            }),
          )
          .optional(),
        expressions: z.array(expression(ref)).optional(),
        fields: z.array(expression(ref)).optional(),
        filters: z.array(expression(ref)).optional(),
        aggregation: z.array(expression(ref)).optional(),
        breakout: z.array(expression(ref)).optional(),
        "order-by": z.array(expression(ref)).optional(),
        limit: z.int().nullish(),
      }),
      z.looseObject({
        "lib/type": z.literal("mbql.stage/native"),
        native: z.string(),
        "template-tags": z
          .union([
            z.array(templateTag(ref)),
            z.record(z.string(), templateTag(ref)),
          ])
          .optional(),
      }),
    ]),
  );
  return self;
}

export function query<R extends Refs>(ref: Ref<R>) {
  return z.looseObject({
    "lib/type": z.literal("mbql/query"),
    database: ref("Database"),
    stages: z.array(stage(ref)).min(1),
  });
}

/** A query in the portable form, with names, paths and entity ids. */
export const PortableQuery = query(portableRef);
export type PortableQuery = z.infer<typeof PortableQuery>;

/** A query in the instance form, with numeric ids. */
export const InstanceQuery = query(instanceRef);
export type InstanceQuery = z.infer<typeof InstanceQuery>;
