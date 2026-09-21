import { describe, expect, it } from "vitest";
import { buildFibers, controlPoint } from "./bundles";
import type { GraphData } from "./types";

const DATA: GraphData = {
  nodes: [
    { id: "da", title: "领域甲", type: "domain", domains: ["da"], x: 0, y: 0 },
    { id: "db", title: "领域乙", type: "domain", domains: ["db"], x: 300, y: 0 },
    { id: "a", title: "卡A", type: "claim", domains: ["da"], x: 10, y: 10 },
    { id: "b", title: "卡B", type: "model", domains: ["db"], x: 290, y: 10 },
  ],
  edges: [
    { id: "e0", from: "a", to: "b", kind: "relation", relation_type: "supports", bundle: "da::db" },
    { id: "e1", from: "a", to: "da", kind: "domain", relation_type: null, bundle: "da" },
  ],
};

describe("buildFibers", () => {
  it("静态中心路径不向领域中心偏移，激活的中心股与其对齐", () => {
    const { fibers } = buildFibers(DATA);
    for (const fiber of fibers) {
      expect(controlPoint(fiber, new Map([["da", { x: 10000, y: -10000 }]]))).toEqual({ x: (fiber.a.x + fiber.b.x) / 2, y: (fiber.a.y + fiber.b.y) / 2 });
      expect(fiber.strands[0].offset).toBe(0);
    }
  });
  it("每条边生成一条纤维，域内 2 股、跨域 3-5 股", () => {
    const { fibers } = buildFibers(DATA);
    expect(fibers).toHaveLength(2);
    const cross = fibers.find((f) => f.edge.id === "e0")!;
    const intra = fibers.find((f) => f.edge.id === "e1")!;
    expect(cross.intra).toBe(false);
    expect(cross.strands.length).toBeGreaterThanOrEqual(3);
    expect(cross.strands.length).toBeLessThanOrEqual(5);
    expect(intra.intra).toBe(true);
    expect(intra.strands).toHaveLength(2);
  });

  it("确定性：同输入同股线参数", () => {
    const a = buildFibers(DATA);
    const b = buildFibers(DATA);
    expect(JSON.stringify(a.fibers)).toBe(JSON.stringify(b.fibers));
  });

  it("束按 domainKey 分组", () => {
    const { bundles } = buildFibers(DATA);
    const ids = bundles.map((b) => b.id).sort();
    expect(ids).toEqual(["da", "da::db"]);
  });

  it("纤维按关系类型取激活色（supports→青）", () => {
    const { fibers } = buildFibers(DATA);
    expect(fibers[0].relationColor).toEqual([96, 165, 250]);
  });

  it("现行七种关系不再落入默认颜色", () => {
    const types = ["specialization", "supplement", "contrast", "challenge", "analogy", "example", "application"];
    const graph = { nodes: DATA.nodes, edges: types.map((type, index) => ({
      id: `current-${index}`, from: "a", to: "b", kind: "relation", relation_type: type, bundle: "current",
    })) };
    const colors = buildFibers(graph).fibers.map(fiber => fiber.relationColor.join(","));
    expect(new Set(colors).size).toBeGreaterThan(4);
    expect(colors.every(color => color !== "96,165,250")).toBe(true);
  });
});
