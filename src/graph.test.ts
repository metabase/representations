import { describe, expect, it } from "bun:test";

import { cyclePath, cycles, type Edge } from "./graph.js";

/** A graph whose node `from` has an edge to each of `to`. */
const graph = (entries: [number, number[]][]): Map<number, Edge[]> =>
  new Map(entries.map(([from, to]) => [from, to.map((t) => ({ to: t }))]));

/** The nodes of `cyclePath`'s cycle through `start`, starting and ending with it. */
const nodesOf = (start: number, path: readonly Edge[]): number[] => [
  start,
  ...path.map((e) => e.to),
];

describe("cyclePath", () => {
  it("follows the edges, not the order of the nodes", () => {
    const edges = graph([
      [0, [2]],
      [1, [0]],
      [2, [1]],
    ]);
    const [component] = cycles(edges, 3);
    expect(nodesOf(0, cyclePath(edges, component))).toEqual([0, 2, 1, 0]);
  });

  it("closes a self-edge on its node", () => {
    const edges = graph([[0, [0]]]);
    expect(cycles(edges, 1)).toEqual([[0]]);
    expect(nodesOf(0, cyclePath(edges, [0]))).toEqual([0, 0]);
  });

  it("takes a shortest way back to the first node, staying in the component", () => {
    const edges = graph([
      [0, [1, 3]],
      [1, [2]],
      [2, [0]],
      [3, [0]],
      [4, [0]],
    ]);
    expect(nodesOf(0, cyclePath(edges, [0, 1, 2, 3]))).toEqual([0, 3, 0]);
  });

  it("returns the edges themselves, in order", () => {
    const edges = new Map([
      [0, [{ to: 1, label: "a" }]],
      [1, [{ to: 0, label: "b" }]],
    ]);
    expect(cyclePath(edges, [0, 1]).map((e) => e.label)).toEqual(["a", "b"]);
  });
});
