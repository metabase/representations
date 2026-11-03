import { isJsonObject, type JsonValue } from "../json.js";
import type { RefModel } from "../refs.js";
import {
  byObject,
  embeddedRef,
  fields,
  items,
  jsonString,
  entries,
  lookup,
  ref,
  sequence,
  unchanged,
  values,
  type Walk,
} from "./core.js";
import { walkMbql } from "./mbql.js";
import { dashboardTabRef } from "./paths.js";

const LINK_MODELS: Readonly<Record<string, RefModel>> = {
  card: "cards",
  dataset: "cards",
  question: "cards",
  collection: "collections",
  dashboard: "dashboards",
  database: "databases",
  table: "tables",
};

function linkRef(linkModel: JsonValue | undefined): Walk {
  const model = lookup(LINK_MODELS, linkModel);
  return model === undefined ? unchanged : ref(model);
}

const walkMbqlJson = jsonString(walkMbql);

const walkDimensionMapping = fields({
  id: walkMbqlJson,
  target: fields({ id: walkMbqlJson, dimension: walkMbql }),
});

const walkClickParameterMapping = entries(walkMbqlJson, (mapping) =>
  isJsonObject(mapping) &&
  isJsonObject(mapping.target) &&
  mapping.target.type === "dimension"
    ? walkDimensionMapping
    : null,
);

const walkClickParameters = fields({
  parameterMapping: walkClickParameterMapping,
});

const walkClickTarget = byObject((behavior) =>
  fields({ targetId: linkRef(behavior.linkType) }),
);

const walkClickTargetTab = byObject((behavior) =>
  fields({ tabId: dashboardTabRef(behavior.targetId) }),
);

const walkClickBehavior = byObject((behavior) =>
  behavior.type === "link"
    ? sequence(walkClickParameters, walkClickTarget, walkClickTargetTab)
    : walkClickParameters,
);

const walkColumnSetting = fields({ click_behavior: walkClickBehavior });

const walkColumnSettings = entries(walkMbqlJson, () => walkColumnSetting);

const walkLinkEntity = byObject((entity) =>
  fields({ id: linkRef(entity.model) }),
);

const walkVisualizerSource = fields({
  sourceId: embeddedRef("cards", /^card:(.+)$/, (id) => `card:${id}`),
});

const walkVisualizerName = embeddedRef(
  "cards",
  /^\$_card:(.+)_name$/,
  (id) => `$_card:${id}_name`,
);

const walkVisualizerColumn: Walk = (value, visitor) =>
  (isJsonObject(value) ? walkVisualizerSource : walkVisualizerName)(
    value,
    visitor,
  );

export const walkVisualizationSettings = fields(
  {
    column_settings: walkColumnSettings,
    click_behavior: walkClickBehavior,
    link: fields({ entity: walkLinkEntity }),
    visualization: fields({
      columnValuesMapping: values(items(walkVisualizerColumn)),
    }),
  },
  walkMbql,
);
