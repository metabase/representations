// Generates lint-parity corpus cases: edits to the base folder (corpus.ts)
// that change what a transform's SQL reads or what a transform test gives.
// Each edit carries tags naming the shapes it uses, so the recorder can keep
// one agreeing case per combination of shapes and answers.
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

// Metabase and the lint read YAML 1.1, where an unquoted 2024-01-01 09:00:00
// is a timestamp and yes a boolean: write with 1.1's rules, which quote them.

import { BASE, type Observation } from "./corpus.js";

/** The native SQL transforms of the base, by file. */
export const NATIVE_TRANSFORMS = [
  "collections/transforms/daily_order_summary.yaml",
  "collections/transforms/native_transform.yaml",
  "collections/transforms/monthly_sales_summary.yaml",
  "collections/transforms/top_categories.yaml",
] as const;

/** The transform tests of the base, by file. */
export const TESTS = [
  "collections/transforms/daily_order_summary/daily_order_summary__orders_per_day.yaml",
  "collections/transforms/native_transform/product_revenue_report__category_totals.yaml",
  "collections/transforms/top_categories/top_categories__three_highest.yaml",
  "collections/transforms/mbql_transform/monthly_order_summary__orders_per_month.yaml",
] as const;

export type Table = { schema?: string; name: string };

export type Op =
  | { kind: "sql"; transform: string; sql: string; tags: string[] }
  | { kind: "drop-input"; test: string; index: number; tags: string[] }
  | { kind: "duplicate-input"; test: string; index: number; tags: string[] }
  | { kind: "add-input"; test: string; table: Table; tags: string[] }
  | {
      kind: "rename-input";
      test: string;
      index: number;
      table: Table;
      tags: string[];
    }
  | { kind: "expectation-sql"; test: string; sql: string; tags: string[] };

type Sql = { sql: string; tags: string[] };

const join2 = (
  a: Sql,
  b: Sql,
  f: (x: string, y: string) => string,
  tags: string[] = [],
): Sql => ({
  sql: f(a.sql, b.sql),
  tags: [...a.tags, ...b.tags, ...tags],
});

/** A table of the warehouse or a transform's target, as SQL might write it. */
const tableRef: fc.Arbitrary<Sql> = fc
  .record({
    table: fc.constantFrom(
      { schema: "public", name: "orders" },
      { schema: "public", name: "products" },
      { schema: "public", name: "people" },
      { schema: "transforms", name: "product_revenue_report" },
      { schema: "transforms", name: "daily_order_summary" },
    ),
    qualify: fc.constantFrom("none", "lower", "upper", "quoted"),
    name: fc.constantFrom(
      "lower",
      "upper",
      "mixed",
      "quoted",
      "quoted-upper",
      "quoted-mixed",
    ),
  })
  .map(({ table, qualify, name }) => {
    const spell = (s: string, how: string) =>
      how === "upper"
        ? s.toUpperCase()
        : how === "mixed"
          ? s[0]!.toUpperCase() + s.slice(1)
          : how === "quoted"
            ? `"${s}"`
            : how === "quoted-upper"
              ? `"${s.toUpperCase()}"`
              : how === "quoted-mixed"
                ? `"${s[0]!.toUpperCase()}${s.slice(1)}"`
                : s;
    // A transform's target needs its schema: the default schema is public.
    const q =
      qualify === "none" && table.schema !== "public" ? "lower" : qualify;
    const schema = q === "none" ? "" : `${spell(table.schema, q)}.`;
    return {
      sql: `${schema}${spell(table.name, name)}`,
      tags: [`schema-${q}`, `name-${name}`],
    };
  });

const alias = fc.constantFrom(
  { sql: "", tags: [] as string[] },
  { sql: " t", tags: ["alias"] },
  { sql: " AS T", tags: ["alias-upper"] },
  { sql: ' "T"', tags: ["alias-quoted-upper"] },
  { sql: ' AS "t"', tags: ["alias-quoted"] },
);

const from: fc.Arbitrary<Sql> = fc
  .tuple(tableRef, alias)
  .map(([t, a]) => ({ sql: `${t.sql}${a.sql}`, tags: [...t.tags, ...a.tags] }));

/** A SELECT, built from the shapes the lint's SQL reading has to get right. */
const select: fc.Arbitrary<Sql> = fc.oneof(
  from.map((f) => ({ sql: `SELECT * FROM ${f.sql}`, tags: f.tags })),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(a, b, (x, y) => `SELECT * FROM ${x} JOIN ${y} ON 1 = 1`, ["join"]),
    ),
  fc.tuple(from, fc.constantFrom("x", "orders", "ORDERS")).map(([f, name]) => ({
    sql: `WITH ${name} AS (SELECT * FROM ${f.sql}) SELECT * FROM ${name}`,
    tags: [...f.tags, name === "x" ? "cte" : "cte-shadows-table"],
  })),
  from.map((f) => ({
    sql: `SELECT * FROM (SELECT * FROM ${f.sql}) s`,
    tags: [...f.tags, "subquery"],
  })),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(a, b, (x, y) => `SELECT 1 FROM ${x} UNION ALL SELECT 1 FROM ${y}`, [
        "union",
      ]),
    ),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(a, b, (x, y) => `SELECT * FROM ${x};\nSELECT * FROM ${y}`, [
        "multi-statement",
      ]),
    ),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(
        a,
        b,
        (x, y) =>
          `SELECT * FROM ${x} WHERE 1 = 1 [[AND 1 IN (SELECT 1 FROM ${y})]]`,
        ["optional-clause"],
      ),
    ),
  fc.tuple(from, from, from).map(([a, b, c]) => ({
    sql: `SELECT * FROM ${a.sql} WHERE 1 = 1 [[AND 1 IN (SELECT 1 FROM ${b.sql} [[WHERE 1 IN (SELECT 1 FROM ${c.sql})]])]]`,
    tags: [...a.tags, ...b.tags, ...c.tags, "nested-optional-clause"],
  })),
  // A tag named d… has a default, and a tag named n… has none (templateTagsOf).
  fc
    .tuple(from, from, fc.constantFrom("d1", "n1"))
    .map(([a, b, tag]) =>
      join2(
        a,
        b,
        (x, y) => `SELECT * FROM ${x} [[JOIN ${y} ON 1 = {{${tag}}}]]`,
        [`optional-tag-${tag}`],
      ),
    ),
  fc
    .tuple(
      from,
      from,
      from,
      fc.constantFrom("d1", "n1"),
      fc.constantFrom("d2", "n2"),
    )
    .map(([a, b, c, outer, inner]) => ({
      sql: `SELECT * FROM ${a.sql} [[JOIN ${b.sql} ON 1 = {{${outer}}} [[JOIN ${c.sql} ON 1 = {{${inner}}}]] ]]`,
      tags: [
        ...a.tags,
        ...b.tags,
        ...c.tags,
        `nested-optional-tags-${outer}-${inner}`,
      ],
    })),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(a, b, (x, y) => `SELECT * FROM ${x} -- FROM ${y}`, [
        "line-comment",
      ]),
    ),
  fc
    .tuple(from, from)
    .map(([a, b]) =>
      join2(a, b, (x, y) => `SELECT 'FROM ${y}' AS s FROM ${x}`, [
        "string-literal",
      ]),
    ),
);

const tableOf = fc.record(
  {
    schema: fc.constantFrom("public", "PUBLIC", "Public"),
    name: fc.constantFrom("orders", "ORDERS", "products", "people", "Products"),
  },
  { requiredKeys: ["name"] },
);

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.tuple(fc.constantFrom(...NATIVE_TRANSFORMS), select).map(
      ([transform, s]): Op => ({
        kind: "sql",
        transform,
        sql: s.sql,
        tags: s.tags,
      }),
    ),
  },
  fc.tuple(fc.constantFrom(...TESTS), fc.nat(2)).map(
    ([test, index]): Op => ({
      kind: "drop-input",
      test,
      index,
      tags: ["drop-input"],
    }),
  ),
  fc.tuple(fc.constantFrom(...TESTS), fc.nat(2)).map(
    ([test, index]): Op => ({
      kind: "duplicate-input",
      test,
      index,
      tags: ["duplicate-input"],
    }),
  ),
  fc.tuple(fc.constantFrom(...TESTS), tableOf).map(
    ([test, table]): Op => ({
      kind: "add-input",
      test,
      table,
      tags: ["add-input"],
    }),
  ),
  fc.tuple(fc.constantFrom(...TESTS), fc.nat(2), tableOf).map(
    ([test, index, table]): Op => ({
      kind: "rename-input",
      test,
      index,
      table,
      tags: ["rename-input"],
    }),
  ),
  fc.tuple(fc.constantFrom(...TESTS), select).map(
    ([test, s]): Op => ({
      kind: "expectation-sql",
      test,
      sql: s.sql,
      tags: ["expectation", ...s.tags],
    }),
  ),
);

/**
 * A number template tag for each `{{name}}` in `sql`, with a default of 1 when
 * the name starts with d.
 */
function templateTagsOf(sql: string): Doc[] {
  const names = [
    ...new Set([...sql.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)),
  ];
  return names.map((name, i) => ({
    type: "number",
    name,
    id: `aa000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    "display-name": name,
    ...(name.startsWith("d") ? { default: 1 } : {}),
  }));
}

/** A case: one to three edits. */
export const caseArbitrary = fc.array(op, { minLength: 1, maxLength: 3 });

type Doc = Record<string, any>; // Representation files are YAML maps.

/** The files `ops` change, with their new contents. */
export function applyOps(ops: readonly Op[]): Record<string, string> {
  const docs = new Map<string, Doc>();
  const doc = (file: string): Doc => {
    let d = docs.get(file);
    if (d === undefined) {
      d = parse(readFileSync(join(BASE, file), "utf8")) as Doc;
      docs.set(file, d);
    }
    return d;
  };
  for (const o of ops) {
    if (o.kind === "sql") {
      const stage = doc(o.transform).source.query.stages[0];
      stage.native = o.sql;
      const tags = templateTagsOf(o.sql);
      if (tags.length > 0) {
        stage["template-tags"] = tags;
      }
      continue;
    }
    const test = doc(o.test);
    const inputs: Doc[] = test.inputs;
    const at =
      inputs.length === 0
        ? -1
        : o.kind === "add-input" || o.kind === "expectation-sql"
          ? 0
          : o.index % inputs.length;
    if (o.kind === "drop-input" && at >= 0) {
      inputs.splice(at, 1);
    } else if (o.kind === "duplicate-input" && at >= 0) {
      inputs.push(structuredClone(inputs[at]));
    } else if (o.kind === "rename-input" && at >= 0) {
      inputs[at]!.table = o.table;
    } else if (o.kind === "add-input") {
      inputs.push({ table: o.table, format: "sql", sql: "SELECT 1 AS id" });
    } else if (o.kind === "expectation-sql") {
      test.expectations = [{ type: "empty", name: "generated", sql: o.sql }];
    }
  }
  return Object.fromEntries(
    [...docs].map(([file, d]) => [
      file,
      stringify(d, { lineWidth: 0, version: "1.1" }),
    ]),
  );
}

/** The tags of a case, sorted and without repeats. */
export function tagsOf(ops: readonly Op[]): string[] {
  return [...new Set(ops.flatMap((o) => [o.kind, ...o.tags]))].sort();
}

/** What a case's answers come to: each answer's kind, sorted, without repeats. */
export function answersOf(o: Observation): string[] {
  if (o.import.status === "failed") {
    return ["import-failed"];
  }
  const kinds = [...Object.values(o.transforms), ...Object.values(o.tests)].map(
    (a) =>
      "refused" in a
        ? a.refused
        : "skipped" in a
          ? `skipped ${a.skipped}`
          : Object.keys(a)[0]!,
  );
  return [...new Set(kinds)].sort();
}

/** The tags of a case that name a shape, leaving out how names are spelled. */
const shapesOf = (tags: readonly string[]) =>
  tags.filter((t) => !/^(schema|name|alias)-?/.test(t));

/**
 * A difference without its file, tables and Metabase's message, so that one
 * cause gives one kind however the case spells its names.
 */
const differenceKind = (difference: string) =>
  difference
    .replace(/^[^:]*: /, "")
    .replace(/ \(".*"\)/s, "")
    .replace(/ reads? .*/s, " reads");

/**
 * Which generated cases the corpus keeps, given the cases it holds (prime). A disagreement is kept
 * once per SQL shape and kind of difference. An agreeing case is kept when it
 * covers a tag or an answer that no case already kept covers, so
 * every shape and every spelling of a name is compared at least once. A case
 * whose import failed compares no shape, and covers no tag.
 */
export function createKeeper() {
  const causes = new Set<string>();
  const covered = new Set<string>();
  return {
    /** Counts `c`, a case already in the corpus, as kept. */
    prime(c: {
      description: string;
      known: string | null;
      observation: Observation;
    }): void {
      const tags = c.description.split(", ");
      if (c.known === null) {
        this.keepAgreeing(tags, c.observation);
      } else {
        this.keepDisagreeing(tags, c.known.split("\n"));
      }
    },
    keepDisagreeing(
      tags: readonly string[],
      differences: readonly string[],
    ): boolean {
      const cause = `${shapesOf(tags).join()}|${[...new Set(differences.map(differenceKind))].sort().join()}`;
      if (causes.has(cause)) {
        return false;
      }
      causes.add(cause);
      return true;
    },
    keepAgreeing(tags: readonly string[], observation: Observation): boolean {
      // A failed import compares no shape, so it covers only itself.
      const marks =
        observation.import.status === "failed"
          ? ["answer import-failed"]
          : [...tags, ...answersOf(observation).map((a) => `answer ${a}`)];
      if (marks.every((m) => covered.has(m))) {
        return false;
      }
      marks.forEach((m) => covered.add(m));
      return true;
    },
  };
}
