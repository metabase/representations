import { isJsonArray, isJsonObject, type JsonValue } from "../json.js";
import type { RefModel } from "../refs.js";
import { pathRef, type Walk } from "./core.js";

export function dashboardTabRef(
  dashboardEntityId: JsonValue | undefined,
): Walk {
  return pathRef(
    "DashboardTab",
    (path) => (isJsonArray(path) ? path[1] : undefined),
    (tabEntityId) => [dashboardEntityId ?? null, tabEntityId],
  );
}

export function serdesEntityRef(model: RefModel): Walk {
  return pathRef(
    model,
    (path) => serdesPathId(path, model),
    (entityId) => [{ model, id: entityId }],
  );
}

export const serdesTableRef = pathRef(
  "Table",
  (path) => {
    const database = serdesPathId(path, "Database");
    const table = serdesPathId(path, "Table");
    return database === undefined || table === undefined
      ? undefined
      : [database, serdesPathId(path, "Schema") ?? null, table];
  },
  (table) => {
    if (!isJsonArray(table)) {
      return table;
    }
    const [database, schema, name] = table;
    return [
      { model: "Database", id: database },
      ...(schema === null ? [] : [{ model: "Schema", id: schema }]),
      { model: "Table", id: name },
    ];
  },
);

function serdesPathId(path: JsonValue, model: string): string | undefined {
  const segment = isJsonArray(path)
    ? path.find((part) => isJsonObject(part) && part.model === model)
    : undefined;
  return isJsonObject(segment) && typeof segment.id === "string"
    ? segment.id
    : undefined;
}
