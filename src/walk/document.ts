import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.js";
import type { RefModel, TablePath } from "../refs.js";
import { convertRef, fields, items, unchanged, type Walk } from "./core.js";

interface EntityPathModel {
  refModel: RefModel;
  serdesModel: string;
}

const SMART_LINK_MODELS: Readonly<Record<string, EntityPathModel>> = {
  card: { refModel: "cards", serdesModel: "Card" },
  dataset: { refModel: "cards", serdesModel: "Card" },
  dashboard: { refModel: "dashboards", serdesModel: "Dashboard" },
};

function entityPath({ refModel, serdesModel }: EntityPathModel): Walk {
  return (value, visitor) => {
    if (visitor.direction === "toInstance") {
      const id = singlePathId(value);
      return id === null ? value : convertRef(visitor, refModel, id);
    }
    const converted = convertRef(visitor, refModel, value);
    return converted === value
      ? value
      : [{ model: serdesModel, id: converted }];
  };
}

function singlePathId(path: JsonValue): string | null {
  if (!isJsonArray(path) || path.length !== 1 || !isJsonObject(path[0])) {
    return null;
  }
  const { id } = path[0];
  return typeof id === "string" ? id : null;
}

const tablePath: Walk = (value, visitor) => {
  if (visitor.direction === "toInstance") {
    const table = toTablePath(value);
    return table === null ? value : convertRef(visitor, "tables", table);
  }
  const converted = convertRef(visitor, "tables", value);
  return converted === value ? value : toSerdesTablePath(converted);
};

function toTablePath(path: JsonValue): TablePath | null {
  if (!isJsonArray(path)) {
    return null;
  }
  const idOf = (model: string) => {
    const segment = path.find(
      (part) => isJsonObject(part) && part.model === model,
    );
    return isJsonObject(segment) && typeof segment.id === "string"
      ? segment.id
      : null;
  };
  const database = idOf("Database");
  const table = idOf("Table");
  return database === null || table === null
    ? null
    : [database, idOf("Schema"), table];
}

function toSerdesTablePath(table: JsonValue): JsonValue {
  if (!isJsonArray(table)) {
    return table;
  }
  const [database, schema, name] = table;
  return [
    { model: "Database", id: database },
    ...(schema === null ? [] : [{ model: "Schema", id: schema }]),
    { model: "Table", id: name },
  ];
}

function smartLinkRef(model: JsonValue | undefined): Walk {
  if (model === "table") {
    return tablePath;
  }
  return typeof model === "string" && Object.hasOwn(SMART_LINK_MODELS, model)
    ? entityPath(SMART_LINK_MODELS[model])
    : unchanged;
}

function walkAttrs(node: JsonObject): Walk {
  switch (node.type) {
    case "cardEmbed":
      return fields({ id: entityPath(SMART_LINK_MODELS.card) });
    case "smartLink":
      return fields({
        entityId: smartLinkRef(
          isJsonObject(node.attrs) ? node.attrs.model : undefined,
        ),
      });
    default:
      return unchanged;
  }
}

export const walkProseMirror: Walk = (value, visitor) =>
  isJsonObject(value)
    ? fields({ attrs: walkAttrs(value), content: items(walkProseMirror) })(
        value,
        visitor,
      )
    : value;
