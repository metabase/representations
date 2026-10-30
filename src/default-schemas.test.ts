import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import {
  defaultSchemaNeed,
  MissingDefaultSchemasError,
  resolveDefaultSchemas,
} from "./default-schemas.js";
import { inputCovers, rewriteCovers } from "./input-match.js";
import { type NullSchema, sameTable, type TableKey } from "./tables.js";

/** A table named in SQL: a null schema is an unqualified name. */
const t = (schema: string | null, name: string) => ({
  schema,
  name,
  nullSchema: "default" as const,
});

/** A table named by an MBQL reference: a null schema is the table with no schema. */
const ref = (schema: string | null, name: string) => ({
  schema,
  name,
  nullSchema: "none" as const,
});

const k = (
  database: string | null,
  schema: string | null,
  name: string,
): TableKey => ({
  database,
  schema,
  name,
  nullSchema: "default",
  caseMatters: false,
});

describe("defaultSchemaNeed", () => {
  it("needs a default schema for an unqualified name", () => {
    expect(
      defaultSchemaNeed([t("PUBLIC", "ORDERS"), t(null, "PEOPLE")], []),
    ).toBe("names PEOPLE without a schema");
  });

  it("needs a default schema for one table name in two schemas in one test", () => {
    const names = [t("A", "orders"), t("b", "ORDERS")];
    expect(defaultSchemaNeed(names, [names])).toBe(
      "names orders in schemas A and b",
    );
  });

  it("needs none for one table name in two schemas outside any test", () => {
    expect(
      defaultSchemaNeed([t("A", "orders"), t("b", "ORDERS")], []),
    ).toBeNull();
  });

  it("needs none when each test names the table in one schema", () => {
    const [a, b] = [t("A", "orders"), t("b", "ORDERS")];
    expect(defaultSchemaNeed([a, b], [[a, t("c", "people")], [b]])).toBeNull();
  });

  it("needs none for an MBQL reference with no schema, which names the table with no schema", () => {
    expect(
      defaultSchemaNeed([ref(null, "ORDERS"), t("PUBLIC", "ORDERS")], []),
    ).toBeNull();
  });

  it("needs none when every name is qualified and each table name has one schema", () => {
    const names = [
      t("PUBLIC", "ORDERS"),
      t("public", "orders"),
      t("RAW", "PEOPLE"),
    ];
    expect(defaultSchemaNeed(names, [names])).toBeNull();
    expect(defaultSchemaNeed([], [])).toBeNull();
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
  // A test's rewrite (`rewriteCovers`) compares only the tables of one test;
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
      ...(isSql(b) ? [inputCovers(a, b, d)] : []),
      ...(inOneTest && isSql(a) && isSql(b) ? [rewriteCovers(a, b, d)] : []),
      sameTable(key(a), key(b), () => d),
    ];
    const names = fc.array(tableName, { maxLength: 4 });
    fc.assert(
      fc.property(names, names, (outside, test) => {
        const all = [...outside, ...test];
        fc.pre(defaultSchemaNeed(all, [test]) === null);
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

  it("refuses, naming each database that needs a default schema and why", () => {
    const legacy = [k("Legacy", "a", "t"), k("Legacy", "b", "t")];
    const resolve = () =>
      resolveDefaultSchemas({
        names: [
          k("Warehouse", null, "orders"),
          ...legacy,
          k("Clean", "public", "orders"),
          k("Spread", "a", "t"),
          k("Spread", "b", "t"),
          k("Given", null, "orders"),
        ],
        testTables: [legacy, [k("Spread", "a", "t")], [k("Spread", "b", "t")]],
        given: { Given: "public" },
        engineOf: noEngines,
      });
    expect(resolve).toThrow(MissingDefaultSchemasError);
    try {
      resolve();
    } catch (e) {
      expect(e instanceof MissingDefaultSchemasError && e.databases).toEqual([
        { database: "Legacy", reason: "names t in schemas a and b" },
        { database: "Warehouse", reason: "names orders without a schema" },
      ]);
    }
  });

  it("gives the default schema given, null given, or null for a MySQL or BigQuery engine", () => {
    const defaultSchemaOf = resolveDefaultSchemas({
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
    expect(defaultSchemaOf("Warehouse")).toBe("public");
    expect(defaultSchemaOf("Flat")).toBeNull();
    expect(defaultSchemaOf("Shop")).toBeNull();
    expect(defaultSchemaOf("Lake")).toBeNull();
  });

  it("keys databases by their exact name, as Metabase looks a database up", () => {
    const resolve = () =>
      resolveDefaultSchemas({
        testTables: [],
        names: [k("warehouse", null, "orders")],
        given: { Warehouse: "public" },
        engineOf: () => null,
      });
    expect(resolve).toThrow(MissingDefaultSchemasError);
  });

  it("takes a given default schema over the engine's", () => {
    const defaultSchemaOf = resolveDefaultSchemas({
      testTables: [],
      names: [k("Shop", null, "orders")],
      given: { Shop: "shop" },
      engineOf: () => "mysql",
    });
    expect(defaultSchemaOf("Shop")).toBe("shop");
  });

  it("asks for the default schema of any other engine", () => {
    expect(() =>
      resolveDefaultSchemas({
        testTables: [],
        names: [k("Warehouse", null, "orders")],
        given: {},
        engineOf: () => "postgres",
      }),
    ).toThrow(MissingDefaultSchemasError);
  });

  it("ignores names with no database", () => {
    expect(
      resolveDefaultSchemas({
        testTables: [],
        names: [k(null, null, "orders")],
        given: {},
        engineOf: noEngines,
      })(null),
    ).toBeNull();
  });
});
