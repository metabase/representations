import { cpSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import yaml from "js-yaml";
import { dirname, join, resolve } from "path";

import type { LintRule } from "./findings.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples", "v1");

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
const PYTHON_HELLO_WORLD_ENTITY_ID = "g2cRYwopfoL1BW9Y4n3wb";
const DAILY_TAG_ENTITY_ID = "dUW7nvQHQBdA0Rx0gJckI";
const WIDGET_PRODUCTS_SEGMENT_ENTITY_ID = "aB3kLmN9pQrStUvWxYz1a";
const QUERIES_COLLECTION_ENTITY_ID = "cOlQuErIeS0ExAmPlE2x1";
const DB = "Sample Database";
const ORDERS_TABLE_FILE = "databases/sample_database/tables/orders/orders.yaml";
const DATABASE_FILE = "databases/sample_database/sample_database.yaml";

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

/** Writes a Database file that gives the Sample Database `engine`. */
function writeEngine(folder: string, engine: string): void {
  write(folder, DATABASE_FILE, {
    name: DB,
    engine,
    "serdes/meta": [{ model: "Database", id: DB }],
  });
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
 * Known-broken edits to the `examples/v1` tree. Each one breaks the
 * references between transforms, tables and transform tests in one way.
 */
export const MUTATIONS: Mutation[] = [
  {
    name: "implicit-join",
    description:
      "An MBQL transform breaks out by a product field through ORDERS.PRODUCT_ID; its test gives ORDERS that column, and has no PRODUCTS input.",
    rules: ["missing-input"],
    apply: (folder) => {
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        doc.source.query.stages[0].breakout.push([
          "field",
          { "source-field": [DB, null, "ORDERS", "PRODUCT_ID"] },
          [DB, null, "PRODUCTS", "CATEGORY"],
        ]);
      });
      edit(folder, MONTHLY_ORDER_SUMMARY_TEST, (doc) => {
        const orders = doc.inputs[0];
        orders.columns.push({ name: "PRODUCT_ID", cast_type: "INTEGER" });
        for (const row of orders.rows) {
          row.PRODUCT_ID = 1;
        }
      });
    },
  },
  {
    name: "segment-filter",
    description:
      "An MBQL transform filters by a segment on PRODUCTS; its test has no PRODUCTS input.",
    rules: ["missing-input"],
    apply: (folder) =>
      edit(folder, MONTHLY_ORDER_SUMMARY, (doc) => {
        doc.source.query.stages[0].filters = [
          ["segment", {}, WIDGET_PRODUCTS_SEGMENT_ENTITY_ID],
        ];
      }),
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
        { name: "orders" },
        "SELECT 1 AS ID",
      ),
  },
  {
    name: "expectation-reads-other-table",
    description:
      "An expectation's SQL reads a table that is neither the output nor an input.",
    rules: ["expectation-reads-other-table"],
    apply: (folder) =>
      edit(folder, DAILY_ORDER_SUMMARY_TEST, (doc) => {
        doc.expectations[1].sql =
          "SELECT * FROM TRANSFORMS.daily_order_summary d JOIN PEOPLE p ON 1 = 1 WHERE d.total_revenue < 0";
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
          "JOIN PRODUCTS p ON o.PRODUCT_ID = p.ID",
          "JOIN PRODUCTS p ON o.PRODUCT_ID = p.ID\nJOIN TRANSFORMS.top_categories t ON t.CATEGORY = p.CATEGORY",
        ),
      );
      addSqlInput(
        folder,
        CATEGORY_TOTALS_TEST,
        { schema: "TRANSFORMS", name: "top_categories" },
        "SELECT 'Gadget' AS CATEGORY, 40.0 AS total_revenue",
      );
    },
  },
  {
    name: "transform-collection",
    description:
      "A transform is put in a collection of the default namespace, where Metabase refuses it.",
    rules: ["transform-collection"],
    apply: (folder) =>
      edit(folder, PRODUCT_REVENUE_REPORT, (doc) => {
        doc.collection_id = QUERIES_COLLECTION_ENTITY_ID;
      }),
  },
  {
    name: "missing-incremental-table-tag",
    description:
      "A native transform writes an incremental table, but its query has no table variable for the range filter.",
    rules: ["missing-incremental-table-tag"],
    apply: (folder) =>
      edit(folder, PRODUCT_REVENUE_REPORT, (doc) => {
        doc.target.type = "table-incremental";
        doc.source["source-incremental-strategy"] = {
          type: "checkpoint",
          "checkpoint-filter-field-id": [DB, null, "ORDERS", "CREATED_AT"],
        };
      }),
  },
  {
    name: "missing-target-schema",
    description:
      "A transform's target names no schema, on a Postgres database, which has schemas.",
    rules: ["missing-target-schema"],
    apply: (folder) => {
      writeEngine(folder, "postgres");
      edit(folder, PYTHON_HELLO_WORLD, (doc) => {
        delete doc.target.schema;
      });
    },
  },
  {
    name: "unsupported-transform-engine",
    description:
      "The transforms' database is H2, whose driver runs no query or Python transform.",
    rules: ["unsupported-transform-engine"],
    apply: (folder) => writeEngine(folder, "h2"),
  },
  {
    name: "untestable-engine",
    description:
      "The tested transforms' database is Snowflake, whose driver runs no transform test.",
    rules: ["untestable-engine"],
    apply: (folder) => writeEngine(folder, "snowflake"),
  },
  {
    name: "missing-input",
    description: "A test drops the input for a table its transform reads.",
    rules: ["missing-input"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.inputs = doc.inputs.filter(
          (input: Record<string, any>) => input.table.name !== "PRODUCTS",
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
        CATEGORY_TOTALS_TEST,
        { name: "PEOPLE" },
        "SELECT 1 AS ID",
      ),
  },
  {
    name: "table-name-typo",
    description:
      "A transform misspells a table it reads, so its test's input no longer matches.",
    rules: ["missing-input", "unused-input"],
    apply: (folder) =>
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace("FROM ORDERS o", "FROM ORDRES o"),
      ),
  },
  {
    name: "row-columns-mismatch",
    description:
      "A test input's row misspells a declared column, so it lacks that column and carries an undeclared one.",
    rules: ["row-columns-mismatch"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        const row = doc.inputs[0].rows[1];
        row.TOTL = row.TOTAL;
        delete row.TOTAL;
      }),
  },
  {
    name: "duplicate-expectation-name",
    description: "A test's two expectations share a name.",
    rules: ["duplicate-expectation-name"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.expectations[1].name = doc.expectations[0].name;
      }),
  },
  {
    name: "no-expectations",
    description: "A test has no expectations, so it checks nothing.",
    rules: ["no-expectations"],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        doc.expectations = [];
      }),
  },
  {
    name: "input-missing-read-column",
    description:
      "A test's ORDERS input drops PRODUCT_ID, a column its transform joins on.",
    rules: ["input-missing-read-column"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        const orders = doc.inputs[0];
        orders.columns = orders.columns.filter(
          (column: Record<string, any>) => column.name !== "PRODUCT_ID",
        );
        for (const row of orders.rows) {
          delete row.PRODUCT_ID;
        }
      }),
  },
  {
    name: "upstream-column-mismatch",
    description:
      "Product Revenue Report renames its total_revenue column; the test of Top Categories, which reads it, keeps the old name.",
    rules: ["upstream-column-mismatch"],
    apply: (folder) =>
      editNativeSql(folder, PRODUCT_REVENUE_REPORT, (sql) =>
        sql.replace("AS total_revenue", "AS revenue"),
      ),
  },
  {
    name: "table-qualified-column",
    description:
      "Top Categories qualifies a column by the name of the table it reads, outside the default schema, with no alias; Metabase's test rewrite leaves the qualifier naming no table.",
    rules: ["table-qualified-column"],
    apply: (folder) =>
      editNativeSql(folder, TOP_CATEGORIES, (sql) =>
        sql.replace(
          "SELECT\n  CATEGORY,",
          "SELECT\n  product_revenue_report.CATEGORY,",
        ),
      ),
  },
  {
    name: "live-sql-input",
    description:
      "A test's SQL input reads the real PRODUCTS table, so the test depends on live data.",
    rules: ["live-sql-input"],
    apply: (folder) =>
      edit(folder, CATEGORY_TOTALS_TEST, (doc) => {
        doc.inputs[1].sql = "SELECT ID, CATEGORY FROM PRODUCTS";
      }),
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
];

/** Copies `examples/v1` to `folder` and applies the named mutation. */
export function mutateExamples(name: string, folder: string): Mutation {
  const mutation = MUTATIONS.find((m) => m.name === name);
  if (mutation === undefined) {
    throw new Error(`Unknown mutation: ${name}`);
  }
  cpSync(EXAMPLES, folder, { recursive: true });
  mutation.apply(folder);
  return mutation;
}

if (import.meta.main) {
  const [name, folder] = process.argv.slice(2);
  if (name === undefined || folder === undefined) {
    console.log("Usage: bun run src/lint-mutations.ts <mutation> <folder>\n");
    for (const mutation of MUTATIONS) {
      console.log(`  ${mutation.name.padEnd(24)} ${mutation.description}`);
    }
    process.exit(1);
  }
  const mutation = mutateExamples(name, folder);
  console.log(`Wrote examples/v1 with ${mutation.name} to ${folder}`);
}
