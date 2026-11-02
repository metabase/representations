import { posix } from "path";

import type { Schemas } from "./schemas.js";
import { snippetIdsOf } from "./snippets.js";
import { valuedTagNames } from "./sql-tables.js";
import {
  type ColumnKey,
  columnOfRef,
  type TableKey,
  tableOfRef,
  uniqueTables,
} from "./tables.js";
import {
  isRecord,
  isUnknownArray,
  stringOrNull,
  templateTagsOf,
  uniqueBy,
  unescapePointer,
} from "./values.js";

export type NativeSql = {
  sql: string;
  database: string | null;
  /** The template tags with a value when Metabase compiles the query (`valuedTagNames`). */
  valuedTags: ReadonlySet<string>;
  /** The entity id of each snippet the template tags name, by snippet name (`snippetIdsOf`). */
  snippetIds: ReadonlyMap<string, string>;
  /** The table of each `table` template tag, by tag name. */
  tableTags: ReadonlyMap<string, TableKey>;
  /** The entity id of the card each `card` template tag names, by tag name. */
  cardTags: ReadonlyMap<string, string>;
  /**
   * Whether the stage has a template tag. Metabase substitutes parameters only
   * in such a stage, and runs the SQL of any other as written.
   */
  hasTemplateTags: boolean;
};

/** The table a template tag names: the table of a tag's field, or a `table` tag's table. */
export type TagTable = { tag: string; type: string; table: TableKey };

/** An entity a query uses: its entity id and the model Metabase resolves it in. */
type EntityRef = { id: string; model: string };

/** The data sources a document names, found where its schema types them. */
export type DataSources = {
  /**
   * The tables the document names outside template tags. A native query's
   * template tags read no table of their own: Metabase reads a `table` tag's
   * table only where the SQL keeps the tag (`NativeSql.tableTags`), and writes
   * a field tag's field as a column.
   */
  tables: TableKey[];
  /** The table each template tag names, in document order. */
  tagTables: TagTable[];
  /**
   * The column of each field id inside a query, but that of a `dimension` tag
   * with no default.
   */
  fields: ColumnKey[];
  /**
   * The cards, metrics, measures, segments and snippets a query uses, each
   * once; a card that a `card` template tag names only where the SQL keeps
   * the tag (`NativeSql.cardTags`).
   */
  entities: EntityRef[];
  natives: NativeSql[];
};

/** The data sources in a document of `model`. */
export type SourceFinder = (doc: unknown, model: string) => DataSources;

type Node = { file: string; pointer: string };

type Context = {
  inQuery: boolean;
  /** The template tag the walk is inside, if any. */
  tag: { name: string; type: string } | null;
  /** Inside a `dimension` template tag with no default. */
  inUnvaluedFilter: boolean;
  database: string | null;
};

const TABLE_ID = "common/id.yaml#/$defs/table_id";
const FIELD_ID = "common/id.yaml#/$defs/field_id";
const ENTITY_ID = "common/id.yaml#/$defs/entity_id";
const QUERY = "common/query.yaml#";
const NATIVE_STAGE = "common/query.yaml#/$defs/native_stage";
const TEMPLATE_TAG = "common/query.yaml#/$defs/template_tag";
/**
 * The model of the entity each reference clause names, as Metabase imports
 * it (`serialization.clj` `import-mbql-update-refs`): a metric is a Card.
 */
const ENTITY_REFS = new Map([
  ["common/ref.yaml#/$defs/metric_ref", "Card"],
  ["common/ref.yaml#/$defs/measure_ref", "Measure"],
  ["common/ref.yaml#/$defs/segment_ref", "Segment"],
]);

/**
 * The model of the entity each query key that holds an entity id names, as
 * Metabase imports it (`serialization.clj` `import-mbql-map`).
 */
const ENTITY_KEYS = new Map([
  ["source-card", "Card"],
  ["card-id", "Card"],
  ["snippet-id", "NativeQuerySnippet"],
]);

/**
 * Whether `tag` is a `dimension` template tag with no default. Metabase writes
 * such a tag as `1 = 1`. It splices the field of a `dimension` tag with a
 * default, and always that of a `temporal-unit` tag (`values.clj`
 * `field-filter-value`, `substitution.clj`).
 */
const isUnvaluedFilter = (tag: unknown) =>
  isRecord(tag) &&
  tag.type === "dimension" &&
  (tag.default === undefined || tag.default === null);

/** The table of each `table` template tag in `templateTags`, by tag name. */
function tableTagsOf(templateTags: unknown): Map<string, TableKey> {
  const tables = new Map<string, TableKey>();
  for (const tag of templateTagsOf(templateTags)) {
    const table = tag.type === "table" ? tableOfRef(tag["table-id"]) : null;
    if (typeof tag.name === "string" && table !== null) {
      tables.set(tag.name, table);
    }
  }
  return tables;
}

/** The card each `card` template tag in `templateTags` names, by tag name. */
function cardTagsOf(templateTags: unknown): Map<string, string> {
  const cards = new Map<string, string>();
  for (const tag of templateTagsOf(templateTags)) {
    if (
      tag.type === "card" &&
      typeof tag.name === "string" &&
      typeof tag["card-id"] === "string"
    ) {
      cards.set(tag.name, tag["card-id"]);
    }
  }
  return cards;
}

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

const keyOf = (node: Node) => `${node.file}#${node.pointer}`;

/**
 * Returns a function that finds the data sources in a representation
 * document. It walks the document alongside its entity schema and collects
 * each value the schema types as a table id (`common/id.yaml#/$defs/table_id`);
 * inside a query it also collects each field id, with its table (a template
 * tag's table apart, and not the field of a `dimension` tag with no default), each entity id
 * (a source card, a template tag's snippet; a card tag's card goes to
 * `NativeSql.cardTags`), each metric, measure and
 * segment reference, and the SQL of each native stage. Where a value may
 * match several branches (`anyOf`, `oneOf`, `if`), the walk follows the
 * branches the value validates against. The walk runs once per document
 * object and model: a later call returns the same `DataSources`, which the
 * caller must not change.
 */
export function createSourceFinder({
  ajv,
  files,
  models,
}: Schemas): SourceFinder {
  // Ajv compiles each key's validator once and keeps it.
  const validates = (node: Node, value: unknown): boolean => {
    const key = node.pointer === "" ? node.file : keyOf(node);
    const validate = ajv.getSchema(key);
    if (validate === undefined) {
      throw new Error(`No schema at ${key}`);
    }
    return validate(value) === true;
  };

  const schemaAt = (node: Node): unknown => {
    let current: unknown = files.get(node.file);
    for (const part of node.pointer.split("/").slice(1)) {
      if (typeof current !== "object" || current === null) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[unescapePointer(part)]; // Checked to be an object above.
    }
    return current;
  };

  const resolveRef = (ref: string, from: string): Node => {
    const [path, fragment = ""] = ref.split("#");
    const file =
      path === ""
        ? from
        : posix.normalize(posix.join(posix.dirname(from), path));
    return { file, pointer: fragment };
  };

  const walk = (doc: unknown, model: string): DataSources => {
    const sources: DataSources = {
      tables: [],
      tagTables: [],
      fields: [],
      entities: [],
      natives: [],
    };
    const file = models.get(model);
    if (file === undefined) {
      return sources;
    }

    const collect = (
      key: string,
      value: unknown,
      context: Context,
      node: Node,
    ) => {
      const table =
        key === TABLE_ID || (context.inQuery && key === FIELD_ID)
          ? tableOfRef(value)
          : null;
      if (table !== null) {
        if (context.tag === null) {
          sources.tables.push(table);
        } else {
          sources.tagTables.push({
            tag: context.tag.name,
            type: context.tag.type,
            table,
          });
        }
      }
      const field =
        context.inQuery && !context.inUnvaluedFilter && key === FIELD_ID
          ? columnOfRef(value)
          : null;
      if (field !== null) {
        sources.fields.push(field);
      }
      if (!context.inQuery) {
        return;
      }
      const refModel = ENTITY_REFS.get(key);
      const keyModel = ENTITY_KEYS.get(
        unescapePointer(node.pointer.slice(node.pointer.lastIndexOf("/") + 1)),
      );
      if (
        key === ENTITY_ID &&
        typeof value === "string" &&
        keyModel !== undefined
      ) {
        // A card tag's card is read where the SQL keeps the tag.
        if (keyModel === "Card" && context.tag?.type === "card") {
          return;
        }
        sources.entities.push({ id: value, model: keyModel });
      } else if (
        refModel !== undefined &&
        isUnknownArray(value) &&
        typeof value[2] === "string"
      ) {
        sources.entities.push({ id: value[2], model: refModel });
      } else if (
        key === NATIVE_STAGE &&
        isRecord(value) &&
        typeof value.native === "string"
      ) {
        sources.natives.push({
          sql: value.native,
          database: context.database,
          valuedTags: valuedTagNames(value["template-tags"]),
          snippetIds: snippetIdsOf(value["template-tags"]),
          tableTags: tableTagsOf(value["template-tags"]),
          cardTags: cardTagsOf(value["template-tags"]),
          hasTemplateTags: templateTagsOf(value["template-tags"]).length > 0,
        });
      }
    };

    const walk = (value: unknown, node: Node, context: Context): void => {
      const schema = schemaAt(node);
      if (!isRecord(schema)) {
        return;
      }
      const at = (...parts: (string | number)[]): Node => ({
        file: node.file,
        pointer: [
          node.pointer,
          ...parts.map((p) => escapePointer(String(p))),
        ].join("/"),
      });

      if (typeof schema.$ref === "string") {
        const target = resolveRef(schema.$ref, node.file);
        const key = keyOf(target);
        collect(key, value, context, node);
        const inner =
          key === QUERY
            ? {
                inQuery: true,
                tag: null,
                inUnvaluedFilter: false,
                database: isRecord(value) ? stringOrNull(value.database) : null,
              }
            : key === TEMPLATE_TAG &&
                isRecord(value) &&
                typeof value.name === "string" &&
                typeof value.type === "string"
              ? {
                  ...context,
                  tag: { name: value.name, type: value.type },
                  inUnvaluedFilter: isUnvaluedFilter(value),
                }
              : context;
        walk(value, target, inner);
      }
      if (isUnknownArray(schema.allOf)) {
        schema.allOf.forEach((_, i) => walk(value, at("allOf", i), context));
      }
      for (const keyword of ["anyOf", "oneOf"]) {
        const branches = schema[keyword];
        if (isUnknownArray(branches)) {
          branches.forEach((_, i) => {
            if (validates(at(keyword, i), value)) {
              walk(value, at(keyword, i), context);
            }
          });
        }
      }
      if (schema.if !== undefined) {
        const branch = validates(at("if"), value) ? "then" : "else";
        if (schema[branch] !== undefined) {
          walk(value, at(branch), context);
        }
      }

      if (isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        for (const key of Object.keys(value)) {
          if (Object.hasOwn(properties, key)) {
            walk(value[key], at("properties", key), context);
          } else if (isRecord(schema.additionalProperties)) {
            walk(value[key], at("additionalProperties"), context);
          }
        }
      }

      if (isUnknownArray(value)) {
        const prefix = isUnknownArray(schema.prefixItems)
          ? schema.prefixItems.length
          : 0;
        value.forEach((item, i) => {
          if (i < prefix) {
            walk(item, at("prefixItems", i), context);
          } else if (isRecord(schema.items)) {
            walk(item, at("items"), context);
          }
        });
      }
    };

    walk(
      doc,
      { file, pointer: "" },
      {
        inQuery: false,
        tag: null,
        inUnvaluedFilter: false,
        database: null,
      },
    );
    return {
      tables: uniqueTables(sources.tables),
      tagTables: sources.tagTables,
      fields: sources.fields,
      entities: uniqueBy(sources.entities, (e) => `${e.model} ${e.id}`),
      natives: sources.natives,
    };
  };

  const memo = new WeakMap<object, Map<string, DataSources>>();
  return (doc, model) => {
    if (typeof doc !== "object" || doc === null) {
      return walk(doc, model);
    }
    const byModel = memo.get(doc) ?? new Map<string, DataSources>();
    memo.set(doc, byModel);
    const known = byModel.get(model);
    if (known !== undefined) {
      return known;
    }
    const sources = walk(doc, model);
    byModel.set(model, sources);
    return sources;
  };
}
