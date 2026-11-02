import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import yaml from "js-yaml";
import { dirname, join, resolve } from "path";

import type { LintRule } from "../findings.js";
import { CONFIG_FILE } from "../settings.js";
import { isRecord } from "../values.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples", "v1");

const PRODUCT_REVENUE_REPORT = "collections/transforms/native_transform.yaml";
const TOP_CATEGORIES = "collections/transforms/top_categories.yaml";
const CATEGORY_TOTALS_TEST =
  "collections/transforms/native_transform/product_revenue_report__category_totals.yaml";
const TOP_CATEGORIES_TEST =
  "collections/transforms/top_categories/top_categories__three_highest.yaml";
const MONTHLY_ORDER_SUMMARY = "collections/transforms/mbql_transform.yaml";
const MONTHLY_ORDER_SUMMARY_TEST =
  "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml";
const DAILY_ORDER_SUMMARY_TEST =
  "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
const PYTHON_TEST =
  "collections/transforms/daily_order_summary/python_hello_world__greetings.yaml";
const PYTHON_HELLO_WORLD = "collections/transforms/python_hello_world.yaml";
const DAILY_ORDER_SUMMARY = "collections/transforms/daily_order_summary.yaml";
const MONTHLY_SALES_SUMMARY =
  "collections/transforms/monthly_sales_summary.yaml";
const PYTHON_HELLO_WORLD_ENTITY_ID = "g2cRYwopfoL1BW9Y4n3wb";
const DAILY_TAG_ENTITY_ID = "dUW7nvQHQBdA0Rx0gJckI";
const ORDERS_MODEL = "collections/main/queries/orders_model.yaml";
const NULL_SCHEMA_CARD = "collections/main/queries/null_schema_products.yaml";
const ORDERS_MODEL_ENTITY_ID = "4eroqa4ZYl4WkNjP8XTvu";
const QUERIES_COLLECTION_ENTITY_ID = "cOlQuErIeS0ExAmPlE2x1";
const POSTGRES_DB = "Sample Postgres";
const POSTGRES_PRODUCTS = [POSTGRES_DB, "public", "products"] as const;
const WIDGETS_SEGMENT_ENTITY_ID = "WarehouseWidgets00001";
const PRODUCT_COUNT_MEASURE_ENTITY_ID = "WarehouseProducts0001";

/** A finding the lint reports: its rule, its file, and its related files, none when not given. */
export type ExpectedFinding = {
  rule: LintRule;
  file: string;
  related?: string[];
};

export type Mutation = {
  name: string;
  description: string;
  /** The findings the lint reports on the mutated tree, each once; the clean tree reports none. */
  findings: ExpectedFinding[];
  apply: (folder: string) => void;
};

/** The value at `path` in `value`, each step a map's key or a list's index; throws where a step finds nothing. */
function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const step of path) {
    const next: unknown =
      typeof step === "number"
        ? Array.isArray(current)
          ? current[step]
          : undefined
        : isRecord(current)
          ? current[step]
          : undefined;
    if (next === undefined) {
      throw new Error(`nothing at ${JSON.stringify(path)}`);
    }
    current = next;
  }
  return current;
}

/** The map at `path` in `value` (`valueAt`); throws when it is not a map. */
export function mapAt(
  value: unknown,
  ...path: (string | number)[]
): Record<string, unknown> {
  const found = valueAt(value, path);
  if (!isRecord(found)) {
    throw new Error(`no map at ${JSON.stringify(path)}`);
  }
  return found;
}

/** The list at `path` in `value` (`valueAt`); throws when it is not a list. */
export function listAt(
  value: unknown,
  ...path: (string | number)[]
): unknown[] {
  const found = valueAt(value, path);
  if (!Array.isArray(found)) {
    throw new Error(`no list at ${JSON.stringify(path)}`);
  }
  return found;
}

/** The text at `path` in `value` (`valueAt`); throws when it is not text. */
export function textAt(value: unknown, ...path: (string | number)[]): string {
  const found = valueAt(value, path);
  if (typeof found !== "string") {
    throw new Error(`no text at ${JSON.stringify(path)}`);
  }
  return found;
}

/** Reads the YAML map in `file`, passes it to `change`, and writes it back. */
export function edit(
  folder: string,
  file: string,
  change: (doc: Record<string, unknown>) => void,
): void {
  const path = join(folder, file);
  const doc = mapAt(yaml.load(readFileSync(path, "utf8")));
  change(doc);
  writeFileSync(path, yaml.dump(doc, { lineWidth: -1 }));
}

/** The template tag that pastes the snippet `name`, by its entity id `id`. */
export function snippetTag(name: string, id: string): Record<string, string> {
  return {
    type: "snippet",
    name: `snippet: ${name}`,
    id: "5e1ec7ed-0000-4000-8000-000000000000",
    "snippet-name": name,
    "snippet-id": id,
  };
}

/** Writes `doc` as YAML to `file`, creating its folder. */
export function write(
  folder: string,
  file: string,
  doc: Readonly<Record<string, unknown>>,
): void {
  const path = join(folder, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(doc, { lineWidth: -1 }));
}

/** The settings of `examples/v1`, as `CONFIG_FILE` gives them. */
type Settings = {
  defaultSchemas: Record<string, string | null>;
  engines: Record<string, string>;
};

/**
 * Writes `CONFIG_FILE` to `folder`: the settings of `examples/v1`, with each
 * entry of `change` over the example's entry for its database.
 */
export function writeSettings(
  folder: string,
  change: Partial<Settings> = {},
): void {
  const settings = JSON.parse(
    readFileSync(join(EXAMPLES, CONFIG_FILE), "utf8"),
  ) as Settings; // The example's settings file is valid.
  writeFileSync(
    join(folder, CONFIG_FILE),
    JSON.stringify({
      defaultSchemas: { ...settings.defaultSchemas, ...change.defaultSchemas },
      engines: { ...settings.engines, ...change.engines },
    }),
  );
}

/**
 * Writes a segment or a measure on the warehouse's products table, whose
 * definition adds `clause`, a filter or an aggregation, to a query of the table.
 */
function writeProductsDefinition(
  folder: string,
  model: "Segment" | "Measure",
  name: string,
  entityId: string,
  clause: Readonly<Record<string, unknown>>,
): void {
  const slug = name.toLowerCase().replaceAll(" ", "_");
  write(
    folder,
    `databases/sample_postgres/tables/products/${model.toLowerCase()}s/${slug}.yaml`,
    {
      name,
      entity_id: entityId,
      creator_id: "admin@example.com",
      table_id: POSTGRES_PRODUCTS,
      definition: {
        "lib/type": "mbql/query",
        database: POSTGRES_DB,
        stages: [
          {
            "lib/type": "mbql.stage/mbql",
            "source-table": POSTGRES_PRODUCTS,
            ...clause,
          },
        ],
      },
      "serdes/meta": [{ model }],
    },
  );
}

/** Moves the transform in `file`, its query and its target to `database`. */
function moveTransform(folder: string, file: string, database: string): void {
  edit(folder, file, (doc) => {
    doc.source_database_id = database;
    const source = mapAt(doc, "source");
    if (source.query !== undefined) {
      mapAt(source, "query").database = database;
    }
    mapAt(doc, "target").database = database;
  });
}

function editNativeSql(
  folder: string,
  file: string,
  change: (sql: string) => string,
): void {
  edit(folder, file, (doc) => {
    const stage = mapAt(doc, "source", "query", "stages", 0);
    stage.native = change(textAt(stage, "native"));
  });
}

/** Appends an input for `table` to the test in `file`, filled by `sql`. */
function addSqlInput(
  folder: string,
  file: string,
  table: { schema?: string; name: string },
  sql: string,
): void {
  edit(folder, file, (doc) => {
    listAt(doc, "inputs").push({ table, format: "sql", sql });
  });
}

/**
 * The rules of the mutations that break a transform test's inputs or SQL in
 * a way Metabase refuses when the test is created, each on a different test.
 */
const REFUSED_TEST_RULES = [
  "missing-input",
  "unused-input",
  "duplicate-input",
  "unparseable-test-sql",
] as const satisfies readonly LintRule[];

/** Known-broken edits to the `examples/v1` tree, each named for what it breaks. */
export const MUTATIONS: Mutation[] = [
  {
    name: "implicit-join",
    description:
      "An MBQL transform breaks out by a product field through orders.product_id; its test gives orders that column, and has no products input.",
    findings: [
      {
        rule: "missing-input",
        file: MONTHLY_ORDER_SUMMARY_TEST,
        related: [MONTHLY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) => {
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        listAt(doc, "source", "query", "stages", 0, "breakout").push([
          "field",
          { "source-field": [POSTGRES_DB, "public", "orders", "product_id"] },
          [POSTGRES_DB, "public", "products", "category"],
        ]);
      });
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        listAt(doc, "inputs", 0, "columns").push({
          name: "product_id",
          cast_type: "INTEGER",
        });
        for (const row of listAt(doc, "inputs", 0, "rows")) {
          mapAt(row).product_id = 1;
        }
      });
    },
  },
  {
    name: "segment-filter",
    description:
      "An MBQL transform filters by a segment on products; its test has no products input.",
    findings: [
      {
        rule: "missing-input",
        file: MONTHLY_ORDER_SUMMARY_TEST,
        related: [MONTHLY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) => {
      writeProductsDefinition(
        folder,
        "Segment",
        "Widgets",
        WIDGETS_SEGMENT_ENTITY_ID,
        {
          filters: [
            [
              "=",
              {},
              ["field", {}, [...POSTGRES_PRODUCTS, "category"]],
              "Widget",
            ],
          ],
        },
      );
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        mapAt(doc, "source", "query", "stages", 0).filters = [
          ["segment", {}, WIDGETS_SEGMENT_ENTITY_ID],
        ];
      });
    },
  },
  {
    name: "measure-aggregation",
    description:
      "An MBQL transform aggregates a measure on products; its test has no products input.",
    findings: [
      {
        rule: "missing-input",
        file: MONTHLY_ORDER_SUMMARY_TEST,
        related: [MONTHLY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) => {
      writeProductsDefinition(
        folder,
        "Measure",
        "Product Count",
        PRODUCT_COUNT_MEASURE_ENTITY_ID,
        {
          aggregation: [
            ["distinct", {}, ["field", {}, [...POSTGRES_PRODUCTS, "id"]]],
          ],
        },
      );
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        listAt(doc, "source", "query", "stages", 0, "aggregation").push([
          "measure",
          {},
          PRODUCT_COUNT_MEASURE_ENTITY_ID,
        ]);
      });
    },
  },
  {
    name: "absent-source",
    description:
      "An MBQL transform filters by a segment that is not in the folder, so its reads are unknown.",
    findings: [{ rule: "reads-not-checked", file: MONTHLY_ORDER_SUMMARY }],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        mapAt(doc, "source", "query", "stages", 0).filters = [
          ["segment", {}, "MissingSegment0000001"],
        ];
      }),
  },
  {
    name: "self-source-card",
    description:
      "An MBQL transform reads a card that uses itself as its source, so its reads are unknown.",
    findings: [{ rule: "reads-not-checked", file: MONTHLY_ORDER_SUMMARY }],
    apply: (folder) => {
      edit(folder, ORDERS_MODEL, (doc) => {
        const stage = mapAt(doc, "dataset_query", "stages", 0);
        delete stage["source-table"];
        stage["source-card"] = ORDERS_MODEL_ENTITY_ID;
      });
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        const stage = mapAt(doc, "source", "query", "stages", 0);
        delete stage["source-table"];
        stage["source-card"] = ORDERS_MODEL_ENTITY_ID;
      });
    },
  },
  {
    name: "unqualified-input",
    description:
      "A test's input drops the schema of a table its transform reads with one; Metabase never matches the two.",
    findings: [
      {
        rule: "missing-input",
        file: TOP_CATEGORIES_TEST,
        related: [TOP_CATEGORIES],
      },
      {
        rule: "unused-input",
        file: TOP_CATEGORIES_TEST,
        related: [TOP_CATEGORIES],
      },
    ],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        delete mapAt(doc, "inputs", 0, "table").schema;
      }),
  },
  {
    name: "qualified-input",
    description:
      "A test's input names a schema other than the default for a table its transform reads unqualified; Metabase never matches the two.",
    findings: [
      {
        rule: "missing-input",
        file: DAILY_ORDER_SUMMARY_TEST,
        related: [DAILY_ORDER_SUMMARY],
      },
      {
        rule: "unused-input",
        file: DAILY_ORDER_SUMMARY_TEST,
        related: [DAILY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) =>
      edit(folder, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "inputs", 0, "table").schema = "OTHER";
      }),
  },
  {
    name: "python-transform-test",
    description:
      "A test is written for a Python transform, which Metabase cannot test.",
    findings: [
      {
        rule: "untestable-transform",
        file: PYTHON_TEST,
        related: [PYTHON_HELLO_WORLD],
      },
    ],
    apply: (folder) => {
      cpSync(join(folder, DAILY_ORDER_SUMMARY_TEST), join(folder, PYTHON_TEST));
      edit(folder, PYTHON_TEST, (doc) => {
        doc.entity_id = "PythonTransformTest01";
        doc.name = "Python Hello World: greetings";
        doc.transform_id = PYTHON_HELLO_WORLD_ENTITY_ID;
      });
    },
  },
  {
    name: "duplicate-input",
    description: "A test declares two inputs for the same table.",
    findings: [{ rule: "duplicate-input", file: DAILY_ORDER_SUMMARY_TEST }],
    apply: (folder) =>
      addSqlInput(
        folder,
        DAILY_ORDER_SUMMARY_TEST,
        { name: "ORDERS" },
        "SELECT 1 AS id",
      ),
  },
  {
    name: "expectation-reads-other-table",
    description:
      "An expectation's SQL reads a table that is neither the output nor an input.",
    findings: [
      {
        rule: "expectation-reads-other-table",
        file: MONTHLY_ORDER_SUMMARY_TEST,
        related: [MONTHLY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "expectations", 0).sql =
          "SELECT * FROM transforms.monthly_order_summary m JOIN people p ON 1 = 1 WHERE m.sum < 0";
      }),
  },
  {
    name: "unparseable-test-sql",
    description:
      "An expectation's SQL does not parse in Postgres, the engine of its database.",
    findings: [
      { rule: "unparseable-test-sql", file: MONTHLY_ORDER_SUMMARY_TEST },
    ],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        mapAt(doc, "expectations", 0).sql =
          "SELECT * FROM transforms.monthly_order_summary m n o";
      }),
  },
  {
    name: "missing-snippet",
    description:
      "A native transform uses a snippet that is not in the folder, so its reads are unknown.",
    findings: [{ rule: "reads-not-checked", file: PRODUCT_REVENUE_REPORT }],
    apply: (folder) =>
      edit(folder, PRODUCT_REVENUE_REPORT, (doc) => {
        const stage = mapAt(doc, "source", "query", "stages", 0);
        stage.native = textAt(stage, "native").replace(
          "GROUP BY",
          "{{snippet: No Such Snippet}}\nGROUP BY",
        );
        stage["template-tags"] = [
          ...(Array.isArray(stage["template-tags"])
            ? stage["template-tags"]
            : []),
          snippetTag("No Such Snippet", "NoSuchSnippet00000001"),
        ];
      }),
  },
  {
    name: "dangling-transform-id",
    description: "A test's transform_id names no entity.",
    findings: [
      {
        rule: "dangling-transform-id",
        file: CATEGORY_TOTALS_TEST,
        related: [PRODUCT_REVENUE_REPORT],
      },
    ],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.transform_id = "MissingTransform00000";
      }),
  },
  {
    name: "wrong-type-transform-id",
    description: "A test's transform_id names a transform tag.",
    findings: [
      {
        rule: "wrong-type-transform-id",
        file: CATEGORY_TOTALS_TEST,
        related: ["transforms/transform_tags/daily.yaml"],
      },
    ],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.transform_id = DAILY_TAG_ENTITY_ID;
      }),
  },
  {
    name: "copied-transform",
    description:
      "A transform file is copied without a new entity_id or target.",
    findings: [
      {
        rule: "duplicate-entity-id",
        file: PRODUCT_REVENUE_REPORT,
        related: ["collections/transforms/native_transform_copy.yaml"],
      },
      {
        rule: "duplicate-entity-id",
        file: "collections/transforms/native_transform_copy.yaml",
        related: [PRODUCT_REVENUE_REPORT],
      },
      {
        rule: "duplicate-target",
        file: PRODUCT_REVENUE_REPORT,
        related: ["collections/transforms/native_transform_copy.yaml"],
      },
      {
        rule: "duplicate-target",
        file: "collections/transforms/native_transform_copy.yaml",
        related: [PRODUCT_REVENUE_REPORT],
      },
    ],
    apply: (folder) =>
      cpSync(
        join(folder, PRODUCT_REVENUE_REPORT),
        join(folder, "collections/transforms/native_transform_copy.yaml"),
      ),
  },
  {
    name: "transform-cycle",
    description:
      "Product Revenue Report reads Top Categories, which reads it; its test gets the new input.",
    findings: [
      {
        rule: "transform-cycle",
        file: PRODUCT_REVENUE_REPORT,
        related: [TOP_CATEGORIES],
      },
    ],
    apply: (folder) => {
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace(
          "JOIN products p ON o.product_id = p.id",
          "JOIN products p ON o.product_id = p.id\nJOIN transforms.top_categories t ON t.category = p.category",
        ),
      );
      addSqlInput(
        folder,
        CATEGORY_TOTALS_TEST,
        { schema: "transforms", name: "top_categories" },
        "SELECT 'Gadget' AS category, 40.0 AS total_revenue",
      );
    },
  },
  {
    name: "transform-collection",
    description:
      "A transform is put in a collection of the default namespace, where Metabase refuses it.",
    findings: [
      {
        rule: "transform-collection",
        file: PRODUCT_REVENUE_REPORT,
        related: ["collections/main/queries.yaml"],
      },
    ],
    apply: (folder) =>
      edit(folder, PRODUCT_REVENUE_REPORT, (doc) => {
        doc.collection_id = QUERIES_COLLECTION_ENTITY_ID;
      }),
  },
  {
    name: "missing-incremental-table-tag",
    description:
      "A native transform writes an incremental table, but its query has no template tag of type table for the range filter.",
    findings: [
      { rule: "missing-incremental-table-tag", file: PRODUCT_REVENUE_REPORT },
    ],
    apply: (folder) =>
      edit(folder, PRODUCT_REVENUE_REPORT, (doc) => {
        mapAt(doc, "target").type = "table-incremental";
        mapAt(doc, "source")["source-incremental-strategy"] = {
          type: "checkpoint",
          "checkpoint-filter-field-id": [
            POSTGRES_DB,
            "public",
            "orders",
            "created_at",
          ],
        };
      }),
  },
  {
    name: "missing-target-database",
    description:
      "A Python transform's target names no database, which Metabase requires for a Python transform.",
    findings: [{ rule: "missing-target-database", file: PYTHON_HELLO_WORLD }],
    apply: (folder) =>
      edit(folder, PYTHON_HELLO_WORLD, (doc) => {
        delete mapAt(doc, "target").database;
      }),
  },
  {
    name: "blank-target-schema",
    description:
      "A transform's target schema is blank, which Metabase's API and a pull both refuse.",
    findings: [{ rule: "blank-target-schema", file: PYTHON_HELLO_WORLD }],
    apply: (folder) =>
      edit(folder, PYTHON_HELLO_WORLD, (doc) => {
        mapAt(doc, "target").schema = "";
      }),
  },
  {
    name: "missing-target-schema",
    description:
      "A transform's target names no schema, on a Postgres database, which has schemas.",
    findings: [{ rule: "missing-target-schema", file: PYTHON_HELLO_WORLD }],
    apply: (folder) =>
      edit(folder, PYTHON_HELLO_WORLD, (doc) => {
        delete mapAt(doc, "target").schema;
      }),
  },
  {
    name: "unsupported-transform-engine",
    description:
      "Python Hello World moves to an H2 database, whose driver runs no Python transform.",
    findings: [
      { rule: "unsupported-transform-engine", file: PYTHON_HELLO_WORLD },
    ],
    apply: (folder) => {
      writeSettings(folder, { engines: { Legacy: "h2" } });
      moveTransform(folder, PYTHON_HELLO_WORLD, "Legacy");
    },
  },
  {
    name: "untestable-engine",
    description:
      "Daily Order Summary, which a test tests, moves to a Snowflake database, whose driver runs no transform test.",
    findings: [
      {
        rule: "untestable-engine",
        file: DAILY_ORDER_SUMMARY_TEST,
        related: [DAILY_ORDER_SUMMARY],
      },
    ],
    apply: (folder) => {
      writeSettings(folder, {
        engines: { Warehouse: "snowflake" },
        defaultSchemas: { Warehouse: "PUBLIC" },
      });
      moveTransform(folder, DAILY_ORDER_SUMMARY, "Warehouse");
    },
  },
  {
    name: "missing-input",
    description: "A test drops the input for a table its transform reads.",
    findings: [
      {
        rule: "missing-input",
        file: CATEGORY_TOTALS_TEST,
        related: [PRODUCT_REVENUE_REPORT],
      },
    ],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.inputs = listAt(doc, "inputs").filter(
          (input) => mapAt(input, "table").name !== "products",
        );
      }),
  },
  {
    name: "unused-input",
    description: "A test has an input for a table its transform does not read.",
    findings: [
      {
        rule: "unused-input",
        file: TOP_CATEGORIES_TEST,
        related: [TOP_CATEGORIES],
      },
    ],
    apply: (folder) =>
      addSqlInput(
        folder,
        TOP_CATEGORIES_TEST,
        { name: "people" },
        "SELECT 1 AS id",
      ),
  },
  {
    name: "table-name-typo",
    description:
      "A transform misspells a table it reads, so its test's input no longer matches.",
    findings: [
      {
        rule: "missing-input",
        file: CATEGORY_TOTALS_TEST,
        related: [PRODUCT_REVENUE_REPORT],
      },
      {
        rule: "unused-input",
        file: CATEGORY_TOTALS_TEST,
        related: [PRODUCT_REVENUE_REPORT],
      },
    ],
    apply: (folder) =>
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace("FROM orders o", "FROM ordres o"),
      ),
  },
  {
    name: "null-schema-reference",
    description:
      "A card counts products by a reference with a null schema, on a Postgres database; Metabase refuses to run it for a user, since the reference names an inactive table.",
    findings: [{ rule: "null-schema-reference", file: NULL_SCHEMA_CARD }],
    apply: (folder) =>
      write(folder, NULL_SCHEMA_CARD, {
        name: "Products by a null schema",
        entity_id: "NullSchemaCard0000001",
        collection_id: "cOlQuErIeS0ExAmPlE2x1",
        creator_id: "admin@example.com",
        display: "scalar",
        database_id: POSTGRES_DB,
        dataset_query: {
          "lib/type": "mbql/query",
          database: POSTGRES_DB,
          stages: [
            {
              "lib/type": "mbql.stage/mbql",
              "source-table": [POSTGRES_DB, null, "products"],
              aggregation: [["count", {}]],
            },
          ],
        },
        visualization_settings: {},
        "serdes/meta": [{ model: "Card" }],
      }),
  },
  {
    name: "database-file",
    description:
      "A Database file for the warehouse sits under databases/; a pull creates a database connection from it that remote sync never syncs or removes.",
    findings: [
      {
        rule: "database-file",
        file: "databases/sample_postgres/sample_postgres.yaml",
      },
    ],
    apply: (folder) =>
      write(folder, "databases/sample_postgres/sample_postgres.yaml", {
        name: POSTGRES_DB,
        engine: "postgres",
        "serdes/meta": [{ model: "Database", id: POSTGRES_DB }],
      }),
  },
  {
    name: "missing-default-schema",
    description:
      "The settings file gives no default schema for Sample Postgres, whose transforms name tables without a schema.",
    findings: [
      {
        rule: "missing-default-schema",
        file: DAILY_ORDER_SUMMARY,
        related: [
          DAILY_ORDER_SUMMARY_TEST,
          "collections/transforms/monthly_sales_summary.yaml",
          PRODUCT_REVENUE_REPORT,
          CATEGORY_TOTALS_TEST,
        ],
      },
    ],
    apply: (folder) =>
      writeFileSync(
        join(folder, CONFIG_FILE),
        JSON.stringify({
          defaultSchemas: { "Sample Database": null },
          engines: { "Sample Database": "sqlite", [POSTGRES_DB]: "postgres" },
        }),
      ),
  },
  {
    name: "skipped-by-metabase",
    description:
      "A YAML file of notes with no serdes/meta sits beside the transforms; Metabase skips it.",
    findings: [
      {
        rule: "skipped-by-metabase",
        file: "collections/transforms/notes.yaml",
      },
    ],
    apply: (folder) =>
      write(folder, "collections/transforms/notes.yaml", { name: "Notes" }),
  },
  {
    name: "duplicate-yaml-key",
    description:
      "A transform file names its name twice, with the same value; Metabase keeps the last.",
    findings: [{ rule: "duplicate-yaml-key", file: TOP_CATEGORIES }],
    apply: (folder) => {
      const path = join(folder, TOP_CATEGORIES);
      const name = readFileSync(path, "utf8")
        .split("\n")
        .find((line) => line.startsWith("name: "));
      appendFileSync(path, `${name}\n`);
    },
  },
  {
    name: "invalid-utf8",
    description:
      "A transform file holds a comment in Latin-1, which is not valid UTF-8.",
    findings: [{ rule: "invalid-utf8", file: TOP_CATEGORIES }],
    apply: (folder) =>
      appendFileSync(
        join(folder, TOP_CATEGORIES),
        Buffer.from("# caf\xe9\n", "latin1"),
      ),
  },
  {
    name: "unknown-engine",
    description:
      "Python Hello World moves to a database whose engine is a driver the lint does not know.",
    findings: [{ rule: "unknown-engine", file: PYTHON_HELLO_WORLD }],
    apply: (folder) => {
      writeSettings(folder, { engines: { Legacy: "third-party-driver" } });
      moveTransform(folder, PYTHON_HELLO_WORLD, "Legacy");
    },
  },
  {
    name: "empty-native-query",
    description: "A native transform's query is only whitespace.",
    findings: [{ rule: "empty-native-query", file: MONTHLY_SALES_SUMMARY }],
    apply: (folder) => editNativeSql(folder, MONTHLY_SALES_SUMMARY, () => " "),
  },
  {
    name: "invalid-test",
    description: "A test has an expectation type the schema does not allow.",
    findings: [{ rule: "schema", file: TOP_CATEGORIES_TEST }],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        mapAt(doc, "expectations", 0).type = "contains";
      }),
  },
  {
    name: "refused-tests",
    description:
      "Four tests each break their inputs or SQL in a different way that Metabase refuses when the test is created.",
    get findings() {
      return REFUSED_TEST_RULES.flatMap((rule) => findMutation(rule).findings);
    },
    // The mutation of each rule has the rule's name.
    apply: (folder) => {
      for (const rule of REFUSED_TEST_RULES) {
        findMutation(rule).apply(folder);
      }
    },
  },
];

function findMutation(name: string): Mutation {
  const mutation = MUTATIONS.find((m) => m.name === name);
  if (mutation === undefined) {
    throw new Error(`Unknown mutation: ${name}`);
  }
  return mutation;
}

/** Copies `examples/v1` to `folder` and applies the named mutation. */
export function mutateExamples(name: string, folder: string): Mutation {
  const mutation = findMutation(name);
  cpSync(EXAMPLES, folder, { recursive: true });
  mutation.apply(folder);
  return mutation;
}

if (import.meta.main) {
  const [name, folder] = process.argv.slice(2);
  if (name === undefined || folder === undefined) {
    console.log(
      "Usage: bun run src/test-support/lint-mutations.ts <mutation> <folder>\n",
    );
    for (const mutation of MUTATIONS) {
      console.log(`  ${mutation.name.padEnd(24)} ${mutation.description}`);
    }
    process.exit(1);
  }
  const mutation = mutateExamples(name, folder);
  console.log(`Wrote examples/v1 with ${mutation.name} to ${folder}`);
}
