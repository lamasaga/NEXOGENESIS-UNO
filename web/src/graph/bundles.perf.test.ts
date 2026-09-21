import { describe, expect, it } from "vitest";
import { buildFibers } from "./bundles";
import type { GraphData } from "./types";

function synthData(nodeCount: number, edgeCount: number): GraphData {
  const domains = Array.from({ length: 12 }, (_, i) => `d${i}`);
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    title: `节点${i}`,
    type: "claim",
    domains: [domains[i % domains.length]],
    x: (i % 100) * 10,
    y: Math.floor(i / 100) * 10,
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => {
    const from = `n${i % nodeCount}`;
    const to = `n${(i * 7 + 13) % nodeCount}`;
    const da = nodes[i % nodeCount].domains[0];
    const db = nodes[(i * 7 + 13) % nodeCount].domains[0];
    return {
      id: `e${i}`,
      from,
      to,
      kind: "relation",
      relation_type: "supports",
      bundle: da === db ? da : [da, db].sort().join("::"),
    };
  });
  return { nodes, edges };
}

describe("规模压测（几何层）", () => {
  it("3000 节点 / 15000 边 的纤维构建 < 1500ms", () => {
    const t0 = performance.now();
    const { fibers, bundles } = buildFibers(synthData(3000, 15000));
    const ms = performance.now() - t0;
    expect(fibers).toHaveLength(15000);
    expect(bundles.length).toBeGreaterThanOrEqual(12);
    expect(ms).toBeLessThan(1500);
  });
});
