import { z } from "zod";

export const EntityId = z.string().regex(/^[A-Za-z0-9_-]{21}$/);

export const NonBlankString = z.string().regex(/\S/);

const InstanceId = z.int().positive();

const SchemaName = z.string().nullable();

const portableRefs = {
  ownId: {},
  Database: z.string(),
  Table: z.tuple([z.string(), SchemaName, z.string()]),
  Field: z.tuple([z.string(), SchemaName, z.string(), z.string()], z.string()),
  User: z.email(),
  Action: EntityId,
  Card: EntityId,
  Collection: EntityId,
  Dashboard: EntityId,
  DashboardTab: z.tuple([EntityId, EntityId]),
  Document: EntityId,
  Measure: EntityId,
  NativeQuerySnippet: EntityId,
  Segment: EntityId,
  Transform: EntityId,
  TransformTag: EntityId,
  CardPath: z.tuple([z.object({ model: z.literal("Card"), id: EntityId })]),
  EntityPath: z.array(z.object({ model: z.string(), id: z.string() })).min(1),
};

const instanceRefs = {
  ownId: { id: InstanceId.optional() },
  Database: InstanceId,
  Table: InstanceId,
  Field: InstanceId,
  User: InstanceId,
  Action: InstanceId,
  Card: InstanceId,
  Collection: InstanceId,
  Dashboard: InstanceId,
  DashboardTab: InstanceId,
  Document: InstanceId,
  Measure: InstanceId,
  NativeQuerySnippet: InstanceId,
  Segment: InstanceId,
  Transform: InstanceId,
  TransformTag: InstanceId,
  CardPath: InstanceId,
  EntityPath: InstanceId,
};

export type Refs = typeof portableRefs | typeof instanceRefs;

export type Ref<R extends Refs> = <K extends keyof Refs>(model: K) => R[K];

export const portableRef: Ref<typeof portableRefs> = (model) =>
  portableRefs[model];

export const instanceRef: Ref<typeof instanceRefs> = (model) =>
  instanceRefs[model];

type SerdesModels = [string, ...string[]];

export function serdesMeta(models: SerdesModels) {
  return z.array(
    z.looseObject({
      model: z.enum(models),
      id: z.string().optional(),
      label: z.string().optional(),
    }),
  );
}

export function portableEntity<Shape extends z.ZodRawShape>(
  models: SerdesModels,
  shape: Shape,
) {
  return z.looseObject({ ...shape, "serdes/meta": serdesMeta(models) });
}

export function instanceEntity<Shape extends z.ZodRawShape>(
  models: SerdesModels,
  shape: Shape,
) {
  return z.looseObject({
    ...shape,
    "serdes/meta": serdesMeta(models).optional(),
  });
}
