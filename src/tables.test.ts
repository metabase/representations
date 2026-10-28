import { describe, expect, it } from "bun:test";

import { type DefaultSchemaOf, sameTable, type TableKey } from "./tables.js";

const table = (
  database: string | null,
  schema: string | null,
  name: string,
): TableKey => ({ database, schema, name });

const noSchemas: DefaultSchemaOf = () => null;
const defaultOf =
  (schemas: Record<string, string | null>): DefaultSchemaOf =>
  (database) =>
    database !== null && Object.hasOwn(schemas, database)
      ? schemas[database]
      : null;

describe("sameTable", () => {
  it("compares names ignoring case, folded to lower case as Metabase folds", () => {
    expect(
      sameTable(
        table("db", "s", "Orders"),
        table("db", "s", "ORDERS"),
        noSchemas,
      ),
    ).toBe(true);
    expect(
      sameTable(
        table("db", "s", "orders"),
        table("db", "s", "people"),
        noSchemas,
      ),
    ).toBe(false);
    // Upper case folds both to "STRASSE"; lower case keeps "straße" and "strasse" apart.
    expect(
      sameTable(
        table("db", "s", "straße"),
        table("db", "s", "STRASSE"),
        noSchemas,
      ),
    ).toBe(false);
  });

  it("compares two known schemas ignoring case", () => {
    expect(
      sameTable(
        table("db", "Public", "t"),
        table("db", "PUBLIC", "t"),
        noSchemas,
      ),
    ).toBe(true);
    expect(
      sameTable(
        table("db", "public", "t"),
        table("db", "other", "t"),
        noSchemas,
      ),
    ).toBe(false);
  });

  it("matches two unqualified names", () => {
    expect(
      sameTable(
        table("db", null, "t"),
        table("db", null, "t"),
        defaultOf({ db: "public" }),
      ),
    ).toBe(true);
  });

  it("resolves an unqualified name to the known default schema, on either side", () => {
    const publicDefault = defaultOf({ db: "public" });
    expect(
      sameTable(
        table("db", null, "t"),
        table("db", "PUBLIC", "t"),
        publicDefault,
      ),
    ).toBe(true);
    expect(
      sameTable(
        table("db", "PUBLIC", "t"),
        table("db", null, "t"),
        publicDefault,
      ),
    ).toBe(true);
    expect(
      sameTable(
        table("db", null, "t"),
        table("db", "other", "t"),
        publicDefault,
      ),
    ).toBe(false);
    expect(
      sameTable(
        table("db", "other", "t"),
        table("db", null, "t"),
        publicDefault,
      ),
    ).toBe(false);
  });

  it("never matches an unqualified name to a schema in a database with no schemas", () => {
    expect(
      sameTable(
        table("db", null, "t"),
        table("db", "public", "t"),
        defaultOf({ db: null }),
      ),
    ).toBe(false);
  });

  it("compares two known databases ignoring case, and lets a missing one match any", () => {
    expect(
      sameTable(table("db1", "s", "t"), table("db2", "s", "t"), noSchemas),
    ).toBe(false);
    expect(
      sameTable(
        table("Sample", "s", "t"),
        table("SAMPLE", "s", "t"),
        noSchemas,
      ),
    ).toBe(true);
    expect(
      sameTable(table(null, "s", "t"), table("db2", "s", "t"), noSchemas),
    ).toBe(true);
  });

  it("takes the default schema of the database the names are in", () => {
    const schemas = defaultOf({ a: "public", b: "other" });
    expect(
      sameTable(table(null, null, "t"), table("a", "other", "t"), schemas),
    ).toBe(false);
    expect(
      sameTable(table("b", null, "t"), table(null, "other", "t"), schemas),
    ).toBe(true);
  });
});
