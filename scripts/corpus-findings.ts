// Hand-written corpus cases, each the smallest folder that shows a difference
// a review of the lint reported. record-corpus.ts --findings records what
// Metabase does with each, so the review's claim is settled by Metabase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

// Metabase and the lint read YAML 1.1, where an unquoted 2024-01-01 09:00:00
// is a timestamp and yes a boolean: write with 1.1's rules, which quote them.

import { BASE } from "./corpus.js";

type Doc = Record<string, any>; // Representation files are YAML maps.

export type FindingCase = {
  name: string;
  description: string;
  origin: string;
  edits: () => Record<string, string>;
};

const DAILY = "collections/transforms/daily_order_summary.yaml";
const DAILY_TEST =
  "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml";
const NATIVE = "collections/transforms/native_transform.yaml";
const PYTHON = "collections/transforms/python_hello_world.yaml";
const MONTHLY = "collections/transforms/mbql_transform.yaml";

function edited(
  file: string,
  change: (doc: Doc) => void,
): Record<string, string> {
  const doc = parse(readFileSync(join(BASE, file), "utf8")) as Doc;
  change(doc);
  return { [file]: stringify(doc, { lineWidth: 0, version: "1.1" }) };
}

/** The daily transform with `sql` as its query, and `tags` as its template tags. */
const dailySql = (sql: string, tags: Doc[] = []) =>
  edited(DAILY, (doc) => {
    const stage = doc.source.query.stages[0];
    stage.native = sql;
    if (tags.length > 0) {
      stage["template-tags"] = tags;
    }
  });

/** A field-filter tag on `field` of the warehouse's `table`, in the public schema. */
const dimensionTag = (name: string, table: string, field: string): Doc => ({
  type: "dimension",
  name,
  id: "bb000001-0000-0000-0000-000000000001",
  "display-name": name,
  dimension: ["field", {}, ["Sample Postgres", "public", table, field]],
  "widget-type": "date/all-options",
});

const numberTag = (name: string, id: string, fields: Doc = {}): Doc => ({
  type: "number",
  name,
  id,
  "display-name": name,
  ...fields,
});

export const FINDING_CASES: FindingCase[] = [
  {
    name: "finding-44-nested-optional-clause",
    description:
      "An optional clause whose tag has a default holds an optional clause whose tag has none. Metabase drops only the inner clause, and reads the outer clause's table.",
    origin: "review v4, #44 (src/sql-tables.ts:72)",
    edits: () =>
      dailySql(
        "SELECT o.created_at FROM orders o [[JOIN products p ON p.id = {{a}} [[JOIN people pe ON pe.id = {{b}}]] ]]",
        [
          numberTag("a", "aa000001-0000-0000-0000-00000000000a", {
            default: 1,
          }),
          numberTag("b", "aa000001-0000-0000-0000-00000000000b"),
        ],
      ),
  },
  {
    name: "finding-43-multi-statement",
    description:
      "A transform's SQL holds two statements, each reading a different table.",
    origin: "review v4, #43 (src/sql-parser.ts:211)",
    edits: () => dailySql("SELECT * FROM orders;\nSELECT * FROM products"),
  },
  {
    name: "finding-43-token-error",
    description:
      "A transform's SQL has an unterminated string, which SQLGlot's tokenizer refuses before parsing.",
    origin: "review v4, #43 (src/sql-parser.ts:10)",
    edits: () => dailySql("SELECT 'abc FROM orders"),
  },
  {
    name: "finding-50-insert-select",
    description: "A transform's SQL is an INSERT ... SELECT reading orders.",
    origin: "review v4, #50 (src/test-sql-checks.ts:115)",
    edits: () => dailySql("INSERT INTO t (a) SELECT o.id FROM orders o"),
  },
  {
    name: "finding-46-mbql-null-schema",
    description:
      "An MBQL transform reads orders through a table reference with a null schema; its test gives public.orders.",
    origin: "review v4, #46 (src/input-match.ts:22)",
    edits: () =>
      edited(MONTHLY, (doc) => {
        const stage = doc.source.query.stages[0];
        stage["source-table"] = ["Sample Postgres", null, "orders"];
        const nullSchema = (x: unknown): unknown =>
          Array.isArray(x)
            ? x.length === 4 && x[0] === "Sample Postgres" && x[1] === "public"
              ? ["Sample Postgres", null, x[2], x[3]]
              : x.map(nullSchema)
            : x;
        stage.aggregation = nullSchema(stage.aggregation);
        stage.breakout = nullSchema(stage.breakout);
      }),
  },
  {
    name: "self-review-2.1-python-table-id-null",
    description:
      "A Python transform reads another transform's target, which does not exist yet, so its source table has table_id: null, as Metabase writes it.",
    origin: "self-review of #40 at 6405d92, section 2.1",
    edits: () =>
      edited(PYTHON, (doc) => {
        doc.source = {
          type: "python",
          body: "def transform(up):\n    return up",
          "source-tables": [
            {
              alias: "up",
              database_id: "Sample Postgres",
              schema: "transforms",
              table: "product_revenue_report",
              table_id: null,
            },
          ],
        };
      }),
  },
  {
    name: "self-review-2.2-field-filter-input",
    description:
      "A transform filters by a field-filter tag on orders.created_at; its test gives orders.",
    origin: "self-review of #40 at 6405d92, section 2.2",
    edits: () =>
      dailySql("SELECT created_at, total FROM orders WHERE {{d}}", [
        dimensionTag("d", "orders", "created_at"),
      ]),
  },
  {
    name: "self-review-2.2-field-filter-unused-input",
    description:
      "A transform filters by a field-filter tag on products.category, and its test gives an input for products too.",
    origin: "self-review of #40 at 6405d92, section 2.2",
    edits: () => ({
      ...dailySql("SELECT created_at, total FROM orders WHERE {{p}}", [
        dimensionTag("p", "products", "category"),
      ]),
      ...edited(DAILY_TEST, (doc) => {
        doc.inputs.push({
          table: { schema: "public", name: "products" },
          format: "rows",
          columns: [{ name: "category", cast_type: "TEXT" }],
          rows: [{ category: "Gadget" }],
        });
      }),
    }),
  },
  {
    name: "self-review-2.3-empty-list-and-string",
    description:
      "Two files hold only an empty YAML list and an empty YAML string.",
    origin: "self-review of #40 at 6405d92, section 2.3",
    edits: () => ({
      "collections/transforms/empty_list.yaml": "[]\n",
      "collections/transforms/empty_string.yaml": "''\n",
    }),
  },
  {
    name: "self-review-3.1-quoted-name-case",
    description:
      'A transform reads "Orders", a quoted name in another case than the table and its test input orders.',
    origin: "self-review of #40 at 6405d92, section 3.1",
    edits: () => dailySql('SELECT o.created_at, o.total FROM "Orders" o'),
  },
  {
    name: "self-review-3.2-source-type-native",
    description:
      "A transform's source type is native, neither query nor python.",
    origin: "self-review of #40 at 6405d92, section 3.2",
    edits: () =>
      edited(NATIVE, (doc) => {
        doc.source.type = "native";
      }),
  },
];
