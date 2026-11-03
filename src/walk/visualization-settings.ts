import { isJsonObject, type JsonValue } from "../json.js";
import type { RefModel } from "../refs.js";
import {
  convertRef,
  fields,
  items,
  jsonString,
  ref,
  values,
  unchanged,
  type Visitor,
  type Walk,
} from "./core.js";
import { walkMbql } from "./mbql.js";

const LINK_MODELS: Readonly<Record<string, RefModel>> = {
  card: "cards",
  dataset: "cards",
  question: "cards",
  collection: "collections",
  dashboard: "dashboards",
  database: "databases",
  table: "tables",
};

const CARD_SOURCE_ID = /^card:(.+)$/;
const CARD_DIMENSION_REF = /^\$_card:(.+)_name$/;

function linkRef(model: JsonValue | undefined): Walk {
  return typeof model === "string" && Object.hasOwn(LINK_MODELS, model)
    ? ref(LINK_MODELS[model])
    : unchanged;
}

const walkDimensionMapping = fields({
  id: jsonString(walkMbql),
  target: fields({ id: jsonString(walkMbql), dimension: walkMbql }),
});

const walkClickParameterMapping: Walk = (value, visitor) => {
  if (!isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, mapping]) =>
      isDimensionMapping(mapping)
        ? [
            String(jsonString(walkMbql)(key, visitor)),
            walkDimensionMapping(mapping, visitor),
          ]
        : [key, mapping],
    ),
  );
};

function isDimensionMapping(mapping: JsonValue): boolean {
  return (
    isJsonObject(mapping) &&
    isJsonObject(mapping.target) &&
    mapping.target.type === "dimension"
  );
}

const walkClickBehavior: Walk = (value, visitor) => {
  if (!isJsonObject(value)) {
    return value;
  }
  const isLink = value.type === "link";
  return fields({
    ...(isLink && {
      targetId: linkRef(value.linkType),
      tabId: ref("dashboardTabs"),
    }),
    parameterMapping: walkClickParameterMapping,
  })(value, visitor);
};

const walkColumnSettings: Walk = (value, visitor) => {
  if (!isJsonObject(value)) {
    return value;
  }
  const walkColumn = fields({ click_behavior: walkClickBehavior });
  return Object.fromEntries(
    Object.entries(value).map(([key, settings]) => [
      String(jsonString(walkMbql)(key, visitor)),
      walkColumn(settings, visitor),
    ]),
  );
};

const walkLinkEntity: Walk = (value, visitor) =>
  isJsonObject(value)
    ? fields({ id: linkRef(value.model) })(value, visitor)
    : value;

function embeddedCardRef(
  pattern: RegExp,
  format: (ref: JsonValue) => string,
): Walk {
  return (value, visitor) => {
    const match = typeof value === "string" ? pattern.exec(value) : null;
    if (match === null) {
      return value;
    }
    const cardRef = embeddedRef(match[1], visitor);
    const converted = convertRef(visitor, "cards", cardRef);
    return converted === cardRef ? value : format(converted);
  };
}

function embeddedRef(text: string, visitor: Visitor): JsonValue {
  return visitor.direction === "toPortable" && /^\d+$/.test(text)
    ? Number(text)
    : text;
}

const walkVisualizerColumn: Walk = (value, visitor) =>
  isJsonObject(value)
    ? fields({
        sourceId: embeddedCardRef(CARD_SOURCE_ID, (id) => `card:${id}`),
      })(value, visitor)
    : embeddedCardRef(CARD_DIMENSION_REF, (id) => `$_card:${id}_name`)(
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
