import { describe, expect, it } from "bun:test";

import { cyclePath, cycles } from "./graph.js";

describe("cyclePath", () => {
  it("follows the edges, not the order of the nodes", () => {
    const edges = new Map([
      [0, [2]],
      [1, [0]],
      [2, [1]],
    ]);
    const [component] = cycles(edges, 3);
    expect(cyclePath(edges, component)).toEqual([0, 2, 1, 0]);
  });

  it("closes a self-edge on its node", () => {
    const edges = new Map([[0, [0]]]);
    expect(cyclePath(edges, [0])).toEqual([0, 0]);
  });

  it("takes a shortest way back to the first node, staying in the component", () => {
    const edges = new Map([
      [0, [1, 3]],
      [1, [2]],
      [2, [0]],
      [3, [0]],
      [4, [0]],
    ]);
    expect(cyclePath(edges, [0, 1, 2, 3])).toEqual([0, 3, 0]);
  });
});
