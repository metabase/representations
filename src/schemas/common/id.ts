import type { JsonObject } from "../../json.js";

export const idSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ID",
  description:
    "Shared type definitions for entity identifiers and foreign keys.",
  $defs: {
    entity_id: {
      type: "string",
      description: "NanoID identifier (21 characters, alphabet A-Za-z0-9_-)",
      pattern: "^[A-Za-z0-9_-]{21}$",
    },
    collection_id: {
      description: "Collection FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    card_id: {
      description: "Card FK (entity_id) of a question, model, or metric",
      $ref: "#/$defs/entity_id",
    },
    dashboard_id: {
      description: "Dashboard FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    dashboard_tab_id: {
      type: "array",
      description: "Dashboard tab FK [dashboard entity_id, tab entity_id]",
      items: {
        $ref: "#/$defs/entity_id",
      },
      minItems: 2,
      maxItems: 2,
    },
    document_id: {
      description: "Document FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    segment_id: {
      description: "Segment FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    measure_id: {
      description: "Measure FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    snippet_id: {
      description: "Snippet FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    transform_id: {
      description: "Transform FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    transform_tag_id: {
      description: "TransformTag FK (entity_id)",
      $ref: "#/$defs/entity_id",
    },
    card_path: {
      type: "array",
      description:
        "Card FK as a serialization path: [{model: Card, id: entity_id}]",
      items: {
        type: "object",
        required: ["model", "id"],
        properties: {
          model: {
            type: "string",
            const: "Card",
          },
          id: {
            $ref: "#/$defs/entity_id",
          },
        },
      },
      minItems: 1,
      maxItems: 1,
    },
    entity_path: {
      type: "array",
      description:
        "FK as a serialization path, such as [{model: Dashboard, id: entity_id}] or [{model: Database, id: name}, {model: Schema, id: name}, {model: Table, id: name}]",
      items: {
        type: "object",
        required: ["model", "id"],
        properties: {
          model: {
            type: "string",
          },
          id: {
            type: "string",
          },
        },
      },
      minItems: 1,
    },
    user_id: {
      type: "string",
      description: "User FK (email address)",
      format: "email",
    },
    database_id: {
      type: "string",
      description: "Database FK (database name)",
    },
    table_id: {
      type: "array",
      description: "Table FK [database, schema, table]",
      prefixItems: [
        {
          type: "string",
          description: "Database name",
        },
        {
          type: ["string", "null"],
          description: "Schema name (null for schemaless databases)",
        },
        {
          type: "string",
          description: "Table name",
        },
      ],
      minItems: 3,
      maxItems: 3,
    },
    field_id: {
      type: "array",
      description:
        "Field FK [database, schema, table, field] for regular fields, or [database, schema, table, parent, child, ...] for JSON-unfolded fields.",
      prefixItems: [
        {
          type: "string",
          description: "Database name",
        },
        {
          type: ["string", "null"],
          description: "Schema name (null for schemaless databases)",
        },
        {
          type: "string",
          description: "Table name",
        },
        {
          type: "string",
          description: "Field name (or first JSON path segment)",
        },
      ],
      items: {
        type: "string",
        description: "Additional JSON path segments",
      },
      minItems: 4,
    },
  },
};
