import { isJsonArray, isJsonObject, type JsonArray } from "../json.js";
import type { RefModel } from "../refs.js";
import {
  convertRef,
  fields,
  items,
  mapEntries,
  ref,
  values,
  type Visitor,
  type Walk,
} from "./core.js";

const CLAUSE_REF_MODELS: Readonly<Record<string, RefModel>> = {
  field: "fields",
  metric: "cards",
  measure: "measures",
  segment: "segments",
};

interface RefSlot {
  model: RefModel;
  index: number;
}

export const walkMbql: Walk = (value, visitor) => {
  if (isJsonArray(value)) {
    return walkClause(value, visitor);
  }
  if (isJsonObject(value)) {
    return mapEntries(value, (key, child) =>
      key === "source-field"
        ? convertRef(visitor, "fields", child)
        : walkMbql(child, visitor),
    );
  }
  return value;
};

function walkClause(clause: JsonArray, visitor: Visitor): JsonArray {
  const slot = refSlot(clause);
  return clause.map((arg, index) =>
    index === slot?.index
      ? convertRef(visitor, slot.model, arg)
      : walkMbql(arg, visitor),
  );
}

function refSlot([head, options]: JsonArray): RefSlot | null {
  if (typeof head !== "string" || !Object.hasOwn(CLAUSE_REF_MODELS, head)) {
    return null;
  }
  return {
    model: CLAUSE_REF_MODELS[head],
    index: isJsonObject(options) ? 2 : 1,
  };
}

const walkTemplateTag = fields({
  "card-id": ref("cards"),
  "snippet-id": ref("snippets"),
  "table-id": ref("tables"),
  dimension: walkMbql,
});

const walkStage: Walk = (value, visitor) =>
  fields(
    {
      "source-table": ref("tables"),
      "source-card": ref("cards"),
      joins: items(walkJoin),
      "template-tags": values(walkTemplateTag),
    },
    walkMbql,
  )(value, visitor);

const walkJoin = fields({ stages: items(walkStage) }, walkMbql);

export const walkQuery = fields({
  database: ref("databases"),
  stages: items(walkStage),
});
