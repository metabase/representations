import { isJsonObject, type JsonValue } from "./json.js";
import type { Kind } from "./kinds.js";
import {
  isPortableRef,
  portableKey,
  toInstanceRefs,
  toPortableRefs,
  withoutPortableRefs,
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

/** The converted value, or the references the given map does not resolve. */
export type Conversion<T, Refs> =
  | { ok: true; value: T }
  | { ok: false; unresolved: Refs };

interface Converted<Ref> {
  value: JsonValue;
  ids: RefEntry<Ref>[];
  unresolved: RefEntry<Ref>[];
}

/** The entity ids of `entity` itself, by model: its own, then those of a dashboard's tabs and cards. */
export function getPortableIds<K extends Kind>(
  kind: K,
  entity: PortableEntity<NoInfer<K>>,
): PortableRefs {
  return toPortableRefs(toInstance(kind, entity, {}).ids);
}

/** The distinct portable references of `entity` to anything but itself, for the caller to resolve. */
export function getPortableRefs<K extends Kind>(
  kind: K,
  entity: PortableEntity<NoInfer<K>>,
): PortableRefs {
  const { ids, unresolved } = toInstance(kind, entity, {});
  return withoutPortableRefs(toPortableRefs(unresolved), toPortableRefs(ids));
}

/** `entity` with its own ids and each portable reference replaced by its instance id from `ids`. */
export function getInstanceEntity<K extends Kind>(
  kind: K,
  entity: PortableEntity<NoInfer<K>>,
  ids: PortableToInstance,
): Conversion<InstanceEntity<K>, PortableRefs> {
  const { value, unresolved } = toInstance(kind, entity, ids);
  return unresolved.length > 0
    ? { ok: false, unresolved: toPortableRefs(unresolved) }
    : { ok: true, value: value as InstanceEntity<K> };
}

/** The distinct instance ids `entity` references outside itself, for the caller to resolve. */
export function getInstanceRefs<K extends Kind>(
  kind: K,
  entity: InstanceEntity<NoInfer<K>>,
): InstanceRefs {
  return toInstanceRefs(toPortable(kind, entity, {}).unresolved);
}

/** `entity` with each instance id replaced by its portable reference from `refs` or from the entity itself, and its own `id` dropped. */
export function getPortableEntity<K extends Kind>(
  kind: K,
  entity: InstanceEntity<NoInfer<K>>,
  refs: InstanceToPortable,
): Conversion<PortableEntity<K>, InstanceRefs> {
  const { value, unresolved } = toPortable(kind, entity, refs);
  return unresolved.length > 0
    ? { ok: false, unresolved: toInstanceRefs(unresolved) }
    : { ok: true, value: withSerdesMeta(kind, value) as PortableEntity<K> };
}

function toInstance(
  kind: Kind,
  entity: JsonValue,
  ids: PortableToInstance,
): Converted<PortableRef> {
  const own: RefEntry<PortableRef>[] = [];
  const unresolved: RefEntry<PortableRef>[] = [];
  const instanceId = (model: RefModel, ref: PortableRef) => {
    const id = idOf(ids, model, ref);
    if (id === undefined) {
      unresolved.push([model, ref]);
    }
    return id ?? ref;
  };
  const value = KIND_WALKS[kind](entity, {
    direction: "toInstance",
    reference: instanceId,
    identity: (model, entityId) => {
      own.push([model, entityId]);
      return instanceId(model, entityId);
    },
  });
  return structuredClone({ value, ids: own, unresolved });
}

function toPortable(
  kind: Kind,
  entity: JsonValue,
  refs: InstanceToPortable,
): Converted<number> {
  const ownRefs = instanceIdentities(kind, entity);
  const unresolved: RefEntry<number>[] = [];
  const value = KIND_WALKS[kind](entity, {
    direction: "toPortable",
    reference: (model, id) => {
      const ref = refOf(refs, model, id) ?? refOf(ownRefs, model, id);
      if (ref === undefined) {
        unresolved.push([model, id]);
        return id;
      }
      return ref;
    },
    identity: () => undefined,
  });
  return structuredClone({ value, ids: [], unresolved });
}

function instanceIdentities(kind: Kind, entity: JsonValue): InstanceToPortable {
  const ownRefs: Partial<Record<RefModel, Record<number, string>>> = {};
  KIND_WALKS[kind](entity, {
    direction: "toPortable",
    reference: (_model, id) => id,
    identity: (model, entityId, id) => {
      if (typeof id === "number") {
        ownRefs[model] = { ...ownRefs[model], [id]: entityId };
      }
    },
  });
  return ownRefs;
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
