/**
 * The cycles of the graph on nodes `0` to `size - 1`, where `edges` maps a node
 * to the nodes it points to: each strongly connected component of more than
 * one node or with a self-edge, as its nodes in ascending order. Components
 * come in the order Tarjan's algorithm completes them.
 */
export function cycles(
  edges: ReadonlyMap<number, readonly number[]>,
  size: number,
): number[][] {
  const index: number[] = new Array(size).fill(-1);
  const low: number[] = new Array(size).fill(0);
  const onStack: boolean[] = new Array(size).fill(false);
  const stack: number[] = [];
  const found: number[][] = [];
  let next = 0;

  const visit = (v: number) => {
    index[v] = low[v] = next++;
    stack.push(v);
    onStack[v] = true;
    for (const w of edges.get(v) ?? []) {
      if (index[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w]);
      }
    }
    if (low[v] === index[v]) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number; // The stack holds v, so it is not empty.
        onStack[w] = false;
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (edges.get(v) ?? []).includes(v)) {
        found.push(component.sort((a, b) => a - b));
      }
    }
  };

  for (let v = 0; v < size; v++) {
    if (index[v] === -1) {
      visit(v);
    }
  }
  return found;
}
