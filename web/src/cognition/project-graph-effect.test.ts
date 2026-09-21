import { describe, expect, it } from "vitest";
import type { CognitiveEpisodeStep, CognitiveEvent } from "../api/client";
import type { GraphEdge } from "../graph/types";
import { projectEpisodeStep, projectGraphEffects } from "./project-graph-effect";

function event(overrides: Partial<CognitiveEvent> = {}): CognitiveEvent {
  return {
    schema_version: "1.0", event_id: "event-1", session_id: "session-1", run_id: "run-1",
    at: "2026-08-27T00:00:00.000Z", kind: "op.observed",
    operator: { name: "graph_walk", mode: "read" },
    targets: {
      node_ids: ["card-b", "card-c"], edge_ids: ["edge-a-b", "edge-b-c"], source_ids: ["card-a"],
      walk_requested_depth: 2, walk_reached_depth: 2, graph_plane: "argument",
      walk_layers: [
        { depth: 1, node_ids: ["card-b"], edge_ids: ["edge-a-b"], ready_edge_ids: ["edge-a-b"], legacy_edge_ids: [], source_ids: ["card-a"] },
        { depth: 2, node_ids: ["card-c"], edge_ids: ["edge-b-c"], ready_edge_ids: ["edge-b-c"], legacy_edge_ids: [], source_ids: ["card-b"], truncated: true },
      ],
    },
    observation: { status: "ok", summary: "沿一条支撑关系读取到两张卡片。" },
    presentation: { title: "沿论证关系展开", detail: "读取完成", tone: "active" },
    ...overrides,
  };
}

describe("projectGraphEffects", () => {
  it("将真实 graph_walk 逐层投影为 1/2/3 跳传播波次", () => {
    const [effect] = projectGraphEffects(event());
    expect(effect).toMatchObject({
      type: "graph.walk",
      payload: {
        start_ids: ["card-a"], requested_depth: 2, reached_depth: 2,
        plane: "argument",
        layers: [
          { depth: 1, node_ids: ["card-b"], edge_ids: ["edge-a-b"] },
          { depth: 2, node_ids: ["card-c"], edge_ids: ["edge-b-c"], truncated: true },
        ],
      },
    });
  });

  it("graph_path 复用逐跳传播，inspect_argument 使用论证透镜", () => {
    const [path] = projectGraphEffects(event({ operator: { name: "graph_path", mode: "read" } }));
    expect(path.type).toBe("graph.walk");
    const [argument] = projectGraphEffects(event({
      operator: { name: "inspect_argument", mode: "read" },
      targets: { node_ids: ["card-a", "card-b"], edge_ids: ["edge-a-b"], source_ids: ["card-a"] },
    }));
    expect(argument).toMatchObject({ type: "lens.begin", payload: { lens_kind: "argument" } });
  });

  it("读取失败不会伪造读卡或命中动画", () => {
    const effects = projectGraphEffects(event({
      operator: { name: "read_card", mode: "read" },
      observation: { status: "error", summary: "卡片不存在" },
    }));
    expect(effects).toHaveLength(1);
    expect(effects[0].type).toBe("session.failed");
  });

  it("批量精读投影全部已观察卡片，而不是只显示首张", () => {
    const [read] = projectGraphEffects(event({
      operator: { name: "read_cards", mode: "read" },
      targets: { node_ids: ["card-a", "card-b", "card-c"], edge_ids: [] },
      observation: { status: "ok", summary: "批量精读 3/3 张卡片。" },
    }));
    expect(read).toMatchObject({
      type: "card.read",
      payload: { card_ids: ["card-a", "card-b", "card-c"], title: "本次精读 3 张知识卡片" },
    });
  });

  it("支持链寻张力投影专用碰撞事件和真实张力目标", () => {
    const [effect] = projectGraphEffects(event({
      operator: { name: "trace_support_to_tension", mode: "read" },
      targets: {
        node_ids: ["card-b", "card-c", "card-d"], edge_ids: ["edge-a-b", "edge-b-c", "edge-c-d"],
        source_ids: ["card-a"], walk_requested_depth: 5, walk_reached_depth: 2,
        walk_layers: [
          { depth: 1, node_ids: ["card-b"], edge_ids: ["edge-a-b"], source_ids: ["card-a"] },
          { depth: 2, node_ids: ["card-c"], edge_ids: ["edge-b-c"], source_ids: ["card-b"] },
        ],
        insight_tension_node_ids: ["card-d"], insight_tension_edge_ids: ["edge-c-d"],
        insight_anchor_ids: ["card-c"], insight_stop_reason: "tension_found",
      },
    }));
    expect(effect).toMatchObject({
      type: "insight.tension-trace",
      payload: { reached_depth: 2, tension_node_ids: ["card-d"], tension_edge_ids: ["edge-c-d"], found: true },
    });
  });

  it("假设反转只把已观察候选和已存在边投影为翻面事件", () => {
    const [effect] = projectGraphEffects(event({
      operator: { name: "probe_assumption_inversion", mode: "read" },
      targets: {
        node_ids: ["card-a", "card-b"], edge_ids: ["edge-a-b"], source_ids: ["card-a"],
        insight_candidate_ids: ["card-b"], insight_stop_reason: "candidates_found",
      },
    }));
    expect(effect).toMatchObject({
      type: "insight.assumption-flip",
      payload: { source_ids: ["card-a"], candidate_ids: ["card-b"], edge_ids: ["edge-a-b"] },
    });
  });

  it("确认写入只投影 Harness 已回执的真实创建和丰富结果", () => {
    const [effect] = projectGraphEffects(event({
      kind: "write.applied",
      operator: { name: "user_write_decision", mode: "runtime-write" },
      targets: { created: ["new-card"], enriched: ["card-a"] },
      observation: { status: "ok", summary: "已原子写入。" },
    }));
    expect(effect).toMatchObject({ type: "write.applied", payload: { created: ["new-card"], enriched: ["card-a"] } });
  });

  it("Thinking Model 和来源追溯使用独立且不伪造关系的视觉语义", () => {
    const [tm] = projectGraphEffects(event({
      kind: "tm.selected", operator: { name: "select_thinking_model", mode: "runtime-write" },
      targets: {}, observation: { status: "ok", summary: "选择证据三角校验。" },
      presentation: { title: "选择思考模型", detail: "evidence-triangulation", tone: "active" },
    }));
    expect(tm.type).toBe("thinking.model");

    const [source] = projectGraphEffects(event({
      operator: { name: "trace_source", mode: "read" }, targets: { node_ids: ["card-a"], edge_ids: [] },
      observation: { status: "ok", summary: "已定位原始来源。" },
    }));
    expect(source).toMatchObject({ type: "evidence.trace", payload: { card_id: "card-a" } });
    expect(source.payload).not.toHaveProperty("edge_ids");
  });

  it("结构问题扫描只点亮真实返回的候选节点", () => {
    const [audit] = projectGraphEffects(event({
      operator: { name: "inspect_structure_issues", mode: "read" },
      targets: { node_ids: ["card-b", "card-c"], edge_ids: [] },
      observation: { status: "partial", summary: "发现两项局部结构问题。" },
      presentation: { title: "扫描结构问题", detail: "发现两项候选", tone: "active" },
    }));
    expect(audit).toMatchObject({
      type: "lens.begin",
      payload: { node_ids: ["card-b", "card-c"], edge_ids: [], lens_kind: "audit" },
    });
  });

  it("证据集合、锚点核验和充分性拥有三种独立画布语义", () => {
    const [inspection] = projectGraphEffects(event({
      operator: { name: "inspect_evidence_set", mode: "read" },
      targets: {
        node_ids: ["card-a", "card-b", "card-c"],
        evidence_role_node_ids: { support: ["card-a"], counter: ["card-b"], boundary: ["card-c"] },
        evidence_claim_count: 2,
      },
    }));
    expect(inspection).toMatchObject({
      type: "evidence.inspect",
      payload: { roles: { support: ["card-a"], counter: ["card-b"], boundary: ["card-c"] }, claim_count: 2 },
    });

    const [verification] = projectGraphEffects(event({
      operator: { name: "verify_evidence_anchors", mode: "read" },
      targets: { evidence_valid_node_ids: ["card-a"], evidence_invalid_node_ids: ["card-b"], evidence_all_valid: false },
    }));
    expect(verification).toMatchObject({ type: "evidence.verify", payload: { valid_ids: ["card-a"], invalid_ids: ["card-b"], all_valid: false } });

    const [sufficiency] = projectGraphEffects(event({
      operator: { name: "inspect_cognitive_sufficiency", mode: "read" },
      targets: { sufficiency_node_ids: ["card-a"], sufficiency_ready: false, sufficiency_missing: ["counter_evidence"] },
    }));
    expect(sufficiency).toMatchObject({ type: "cognition.sufficiency", payload: { node_ids: ["card-a"], ready: false, missing: ["counter_evidence"] } });
  });

  it("比较与类比分开投影，类比不把候选关系伪造成图边", () => {
    const [comparison] = projectGraphEffects(event({
      operator: { name: "compare_cards", mode: "read" },
      targets: { node_ids: ["card-a", "card-b"], edge_ids: ["edge-a-b"] },
    }));
    expect(comparison).toMatchObject({ type: "lens.begin", payload: { lens_kind: "compare", edge_ids: ["edge-a-b"] } });

    const [analogy] = projectGraphEffects(event({
      operator: { name: "graph_analogize", mode: "read" },
      targets: { node_ids: ["card-a", "card-c"], edge_ids: ["edge-a-c"], source_ids: ["card-a"] },
    }));
    expect(analogy).toMatchObject({ type: "lens.begin", payload: { lens_kind: "analogy", edge_ids: [] } });
  });

  it("关系预演与待确认提案只标记端点，不伪造已提交关系", () => {
    const [simulation] = projectGraphEffects(event({
      operator: { name: "simulate_relation_patch", mode: "read" },
      targets: { node_ids: ["card-a", "card-b"], relation_source_id: "card-a", relation_target_id: "card-b", relation_decision: "change", relation_type: "supports" },
    }));
    expect(simulation).toMatchObject({ type: "relation.simulate", payload: { source_id: "card-a", target_id: "card-b", decision: "change" } });

    const [pending] = projectGraphEffects(event({
      kind: "proposal.created", operator: { name: "propose_relation_patch", mode: "proposal" },
      targets: { node_ids: ["card-a", "card-b"], relation_source_id: "card-a", relation_target_id: "card-b", relation_type: "supports" },
    }));
    expect(pending).toMatchObject({ type: "proposal.pending", payload: { source_id: "card-a", target_id: "card-b", relation_type: "supports" } });

    const [applied] = projectGraphEffects(event({
      kind: "write.applied", operator: { name: "propose_relation_patch", mode: "write" },
      targets: {
        node_ids: ["card-a", "card-b"], edge_ids: ["edge-a-b"],
        relation_source_id: "card-a", relation_target_id: "card-b", relation_decision: "upsert", relation_type: "supports",
      },
    }));
    expect(applied).toMatchObject({ type: "relation.applied", payload: { edge_ids: ["edge-a-b"], source_id: "card-a", target_id: "card-b" } });
  });

  it("从持久化 Episode 重放支持链时保留层级与张力目标", () => {
    const edges: GraphEdge[] = [
      { id: "edge-a-b", from: "card-a", to: "card-b", kind: "relation", relation_type: "supports", bundle: "d" },
      { id: "edge-b-c", from: "card-b", to: "card-c", kind: "relation", relation_type: "conflicts-with", bundle: "d" },
    ];
    const step = {
      step: 9, at: "2026-09-05T00:00:00.000Z",
      action: { operator: "trace_support_to_tension", mode: "read" },
      observation: { status: "ok", summary: "发现首个张力。", data: {
        start: "card-a", requested_depth: 5, reached_depth: 1, stop_reason: "tension_found",
        support_layers: [{ depth: 1, source_ids: ["card-a"], node_ids: ["card-b"], edges: [{ from: "card-a", to: "card-b", type: "supports" }] }],
        tension: { node_ids: ["card-c"], anchor_ids: ["card-b"], edges: [{ from: "card-b", to: "card-c", type: "conflicts-with" }] },
      } },
    } satisfies CognitiveEpisodeStep;
    const [effect] = projectEpisodeStep(step, "run-1", 0, edges);
    expect(effect).toMatchObject({
      type: "insight.tension-trace",
      payload: { layers: [{ edge_ids: ["edge-a-b"] }], tension_node_ids: ["card-c"], tension_edge_ids: ["edge-b-c"], stop_reason: "tension_found" },
    });
  });

  it("关系模拟重放使用真实裁决中的新方向，不回退到旧端点", () => {
    const step = {
      step: 1, at: "2026-09-05T00:00:00.000Z", action: { operator: "simulate_relation_patch", mode: "read" },
      observation: { status: "ok", summary: "预演反向关系", data: {
        source_id: "a", target_id: "b", nodes: [{ id: "a" }, { id: "b" }],
        adjudication: { decision: "change", proposed_relation: { from: "b", to: "a", type: "supports" } },
      } },
    } satisfies CognitiveEpisodeStep;
    expect(projectEpisodeStep(step, "run-1", 0)[0]).toMatchObject({ type: "relation.simulate", payload: { source_id: "b", target_id: "a", relation_type: "supports" } });
  });
});
