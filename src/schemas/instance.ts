import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.js";

const ID_SCHEMA = "common/id.json";
const IDENTITY_DEF = "entity_id";
const FOREIGN_KEY_REF = /(?:^|\/)id\.json#\/\$defs\/(\w+)$/;

export function toInstanceSchemas<Name extends string>(
  portableSchemas: Readonly<Record<Name, JsonObject>>,
): Record<Name, JsonObject> {
  const entries = Object.entries<JsonObject>(portableSchemas).map(
    ([name, schema]) => [
      name,
      name === ID_SCHEMA
        ? toInstanceIdSchema(schema)
        : toInstanceSchema(schema),
    ],
  );
  return Object.fromEntries(entries);
}

function toInstanceIdSchema(schema: JsonObject): JsonObject {
  const defs = isJsonObject(schema.$defs) ? schema.$defs : {};
  return {
    ...schema,
    $defs: Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [
        name,
        name === IDENTITY_DEF ? def : instanceForeignKey(name),
      ]),
    ),
  };
}

function instanceForeignKey(def: string): JsonObject {
  const target = def.replace(/_(id|path)$/, "").replaceAll("_", " ");
  return def === "dashboard_tab_id"
    ? {
        type: "integer",
        description: `Instance id of the referenced ${target}, negative for a new tab in a dashboard update`,
      }
    : {
        type: "integer",
        minimum: 1,
        description: `Instance id of the referenced ${target}`,
      };
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
  const nullableKey = isForeignKeyRef(node.then) && isJsonObject(node.if);
  if (!nullableKey && !isForeignKeyRef(node)) {
    return node;
  }
  const { description: _description, ...foreignKey } = node;
  if (!nullableKey || !isJsonObject(node.if)) {
    return foreignKey;
  }
  return {
    ...foreignKey,
    ...(node.type === undefined
      ? {}
      : { type: replaceType(node.type, node.if.type) }),
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

function replaceType(
  type: JsonValue,
  portableType: JsonValue | undefined,
): JsonValue {
  const replace = (t: JsonValue) => (t === portableType ? "integer" : t);
  return isJsonArray(type) ? type.map(replace) : replace(type);
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
      id: { type: "integer", description: "Instance id" },
      ...node.properties,
    },
  };
}
