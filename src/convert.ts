import { isJsonObject, type JsonValue } from "./json.js";
import type { Kind } from "./kinds.js";
import {
  isPortableRef,
  portableKey,
  toInstanceRefs,
  toPortableRefs,
  type InstanceRefs,
  type InstanceToPortable,
  type PortableRef,
  type PortableRefs,
  type PortableToInstance,
  type RefEntry,
  type RefModel,
} from "./refs.js";
import type { InstanceEntity, PortableEntity } from "./validate.js";
import { KIND_WALKS } from "./walk/entities.js";

/** A validated portable entity and its kind. */
export interface PortableItem {
  kind: Kind;
  entity: PortableEntity;
}

/** A validated instance entity and its kind. */
export interface InstanceItem {
  kind: Kind;
  entity: InstanceEntity;
}

/** The converted items, or the references the given map does not resolve. */
export type Conversion<T, Refs> =
  | { ok: true; value: T }
  | { ok: false; unresolved: Refs };

interface Converted<Ref> {
  entities: JsonValue[];
  unresolved: RefEntry<Ref>[];
}

/** The distinct portable references `items` make to anything outside the list, for the caller to resolve. */
export function getPortableRefs(items: PortableItem[]): PortableRefs {
  return toPortableRefs(toInstance(items, {}).unresolved);
}

/**
 * `items` with each portable reference replaced by its instance id: from `ids`, or, for an entity
 * of the list that `ids` lacks, a negative id unique within the list.
 */
export function getInstanceEntities(
  items: PortableItem[],
  ids: PortableToInstance,
): Conversion<InstanceItem[], PortableRefs> {
  const { entities, unresolved } = toInstance(items, ids);
  if (unresolved.length > 0) {
    return { ok: false, unresolved: toPortableRefs(unresolved) };
  }
  return {
    ok: true,
    value: items.map(({ kind }, index) => ({
      kind,
      entity: entities[index] as InstanceEntity,
    })),
  };
}

/** The distinct instance ids `items` reference outside the list, for the caller to resolve. */
export function getInstanceRefs(items: InstanceItem[]): InstanceRefs {
  return toInstanceRefs(toPortable(items, {}).unresolved);
}

/**
 * `items` with each instance id replaced by its portable reference: from `refs`, or, for an
 * entity of the list, its own entity id.
 */
export function getPortableEntities(
  items: InstanceItem[],
  refs: InstanceToPortable,
): Conversion<PortableItem[], InstanceRefs> {
  const { entities, unresolved } = toPortable(items, refs);
  if (unresolved.length > 0) {
    return { ok: false, unresolved: toInstanceRefs(unresolved) };
  }
  return {
    ok: true,
    value: items.map(({ kind }, index) => ({
      kind,
      entity: withSerdesMeta(kind, entities[index]) as PortableEntity,
    })),
  };
}

function toInstance(
  items: PortableItem[],
  ids: PortableToInstance,
): Converted<PortableRef> {
  const memberIds = newMemberIds(portableIdentities(items), ids);
  const instanceId = (model: RefModel, ref: PortableRef) =>
    idOf(ids, model, ref) ?? idOf(memberIds, model, ref);
  const unresolved: RefEntry<PortableRef>[] = [];
  const entities = items.map(({ kind, entity }) =>
    KIND_WALKS[kind](entity, {
      direction: "toInstance",
      reference: (model, ref) => {
        const id = instanceId(model, ref);
        if (id === undefined) {
          unresolved.push([model, ref]);
          return ref;
        }
        return id;
      },
      identity: (model, entityId) => instanceId(model, entityId) ?? null,
    }),
  );
  return structuredClone({ entities, unresolved });
}

function toPortable(
  items: InstanceItem[],
  refs: InstanceToPortable,
): Converted<number> {
  const memberRefs = byModel(instanceIdentities(items));
  const portableRef = (model: RefModel, id: number) =>
    refOf(refs, model, id) ?? refOf(memberRefs, model, id);
  const unresolved: RefEntry<number>[] = [];
  const entities = items.map(({ kind, entity }) =>
    KIND_WALKS[kind](entity, {
      direction: "toPortable",
      reference: (model, id) => {
        const ref = portableRef(model, id);
        if (ref === undefined) {
          unresolved.push([model, id]);
          return id;
        }
        return ref;
      },
      identity: () => undefined,
    }),
  );
  return structuredClone({ entities, unresolved });
}

function portableIdentities(items: PortableItem[]): RefEntry<string>[] {
  const identities: RefEntry<string>[] = [];
  for (const { kind, entity } of items) {
    KIND_WALKS[kind](entity, {
      direction: "toInstance",
      reference: (_model, ref) => ref,
      identity: (model, entityId) => {
        identities.push([model, entityId]);
        return null;
      },
    });
  }
  return identities;
}

function instanceIdentities(
  items: InstanceItem[],
): [RefModel, number, string][] {
  const identities: [RefModel, number, string][] = [];
  for (const { kind, entity } of items) {
    KIND_WALKS[kind](entity, {
      direction: "toPortable",
      reference: (_model, id) => id,
      identity: (model, entityId, id) => {
        if (typeof id === "number") {
          identities.push([model, id, entityId]);
        }
      },
    });
  }
  return identities;
}

function newMemberIds(
  identities: RefEntry<string>[],
  ids: PortableToInstance,
): PortableToInstance {
  const lastIds = new Map<RefModel, number>();
  const newIds = identities
    .filter(([model, entityId]) => idOf(ids, model, entityId) === undefined)
    .map(([model, entityId]): [RefModel, string, number] => {
      const id = (lastIds.get(model) ?? 0) - 1;
      lastIds.set(model, id);
      return [model, entityId, id];
    });
  return byModel(newIds);
}

function byModel<Value>(
  entries: [RefModel, string | number, Value][],
): Partial<Record<RefModel, Record<string, Value>>> {
  const map: Partial<Record<RefModel, Record<string, Value>>> = {};
  for (const [model, key, value] of entries) {
    map[model] = { ...map[model], [key]: value };
  }
  return map;
}

function idOf(
  ids: PortableToInstance,
  model: RefModel,
  ref: PortableRef,
): number | undefined {
  const modelIds = ids[model] ?? {};
  const key = portableKey(ref);
  return Object.hasOwn(modelIds, key) ? modelIds[key] : undefined;
}

function refOf(
  refs: InstanceToPortable,
  model: RefModel,
  id: number,
): PortableRef | undefined {
  const modelRefs = refs[model] ?? {};
  const ref = Object.hasOwn(modelRefs, id) ? modelRefs[id] : undefined;
  return ref !== undefined && isPortableRef(model, ref) ? ref : undefined;
}

function withSerdesMeta(kind: Kind, value: JsonValue): JsonValue {
  if (kind === "Query" || !isJsonObject(value) || "serdes/meta" in value) {
    return value;
  }
  return {
    ...value,
    "serdes/meta": [{ model: kind, id: value.entity_id ?? null }],
  };
}
