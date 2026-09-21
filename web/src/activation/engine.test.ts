import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../graph/types";
import { activationNow } from "./clock";
import { ActivationEngine, gestureLifetime } from "./engine";
import { THEME } from "./theme";

const EDGES: GraphEdge[] = [
  { id: "e0", from: "a", to: "b", kind: "relation", relation_type: "supports", bundle: "da::db" },
  { id: "e1", from: "b", to: "c", kind: "relation", relation_type: "based-on", bundle: "da" },
  { id: "e2", from: "c", to: "d", kind: "relation", relation_type: "extends", bundle: "dc" },
];

function makeEngine() {
  return new ActivationEngine(EDGES);
}

describe("ActivationEngine", () => {
  it("工作级神经流会即时切换形态并自然退出", () => {
    const engine = makeEngine();
    engine.enqueueEvent({ type: "neural.flow", ts: 0, payload: { kind: "rewiring", node_ids: ["a"], duration: 4 } }, 10);
    expect(engine.neuralFlow(10.2)).toMatchObject({ kind: "rewiring", nodeIds: ["a"] });
    expect(engine.graphNarration().title).toBe("知识网络正在重组");
    engine.enqueueEvent({ type: "neural.stop", ts: 0, payload: {} }, 10.4);
    expect(engine.neuralFlow(11.4)).toBeNull();
  });

  it("拓扑更新只点亮真实新增节点与关系", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "topology.changed", ts: 0, payload: { node_ids: ["b"], edge_ids: ["e0"] } }, 10);
    expect(engine.neuralFlow(10.2)?.kind).toBe("commit");
    expect(engine.nodeMotionOf("b", 10.2)?.kind).toBe("created");
    expect(engine.heatOf("e0", 10.2)).not.toBeNull();
    expect(engine.heatOf("e1", 10.2)).toBeNull();
  });

  it("seed 事件只点亮命中节点", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: ["a"], edge_ids: [], role: "seed",
    } }, 10);
    expect(engine.nodeActOf("a")).toBeGreaterThan(1);
    expect(engine.heatOf("e0", 10)).toBeNull();
  });

  it("expand 只激活精确关系边并按 100ms 错峰", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: [], edge_ids: ["e0", "e1"], source_ids: ["a"], role: "expand",
    } }, 10);
    expect(engine.heatOf("e0", 10)?.direction).toBe(1);
    expect(engine.heatOf("e1", 10)?.front).toBe(0);
    expect(engine.heatOf("e0", 11)?.front).toBeGreaterThan(0.8);
  });

  it("关系传播根据种子所在端点改变方向", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: [], edge_ids: ["e0"], source_ids: ["b"], role: "conflict",
    } }, 0);
    expect(engine.heatOf("e0", 0)?.direction).toBe(-1);
  });

  it("关系热力经历推进、保持、衰减与清理", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: [], edge_ids: ["e0"], role: "expand",
    } }, 0);
    expect(engine.heatOf("e0", 1)?.fade).toBe(1);
    expect(engine.heatOf("e0", 2.6)?.fade).toBeLessThan(1);
    expect(engine.heatOf("e0", 3.5)).toBeNull();
  });

  it("lens.begin 设置判断语义并点亮精确边", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "lens.begin", ts: 0, payload: {
      index: 1, name: "证据强度", node_ids: ["a"], edge_ids: ["e0"], source_ids: ["a"],
    } }, 0);
    expect(engine.lensLabel).toBe("透镜一 · 证据强度");
    expect(engine.nodeMotionOf("a")?.kind).toBe("lens");
    expect(engine.heatOf("e0", 0)).not.toBeNull();
  });

  it("session.idle 保证最短可读时长后柔和退出", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: ["a"], edge_ids: ["e0"], role: "expand",
    } }, 0);
    engine.handleEvent({ type: "session.idle", ts: 0, payload: {} }, 0.1);
    expect(engine.heatOf("e0", 0.1)).not.toBeNull();
    expect(engine.heatOf("e0", 1.7)).toBeNull();
    expect(engine.lensLabel).toBeNull();
    expect(engine.skillLabel).toBeNull();
  });

  it("节点激活按真实时间衰减", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: ["a"], edge_ids: [], role: "seed",
    } }, 0);
    const before = engine.nodeActOf("a");
    engine.decay(1);
    expect(engine.nodeActOf("a")).toBeLessThan(before);
  });

  it("card.read 形成独立读卡聚焦状态", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "card.read", ts: 0, payload: {
      card_id: "a", title: "利率传导机制",
    } }, 0);
    expect(engine.nodeActOf("a")).toBeCloseTo(0.9);
    expect(engine.nodeColorOf("a")).toEqual(THEME.colors.read);
    expect(engine.nodeMotionOf("a")?.kind).toBe("read");
    expect(engine.graphNarration().detail).toBe("利率传导机制");
  });

  it("card.read 保持 5.5 秒并在结束时清理", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "card.read", ts: 0, payload: {
      card_id: "a", title: "利率传导机制",
    } }, 10);
    engine.decay(5, 15);
    expect(engine.nodeMotionOf("a", 15.2)?.kind).toBe("read");
    expect(engine.nodeMotionOf("a", 15.49)).not.toBeNull();
    expect(engine.nodeMotionOf("a", 15.5)).toBeNull();
  });

  it("批量精读按真实卡片列表逐张出现", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "card.read", ts: 0, payload: {
      card_ids: ["a", "b"], title: "本次精读 2 张知识卡片",
    } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("read");
    expect(engine.nodeMotionOf("b", 10.1)).toBeNull();
    expect(engine.nodeMotionOf("b", 10 + THEME.timing.readStagger + 0.1)?.kind).toBe("read");
    expect(engine.graphNarration()).toMatchObject({ title: "正在逐张精读知识卡片" });
  });

  it("真实操作经队列逐步进入画布，后续事件不会被同一帧吞掉", () => {
    const engine = makeEngine();
    expect(engine.enqueueEvents([
      { type: "graph.hit", ts: 0, payload: { event_id: "queue:seed", node_ids: ["a"], edge_ids: [], role: "seed" } },
      { type: "card.read", ts: 0, payload: { event_id: "queue:read", card_id: "b", title: "B" } },
    ], 10)).toBe(true);
    expect(engine.pendingEventCount()).toBe(2);
    expect(engine.decay(0, 10)).toBe(true);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("seed");
    expect(engine.nodeMotionOf("b", 10.1)).toBeNull();
    expect(engine.pendingEventCount()).toBe(1);
    expect(engine.decay(0, 10 + THEME.timing.eventQueueGap - 0.01)).toBe(false);
    expect(engine.decay(0, 10 + gestureLifetime() - 0.01)).toBe(false);
    expect(engine.decay(0, 10 + gestureLifetime() + 0.01)).toBe(true);
    expect(engine.nodeMotionOf("b", 10 + gestureLifetime() + 0.1)?.kind).toBe("read");
  });

  it("同批召回节点以 120ms 微错峰入场", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: ["a", "b"], edge_ids: [], role: "seed",
    } }, 10);
    expect(engine.nodeActOf("a", 10.03)).toBeGreaterThan(0);
    expect(engine.nodeActOf("b", 10.03)).toBe(0);
    expect(engine.nodeActOf("b", 10.2)).toBeGreaterThan(0);
  });

  it("检索只显示全图扫描，不伪造命中节点", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "retrieve.query", ts: 0, payload: {
      query: "货币政策传导",
    } }, 0);
    expect(engine.graphNarration()).toMatchObject({ phase: "retrieving", title: "正在检索知识体" });
    expect(engine.searchMotion(0.2)?.alpha).toBeGreaterThan(0);
    expect(engine.nodeActOf("a", 0.2)).toBe(0);
    engine.handleEvent({ type: "graph.miss", ts: 0, payload: {} }, 0.25);
    expect(engine.graphNarration().phase).toBe("miss");
    expect(engine.searchMotion(0.3)?.missed).toBe(true);
  });

  it("统一上下文组装结果显示真实账户数量", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "context.ready", ts: 0, payload: {
      core_count: 3, conflict_count: 2, expansion_count: 4, material_count: 5,
    } }, 0);
    expect(engine.graphNarration()).toMatchObject({
      title: "检索上下文已组装", detail: "核心 3 · 冲突 2 · 扩展 4 · 质料 5",
    });
  });

  it("单独投影的第二跳关系按波次延迟启动", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.hit", ts: 0, payload: {
      node_ids: ["c"], edge_ids: ["e1"], source_ids: ["b"], role: "expand", depth: 2,
    } }, 10);
    expect(engine.heatOf("e1", 10)?.front).toBe(0);
    expect(engine.heatOf("e1", 10.2)?.front).toBe(0);
    expect(engine.heatOf("e1", 10.5)?.front).toBeGreaterThan(0);
  });

  it("graph.walk 只按真实层级依次传播并保留深度语义", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.walk", ts: 0, payload: {
      start_ids: ["a"], requested_depth: 3, reached_depth: 3,
      layers: [
        { depth: 1, node_ids: ["b"], edge_ids: ["e0"], source_ids: ["a"] },
        { depth: 2, node_ids: ["c"], edge_ids: ["e1"], source_ids: ["b"] },
        { depth: 3, node_ids: ["d"], edge_ids: ["e2"], source_ids: ["c"], truncated: true },
      ],
    } }, 10);
    expect(engine.heatOf("e0", 10)?.depth).toBe(1);
    expect(engine.heatOf("e1", 10.5)?.depth).toBe(2);
    expect(engine.heatOf("e2", 10.5)?.front).toBe(0);
    expect(engine.heatOf("e2", 10.95)?.depth).toBe(3);
    expect(engine.nodeMotionOf("d", 11)).toBeNull();
    expect(engine.heatOf("e1", 10.8)?.front).toBe(0);
    expect(engine.nodeMotionOf("d", 13.1)?.depth).toBe(3);
    expect(engine.graphNarration()).toMatchObject({
      title: "沿论证关系探索 3 跳",
      detail: "到达 3 跳 · 访问 3 张卡片 · 3 条关系 · 已按预算收束",
    });
  });

  it("待核验旧边会保留可见性，但不会伪装成可靠传播", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "graph.walk", ts: 0, payload: {
      start_ids: ["a"], requested_depth: 1, reached_depth: 1, plane: "argument",
      layers: [{ depth: 1, node_ids: ["b"], edge_ids: ["e0"], ready_edge_ids: [], legacy_edge_ids: ["e0"], source_ids: ["a"] }],
    } }, 10);
    expect(engine.heatOf("e0", 10.4)?.readiness).toBe("legacy");
    expect(engine.graphNarration().detail).toContain("含待核验旧边");
  });

  it("支持链寻张力先逐层推进，再用碰撞信号点亮真实反对边", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "insight.tension-trace", ts: 0, payload: {
      start_ids: ["a"], requested_depth: 5, reached_depth: 2,
      layers: [
        { depth: 1, node_ids: ["b"], edge_ids: ["e0"], source_ids: ["a"] },
        { depth: 2, node_ids: ["c"], edge_ids: ["e1"], source_ids: ["b"] },
      ],
      tension_node_ids: ["d"], tension_edge_ids: ["e2"], anchor_ids: ["c"],
      found: true, stop_reason: "tension_found",
    } }, 10);
    expect(engine.heatOf("e0", 10)?.signal).toBe("normal");
    expect(engine.heatOf("e2", 10.9)?.signal).toBe("tension");
    expect(engine.heatOf("e2", 11.2)?.front).toBe(0);
    expect(engine.nodeMotionOf("d", 13.1)?.kind).toBe("tension");
    expect(engine.graphNarration()).toMatchObject({ phase: "insight", title: "沿支持链发现首个张力" });
  });

  it("假设反转用独立翻面信号标记候选，且只激活事件中的真实边", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "insight.assumption-flip", ts: 0, payload: {
      source_ids: ["a"], candidate_ids: ["b"], edge_ids: ["e0"], stop_reason: "candidates_found",
    } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("inversion");
    expect(engine.nodeMotionOf("b", 10.3)?.kind).toBe("inversion");
    expect(engine.heatOf("e0", 10.3)?.signal).toBe("inversion");
    expect(engine.heatOf("e1", 10.3)).toBeNull();
    expect(engine.graphNarration()).toMatchObject({ phase: "insight", title: "正在反转关键假设" });
  });

  it("SSE 重放的相同事件只处理一次", () => {
    const engine = makeEngine();
    const event = { type: "graph.hit", ts: 0, payload: {
      event_id: "conv:scope:1", node_ids: ["a"], edge_ids: [], role: "seed",
    } };
    expect(engine.handleEvent(event, 0)).toBe(true);
    engine.decay(0.5, 1);
    const before = engine.nodeActOf("a", 1);
    expect(engine.handleEvent(event, 1)).toBe(false);
    expect(engine.nodeActOf("a", 1)).toBeCloseTo(before);
  });

  it("图拓扑热更新不丢失写入状态", () => {
    const engine = makeEngine();
    const eventNow = activationNow(120_000);
    engine.handleEvent({ type: "write.applied", ts: 0, payload: {
      created: ["new-card"], enriched: ["a"],
    } }, eventNow);
    engine.updateTopology([...EDGES, {
      id: "e2", from: "new-card", to: "a", kind: "relation",
      relation_type: "extends", bundle: "da",
    }]);
    const frameNow = activationNow(120_200);
    expect(engine.nodeMotionOf("new-card", frameNow)?.kind).toBe("created");
    expect(engine.nodeMotionOf("a", frameNow)?.kind).toBe("enriched");
  });

  it("Agent 失败形成明确终止状态而不是伪装完成", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "retrieve.query", ts: 0, payload: { query: "测试" } }, 0);
    engine.handleEvent({ type: "session.failed", ts: 0, payload: {
      reason: "talk-failed:TimeoutError",
    } }, 1);
    expect(engine.graphNarration()).toMatchObject({
      phase: "failed", title: "本轮知识调用中断", detail: "模型或知识服务响应超时",
    });
  });

  it("证据角色使用不同节点动作，且不制造关系传播", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "evidence.inspect", ts: 0, payload: {
      roles: { support: ["a"], counter: ["b"], boundary: ["c"] }, claim_count: 2,
    } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("evidence-support");
    expect(engine.nodeMotionOf("b", 10.3)?.kind).toBe("evidence-counter");
    expect(engine.nodeMotionOf("c", 10.5)?.kind).toBe("evidence-boundary");
    expect(engine.heatOf("e0", 10.5)).toBeNull();
    expect(engine.graphNarration()).toMatchObject({ title: "正在审视证据结构" });
  });

  it("锚点核验区分通过与失败，充分性区分闭合与缺口", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "evidence.verify", ts: 0, payload: {
      valid_ids: ["a"], invalid_ids: ["b"], all_valid: false,
    } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("verify-valid");
    expect(engine.nodeMotionOf("b", 10.1)?.kind).toBe("verify-invalid");
    expect(engine.graphNarration()).toMatchObject({ title: "证据锚点存在缺口" });

    engine.handleEvent({ type: "cognition.sufficiency", ts: 0, payload: {
      node_ids: ["a", "b"], ready: true, missing: [],
    } }, 11);
    expect(engine.nodeMotionOf("a", 11.1)?.kind).toBe("verify-valid");
    expect(engine.nodeMotionOf("a", 12.8)?.kind).toBe("sufficient");
    expect(engine.graphNarration()).toMatchObject({ title: "证据已经足够，正在收束" });
  });

  it("论证、比较、类比和诊断不再共用同一种节点动作", () => {
    const cases = [
      ["argument", "argument"], ["compare", "compare"], ["analogy", "analogy"], ["audit", "audit"],
    ] as const;
    for (const [lensKind, expectedKind] of cases) {
      const engine = makeEngine();
      engine.handleEvent({ type: "lens.begin", ts: 0, payload: {
        index: 1, name: lensKind, node_ids: ["a"], edge_ids: lensKind === "analogy" ? [] : ["e0"],
        source_ids: ["a"], lens_kind: lensKind,
      } }, 10);
      expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe(expectedKind);
      if (lensKind === "analogy") expect(engine.heatOf("e0", 10.1)).toBeNull();
    }
  });

  it("关系模拟和待确认提案停留在幽灵端点层", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "relation.simulate", ts: 0, payload: {
      node_ids: ["a", "b"], source_id: "a", target_id: "b", decision: "change", relation_type: "supports",
    } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("simulation");
    expect(engine.nodeMotionOf("b", 10.3)?.kind).toBe("simulation");
    expect(engine.heatOf("e0", 10.1)).toBeNull();
    expect(engine.graphNarration()).toMatchObject({ title: "正在幽灵层预演关系" });
  });

  it("来源追溯与普通精读使用不同动作，正式关系写入才沿真实边传播", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "evidence.trace", ts: 0, payload: { card_id: "a", title: "材料 A" } }, 10);
    expect(engine.nodeMotionOf("a", 10.1)?.kind).toBe("source");

    engine.handleEvent({ type: "relation.applied", ts: 0, payload: {
      edge_ids: ["e0"], source_id: "a", target_id: "b", decision: "upsert", relation_type: "supports",
    } }, 11);
    expect(engine.heatOf("e0", 11.1)).not.toBeNull();
    expect(engine.nodeMotionOf("b", 11.3)?.kind).toBe("enriched");
    expect(engine.graphNarration()).toMatchObject({ title: "知识关系已写入" });
  });

  it("后台恢复只消费一个事件，随后保留完整精读窗口", () => {
    const engine = makeEngine();
    engine.enqueueEvents([
      { type: "card.read", ts: 0, payload: { card_id: "a" } },
      { type: "evidence.verify", ts: 0, payload: { valid_ids: ["a"] } },
      { type: "session.idle", ts: 0, payload: {} },
    ], 0);
    engine.decay(0, 100);
    expect(engine.pendingEventCount()).toBe(2);
    expect(engine.graphNarration().detail).toContain("操作回放");
    engine.decay(0, 100.1);
    expect(engine.pendingEventCount()).toBe(2);
    expect(engine.nodeMotionOf("a", 105)?.kind).toBe("read");
    engine.decay(0, 105.6);
    expect(engine.nodeMotionOf("a", 105.8)?.kind).toBe("verify-valid");
  });

  it("未来动作和边反馈不会遮掉当前精读，标题只属于精读", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "card.read", ts: 0, payload: { card_id: "a" } }, 10);
    engine.handleEvent({ type: "evidence.verify", ts: 0, payload: { valid_ids: ["a"] } }, 11);
    engine.pokeFromRenderer("a", 2, 11.5);
    expect(engine.nodeMotionOf("a", 12)?.kind).toBe("read");
    expect(engine.readingFocus(12)?.id).toBe("a");
    expect(engine.nodeMotionOf("a", 15.6)?.kind).toBe("verify-valid");
    expect(engine.readingFocus(15.6)).toBeNull();
  });

  it("关系候选线仅属于临时叠加层，失败会立即清理所有候选动作", () => {
    const engine = makeEngine();
    engine.handleEvent({ type: "relation.simulate", ts: 0, payload: { source_id: "a", target_id: "b", decision: "remove" } }, 10);
    expect(engine.overlaysAt(11)).toMatchObject([{ kind: "simulation", sourceId: "a", targetId: "b", decision: "remove" }]);
    expect(engine.heatOf("e0", 11)).toBeNull();
    engine.enqueueEvent({ type: "session.failed", ts: 0, payload: {} }, 11);
    expect(engine.overlaysAt(11.1)).toEqual([]);
    expect(engine.nodeMotionOf("a", 11.1)).toBeNull();
  });
});
