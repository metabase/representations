import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.js";

const ID_SCHEMA = "common/id.json";
const FOREIGN_KEY_REF = /(?:^|\/)id\.json#\/\$defs\/(\w+)$/;
const IDENTITY_DEF = "entity_id";
const NEW_ROW_DEFS = new Set(["dashboard_tab_id"]);

export function toInstanceSchemas(
  portableSchemas: Readonly<Record<string, JsonObject>>,
): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.entries(portableSchemas).map(([name, schema]) => [
      name,
      name === ID_SCHEMA
        ? toInstanceIdSchema(schema)
        : toInstanceSchema(schema),
    ]),
  );
}

function toInstanceIdSchema(schema: JsonObject): JsonObject {
  const defs = isJsonObject(schema.$defs) ? schema.$defs : {};
  return {
    ...schema,
    $defs: Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [
        name,
        name === IDENTITY_DEF ? def : instanceId(name),
      ]),
    ),
  };
}

function instanceId(def: string): JsonObject {
  return NEW_ROW_DEFS.has(def)
    ? { type: "integer", description: "Instance id, negative for a new row" }
    : { type: "integer", minimum: 1, description: "Instance id" };
}

function toInstanceSchema(schema: JsonObject): JsonObject {
  const node = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key, toInstanceNode(value)]),
  );
  return withInstanceId(withoutRequiredMeta(withIntegerForeignKey(node)));
}

function toInstanceNode(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map(toInstanceNode);
  }
  return isJsonObject(value) ? toInstanceSchema(value) : value;
}

function withIntegerForeignKey(node: JsonObject): JsonObject {
  if (!isForeignKeyRef(node.then) || !isJsonObject(node.if)) {
    return node;
  }
  return {
    ...node,
    ...(node.type === undefined ? {} : { type: toIntegerType(node.type) }),
    if: { ...node.if, type: "integer" },
  };
}

function isForeignKeyRef(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value) || typeof value.$ref !== "string") {
    return false;
  }
  const def = FOREIGN_KEY_REF.exec(value.$ref)?.[1];
  return def !== undefined && def !== IDENTITY_DEF;
}

function toIntegerType(type: JsonValue): JsonValue {
  const types = isJsonArray(type) ? type : [type];
  const integerTypes = types.map((t) =>
    t === "string" || t === "array" ? "integer" : t,
  );
  return isJsonArray(type) ? [...new Set(integerTypes)] : integerTypes[0];
}

function withoutRequiredMeta(node: JsonObject): JsonObject {
  if (!isJsonArray(node.required)) {
    return node;
  }
  return {
    ...node,
    required: node.required.filter((key) => key !== "serdes/meta"),
  };
}

function withInstanceId(node: JsonObject): JsonObject {
  if (!isJsonObject(node.properties) || !("entity_id" in node.properties)) {
    return node;
  }
  return {
    ...node,
    properties: {
      id: {
        type: "integer",
        description: "Instance id, negative for a new row",
      },
      ...node.properties,
    },
  };
}
