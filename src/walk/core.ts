import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import { isPortableRef, type PortableRef, type RefModel } from "../refs.js";

export type Visitor =
  | {
      readonly direction: "toInstance";
      reference(model: RefModel, ref: PortableRef): JsonValue;
      identity(model: RefModel, entityId: string): JsonValue;
    }
  | {
      readonly direction: "toPortable";
      reference(model: RefModel, id: number): JsonValue;
      identity(model: RefModel, entityId: string, id: JsonValue): void;
    };

export type Walk = (value: JsonValue, visitor: Visitor) => JsonValue;

export const unchanged: Walk = (value) => value;

export function ref(model: RefModel): Walk {
  return (value, visitor) => {
    if (visitor.direction === "toPortable") {
      return typeof value === "number"
        ? visitor.reference(model, value)
        : value;
    }
    return isPortableRef(model, value)
      ? visitor.reference(model, value)
      : value;
  };
}

export function pathRef(
  model: RefModel,
  fromPath: (path: JsonValue) => JsonValue | undefined,
  toPath: (ref: JsonValue) => JsonValue,
): Walk {
  const walkRef = ref(model);
  return (value, visitor) => {
    if (visitor.direction === "toInstance") {
      const portable = fromPath(value);
      return portable === undefined ? value : walkRef(portable, visitor);
    }
    const converted = walkRef(value, visitor);
    return converted === value ? value : toPath(converted);
  };
}

export function embeddedRef(
  model: RefModel,
  pattern: RegExp,
  format: (ref: JsonValue) => string,
): Walk {
  const walkRef = ref(model);
  return (value, visitor) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null) {
      return value;
    }
    const embedded = /^\d+$/.test(match[1]) ? Number(match[1]) : match[1];
    const converted = walkRef(embedded, visitor);
    return converted === embedded ? value : format(converted);
  };
}

export function sequence(...walks: Walk[]): Walk {
  return (value, visitor) =>
    walks.reduce((walked, walk) => walk(walked, visitor), value);
}

export function lazy(walk: () => Walk): Walk {
  return (value, visitor) => walk()(value, visitor);
}

export function byObject(walkOf: (object: JsonObject) => Walk): Walk {
  return (value, visitor) =>
    isJsonObject(value) ? walkOf(value)(value, visitor) : value;
}

export function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: JsonValue | undefined,
): T | undefined {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

export function fields(
  walks: Readonly<Record<string, Walk>>,
  rest: Walk = unchanged,
): Walk {
  return (value, visitor) =>
    isJsonObject(value) ? walkFields(value, walks, rest, visitor) : value;
}

export function items(walk: Walk): Walk {
  return (value, visitor) =>
    isJsonArray(value) ? value.map((item) => walk(item, visitor)) : value;
}

export function values(walk: Walk): Walk {
  const walkItems = items(walk);
  const walkEntries = fields({}, walk);
  return (value, visitor) =>
    (isJsonArray(value) ? walkItems : walkEntries)(value, visitor);
}

export function entries(
  walkKey: Walk,
  walkOf: (value: JsonValue) => Walk | null,
): Walk {
  return (value, visitor) => {
    if (!isJsonObject(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const walk = walkOf(child);
        return walk === null
          ? [key, child]
          : [String(walkKey(key, visitor)), walk(child, visitor)];
      }),
    );
  };
}

export function entity(
  model: RefModel,
  walks: Readonly<Record<string, Walk>>,
): Walk {
  return (value, visitor) => {
    if (!isJsonObject(value)) {
      return value;
    }
    const { id, ...object } = value;
    const entityId = object.entity_id;
    if (typeof entityId !== "string") {
      return walkFields(object, walks, unchanged, visitor);
    }
    if (visitor.direction === "toPortable") {
      visitor.identity(model, entityId, id ?? null);
      return walkFields(object, walks, unchanged, visitor);
    }
    const instanceId = visitor.identity(model, entityId);
    return { id: instanceId, ...walkFields(object, walks, unchanged, visitor) };
  };
}

export function jsonString(walk: Walk): Walk {
  return (value, visitor) => {
    const parsed = typeof value === "string" ? parseJson(value) : undefined;
    if (parsed === undefined) {
      return value;
    }
    const walked = JSON.stringify(walk(parsed, visitor));
    return walked === JSON.stringify(parsed) ? value : walked;
  };
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function walkFields(
  object: JsonObject,
  walks: Readonly<Record<string, Walk>>,
  rest: Walk,
  visitor: Visitor,
): JsonObject {
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      (lookup(walks, key) ?? rest)(child, visitor),
    ]),
  );
}
