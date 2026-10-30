import { cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { dirname, join, resolve } from "path";

import type { LintRule } from "../findings.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples", "v1");

const PRODUCT_REVENUE_REPORT = "collections/transforms/native_transform.yaml";
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
const PRODUCT_SUMMARY = "collections/transforms/product_summary.yaml";
const PYTHON_HELLO_WORLD_ENTITY_ID = "g2cRYwopfoL1BW9Y4n3wb";
const DAILY_TAG_ENTITY_ID = "dUW7nvQHQBdA0Rx0gJckI";
const ORDERS_MODEL = "collections/main/queries/orders_model.yaml";
const ORDERS_MODEL_ENTITY_ID = "4eroqa4ZYl4WkNjP8XTvu";
const DB = "Sample Database";
const POSTGRES_DB = "Sample Postgres";
const POSTGRES_PRODUCTS = [POSTGRES_DB, "public", "products"] as const;
const WIDGETS_SEGMENT_ENTITY_ID = "WarehouseWidgets00001";
const PRODUCT_COUNT_MEASURE_ENTITY_ID = "WarehouseProducts0001";
const ORDERS_TABLE_FILE = "databases/sample_database/tables/orders/orders.yaml";

export type Mutation = {
  name: string;
  description: string;
  /** The rules the lint reports on the mutated tree; the clean tree reports none. */
  rules: LintRule[];
  apply: (folder: string) => void;
};

function edit(
  folder: string,
  file: string,
  change: (doc: Record<string, any>) => void,
): void {
  const path = join(folder, file);
  const doc = yaml.load(readFileSync(path, "utf8")) as Record<string, any>; // Representation files are YAML maps.
  change(doc);
  writeFileSync(path, yaml.dump(doc, { lineWidth: -1 }));
}

/** Writes `doc` as YAML to `file`, creating its folder. */
function write(
  folder: string,
  file: string,
  doc: Readonly<Record<string, unknown>>,
): void {
  const path = join(folder, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump(doc, { lineWidth: -1 }));
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

function editNativeSql(
  folder: string,
  file: string,
  change: (sql: string) => string,
): void {
  edit(folder, file, (doc) => {
    const stage = doc.source.query.stages[0];
    stage.native = change(stage.native);
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
    doc.inputs.push({ table, format: "sql", sql });
  });
}

/**
 * The rules of the mutations that break a transform test in a way Metabase
 * refuses when the test is created, each on a different test.
 */
const REFUSED_TEST_RULES = [
  "missing-input",
  "unused-input",
  "duplicate-input",
  "expectation-reads-other-table",
] as const satisfies readonly LintRule[];

/** Known-broken edits to the `examples/v1` tree, each named for what it breaks. */
export const MUTATIONS: Mutation[] = [
  {
    name: "implicit-join",
    description:
      "An MBQL transform breaks out by a product field through orders.product_id; its test gives orders that column, and has no products input.",
    rules: ["missing-input"],
    apply: (folder) => {
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        doc.source.query.stages[0].breakout.push([
          "field",
          { "source-field": [POSTGRES_DB, "public", "orders", "product_id"] },
          [POSTGRES_DB, "public", "products", "category"],
        ]);
      });
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        const orders = doc.inputs[0];
        orders.columns.push({ name: "product_id", cast_type: "INTEGER" });
        for (const row of orders.rows) {
          row.product_id = 1;
        }
      });
    },
  },
  {
    name: "segment-filter",
    description:
      "An MBQL transform filters by a segment on products; its test has no products input.",
    rules: ["missing-input"],
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
        doc.source.query.stages[0].filters = [
          ["segment", {}, WIDGETS_SEGMENT_ENTITY_ID],
        ];
      });
    },
  },
  {
    name: "measure-aggregation",
    description:
      "An MBQL transform aggregates a measure on products; its test has no products input.",
    rules: ["missing-input"],
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
        doc.source.query.stages[0].aggregation.push([
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
    rules: ["reads-not-checked"],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        doc.source.query.stages[0].filters = [
          ["segment", {}, "MissingSegment0000001"],
        ];
      }),
  },
  {
    name: "self-source-card",
    description:
      "An MBQL transform reads a card that uses itself as its source, so its reads are unknown.",
    rules: ["reads-not-checked"],
    apply: (folder) => {
      edit(folder, ORDERS_MODEL, (doc) => {
        const [stage] = doc.dataset_query.stages;
        delete stage["source-table"];
        stage["source-card"] = ORDERS_MODEL_ENTITY_ID;
      });
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        const [stage] = doc.source.query.stages;
        delete stage["source-table"];
        stage["source-card"] = ORDERS_MODEL_ENTITY_ID;
      });
    },
  },
  {
    name: "unqualified-input",
    description:
      "A test's input drops the schema of a table its transform reads with one; Metabase never matches the two.",
    rules: ["missing-input", "unused-input"],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        delete doc.inputs[0].table.schema;
      }),
  },
  {
    name: "qualified-input",
    description:
      "A test's input names a schema other than the default for a table its transform reads unqualified; Metabase never matches the two.",
    rules: ["missing-input", "unused-input"],
    apply: (folder) =>
      edit(folder, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        doc.inputs[0].table.schema = "OTHER";
      }),
  },
  {
    name: "python-transform-test",
    description:
      "A test is written for a Python transform, which Metabase cannot test.",
    rules: ["untestable-transform"],
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
    rules: ["duplicate-input"],
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
    rules: ["expectation-reads-other-table"],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        doc.expectations[0].sql =
          "SELECT * FROM transforms.monthly_order_summary m JOIN people p ON 1 = 1 WHERE m.sum < 0";
      }),
  },
  {
    name: "missing-snippet",
    description:
      "A native transform uses a snippet that is not in the folder, so its reads are unknown.",
    rules: ["reads-not-checked"],
    apply: (folder) =>
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace("GROUP BY", "{{snippet: No Such Snippet}}\nGROUP BY"),
      ),
  },
  {
    name: "dangling-transform-id",
    description: "A test's transform_id names no entity.",
    rules: ["dangling-transform-id"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.transform_id = "MissingTransform00000";
      }),
  },
  {
    name: "wrong-type-transform-id",
    description: "A test's transform_id names a transform tag.",
    rules: ["wrong-type-transform-id"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.transform_id = DAILY_TAG_ENTITY_ID;
      }),
  },
  {
    name: "copied-transform",
    description:
      "A transform file is copied without a new entity_id or target.",
    rules: ["duplicate-entity-id", "duplicate-target"],
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
    rules: ["transform-cycle"],
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
    name: "missing-input",
    description: "A test drops the input for a table its transform reads.",
    rules: ["missing-input"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.inputs = doc.inputs.filter(
          (input: Record<string, any>) => input.table.name !== "products",
        );
      }),
  },
  {
    name: "unused-input",
    description: "A test has an input for a table its transform does not read.",
    rules: ["unused-input"],
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
    rules: ["missing-input", "unused-input"],
    apply: (folder) =>
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace("FROM orders o", "FROM ordres o"),
      ),
  },
  {
    name: "null-schema-reference",
    description:
      "Product Summary reads products by a reference with a null schema, on a Postgres database, so it names a table that does not exist.",
    rules: ["null-schema-reference"],
    apply: (folder) =>
      edit(folder, PRODUCT_SUMMARY, (doc) => {
        doc.source.query.stages[0]["source-table"] = [
          POSTGRES_DB,
          null,
          "products",
        ];
      }),
  },
  {
    name: "skipped-by-metabase",
    description:
      "A YAML file of notes with no serdes/meta sits beside the transforms; Metabase skips it.",
    rules: ["skipped-by-metabase"],
    apply: (folder) =>
      write(folder, "collections/transforms/notes.yaml", { name: "Notes" }),
  },
  {
    name: "invalid-test",
    description: "A test has an expectation type the schema does not allow.",
    rules: ["schema"],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        doc.expectations[0].type = "contains";
      }),
  },
  {
    name: "broken-table-file",
    description:
      "A table file has no name and a number for its schema; the lint must not count it as a table.",
    rules: ["schema"],
    apply: (folder) =>
      write(folder, ORDERS_TABLE_FILE, {
        db_id: DB,
        schema: 5,
        "serdes/meta": [{ model: "Table" }],
      }),
  },
  {
    name: "refused-tests",
    description:
      "Four tests each break in a different way that Metabase refuses when the test is created.",
    rules: [...REFUSED_TEST_RULES],
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
