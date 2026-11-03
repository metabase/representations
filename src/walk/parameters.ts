import { fields, ref } from "./core.js";
import { walkMbql } from "./mbql.js";

export const walkParameter = fields({
  values_source_config: fields({
    card_id: ref("cards"),
    value_field: walkMbql,
    label_field: walkMbql,
  }),
});

export const walkParameterMapping = fields({
  card_id: ref("cards"),
  target: walkMbql,
});
