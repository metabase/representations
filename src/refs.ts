import { isJsonArray, type JsonValue } from "./json.js";

export const REF_MODELS = [
  "databases",
  "tables",
  "fields",
  "users",
  "collections",
  "cards",
  "dashboards",
  "dashboardTabs",
  "dashboardCards",
  "documents",
  "segments",
  "measures",
  "snippets",
  "transforms",
  "transformTags",
  "transformJobs",
  "transformTests",
  "actions",
  "pythonLibraries",
] as const;

export type RefModel = (typeof REF_MODELS)[number];

/** A table by name: `[database, schema, table]`, with a null schema for schemaless databases. */
export type TablePath = [
  database: string,
  schema: string | null,
  table: string,
];

/** A field by name: `[database, schema, table, field]`, plus the path of a JSON-unfolded field. */
export type FieldPath = [
  database: string,
  schema: string | null,
  table: string,
  field: string,
  ...path: string[],
];

type PortableRefTypes = { tables: TablePath; fields: FieldPath } & {
  [M in Exclude<RefModel, "tables" | "fields">]: string;
};

/** A portable reference: a database name, a user email, a table or field path, or an entity id. */
export type PortableRef = PortableRefTypes[RefModel];

/** The distinct portable references of an entity, by the model they point to. */
export type PortableRefs = { [M in RefModel]: PortableRefTypes[M][] };

/** The distinct instance ids an entity references, by the model they point to. */
export type InstanceRefs = { [M in RefModel]: number[] };

/** Instance ids by {@link portableKey} of their portable reference. */
export type PortableToInstance = {
  [M in RefModel]?: Readonly<Record<string, number>>;
};

/** Portable references by the instance id they resolve. */
export type InstanceToPortable = {
  [M in RefModel]?: Readonly<Record<number, PortableRefTypes[M]>>;
};

/** The key of a portable reference in {@link PortableToInstance}: the string itself, or a path as JSON. */
export function portableKey(ref: PortableRef): string {
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}

export function isPortableRef(
  model: RefModel,
  value: JsonValue,
): value is PortableRef {
  switch (model) {
    case "tables":
      return isPath(value) && value.length === 3;
    case "fields":
      return isPath(value) && value.length >= 4;
    default:
      return typeof value === "string";
  }
}

function isPath(value: JsonValue): value is (string | null)[] {
  return (
    isJsonArray(value) &&
    value.every((part, index) =>
      index === 1
        ? part === null || typeof part === "string"
        : typeof part === "string",
    )
  );
}

export type PortableRefEntry = [model: RefModel, ref: PortableRef];
export type InstanceRefEntry = [model: RefModel, id: number];

/** Merges portable references, keeping each distinct one once, in first-seen order. */
export function mergePortableRefs(...refs: PortableRefs[]): PortableRefs {
  return toPortableRefs(
    refs.flatMap((entityRefs) =>
      REF_MODELS.flatMap((model) =>
        entityRefs[model].map((ref): PortableRefEntry => [model, ref]),
      ),
    ),
  );
}

/** Merges instance references, keeping each distinct id once, in first-seen order. */
export function mergeInstanceRefs(...refs: InstanceRefs[]): InstanceRefs {
  return toInstanceRefs(
    refs.flatMap((entityRefs) =>
      REF_MODELS.flatMap((model) =>
        entityRefs[model].map((id): InstanceRefEntry => [model, id]),
      ),
    ),
  );
}

export function toPortableRefs(entries: PortableRefEntry[]): PortableRefs {
  const refsOf = (model: RefModel) => {
    const refs = entries
      .filter(([entryModel]) => entryModel === model)
      .map(([, ref]) => ref);
    return [...new Map(refs.map((ref) => [portableKey(ref), ref])).values()];
  };
  return {
    databases: refsOf("databases").filter(isString),
    tables: refsOf("tables").filter(isTablePath),
    fields: refsOf("fields").filter(isFieldPath),
    users: refsOf("users").filter(isString),
    collections: refsOf("collections").filter(isString),
    cards: refsOf("cards").filter(isString),
    dashboards: refsOf("dashboards").filter(isString),
    dashboardTabs: refsOf("dashboardTabs").filter(isString),
    dashboardCards: refsOf("dashboardCards").filter(isString),
    documents: refsOf("documents").filter(isString),
    segments: refsOf("segments").filter(isString),
    measures: refsOf("measures").filter(isString),
    snippets: refsOf("snippets").filter(isString),
    transforms: refsOf("transforms").filter(isString),
    transformTags: refsOf("transformTags").filter(isString),
    transformJobs: refsOf("transformJobs").filter(isString),
    transformTests: refsOf("transformTests").filter(isString),
    actions: refsOf("actions").filter(isString),
    pythonLibraries: refsOf("pythonLibraries").filter(isString),
  };
}

export function toInstanceRefs(entries: InstanceRefEntry[]): InstanceRefs {
  const idsOf = (model: RefModel) => [
    ...new Set(
      entries
        .filter(([entryModel]) => entryModel === model)
        .map(([, id]) => id),
    ),
  ];
  return {
    databases: idsOf("databases"),
    tables: idsOf("tables"),
    fields: idsOf("fields"),
    users: idsOf("users"),
    collections: idsOf("collections"),
    cards: idsOf("cards"),
    dashboards: idsOf("dashboards"),
    dashboardTabs: idsOf("dashboardTabs"),
    dashboardCards: idsOf("dashboardCards"),
    documents: idsOf("documents"),
    segments: idsOf("segments"),
    measures: idsOf("measures"),
    snippets: idsOf("snippets"),
    transforms: idsOf("transforms"),
    transformTags: idsOf("transformTags"),
    transformJobs: idsOf("transformJobs"),
    transformTests: idsOf("transformTests"),
    actions: idsOf("actions"),
    pythonLibraries: idsOf("pythonLibraries"),
  };
}

function isString(ref: PortableRef): ref is string {
  return typeof ref === "string";
}

function isTablePath(ref: PortableRef): ref is TablePath {
  return typeof ref !== "string" && ref.length === 3;
}

function isFieldPath(ref: PortableRef): ref is FieldPath {
  return typeof ref !== "string" && ref.length >= 4;
}
