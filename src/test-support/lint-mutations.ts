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
const PRODUCT_SUMMARY = "collections/transforms/product_summary.yaml";
const ORDERS_MODEL = "collections/main/queries/orders_model.yaml";
const ORDERS_MODEL_ENTITY_ID = "4eroqa4ZYl4WkNjP8XTvu";
const DB = "Sample Database";
const POSTGRES_DB = "Sample Postgres";
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

/** Known-broken edits to the `examples/v1` tree, each named for what it breaks. */
export const MUTATIONS: Mutation[] = [
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
    name: "null-schema-reference",
    description:
      "Product Summary reads products by a reference with a null schema, on a database whose default schema is public, so it names a table that likely does not exist.",
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
