import type { JsonObject } from "../json.js";

export const transformSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Transform",
  description:
    "Generates a table in the database by running a query or Python script. Transforms allow materializing results as persistent database tables.",
  type: "object",
  required: [
    "name",
    "entity_id",
    "creator_id",
    "source_database_id",
    "source",
    "target",
    "serdes/meta",
  ],
  properties: {
    name: {
      type: "string",
      description: "Transform name",
    },
    entity_id: {
      $ref: "common/id.json#/$defs/entity_id",
    },
    source_database_id: {
      $ref: "common/id.json#/$defs/database_id",
    },
    source: {
      description:
        "Source definition — either a query (type: query) or a Python script (type: python).",
      type: "object",
      allOf: [
        {
          if: {
            properties: {
              type: {
                const: "query",
              },
            },
          },
          then: {
            $ref: "#/$defs/query_source",
          },
        },
        {
          if: {
            properties: {
              type: {
                const: "python",
              },
            },
          },
          then: {
            $ref: "#/$defs/python_source",
          },
        },
      ],
    },
    target: {
      type: "object",
      description: "Where the resulting table is written",
      required: ["type", "name"],
      properties: {
        database: {
          $ref: "common/id.json#/$defs/database_id",
        },
        type: {
          type: "string",
          enum: ["table", "table-incremental"],
        },
        schema: {
          type: ["string", "null"],
          description: "Target schema name",
        },
        name: {
          type: "string",
          description: "Target table name",
        },
        "target-incremental-strategy": {
          type: "object",
          description:
            "How an incremental run writes its rows: append them, or merge them on a unique key",
          properties: {
            type: {
              type: "string",
              enum: ["append", "merge"],
            },
            "unique-key": {
              type: "array",
              description: "The columns a merge matches rows on",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Column name",
                  },
                  "field-id": {
                    description:
                      "Field FK of the column, null until the target table exists",
                    type: ["array", "null"],
                    if: {
                      type: "array",
                    },
                    then: {
                      $ref: "common/id.json#/$defs/field_id",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    creator_id: {
      $ref: "common/id.json#/$defs/user_id",
    },
    owner_user_id: {
      description: "User FK (email) of the transform's owner",
      type: ["string", "null"],
      if: {
        type: "string",
      },
      then: {
        $ref: "common/id.json#/$defs/user_id",
      },
    },
    description: {
      type: ["string", "null"],
      description: "Human-readable description",
    },
    collection_id: {
      description: "Collection FK, null for root collection",
      type: ["string", "null"],
      if: {
        type: "string",
      },
      then: {
        $ref: "common/id.json#/$defs/collection_id",
      },
    },
    tags: {
      type: "array",
      description: "Transform tag associations",
      items: {
        type: "object",
        properties: {
          entity_id: {
            description: "NanoID of this tag association",
            $ref: "common/id.json#/$defs/entity_id",
          },
          tag_id: {
            description: "TransformTag FK",
            $ref: "common/id.json#/$defs/transform_tag_id",
          },
          position: {
            type: "integer",
            description: "Ordering position",
          },
          "serdes/meta": {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                model: {
                  type: "string",
                  const: "TransformTransformTag",
                },
              },
            },
          },
        },
      },
    },
    created_at: {
      type: "string",
      description: "ISO 8601 timestamp",
      format: "date-time",
    },
    "serdes/meta": {
      type: "array",
      description: "Identity path for serialization",
      items: {
        type: "object",
        required: ["model"],
        properties: {
          id: {
            type: "string",
            description: "Entity identifier (matches entity_id)",
          },
          label: {
            type: "string",
            description: "Slugified name",
          },
          model: {
            type: "string",
            const: "Transform",
          },
        },
      },
    },
  },
  $defs: {
    incremental_strategy: {
      type: "object",
      description: "Incremental execution strategy",
      properties: {
        "checkpoint-filter-field-id": {
          description:
            "Field FK of the column that marks rows already processed",
          $ref: "common/id.json#/$defs/field_id",
        },
      },
    },
    query_source: {
      type: "object",
      description: "Query-based source (MBQL or native)",
      required: ["type", "query"],
      properties: {
        type: {
          type: "string",
          const: "query",
        },
        query: {
          description: "Query in pMBQL format",
          $ref: "common/query.json",
        },
        "source-incremental-strategy": {
          $ref: "#/$defs/incremental_strategy",
        },
      },
    },
    python_source: {
      type: "object",
      description:
        "Python script source. The script receives source tables as pandas DataFrames and must return a DataFrame as the result.",
      required: ["type", "body", "source-tables"],
      properties: {
        type: {
          type: "string",
          const: "python",
        },
        body: {
          type: "string",
          description: "Python source code",
        },
        "source-tables": {
          type: "array",
          description: "Source tables available to the script as DataFrames",
          items: {
            type: "object",
            required: ["alias", "database_id"],
            properties: {
              alias: {
                type: "string",
                description: "Variable name for the table in Python",
              },
              database_id: {
                $ref: "common/id.json#/$defs/database_id",
              },
              schema: {
                type: ["string", "null"],
                description: "Schema name",
              },
              table: {
                type: "string",
                description: "Table name",
              },
              table_id: {
                $ref: "common/id.json#/$defs/table_id",
              },
            },
          },
        },
        "source-database": {
          $ref: "common/id.json#/$defs/database_id",
        },
        "source-incremental-strategy": {
          $ref: "#/$defs/incremental_strategy",
        },
      },
    },
  },
};
