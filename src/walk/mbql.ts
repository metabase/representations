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
  field: ref("Field"),
  metric: ref("Card"),
  measure: ref("Measure"),
  segment: ref("Segment"),
};

export const walkMbql: Walk = (value, visitor) => {
  if (isJsonArray(value)) {
    return walkClause(value, visitor);
  }
  return isJsonObject(value) ? walkOptions(value, visitor) : value;
};

const walkOptions = fields({ "source-field": ref("Field") }, walkMbql);

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
  "card-id": ref("Card"),
  "snippet-id": ref("NativeQuerySnippet"),
  "table-id": ref("Table"),
  dimension: walkMbql,
});

const walkStage: Walk = fields(
  {
    "source-table": ref("Table"),
    "source-card": ref("Card"),
    joins: items(fields({ stages: items(lazy(() => walkStage)) }, walkMbql)),
    "template-tags": values(walkTemplateTag),
  },
  walkMbql,
);

export const walkQuery = fields({
  database: ref("Database"),
  stages: items(walkStage),
});
