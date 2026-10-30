import { describe, expect, it } from "bun:test";

import { stripLargeLiteralLists } from "./literal-lists.js";

const numbers = (count: number) =>
  Array.from({ length: count }, (_, i) => String(i)).join(", ");
const tuples = (count: number) =>
  Array.from({ length: count }, (_, i) => `(${i}, 'a''b')`).join(", ");

describe("stripLargeLiteralLists", () => {
  it("replaces an IN list of 100 commas, and keeps one of 99", () => {
    expect(
      stripLargeLiteralLists(`SELECT * FROM t WHERE id IN (${numbers(101)})`),
    ).toBe("SELECT * FROM t WHERE id IN (NULL)");
    const kept = `SELECT * FROM t WHERE id IN (${numbers(100)})`;
    expect(stripLargeLiteralLists(kept)).toBe(kept);
  });

  it("replaces a VALUES clause of more than 100 tuples by one tuple of NULLs", () => {
    expect(stripLargeLiteralLists(`INSERT INTO t VALUES ${tuples(101)}`)).toBe(
      "INSERT INTO t VALUES (NULL, NULL)",
    );
    const kept = `INSERT INTO t VALUES ${tuples(100)}`;
    expect(stripLargeLiteralLists(kept)).toBe(kept);
  });

  it("replaces an ARRAY literal, keeping the keyword's case", () => {
    expect(stripLargeLiteralLists(`SELECT array[${numbers(101)}] FROM t`)).toBe(
      "SELECT array[NULL] FROM t",
    );
  });

  it("keeps a list with a column or a subquery, and strips a large list inside it", () => {
    const withColumn = `SELECT * FROM t WHERE id IN (x, ${numbers(150)})`;
    expect(stripLargeLiteralLists(withColumn)).toBe(withColumn);
    expect(
      stripLargeLiteralLists(
        `SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE k IN (${numbers(101)}))`,
      ),
    ).toBe("SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE k IN (NULL))");
  });
});
