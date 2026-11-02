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
const ORDERS_MODEL = "collections/main/queries/orders_model.yaml";
const NULL_SCHEMA_CARD = "collections/main/queries/null_schema_products.yaml";
const ORDERS_MODEL_ENTITY_ID = "4eroqa4ZYl4WkNjP8XTvu";
const POSTGRES_DB = "Sample Postgres";

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

/** Known-broken edits to the `examples/v1` tree, each named for what it breaks. */
export const MUTATIONS: Mutation[] = [
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
        file: "collections/transforms/daily_order_summary.yaml",
        related: [
          "collections/transforms/monthly_sales_summary.yaml",
          "collections/transforms/native_transform.yaml",
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
    name: "invalid-test",
    description: "A test has an expectation type the schema does not allow.",
    findings: [{ rule: "schema", file: TOP_CATEGORIES_TEST }],
    apply: (folder) =>
      edit(folder, TOP_CATEGORIES_TEST, (doc) => {
        mapAt(doc, "expectations", 0).type = "contains";
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
