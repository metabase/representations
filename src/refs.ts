import { isJsonArray, type JsonValue } from "./json.js";

/** The models an entity can reference, spelled as in `serdes/meta`. */
export const REF_MODELS = [
  "Database",
  "Table",
  "Field",
  "User",
  "Collection",
  "Card",
  "Dashboard",
  "DashboardTab",
  "DashboardCard",
  "Document",
  "Segment",
  "Measure",
  "NativeQuerySnippet",
  "Transform",
  "TransformTag",
  "TransformJob",
  "TransformTest",
  "Action",
  "PythonLibrary",
] as const;

/** A model an entity can reference, spelled as in `serdes/meta`, such as `Table` or `Card`. */
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

/** A portable reference: a database name, a user email, a table or field path, or an entity id. */
export type PortableRef = string | TablePath | FieldPath;

/** The distinct portable references of one or more entities, by the model they point to. */
export type PortableRefs = Partial<Record<RefModel, PortableRef[]>>;

/** The distinct instance ids one or more entities reference, by the model they point to. */
export type InstanceRefs = Partial<Record<RefModel, number[]>>;

/** The instance id of each portable reference, keyed by {@link portableKey}, by model. */
export type PortableToInstance = Partial<
  Record<RefModel, Readonly<Record<string, number>>>
>;

/** The portable reference of each instance id, by model. */
export type InstanceToPortable = Partial<
  Record<RefModel, Readonly<Record<number, PortableRef>>>
>;

export type RefEntry<Ref> = [model: RefModel, ref: Ref];

const ENTITY_ID = /^[A-Za-z0-9_-]{21}$/;

/** The key of a portable reference in {@link PortableToInstance}: the string itself, or a path as JSON. */
export function portableKey(ref: PortableRef): string {
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}

export function isPortableRef(
  model: RefModel,
  value: JsonValue,
): value is PortableRef {
  switch (model) {
    case "Table":
      return isPath(value) && value.length === 3;
    case "Field":
      return isPath(value) && value.length >= 4;
    case "Database":
    case "User":
      return typeof value === "string";
    default:
      return typeof value === "string" && ENTITY_ID.test(value);
  }
}

function isPath(value: JsonValue): value is (string | null)[] {
  return (
    isJsonArray(value) &&
    value.every(
      (part, index) =>
        typeof part === "string" || (index === 1 && part === null),
    )
  );
}

export function toPortableRefs(entries: RefEntry<PortableRef>[]): PortableRefs {
  return groupByModel(entries, portableKey);
}

export function toInstanceRefs(entries: RefEntry<number>[]): InstanceRefs {
  return groupByModel(entries, (id) => id);
}

function groupByModel<Ref>(
  entries: RefEntry<Ref>[],
  keyOf: (ref: Ref) => string | number,
): Partial<Record<RefModel, Ref[]>> {
  const groups = new Map<RefModel, Map<string | number, Ref>>();
  for (const [model, ref] of entries) {
    const group = groups.get(model) ?? new Map<string | number, Ref>();
    group.set(keyOf(ref), ref);
    groups.set(model, group);
  }
  return Object.fromEntries(
    [...groups].map(([model, group]) => [model, [...group.values()]]),
  );
}
