// 复杂普通问答必须形成可观察状态，并在 TM、图、证据和停止条件闭合后完成。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generalAnalysisReadiness } from "../packages/nexogenesis-tools/lib/cognition/general-analysis.js";
import { OperatorRegistry } from "../packages/nexogenesis-tools/lib/cognition/operator-registry.js";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";

const root = mkdtempSync(join(tmpdir(), "nexo-general-closure-"));
try {
  const runtime = new CognitiveRuntime(root);
  const registry = new OperatorRegistry();
  const descriptors = [
    ["retrieve", ["retrieve-candidates"]],
    ["read_card", ["read-card", "read-evidence-slice"]],
    ["graph_walk", ["traverse-graph"]],
    ["compare_cards", ["compare-semantic-dimensions"]],
    ["inspect_evidence_set", ["inspect-evidence-set"]],
    ["verify_evidence_anchors", ["verify-evidence-anchors"]],
    ["inspect_cognitive_sufficiency", ["inspect-analysis-sufficiency"]]
  ];
  for (const [name, capabilities] of descriptors) registry.register({ name, version: "test", capabilities, mode: "read", risk: "low", cost: "low" });

  const { run } = runtime.start({
    session_id: "session-general", mode: "general", skill: "nexo-talk", goal: "比较两个危机机制",
    scope: { analysis_depth: "iterative", structure_need: "required" },
    budget: { max_steps: 24, max_reads: 20, max_writes: 0 }
  });
  runtime.selectThinkingModel(run.run_id, {
    id: "test-model", version: "1.0.0", purpose: "测试闭合", applicable_modes: ["general"],
    required_capabilities: ["retrieve-candidates", "read-evidence-slice", "compare-semantic-dimensions", "inspect-evidence-set", "verify-evidence-anchors"],
    observation_obligations: [
      { role: "精读两个对象", accepted_capabilities: ["read-evidence-slice"], minimum_observations: 2, minimum_distinct_targets: 2, require_full_read: true },
      { role: "比较两个对象", accepted_capabilities: ["compare-semantic-dimensions"], minimum_distinct_targets: 2 },
      { role: "检查证据", accepted_capabilities: ["inspect-evidence-set"] },
      { role: "核验证据", accepted_capabilities: ["verify-evidence-anchors"] }
    ], evidence_roles: ["support", "counter", "boundary"], output_obligations: ["evidence_anchors"], stop_conditions: ["证据闭合"]
  });

  const record = (operator, data, evidence = []) => runtime.record(run.run_id, {
    action: { operator, mode: "read" }, observation: { operator, status: "ok", summary: `${operator} 完成`, data: operator === "read_card" ? { ...data, reading: { coverage: "full" } } : data, evidence }
  });
  record("retrieve", { results: [{ card_id: "焦点卡" }] });
  record("graph_walk", {
    requested_hops: 2, reached_hops: 2,
    nodes: [{ id: "近邻卡", hop: 1 }, { id: "二跳卡", hop: 2 }]
  });
  record("read_card", { id: "焦点卡" }, [{ card_id: "焦点卡" }]);
  record("read_card", { id: "二跳卡" }, [{ card_id: "二跳卡" }]);
  record("compare_cards", { compared: ["焦点卡", "二跳卡"] });
  const items = [
    { anchor: "焦点卡", card_id: "焦点卡", role: "support", claim_id: "claim-1", usable: true },
    { anchor: "二跳卡", card_id: "二跳卡", role: "counter", claim_id: "claim-1", usable: true }
  ];
  record("inspect_evidence_set", { roles_present: ["support", "counter"], uncovered_claims: [], results: items });
  record("verify_evidence_anchors", { results: items });

  let state = runtime.get(run.run_id);
  const readiness = generalAnalysisReadiness(state, registry);
  assert.equal(readiness.ready, true, readiness.missing.join(","));
  assert.equal(readiness.progress.graph.read_hop2_card, true);
  assert.equal(readiness.evidence_anchors.length, 2);
  assert.ok(state.workspace.observed_nodes.some((item) => item.card_id === "二跳卡" && item.hop === 2));
  assert.ok(state.workspace.evidence.length > 0, "观察与核验证据应自动投影到 Workspace");
  assert.ok(state.workspace.counter_evidence.some((item) => item.role === "counter"));

  record("inspect_cognitive_sufficiency", readiness);
  state = runtime.get(run.run_id);
  assert.equal(state.workspace.extension.checkpoint.phase, "sufficient");
  assert.equal(generalAnalysisReadiness(state, registry, { require_sufficiency_observation: true }).ready, true);

  record("read_card", { id: "新增卡" }, [{ card_id: "新增卡" }]);
  state = runtime.get(run.run_id);
  const stale = generalAnalysisReadiness(state, registry, { require_sufficiency_observation: true });
  assert.equal(stale.ready, false, "新增知识观察后，旧的充分性结论必须失效");
  assert.ok(stale.missing.includes("fresh_sufficiency_check"));

  runtime.updateWorkspace(run.run_id, { scope: { analysis_depth: "iterative", structure_need: "required", complexity_level: "deep" } });
  const deep = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.ok(deep.missing.includes("boundary_evidence"), "deep 档必须同时检查反证与边界");
  assert.ok(deep.missing.includes("distinct_read_targets"), "deep 档必须精读更多不同对象，而不是只增加候选数量");
  console.log("PASS iterative general analysis closes observable state, graph, evidence, and sufficiency");
} finally {
  rmSync(root, { recursive: true, force: true });
}
