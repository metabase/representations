import { isJsonObject, type JsonValue } from "./json.js";
import { KIND_MODELS, type Kind } from "./kinds.js";
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

export type Conversion<T, Refs> =
  | { ok: true; value: T }
  | { ok: false; unresolved: Refs };

/** The portable references `entity` makes, to resolve to instance ids. */
export function getPortableRefs<K extends Kind>(
  kind: K,
  entity: PortableEntity<K>,
): PortableRefs {
  const entries: PortableRefEntry[] = [];
  KIND_WALKS[kind](entity, {
    direction: "toInstance",
    visit: (model, ref) => {
      entries.push([model, ref]);
      return ref;
    },
  });
  return toPortableRefs(entries);
}

/** `entity` with every portable reference replaced by its instance id from `refs`. */
export function getInstanceEntity<K extends Kind>(
  kind: K,
  entity: PortableEntity<K>,
  refs: PortableToInstance,
): Conversion<InstanceEntity<K>, PortableRefs> {
  const unresolved: PortableRefEntry[] = [];
  const value = KIND_WALKS[kind](entity, {
    direction: "toInstance",
    visit: (model, ref) => {
      const id = refs[model]?.[portableKey(ref)];
      if (id === undefined) {
        unresolved.push([model, ref]);
        return ref;
      }
      return id;
    },
  });
  return unresolved.length > 0
    ? { ok: false, unresolved: toPortableRefs(unresolved) }
    : { ok: true, value: asInstanceEntity<K>(value) };
}

/** The instance ids `entity` references, to resolve to portable references. */
export function getInstanceRefs<K extends Kind>(
  kind: K,
  entity: InstanceEntity<K>,
): InstanceRefs {
  const entries: InstanceRefEntry[] = [];
  KIND_WALKS[kind](entity, {
    direction: "toPortable",
    visit: (model, id) => {
      entries.push([model, id]);
      return id;
    },
  });
  return toInstanceRefs(entries);
}

/** `entity` with every instance id replaced by its portable reference from `refs`. */
export function getPortableEntity<K extends Kind>(
  kind: K,
  entity: InstanceEntity<K>,
  refs: InstanceToPortable,
): Conversion<PortableEntity<K>, InstanceRefs> {
  const unresolved: InstanceRefEntry[] = [];
  const value = KIND_WALKS[kind](entity, {
    direction: "toPortable",
    visit: (model, id) => {
      const ref = refs[model]?.[id];
      if (ref === undefined) {
        unresolved.push([model, id]);
        return id;
      }
      return ref;
    },
  });
  return unresolved.length > 0
    ? { ok: false, unresolved: toInstanceRefs(unresolved) }
    : { ok: true, value: asPortableEntity<K>(withSerdesMeta(kind, value)) };
}

function withSerdesMeta(kind: Kind, value: JsonValue): JsonValue {
  const model = KIND_MODELS[kind];
  if (model === null || !isJsonObject(value) || "serdes/meta" in value) {
    return value;
  }
  return { ...value, "serdes/meta": [{ model, id: value.entity_id ?? null }] };
}

function asInstanceEntity<K extends Kind>(value: JsonValue): InstanceEntity<K> {
  return value as InstanceEntity<K>;
}

function asPortableEntity<K extends Kind>(value: JsonValue): PortableEntity<K> {
  return value as PortableEntity<K>;
}
