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
): TableKey => ({ database, schema, name, nullSchema: "default" });

describe("defaultSchemaNeed", () => {
  it("needs a default schema for an unqualified name", () => {
    expect(defaultSchemaNeed([t("PUBLIC", "ORDERS"), t(null, "PEOPLE")])).toBe(
      "names PEOPLE without a schema",
    );
  });

  it("needs a default schema for one table name in two schemas", () => {
    expect(defaultSchemaNeed([t("A", "orders"), t("b", "ORDERS")])).toBe(
      "names orders in schemas A and b",
    );
  });

  it("needs none for an MBQL reference with no schema, which names the table with no schema", () => {
    expect(
      defaultSchemaNeed([ref(null, "ORDERS"), t("PUBLIC", "ORDERS")]),
    ).toBeNull();
  });

  it("needs none when every name is qualified and each table name has one schema", () => {
    expect(
      defaultSchemaNeed([
        t("PUBLIC", "ORDERS"),
        t("public", "orders"),
        t("RAW", "PEOPLE"),
      ]),
    ).toBeNull();
    expect(defaultSchemaNeed([])).toBeNull();
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
  it("lets through only names whose matches never depend on the default schema", () => {
    const defaults = [null, "a", "b"] as const;
    const key = (n: GeneratedName): TableKey => ({ database: "db", ...n });
    const isSql = (n: GeneratedName) => n.nullSchema === "default";
    // Test inputs and transform targets are named as in SQL; only a read may
    // be an MBQL reference.
    const answers = (a: GeneratedName, b: GeneratedName, d: string | null) => [
      ...(isSql(b) ? [inputCovers(a, b, d)] : []),
      ...(isSql(a) && isSql(b) ? [rewriteCovers(a, b, d)] : []),
      sameTable(key(a), key(b), () => d),
    ];
    fc.assert(
      fc.property(fc.array(tableName, { maxLength: 4 }), (names) => {
        fc.pre(defaultSchemaNeed(names) === null);
        for (const a of names) {
          for (const b of names) {
            const [first, ...rest] = defaults.map((d) => answers(a, b, d));
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
    const resolve = () =>
      resolveDefaultSchemas({
        names: [
          k("Warehouse", null, "orders"),
          k("Legacy", "a", "t"),
          k("Legacy", "b", "t"),
          k("Clean", "public", "orders"),
          k("Given", null, "orders"),
        ],
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

  it("takes a given default schema over the engine's", () => {
    const defaultSchemaOf = resolveDefaultSchemas({
      names: [k("Shop", null, "orders")],
      given: { Shop: "shop" },
      engineOf: () => "mysql",
    });
    expect(defaultSchemaOf("Shop")).toBe("shop");
  });

  it("asks for the default schema of any other engine", () => {
    expect(() =>
      resolveDefaultSchemas({
        names: [k("Warehouse", null, "orders")],
        given: {},
        engineOf: () => "postgres",
      }),
    ).toThrow(MissingDefaultSchemasError);
  });

  it("ignores names with no database", () => {
    expect(
      resolveDefaultSchemas({
        names: [k(null, null, "orders")],
        given: {},
        engineOf: noEngines,
      })(null),
    ).toBeNull();
  });
});
