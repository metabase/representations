import { isJsonArray, isJsonObject, type JsonArray } from "../json.js";
import {
  fields,
  items,
  lazy,
  lookup,
  ref,
  values,
  type Visitor,
  type Walk,
} from "./core.js";

const CLAUSE_REFS: Readonly<Record<string, Walk>> = {
  field: ref("fields"),
  metric: ref("cards"),
  measure: ref("measures"),
  segment: ref("segments"),
};

export const walkMbql: Walk = (value, visitor) => {
  if (isJsonArray(value)) {
    return walkClause(value, visitor);
  }
  return isJsonObject(value) ? walkOptions(value, visitor) : value;
};

const walkOptions = fields({ "source-field": ref("fields") }, walkMbql);

function walkClause(clause: JsonArray, visitor: Visitor): JsonArray {
  const [head, options] = clause;
  const clauseRef = lookup(CLAUSE_REFS, head);
  const refIndex = isJsonObject(options) ? 2 : 1;
  return clause.map((arg, index) =>
    clauseRef !== undefined && index === refIndex
      ? clauseRef(arg, visitor)
      : walkMbql(arg, visitor),
  );
}

export const walkTemplateTag = fields({
  "card-id": ref("cards"),
  "snippet-id": ref("snippets"),
  "table-id": ref("tables"),
  dimension: walkMbql,
});

const walkStage: Walk = fields(
  {
    "source-table": ref("tables"),
    "source-card": ref("cards"),
    joins: items(fields({ stages: items(lazy(() => walkStage)) }, walkMbql)),
    "template-tags": values(walkTemplateTag),
  },
  walkMbql,
);

export const walkQuery = fields({
  database: ref("databases"),
  stages: items(walkStage),
});
