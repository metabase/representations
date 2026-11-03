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
      visit(model: RefModel, ref: PortableRef): JsonValue;
    }
  | {
      readonly direction: "toPortable";
      visit(model: RefModel, id: number): JsonValue;
    };

export type Walk = (value: JsonValue, visitor: Visitor) => JsonValue;

export function convertRef(
  visitor: Visitor,
  model: RefModel,
  value: JsonValue,
): JsonValue {
  if (visitor.direction === "toPortable") {
    return typeof value === "number" ? visitor.visit(model, value) : value;
  }
  return isPortableRef(model, value) ? visitor.visit(model, value) : value;
}

export const unchanged: Walk = (value) => value;

export function ref(model: RefModel): Walk {
  return (value, visitor) => convertRef(visitor, model, value);
}

export function fields(
  walks: Readonly<Record<string, Walk>>,
  rest?: Walk,
): Walk {
  return (value, visitor) =>
    isJsonObject(value) ? walkFields(value, walks, rest, visitor) : value;
}

function walkFields(
  object: JsonObject,
  walks: Readonly<Record<string, Walk>>,
  rest: Walk | undefined,
  visitor: Visitor,
): JsonObject {
  return mapEntries(object, (key, child) => {
    const walk = Object.hasOwn(walks, key) ? walks[key] : rest;
    return walk === undefined ? child : walk(child, visitor);
  });
}

export function items(walk: Walk): Walk {
  return (value, visitor) =>
    isJsonArray(value) ? value.map((item) => walk(item, visitor)) : value;
}

export function values(walk: Walk): Walk {
  return (value, visitor) =>
    isJsonArray(value)
      ? items(walk)(value, visitor)
      : fields({}, walk)(value, visitor);
}

export function entity(
  model: RefModel,
  walks: Readonly<Record<string, Walk>>,
): Walk {
  return (value, visitor) => {
    if (!isJsonObject(value)) {
      return value;
    }
    if (visitor.direction === "toPortable") {
      const { id: _id, ...portable } = value;
      return walkFields(portable, walks, undefined, visitor);
    }
    if (value.entity_id === undefined) {
      return walkFields(value, walks, undefined, visitor);
    }
    const id = convertRef(visitor, model, value.entity_id);
    return { id, ...walkFields(value, walks, undefined, visitor) };
  };
}

export function jsonString(walk: Walk): Walk {
  return (value, visitor) => {
    if (typeof value !== "string") {
      return value;
    }
    const parsed = parseJson(value);
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

export function mapEntries(
  object: JsonObject,
  map: (key: string, value: JsonValue) => JsonValue,
): JsonObject {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, map(key, value)]),
  );
}
