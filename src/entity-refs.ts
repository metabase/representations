import { readFileSync } from "fs";
import { resolve } from "path";

import { type Doc, holderOf, otherHolderOf } from "./documents.js";
import type { Report } from "./findings.js";
import { isRecord, isUnknownArray } from "./values.js";
import { VENDOR_DIR } from "./vendor-sources.js";

/**
 * An entity id a file references: where in the file (a YAML path such as
 * `dashcards[0].series[1].card_id`), the id, and the models whose files may
 * hold it.
 */
export type EntityReference = {
  path: string;
  entityId: string;
  allowedModels: readonly string[];
  /**
   * For a dashboard tab named as `[dashboard, tab]`, the dashboard's entity
   * id: the tab must be one of that dashboard's tabs.
   */
  dashboard?: string;
};

type Body = Readonly<Record<string, unknown>>;

/** The entity references in a file of one model. */
type RefFinder = (body: Body) => EntityReference[];

const CARD = ["Card"] as const;
const COLLECTION = ["Collection"] as const;
const DASHBOARD_TAB = "DashboardTab";

/** Metabase's portable id, a 21-character NanoID (`serialization.clj` `entity-id?`). */
const PORTABLE_ID = /^[A-Za-z0-9_-]{21}$/;

const isPortableId = (value: unknown): value is string =>
  typeof value === "string" && PORTABLE_ID.test(value);

/** `path` followed by `key`, as a YAML path: `a.b`, `a[0]`, or `a["k.ey"]`. */
function join(path: string, key: string | number): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }
  if (/^[A-Za-z_][A-Za-z0-9_/-]*$/.test(key)) {
    return path === "" ? key : `${path}.${key}`;
  }
  return `${path}[${JSON.stringify(key)}]`;
}

function ref(
  path: string,
  entityId: unknown,
  allowedModels: readonly string[],
): EntityReference[] {
  return typeof entityId === "string" && entityId !== ""
    ? [{ path, entityId, allowedModels }]
    : [];
}

/** The reference a key of `body` holds, when it holds a string. */
const keyRef = (
  body: unknown,
  path: string,
  key: string,
  allowedModels: readonly string[],
): EntityReference[] =>
  isRecord(body) ? ref(join(path, key), body[key], allowedModels) : [];

/** `find` over each item of the array `value`. */
const eachItem = (
  value: unknown,
  path: string,
  find: (item: unknown, path: string) => EntityReference[],
): EntityReference[] =>
  isUnknownArray(value)
    ? value.flatMap((item, i) => find(item, join(path, i)))
    : [];

/**
 * A dashboard tab reference: a tab's entity id, or `[dashboard, tab]`, which
 * names the dashboard the tab must belong to.
 */
function tabRef(path: string, value: unknown): EntityReference[] {
  if (!isUnknownArray(value)) {
    return ref(path, value, [DASHBOARD_TAB]);
  }
  const [dashboard] = value;
  return ref(path, value[value.length - 1], [DASHBOARD_TAB]).map((r) =>
    value.length > 1 && typeof dashboard === "string" ? { ...r, dashboard } : r,
  );
}

/**
 * The model an MBQL reference clause names (`serialization.clj`
 * `mbql-ref-tag->model`): a metric is a Card.
 */
const CLAUSE_MODELS: Readonly<Record<string, string>> = {
  metric: "Card",
  segment: "Segment",
  measure: "Measure",
};

/**
 * The entity references in MBQL, as Metabase finds the dependencies of a
 * query it imports (`serialization.clj` `mbql-deps-map`, `mbql-deps-vector`):
 * a `source-card`, a `source-table` that is a portable id (a card), a
 * `snippet-id`, a `card-id` or `card_id`, and the `metric`, `segment` and
 * `measure` clauses. Database, table and field references are not entity ids:
 * Metabase creates stubs for those it does not find.
 */
function mbqlRefs(value: unknown, path: string): EntityReference[] {
  if (isUnknownArray(value)) {
    const [tag, second, third] = value;
    const model = typeof tag === "string" ? CLAUSE_MODELS[tag] : undefined;
    if (model !== undefined && isRecord(second) && isPortableId(third)) {
      return [
        ...ref(join(path, 2), third, [model]),
        ...mbqlRefs(second, join(path, 1)),
      ];
    }
    // A legacy (MBQL 4) clause with no options.
    if (model !== undefined && isPortableId(second) && value.length === 2) {
      return ref(join(path, 1), second, [model]);
    }
    return value.flatMap((item, i) => mbqlRefs(item, join(path, i)));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, v]) => {
    const at = join(path, key);
    if ((key === "source-card" || key === "source-table") && isPortableId(v)) {
      return ref(at, v, CARD);
    }
    if (key === "snippet-id" && isPortableId(v)) {
      return ref(at, v, ["NativeQuerySnippet"]);
    }
    if ((key === "card-id" || key === "card_id") && typeof v === "string") {
      return ref(at, v, CARD);
    }
    return mbqlRefs(v, at);
  });
}

/**
 * The card each parameter takes its values from (`values_source_config.card_id`,
 * `serialization.clj` `import-parameters`).
 */
const parameterRefs = (parameters: unknown, path: string): EntityReference[] =>
  eachItem(parameters, path, (parameter, at) =>
    isRecord(parameter)
      ? keyRef(
          parameter.values_source_config,
          join(at, "values_source_config"),
          "card_id",
          CARD,
        )
      : [],
  );

/**
 * The model a link card's or a click behavior's target is, by its link model
 * (`serialization.clj` `link-card-model->toucan-model`), leaving out tables and
 * databases, which are not entity ids.
 */
const LINK_MODELS: Readonly<Record<string, readonly string[]>> = {
  card: CARD,
  dataset: CARD,
  question: CARD,
  collection: COLLECTION,
  dashboard: ["Dashboard"],
};

/**
 * The target of a click behavior that links to an entity, and the dashboard
 * tab it opens (`serialization.clj` `import-viz-click-behavior-link`).
 */
function clickBehaviorRefs(settings: unknown, path: string): EntityReference[] {
  const behavior = isRecord(settings) ? settings.click_behavior : undefined;
  if (!isRecord(behavior) || behavior.type !== "link") {
    return [];
  }
  const at = join(path, "click_behavior");
  const models =
    typeof behavior.linkType === "string"
      ? LINK_MODELS[behavior.linkType]
      : undefined;
  return [
    ...(models === undefined
      ? []
      : ref(join(at, "targetId"), behavior.targetId, models)),
    ...tabRef(join(at, "tabId"), behavior.tabId),
  ];
}

const VISUALIZER_SOURCE = /^card:([A-Za-z0-9_-]{21})$/;
const VISUALIZER_DIMENSION = /^\$_card:([A-Za-z0-9_-]{21})_name$/;

/**
 * The cards a visualizer dashcard draws on
 * (`serialization.clj` `import-visualizer-settings`).
 */
function visualizerRefs(settings: Body, path: string): EntityReference[] {
  const visualization = settings.visualization;
  const mapping = isRecord(visualization)
    ? visualization.columnValuesMapping
    : undefined;
  if (!isRecord(mapping)) {
    return [];
  }
  const at = join(join(path, "visualization"), "columnValuesMapping");
  return Object.entries(mapping).flatMap(([column, sources]) =>
    eachItem(sources, join(at, column), (source, sourceAt) => {
      if (isRecord(source) && typeof source.sourceId === "string") {
        const id = VISUALIZER_SOURCE.exec(source.sourceId)?.[1];
        return ref(join(sourceAt, "sourceId"), id, CARD);
      }
      return ref(
        sourceAt,
        typeof source === "string"
          ? VISUALIZER_DIMENSION.exec(source)?.[1]
          : undefined,
        CARD,
      );
    }),
  );
}

/**
 * The MBQL in each `column_settings` key, a JSON-encoded reference that
 * Metabase decodes and walks (`serialization.clj`
 * `visualization-settings-deps`). A key that is not JSON holds none.
 */
function columnKeyRefs(columns: Body, path: string): EntityReference[] {
  return Object.keys(columns).flatMap((key) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(key);
      // eslint-disable-next-line no-restricted-syntax -- wraps JSON.parse only, which reads no SQL
    } catch {
      return [];
    }
    return mbqlRefs(decoded, join(path, key));
  });
}

/**
 * The entity references in visualization settings, as Metabase finds their
 * dependencies and imports them (`serialization.clj`
 * `visualization-settings-deps`, `import-visualization-settings`): MBQL
 * anywhere in them and in each `column_settings` key, a link card's entity,
 * the click behaviors of the card and of each column, and the cards of a
 * visualizer dashcard. Timelines are left out: Metabase drops a missing one
 * without a message.
 */
function visualizationRefs(settings: unknown, path: string): EntityReference[] {
  if (!isRecord(settings)) {
    return [];
  }
  const link = settings.link;
  const entity = isRecord(link) ? link.entity : undefined;
  const linkModels =
    isRecord(entity) && typeof entity.model === "string"
      ? LINK_MODELS[entity.model]
      : undefined;
  const columns = settings.column_settings;
  const columnsAt = join(path, "column_settings");
  return [
    ...mbqlRefs(settings, path),
    ...(linkModels === undefined
      ? []
      : keyRef(entity, join(join(path, "link"), "entity"), "id", linkModels)),
    ...clickBehaviorRefs(settings, path),
    ...(isRecord(columns)
      ? [
          ...columnKeyRefs(columns, columnsAt),
          ...Object.entries(columns).flatMap(([key, column]) =>
            clickBehaviorRefs(column, join(columnsAt, key)),
          ),
        ]
      : []),
    ...visualizerRefs(settings, path),
  ];
}

/**
 * The models a document's serdes path may end in that are not entity ids: a
 * smart link to a database, a table or a user (`prose_mirror.clj`
 * `smart-link-model->db-model`).
 */
const NOT_ENTITY_PATH_MODELS = new Set(["Database", "Table", "User"]);

/** The content type of a ProseMirror document (`prose_mirror.clj` `prose-mirror-content-type`). */
const PROSE_MIRROR = "application/json+vnd.prose-mirror";

/** The entity a serdes path in a document names, by its last element. */
function documentPathRef(value: unknown, path: string): EntityReference[] {
  if (!isUnknownArray(value)) {
    return [];
  }
  const last = value[value.length - 1];
  if (!isRecord(last) || typeof last.model !== "string") {
    return [];
  }
  return NOT_ENTITY_PATH_MODELS.has(last.model)
    ? []
    : ref(join(join(path, value.length - 1), "id"), last.id, [last.model]);
}

/**
 * The cards a document embeds and the entities its smart links name
 * (`document.clj` `document-deps`, `entity-id->id`), in any node.
 */
function documentNodeRefs(node: unknown, path: string): EntityReference[] {
  if (!isRecord(node)) {
    return [];
  }
  const attrs = isRecord(node.attrs) ? node.attrs : {};
  const attrsAt = join(path, "attrs");
  const own =
    node.type === "cardEmbed"
      ? documentPathRef(attrs.id, join(attrsAt, "id"))
      : node.type === "smartLink"
        ? documentPathRef(attrs.entityId, join(attrsAt, "entityId"))
        : [];
  return [
    ...own,
    ...eachItem(node.content, join(path, "content"), documentNodeRefs),
  ];
}

/** A dashcard's card, action, series, parameter mappings, tab and settings. */
const dashcardRefs = (dashcard: unknown, path: string): EntityReference[] =>
  isRecord(dashcard)
    ? [
        ...keyRef(dashcard, path, "card_id", CARD),
        ...keyRef(dashcard, path, "action_id", ["Action"]),
        ...eachItem(dashcard.series, join(path, "series"), (s, at) =>
          keyRef(s, at, "card_id", CARD),
        ),
        ...eachItem(
          dashcard.parameter_mappings,
          join(path, "parameter_mappings"),
          mbqlRefs,
        ),
        ...tabRef(join(path, "dashboard_tab_id"), dashcard.dashboard_tab_id),
        ...visualizationRefs(
          dashcard.visualization_settings,
          join(path, "visualization_settings"),
        ),
      ]
    : [];

/** The collection a file is in, under `key`. */
const collectionRef =
  (key: string): RefFinder =>
  (body) =>
    keyRef(body, "", key, COLLECTION);

/** The models of an OsiAiContext's `entity_type` (`osi_ai_context.clj` `entity-type->toucan`). */
const AI_CONTEXT_MODELS: Readonly<Record<string, readonly string[]>> = {
  card: CARD,
  model: CARD,
  metric: CARD,
  question: CARD,
  measure: ["Measure"],
  segment: ["Segment"],
};

/**
 * For each model with entity references, where its files hold them, as
 * Metabase's `deserialization-dependencies` and import transforms read them.
 * Not here: a transform's collection (`transform-collection`) and a
 * transform test's transform (`dangling-transform-id`), which other rules
 * check; users, databases, tables and fields, which are not entity ids; and
 * timelines named in visualization settings, which Metabase drops without a
 * message when missing.
 */
export const ENTITY_REF_FINDERS: Readonly<Record<string, RefFinder>> = {
  // card.clj `card-deps`. Not `result_metadata`: its `field_ref`s are field,
  // expression and aggregation references, which hold no entity id.
  Card: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...keyRef(body, "", "dashboard_id", ["Dashboard"]),
    ...keyRef(body, "", "document_id", ["Document"]),
    ...mbqlRefs(body.dataset_query, "dataset_query"),
    ...parameterRefs(body.parameters, "parameters"),
    ...eachItem(body.parameter_mappings, "parameter_mappings", mbqlRefs),
    ...eachItem(body.dimension_mappings, "dimension_mappings", (m, at) =>
      isRecord(m) ? mbqlRefs(m.target, join(at, "target")) : [],
    ),
    ...visualizationRefs(body.visualization_settings, "visualization_settings"),
  ],
  // dashboard.clj `dashboard-deps`
  Dashboard: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...parameterRefs(body.parameters, "parameters"),
    ...eachItem(body.dashcards, "dashcards", dashcardRefs),
  ],
  // document.clj `serdes/deserialization-dependencies "Document"`: Metabase
  // reads the content of a ProseMirror document only (`document-deps`).
  Document: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...(body.content_type === PROSE_MIRROR
      ? documentNodeRefs(body.document, "document")
      : []),
  ],
  // collection.clj `serdes/deserialization-dependencies "Collection"`
  Collection: collectionRef("parent_id"),
  // native_query_snippet.clj `serdes/deserialization-dependencies "NativeQuerySnippet"`
  NativeQuerySnippet: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...mbqlRefs(body.template_tags, "template_tags"),
  ],
  // actions/models.clj `serdes/deserialization-dependencies "Action"`, and
  // what its `:parameters`, `:parameter_mappings` and `:visualization_settings`
  // transforms import.
  Action: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...keyRef(body, "", "model_id", CARD),
    ...eachItem(body.query, "query", (query, at) =>
      isRecord(query)
        ? mbqlRefs(query.dataset_query, join(at, "dataset_query"))
        : [],
    ),
    ...parameterRefs(body.parameters, "parameters"),
    ...eachItem(body.parameter_mappings, "parameter_mappings", mbqlRefs),
    ...visualizationRefs(body.visualization_settings, "visualization_settings"),
  ],
  // data_app.clj `serdes/deserialization-dependencies "DataApp"`
  DataApp: collectionRef("collection"),
  // timeline.clj `serdes/deserialization-dependencies "Timeline"`
  Timeline: collectionRef("collection_id"),
  // metabot.clj, metabot_prompt.clj `serdes/deserialization-dependencies`
  Metabot: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...eachItem(body.prompts, "prompts", (prompt, at) =>
      keyRef(prompt, at, "card_id", CARD),
    ),
  ],
  // segment.clj, measure.clj: `mbql-deps` of the definition
  Segment: (body) => mbqlRefs(body.definition, "definition"),
  Measure: (body) => mbqlRefs(body.definition, "definition"),
  // table.clj `serdes/deserialization-dependencies "Table"`
  Table: (body) => [
    ...keyRef(body, "", "collection_id", COLLECTION),
    ...keyRef(body, "", "transform_id", ["Transform"]),
  ],
  // table_user_settings.clj `serdes/deserialization-dependencies "TableUserSettings"`
  TableUserSettings: collectionRef("collection_id"),
  // transform.clj `serdes/deserialization-dependencies "Transform"`, less its
  // collection, which `transform-collection` checks.
  Transform: (body) => [
    ...eachItem(body.tags, "tags", (tag, at) =>
      keyRef(tag, at, "tag_id", ["TransformTag"]),
    ),
    ...mbqlRefs(body.source, "source"),
  ],
  // transform_job.clj `serdes/deserialization-dependencies "TransformJob"`
  TransformJob: (body) =>
    eachItem(body.job_tags, "job_tags", (tag, at) =>
      keyRef(tag, at, "tag_id", ["TransformTag"]),
    ),
  // osi_ai_context.clj `ingested-path`: the entity the context describes; a
  // table is not an entity id.
  OsiAiContext: (body) => {
    const models =
      typeof body.entity_type === "string"
        ? AI_CONTEXT_MODELS[body.entity_type]
        : undefined;
    return models === undefined
      ? []
      : keyRef(body, "", "entity_local_id", models);
  },
};

/** The entity references in a file of `model`. */
export function entityRefsOf(model: string, body: Body): EntityReference[] {
  return ENTITY_REF_FINDERS[model]?.(body) ?? [];
}

/**
 * The instance analytics content Metabase EE loads at startup, by entity id,
 * with its model: `vendor/instance-analytics.json`, which
 * `scripts/update-instance-analytics.ts` writes from Metabase's
 * `resources/instance_analytics` (at commit 714a9e49117).
 */
function instanceAnalyticsEntities(): [string, string][] {
  const { entities } = JSON.parse(
    readFileSync(resolve(VENDOR_DIR, "instance-analytics.json"), "utf8"),
  ) as { entities: Record<string, string> };
  return Object.entries(entities);
}

/**
 * The entities a fresh Metabase instance has, by entity id, with their
 * model: a reference to one resolves without a file, but only as that model.
 */
export const BUILT_IN_ENTITIES: ReadonlyMap<string, string> = new Map([
  // The built-in transform tags: resources/migrations/057_update_migrations.yaml:990-994
  // (changeSet v57.2025-08-22T00:13:00). Remote sync does not sync them
  // (docs/data-modeling/semantic-layer/remote-sync.md, "What doesn't sync").
  ["wYLcUPbtF7jVPO0duGGHR", "TransformTag"],
  ["dUW7nvQHQBdA0Rx0gJckI", "TransformTag"],
  ["qPGCJu7t97kn-X07_fgSj", "TransformTag"],
  ["DeeJHc81qKhD9qWINISO8", "TransformTag"],
  ...instanceAnalyticsEntities(),
]);

/** Each dashboard tab's entity id, with the dashboard files that hold it. */
function dashboardTabs(docs: readonly Doc[]): Map<string, Doc[]> {
  const tabs = new Map<string, Doc[]>();
  for (const doc of docs) {
    if (doc.model === "Dashboard" && isUnknownArray(doc.body.tabs)) {
      for (const tab of doc.body.tabs) {
        if (isRecord(tab) && typeof tab.entity_id === "string") {
          tabs.set(tab.entity_id, [...(tabs.get(tab.entity_id) ?? []), doc]);
        }
      }
    }
  }
  return tabs;
}

/**
 * Reports each entity id a file references (`entityRefsOf`) that no file of
 * an allowed model holds (`holderOf`; for a dashboard tab, a tab of the
 * dashboard the reference names, or of any dashboard when it names none): as
 * `wrong-type-entity-ref` when a file of another model holds it
 * (`otherHolderOf`), else as `dangling-entity-ref`. A remote-sync repository
 * must hold everything its content uses (`remote-sync.md`, "Library content
 * must be self-contained"), and Metabase fails the import on a reference it
 * cannot resolve. A built-in entity (`BUILT_IN_ENTITIES`) needs no file.
 */
export function reportEntityRefs(
  docs: readonly Doc[],
  byEntityId: ReadonlyMap<string, readonly Doc[]>,
  report: Report,
): void {
  const tabs = dashboardTabs(docs);
  for (const doc of docs) {
    for (const { path, entityId, allowedModels, dashboard } of entityRefsOf(
      doc.model,
      doc.body,
    )) {
      const tabHolders = tabs.get(entityId) ?? [];
      const holds = (model: string): boolean =>
        model === DASHBOARD_TAB
          ? tabHolders.some(
              (d) => dashboard === undefined || d.body.entity_id === dashboard,
            )
          : holderOf(byEntityId, entityId, model) !== null;
      const builtIn = BUILT_IN_ENTITIES.get(entityId);
      if (
        allowedModels.some(holds) ||
        (builtIn !== undefined && allowedModels.includes(builtIn))
      ) {
        continue;
      }
      const wanted = `${allowedModels.join(" or ")}${
        dashboard === undefined ? "" : ` of dashboard ${dashboard}`
      }`;
      // No file of an allowed model holds the id, so any holder is of another.
      const other = otherHolderOf(byEntityId, entityId, allowedModels[0]);
      if (other !== null) {
        report(
          "wrong-type-entity-ref",
          doc,
          `${path} ${entityId} names a ${other.model}, not a ${wanted}`,
          (byEntityId.get(entityId) ?? []).map((h) => h.file),
        );
      } else if (dashboard !== undefined && tabHolders.length > 0) {
        report(
          "dangling-entity-ref",
          doc,
          `${path} ${entityId} matches no ${wanted}; it is a tab of another dashboard`,
          tabHolders.map((d) => d.file),
        );
      } else {
        report(
          "dangling-entity-ref",
          doc,
          `${path} ${entityId} matches no ${wanted} in the folder; Metabase fails the import on a reference it cannot resolve, and a synced repository must hold everything its content uses`,
        );
      }
    }
  }
}
