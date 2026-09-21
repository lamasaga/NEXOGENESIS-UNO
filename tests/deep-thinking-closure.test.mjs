import { fileURLToPath } from "node:url";
// 深入思考测试必须按可观察顺序执行搜集、分析、受控认知偏移、类比、反例与证据闭合。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generalAnalysisReadiness } from "../packages/nexogenesis-tools/lib/cognition/general-analysis.js";
import { OperatorRegistry } from "../packages/nexogenesis-tools/lib/cognition/operator-registry.js";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { ThinkingModelRegistry } from "../packages/nexogenesis-tools/lib/cognition/thinking-models.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "nexo-deep-thinking-"));
try {
  const skill = readFileSync(join(projectRoot, ".agent", "skills", "nexo-deep-think", "SKILL.md"), "utf8");
  assert.match(skill, /execution_profile="deep-think-v1"/);
  assert.match(skill, /select_thinking_model\(id="deep-inquiry"\)/);
  assert.match(skill, /完成后重复调用 finish/);

  const model = new ThinkingModelRegistry(projectRoot).load().get("deep-inquiry");
  assert.ok(model, "deep-inquiry TM 必须可加载");
  const registry = new OperatorRegistry();
  for (const [name, capabilities] of [
    ["retrieve", ["retrieve-candidates", "plan-retrieval-context"]],
    ["read_card", ["read-card", "read-evidence-slice"]],
    ["read_cards", ["read-card", "read-evidence-slice", "batch-read"]],
    ["graph_walk", ["trace-argument-paths"]],
    ["inspect_argument", ["inspect-argument"]],
    ["compare_cards", ["compare-semantic-dimensions"]],
    ["trace_support_to_tension", ["trace-support-to-tension", "insight-probe"]],
    ["probe_assumption_inversion", ["probe-assumption-inversion", "insight-probe"]],
    ["graph_analogize", ["analogize-cross-domain"]],
    ["inspect_conflicts", ["inspect-conflict-neighborhood"]],
    ["inspect_evidence_set", ["inspect-evidence-set"]],
    ["verify_evidence_anchors", ["verify-evidence-anchors"]],
    ["inspect_cognitive_sufficiency", ["inspect-analysis-sufficiency"]]
  ]) registry.register({ name, version: "test", capabilities, mode: "read", risk: "low", cost: "low" });

  const runtime = new CognitiveRuntime(root);
  const { run } = runtime.start({
    session_id: "deep-session", mode: "general", skill: "nexo-deep-think", goal: "测试深入思考闭环",
    scope: { analysis_depth: "iterative", structure_need: "required", execution_profile: "deep-think-v1", complexity_level: "deep" }
  });
  runtime.selectThinkingModel(run.run_id, model, new ThinkingModelRegistry(projectRoot).load().capabilityCoverage(model, registry));
  const record = (operator, data, evidence = []) => runtime.record(run.run_id, {
    action: { operator, mode: "read" },
    observation: { operator, status: "ok", summary: `${operator} 完成`, data: operator === "read_card" ? { ...data, reading: { coverage: "full" } } : operator === "read_cards" ? { ...data, results: data.results.map((item) => ({ ...item, reading: { coverage: "full" } })) } : data, evidence }
  });

  record("retrieve", { nodes: [{ id: "焦点卡" }] });
  record("retrieve", { nodes: [{ id: "异议卡" }] });
  record("graph_walk", {
    requested_hops: 2, reached_hops: 2,
    nodes: [{ id: "近邻卡", hop: 1 }, { id: "二跳卡", hop: 2 }]
  });
  for (const id of ["焦点卡", "二跳卡", "机制卡"]) record("read_card", { id }, [{ card_id: id }]);

  let readiness = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.ok(readiness.missing.includes("argument_inspection"));
  assert.equal(readiness.progress.deep_thinking.retrievals_before_analysis, 2);
  assert.equal(readiness.progress.deep_thinking.distinct_reads_before_analysis, 3);

  record("inspect_argument", { start: "焦点卡", boundaries: "只在特定条件下成立" });
  record("compare_cards", { compared: ["焦点卡", "机制卡"] });
  readiness = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.ok(readiness.missing.includes("controlled_insight_probe"), "机制比较后必须尝试一次受控认知偏移");

  record("trace_support_to_tension", {
    start: "焦点卡", stop_reason: "tension_found",
    tension: { opponent_ids: ["张力卡"], conflict_card_ids: [], node_ids: ["张力卡"] }
  });
  readiness = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.ok(readiness.missing.includes("insight_candidate_read"), "特殊 OPS 返回的张力候选未经精读不能交差");
  record("read_card", { id: "张力卡" }, [{ card_id: "张力卡" }]);
  record("graph_analogize", { start: "焦点卡", nodes: [{ id: "类比卡" }] });
  readiness = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.ok(readiness.missing.includes("analogy_candidate_read"), "类比候选未经精读不能交差");

  record("read_card", { id: "类比卡" }, [{ card_id: "类比卡" }]);
  record("inspect_conflicts", { start: "焦点卡", parties: ["异议卡"] });
  record("read_cards", { results: [{ card_id: "异议卡" }, { card_id: "边界卡" }] }, [{ card_id: "异议卡" }, { card_id: "边界卡" }]);
  const evidenceItems = [
    { anchor: "焦点卡", card_id: "焦点卡", role: "support", claim_id: "claim-1", usable: true },
    { anchor: "异议卡", card_id: "异议卡", role: "counter", claim_id: "claim-1", usable: true },
    { anchor: "边界卡", card_id: "边界卡", role: "boundary", claim_id: "claim-1", usable: true }
  ];
  record("inspect_evidence_set", { roles_present: ["support", "counter", "boundary"], uncovered_claims: [], results: evidenceItems });
  record("verify_evidence_anchors", { results: evidenceItems });

  runtime.updateWorkspace(run.run_id, {
    hypotheses: [{ id: "claim-1", statement: "焦点判断只在特定范围成立", status: "supported", scope: "合成样本，不外推", uncertainty: "现实适配尚待核验", anchors: ["焦点卡", "异议卡", "边界卡"] }],
    extension: { insight_reviews: [
      { operation_step: runtime.get(run.run_id).episode.steps.find((step) => step.action.operator === "trace_support_to_tension").step, outcome: "unchanged", finding: "候选未推翻限定判断", anchors: ["张力卡"], next_check: "还需现实样本验证" },
      { operation_step: runtime.get(run.run_id).episode.steps.find((step) => step.action.operator === "graph_analogize").step, outcome: "inconclusive", finding: "有结构对应但无实证", anchors: ["类比卡"], next_check: "检查边界差异", mapping: "反馈环节对应", break_point: "对象和制度不同" }
    ] }
  });

  readiness = generalAnalysisReadiness(runtime.get(run.run_id), registry);
  assert.equal(readiness.ready, true, readiness.missing.join(","));
  assert.equal(readiness.progress.deep_thinking.insight_operator, "trace_support_to_tension");
  assert.equal(readiness.progress.deep_thinking.insight_candidate_read, true);
  assert.equal(readiness.progress.deep_thinking.analogy_candidate_read, true);
  assert.equal(readiness.progress.deep_thinking.counter_read_after_conflict, true);
  assert.equal(readiness.progress.distinct_read_targets, 7);

  record("inspect_cognitive_sufficiency", readiness);
  assert.equal(generalAnalysisReadiness(runtime.get(run.run_id), registry, { require_sufficiency_observation: true }).ready, true);
  console.log("PASS deep thinking enforces ordered TM/OPS observations and evidence closure");
} finally {
  rmSync(root, { recursive: true, force: true });
}
