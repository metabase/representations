import { describe, expect, it } from "bun:test";

import {
  mergeInstanceRefs,
  mergePortableRefs,
  portableKey,
  type TablePath,
} from "./index.js";

const ORDERS: TablePath = ["Sample Database", null, "ORDERS"];
const PRODUCTS: TablePath = ["Sample Database", null, "PRODUCTS"];

const noPortableRefs = mergePortableRefs();
const noInstanceRefs = mergeInstanceRefs();

describe("portableKey", () => {
  it("keys a name by itself and a path by its JSON", () => {
    expect(portableKey("Sample Database")).toBe("Sample Database");
    expect(portableKey(ORDERS)).toBe('["Sample Database",null,"ORDERS"]');
  });

  it("keys paths that join to the same string apart", () => {
    expect(portableKey(["a/b", null, "c"])).not.toBe(
      portableKey(["a", "b", "c"]),
    );
  });
});

describe("mergePortableRefs", () => {
  it("keeps each reference once, in first-seen order", () => {
    const merged = mergePortableRefs(
      { ...noPortableRefs, tables: [PRODUCTS], cards: ["b"] },
      { ...noPortableRefs, tables: [ORDERS, [...PRODUCTS]], cards: ["a", "b"] },
    );

    expect(merged).toEqual({
      ...noPortableRefs,
      tables: [PRODUCTS, ORDERS],
      cards: ["b", "a"],
    });
  });
});

describe("mergeInstanceRefs", () => {
  it("keeps each id once, in first-seen order", () => {
    const merged = mergeInstanceRefs(
      { ...noInstanceRefs, cards: [2, 1] },
      { ...noInstanceRefs, cards: [1, 3], tables: [7] },
    );

    expect(merged).toEqual({
      ...noInstanceRefs,
      cards: [2, 1, 3],
      tables: [7],
    });
  });
});
