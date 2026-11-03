import { describe, expect, it } from "bun:test";

import {
  mergeInstanceRefs,
  mergePortableRefs,
  portableKey,
  type TablePath,
} from "./index.js";

const ORDERS: TablePath = ["Sample Database", null, "ORDERS"];
const PRODUCTS: TablePath = ["Sample Database", null, "PRODUCTS"];

describe("portableKey", () => {
  it("keys name by itself and path by its JSON", () => {
    expect(portableKey("Sample Database")).toBe("Sample Database");
    expect(portableKey(ORDERS)).toBe('["Sample Database",null,"ORDERS"]');
  });

  it("keys paths that join to same string apart", () => {
    expect(portableKey(["a/b", null, "c"])).not.toBe(
      portableKey(["a", "b", "c"]),
    );
  });
});

describe("mergePortableRefs", () => {
  it("keeps each reference once, in first-seen order", () => {
    const merged = mergePortableRefs(
      { tables: [PRODUCTS], cards: ["b"] },
      { tables: [ORDERS, [...PRODUCTS]], cards: ["a", "b"] },
    );

    expect(merged).toEqual({ tables: [PRODUCTS, ORDERS], cards: ["b", "a"] });
  });
});

describe("mergeInstanceRefs", () => {
  it("keeps each id once, in first-seen order", () => {
    const merged = mergeInstanceRefs(
      { cards: [2, 1] },
      { cards: [1, 3], tables: [7] },
    );

    expect(merged).toEqual({ cards: [2, 1, 3], tables: [7] });
  });
});
