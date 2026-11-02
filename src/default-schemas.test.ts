import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import {
  defaultSchemaNeeds,
  type NamedTable,
  resolveDefaultSchemas,
} from "./default-schemas.js";
import { inputCovers } from "./input-match.js";
import { type NullSchema, sameTable, type TableKey } from "./tables.js";

const FILE = "collections/t.yaml";

/** A table named in SQL: a null schema is an unqualified name. */
const t = (schema: string | null, name: string, file = FILE) => ({
  schema,
  name,
  nullSchema: "default" as const,
  file,
});

/** A table named by an MBQL reference: a null schema is the table with no schema. */
const ref = (schema: string | null, name: string) => ({
  schema,
  name,
  nullSchema: "none" as const,
  file: FILE,
});

/** The tables of one transform test, in the file `file`. */
const inTest = <T>(tables: readonly T[], file = "collections/test.yaml") => ({
  file,
  tables,
});

const k = (
  database: string | null,
  schema: string | null,
  name: string,
): NamedTable => ({
  database,
  schema,
  name,
  nullSchema: "default",
  caseMatters: false,
  file: `${database ?? "none"}.yaml`,
});

describe("defaultSchemaNeeds", () => {
  it("needs a default schema for each file with an unqualified name, once", () => {
    expect(
      defaultSchemaNeeds(
        [
          t("PUBLIC", "ORDERS"),
          t(null, "PEOPLE", "a.yaml"),
          t(null, "X", "a.yaml"),
          t(null, "X"),
        ],
        [],
      ),
    ).toEqual([
      {
        file: "a.yaml",
        reason:
          'names "PEOPLE" without a schema, so it resolves to the default schema',
      },
      {
        file: FILE,
        reason:
          'names "X" without a schema, so it resolves to the default schema',
      },
    ]);
  });

  it("needs a default schema for one table name in two schemas in one test", () => {
    const names = [t("A", "orders"), t("b", "ORDERS")];
    expect(defaultSchemaNeeds(names, [inTest(names)])).toEqual([
      {
        file: "collections/test.yaml",
        reason:
          'names "orders" in schemas "A" and "b" in one transform test, which only the default schema tells apart',
      },
    ]);
  });

  it("needs none for one table name in two schemas outside any test", () => {
    expect(
      defaultSchemaNeeds([t("A", "orders"), t("b", "ORDERS")], []),
    ).toEqual([]);
  });

  it("needs none when each test names the table in one schema", () => {
    const [a, b] = [t("A", "orders"), t("b", "ORDERS")];
    expect(
      defaultSchemaNeeds([a, b], [inTest([a, t("c", "people")]), inTest([b])]),
    ).toEqual([]);
  });

  it("needs none for an MBQL reference with no schema, which names the table with no schema", () => {
    expect(
      defaultSchemaNeeds([ref(null, "ORDERS"), t("PUBLIC", "ORDERS")], []),
    ).toEqual([]);
  });

  it("needs a default schema for an MBQL reference with no schema and the table in a schema in one test", () => {
    const names = [ref(null, "ORDERS"), t("PUBLIC", "orders")];
    expect(defaultSchemaNeeds(names, [inTest(names)])).toEqual([
      {
        file: "collections/test.yaml",
        reason:
          'names "ORDERS" with no schema and in a schema in one transform test, which only the default schema matches',
      },
    ]);
  });

  it("needs none when every name is qualified and each table name has one schema", () => {
    const names = [
      t("PUBLIC", "ORDERS"),
      t("public", "orders"),
      t("RAW", "PEOPLE"),
    ];
    expect(defaultSchemaNeeds(names, [inTest(names)])).toEqual([]);
    expect(defaultSchemaNeeds([], [])).toEqual([]);
  });
});

// Few schemas and names, so that generated names collide often.
const tableName = fc.record({
  schema: fc.constantFrom(null, "a", "A", "b"),
  name: fc.constantFrom("t", "T", "u"),
  nullSchema: fc.constantFrom<NullSchema>("default", "none"),
});

type GeneratedName = {
  schema: string | null;
  name: string;
  nullSchema: NullSchema;
};

describe("the default-schema gate", () => {
  // A test's inputs (`inputCovers`) compare only the tables of one test;
  // every other comparison may pair any two names.
  it("lets through only names whose matches never depend on the default schema", () => {
    const defaults = [null, "a", "b"] as const;
    const key = (n: GeneratedName): TableKey => ({
      database: "db",
      ...n,
      caseMatters: false,
    });
    const isSql = (n: GeneratedName) => n.nullSchema === "default";
    // Test inputs and transform targets are named as in SQL; only a read may
    // be an MBQL reference.
    const answers = (
      a: GeneratedName,
      b: GeneratedName,
      inOneTest: boolean,
      d: string | null,
    ) => [
      ...(inOneTest && isSql(b) ? [inputCovers(a, b, d)] : []),
      sameTable(key(a), key(b), () => d),
    ];
    const names = fc.array(tableName, { maxLength: 4 });
    fc.assert(
      fc.property(names, names, (outside, test) => {
        const all = [...outside, ...test];
        fc.pre(
          defaultSchemaNeeds(
            all.map((n) => ({ ...n, file: FILE })),
            [inTest(test)],
          ).length === 0,
        );
        for (const a of all) {
          for (const b of all) {
            const inOneTest = test.includes(a) && test.includes(b);
            const [first, ...rest] = defaults.map((d) =>
              answers(a, b, inOneTest, d),
            );
            for (const other of rest) {
              expect(other).toEqual(first);
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("resolveDefaultSchemas", () => {
  const noEngines = () => null;

  it("names each database that needs a default schema and has none, with each file that needs it, and gives it null", () => {
    const legacy = [k("Legacy", "a", "t"), k("Legacy", "b", "t")];
    const { defaultSchemaOf, unknown } = resolveDefaultSchemas({
      // people.yaml first: the files and the reason follow path order.
      names: [
        { ...k("Warehouse", null, "people"), file: "people.yaml" },
        k("Warehouse", null, "orders"),
        ...legacy,
        k("Clean", "public", "orders"),
        k("Spread", "a", "t"),
        k("Spread", "b", "t"),
        k("Given", null, "orders"),
      ],
      testTables: [
        inTest(legacy, "legacy_test.yaml"),
        inTest([k("Spread", "a", "t")]),
        inTest([k("Spread", "b", "t")]),
      ],
      given: { Given: "public" },
      engineOf: noEngines,
    });
    expect(unknown).toEqual([
      {
        database: "Legacy",
        files: ["legacy_test.yaml"],
        reason:
          'names "t" in schemas "a" and "b" in one transform test, which only the default schema tells apart',
      },
      {
        database: "Warehouse",
        files: ["Warehouse.yaml", "people.yaml"],
        reason:
          'names "orders" without a schema, so it resolves to the default schema',
      },
    ]);
    expect(defaultSchemaOf("Warehouse")).toBeNull();
    expect(defaultSchemaOf("Given")).toBe("public");
  });

  it("gives the default schema given, null given, or null for a MySQL or BigQuery engine", () => {
    const { defaultSchemaOf, unknown } = resolveDefaultSchemas({
      testTables: [],
      names: [
        k("Warehouse", null, "orders"),
        k("Flat", null, "orders"),
        k("Shop", null, "orders"),
        k("Lake", null, "orders"),
      ],
      given: { Warehouse: "public", Flat: null },
      engineOf: (database) =>
        database === "Shop"
          ? "mysql"
          : database === "Lake"
            ? "bigquery-cloud-sdk"
            : null,
    });
    expect(unknown).toEqual([]);
    expect(defaultSchemaOf("Warehouse")).toBe("public");
    expect(defaultSchemaOf("Flat")).toBeNull();
    expect(defaultSchemaOf("Shop")).toBeNull();
    expect(defaultSchemaOf("Lake")).toBeNull();
  });

  it("keys databases by their exact name, as Metabase looks a database up", () => {
    const { unknown } = resolveDefaultSchemas({
      testTables: [],
      names: [k("warehouse", null, "orders")],
      given: { Warehouse: "public" },
      engineOf: () => null,
    });
    expect(unknown.map((u) => u.database)).toEqual(["warehouse"]);
  });

  it("takes a given default schema over the engine's", () => {
    const { defaultSchemaOf } = resolveDefaultSchemas({
      testTables: [],
      names: [k("Shop", null, "orders")],
      given: { Shop: "shop" },
      engineOf: () => "mysql",
    });
    expect(defaultSchemaOf("Shop")).toBe("shop");
  });

  it("asks for the default schema of any other engine", () => {
    const { unknown } = resolveDefaultSchemas({
      testTables: [],
      names: [k("Warehouse", null, "orders")],
      given: {},
      engineOf: () => "postgres",
    });
    expect(unknown.map((u) => u.database)).toEqual(["Warehouse"]);
  });

  it("ignores names with no database", () => {
    const { defaultSchemaOf, unknown } = resolveDefaultSchemas({
      testTables: [],
      names: [k(null, null, "orders")],
      given: {},
      engineOf: noEngines,
    });
    expect(unknown).toEqual([]);
    expect(defaultSchemaOf(null)).toBeNull();
  });
});
