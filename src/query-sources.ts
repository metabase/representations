import type { ValidateFunction } from "ajv/dist/2020.js";
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
import { isRecord, stringOrNull } from "./values.js";

export type NativeSql = {
  sql: string;
  database: string | null;
  /** The template tags with a value when Metabase compiles the query (`valuedTagNames`). */
  valuedTags: ReadonlySet<string>;
  /** The entity id of each snippet the template tags name, by snippet name (`snippetIdsOf`). */
  snippetIds: ReadonlyMap<string, string>;
};

/** The data sources a document names, found where its schema types them. */
export type DataSources = {
  tables: TableKey[];
  /** The column of each field id inside a query. */
  fields: ColumnKey[];
  /** Entity ids of cards, metrics, measures, segments and snippets a query uses. */
  entities: string[];
  natives: NativeSql[];
};

type Node = { file: string; pointer: string };

type Context = { inQuery: boolean; database: string | null };

const TABLE_ID = "common/id.yaml#/$defs/table_id";
const FIELD_ID = "common/id.yaml#/$defs/field_id";
const ENTITY_ID = "common/id.yaml#/$defs/entity_id";
const QUERY = "common/query.yaml#";
const NATIVE_STAGE = "common/query.yaml#/$defs/native_stage";
const ENTITY_REFS = new Set([
  "common/ref.yaml#/$defs/metric_ref",
  "common/ref.yaml#/$defs/measure_ref",
  "common/ref.yaml#/$defs/segment_ref",
]);

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

const unescapePointer = (part: string) =>
  part.replace(/~1/g, "/").replace(/~0/g, "~");

const keyOf = (node: Node) => `${node.file}#${node.pointer}`;

/**
 * Returns a function that finds the data sources in a representation
 * document. It walks the document alongside its entity schema and collects
 * each value the schema types as a table id (`common/id.yaml#/$defs/table_id`);
 * inside a query it also collects each field id, with its table, each entity id
 * (a source card, a template tag's card or snippet), each metric, measure and
 * segment reference, and the SQL of each native stage. Where a value may
 * match several branches (`anyOf`, `oneOf`, `if`), the walk follows the
 * branches the value validates against.
 */
export function createSourceFinder({ ajv, files, models }: Schemas) {
  const validators = new Map<string, ValidateFunction>();
  const validates = (node: Node, value: unknown): boolean => {
    const key = node.pointer === "" ? node.file : keyOf(node);
    let validate = validators.get(key);
    if (validate === undefined) {
      validate = ajv.getSchema(key);
      if (validate === undefined) {
        throw new Error(`No schema at ${key}`);
      }
      validators.set(key, validate);
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

  return function findSources(doc: unknown, model: string): DataSources {
    const sources: DataSources = {
      tables: [],
      fields: [],
      entities: [],
      natives: [],
    };
    const file = models.get(model);
    if (file === undefined) {
      return sources;
    }

    const collect = (key: string, value: unknown, context: Context) => {
      const table =
        key === TABLE_ID || (context.inQuery && key === FIELD_ID)
          ? tableOfRef(value)
          : null;
      if (table !== null) {
        sources.tables.push(table);
      }
      const field =
        context.inQuery && key === FIELD_ID ? columnOfRef(value) : null;
      if (field !== null) {
        sources.fields.push(field);
      }
      if (!context.inQuery) {
        return;
      }
      if (key === ENTITY_ID && typeof value === "string") {
        sources.entities.push(value);
      } else if (
        ENTITY_REFS.has(key) &&
        Array.isArray(value) &&
        typeof value[2] === "string"
      ) {
        sources.entities.push(value[2]);
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
        collect(key, value, context);
        const inner =
          key === QUERY
            ? {
                inQuery: true,
                database: isRecord(value) ? stringOrNull(value.database) : null,
              }
            : context;
        walk(value, target, inner);
      }
      if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach((_, i) => walk(value, at("allOf", i), context));
      }
      for (const keyword of ["anyOf", "oneOf"]) {
        const branches = schema[keyword];
        if (Array.isArray(branches)) {
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
          if (key in properties) {
            walk(value[key], at("properties", key), context);
          } else if (isRecord(schema.additionalProperties)) {
            walk(value[key], at("additionalProperties"), context);
          }
        }
      }

      if (Array.isArray(value)) {
        const prefix = Array.isArray(schema.prefixItems)
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

    walk(doc, { file, pointer: "" }, { inQuery: false, database: null });
    return {
      tables: uniqueTables(sources.tables),
      fields: sources.fields,
      entities: [...new Set(sources.entities)],
      natives: sources.natives,
    };
  };
}
