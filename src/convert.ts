import { isJsonArray, isJsonObject, type JsonValue } from "./json.js";
import { KIND_SPECS, type Kind } from "./kinds.js";
import {
  portableKey,
  toInstanceRefs,
  toPortableRefs,
  type InstanceRefEntry,
  type InstanceRefs,
  type InstanceToPortable,
  type PortableRefEntry,
  type PortableRefs,
  type PortableToInstance,
} from "./refs.js";
import type { InstanceEntity, PortableEntity } from "./validate.js";
import { KIND_WALKS } from "./walk/entities.js";

/** The converted value, or the references the given maps do not resolve. */
export type Conversion<T, Refs> =
  | { ok: true; value: T }
  | { ok: false; unresolved: Refs };

interface Walked<Entry> {
  value: JsonValue;
  unresolved: Entry[];
}

/** The distinct portable references of `entity`, its own entity id first, for the caller to resolve. */
export function getPortableRefs<K extends Kind>(
  kind: K,
  entity: PortableEntity<NoInfer<K>>,
): PortableRefs {
  return toPortableRefs(walkToInstance(kind, entity, {}).unresolved);
}

/** `entity` with each portable reference replaced by its instance id from `ids`, and its own `id` added. */
export function getInstanceEntity<K extends Kind>(
  kind: K,
  entity: PortableEntity<NoInfer<K>>,
  ids: PortableToInstance,
): Conversion<InstanceEntity<K>, PortableRefs> {
  const { value, unresolved } = walkToInstance(kind, entity, ids);
  return unresolved.length > 0
    ? { ok: false, unresolved: toPortableRefs(unresolved) }
    : { ok: true, value: value as InstanceEntity<K> };
}

/** The distinct instance ids `entity` references, without its own `id`, for the caller to resolve. */
export function getInstanceRefs<K extends Kind>(
  kind: K,
  entity: InstanceEntity<NoInfer<K>>,
): InstanceRefs {
  return toInstanceRefs(walkToPortable(kind, entity, {}).unresolved);
}

/** `entity` with each instance id replaced by its portable reference from `refs`, and its own `id` dropped. */
export function getPortableEntity<K extends Kind>(
  kind: K,
  entity: InstanceEntity<NoInfer<K>>,
  refs: InstanceToPortable,
): Conversion<PortableEntity<K>, InstanceRefs> {
  const { value, unresolved } = walkToPortable(kind, entity, refs);
  return unresolved.length > 0
    ? { ok: false, unresolved: toInstanceRefs(unresolved) }
    : { ok: true, value: withSerdesMeta(kind, value) as PortableEntity<K> };
}

function walkToInstance(
  kind: Kind,
  entity: JsonValue,
  ids: PortableToInstance,
): Walked<PortableRefEntry> {
  const unresolved: PortableRefEntry[] = [];
  const value = KIND_WALKS[kind](entity, {
    direction: "toInstance",
    visit: (model, ref) => {
      const key = portableKey(ref);
      const modelIds = ids[model] ?? {};
      if (Object.hasOwn(modelIds, key)) {
        return modelIds[key];
      }
      unresolved.push([model, ref]);
      return ref;
    },
  });
  return { value, unresolved };
}

function walkToPortable(
  kind: Kind,
  entity: JsonValue,
  refs: InstanceToPortable,
): Walked<InstanceRefEntry> {
  const unresolved: InstanceRefEntry[] = [];
  const value = KIND_WALKS[kind](entity, {
    direction: "toPortable",
    visit: (model, id) => {
      const modelRefs = refs[model] ?? {};
      if (Object.hasOwn(modelRefs, id)) {
        const ref = modelRefs[id];
        return isJsonArray(ref) ? [...ref] : ref;
      }
      unresolved.push([model, id]);
      return id;
    },
  });
  return { value, unresolved };
}

function withSerdesMeta(kind: Kind, value: JsonValue): JsonValue {
  const { serdesModel } = KIND_SPECS[kind];
  if (serdesModel === null || !isJsonObject(value) || "serdes/meta" in value) {
    return value;
  }
  return {
    ...value,
    "serdes/meta": [{ model: serdesModel, id: value.entity_id ?? null }],
  };
}
