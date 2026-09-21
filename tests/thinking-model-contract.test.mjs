import { fileURLToPath } from "node:url";
// Thinking Model 必须能在真实 Operator 契约上闭合，不能只是可选提示文件。
import assert from "node:assert/strict";
import { missingModelCapabilities, modelRequirementStatus, observationSatisfiesCapability, ThinkingModelRegistry } from "../packages/nexogenesis-tools/lib/cognition/thinking-models.js";
import { OperatorRegistry } from "../packages/nexogenesis-tools/lib/cognition/operator-registry.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = new OperatorRegistry();
const capabilityGroups = [
  ["retrieve-candidates"], ["read-card", "read-evidence-slice"], ["write-buffer"],
  ["inspect-source-map", "extract-epub-text", "extract-pdf-text"], ["audit-source-coverage"],
  ["inspect-compile-checkpoint"], ["resume-compile-checkpoint"], ["inspect-domain-members"],
  ["inspect-unconnected-cards"], ["inspect-integration-candidates"], ["record-structure-review"],
  ["inspect-knowledge-gap"], ["plan-knowledge-improvement"], ["verify-knowledge-improvement"],
  ["simulate-domain-split"], ["reassign-domain-members"],
  ["assign-domain-members"], ["retire-domain"], ["digest-semantic-patch"],
  ["inspect-knowledge-structure"], ["inspect-relation-case"], ["simulate-relation-patch", "inspect-structural-impact"],
  ["inspect-argument"], ["trace-argument-paths"], ["propose-relation-change"],
  ["trace-support-to-tension", "probe-assumption-inversion", "insight-probe"],
  ["compare-neighborhood", "compare-claims", "compare-semantic-dimensions", "analogize-cross-domain"], ["inspect-conflict-neighborhood"], ["trace-source"],
  ["inspect-evidence-set"], ["verify-evidence-anchors"], ["inspect-checkpoint-update"], ["read-cognitive-workspace"]
];
for (const [index, capabilities] of capabilityGroups.entries()) {
  registry.register({ name: `op-${index}`, version: "test", capabilities, mode: "read", risk: "low", cost: "low" });
}
const models = new ThinkingModelRegistry(root).load();
for (const model of models.list()) {
  const coverage = models.capabilityCoverage(model, registry);
  assert.equal(coverage.available, true, `${model.id}: ${coverage.missing.join(",")}`);
}
const incomplete = models.capabilityCoverage(models.get("candidate-assimilation"), new OperatorRegistry());
assert.deepEqual(incomplete.missing.sort(), ["digest-semantic-patch", "read-evidence-slice", "retrieve-candidates"].sort());

const evidenceRegistry = new OperatorRegistry();
evidenceRegistry.register({ name: "reader", version: "test", capabilities: ["read-evidence-slice"], mode: "read", risk: "low", cost: "low" });
const state = {
  run: { thinking_model: { required_capabilities: ["read-evidence-slice"], selected_at_step: 0 } },
  episode: { steps: [{ step: 1, action: { operator: "reader" }, observation: { status: "rejected", reason_code: "missing_card" } }] }
};
assert.deepEqual(missingModelCapabilities(state, evidenceRegistry), ["read-evidence-slice"], "拒绝回执不能满足 Thinking Model 能力");
state.episode.steps.push({ step: 2, action: { operator: "reader" }, observation: { status: "partial", data: { nodes: [] } } });
assert.deepEqual(missingModelCapabilities(state, evidenceRegistry), [], "真实空结果也可以是有效观察");
assert.equal(observationSatisfiesCapability({ status: "partial", data: { misuse: "wrong channel" } }), false);

const semanticRegistry = new OperatorRegistry();
semanticRegistry.register({ name: "compare", version: "test", capabilities: ["compare-semantic-dimensions"], mode: "read", risk: "low", cost: "low" });
semanticRegistry.register({ name: "verify_evidence_anchors", version: "test", capabilities: ["verify-evidence-anchors"], mode: "read", risk: "low", cost: "low" });
const semanticState = {
  run: { thinking_model: {
    required_capabilities: ["compare-semantic-dimensions"], selected_at_step: 1,
    observation_obligations: [{ role: "比较两个对象", accepted_capabilities: ["compare-semantic-dimensions"], minimum_distinct_targets: 2 }],
    output_obligations: ["evidence_anchors"]
  } },
  workspace: { scope: {} },
  episode: { steps: [
    { step: 1, action: { operator: "compare" }, observation: { status: "ok", data: { compared: ["旧甲", "旧乙"] } } },
    { step: 2, action: { operator: "compare" }, observation: { status: "ok", data: { compared: ["甲"] } } }
  ] }
};
let semanticStatus = modelRequirementStatus(semanticState, semanticRegistry, { evidence_anchors: [] });
assert.equal(semanticStatus.unmet_observation_obligations.length, 1, "切换 TM 前的对象不能替新模型满足义务");
semanticState.episode.steps.push({ step: 3, action: { operator: "compare" }, observation: { status: "ok", data: { compared: ["甲", "乙"] } } });
semanticState.episode.steps.push({ step: 4, action: { operator: "verify_evidence_anchors" }, observation: { status: "ok", data: { results: [{ anchor: "甲", role: "support", claim_id: "c1", usable: true }] } } });
semanticStatus = modelRequirementStatus(semanticState, semanticRegistry, { evidence_anchors: [{ anchor: "甲", role: "support", claim_id: "c1" }] });
assert.deepEqual(semanticStatus, { missing_capabilities: [], unmet_observation_obligations: [], missing_output_obligations: [] });
console.log(`PASS ${models.list().length} Thinking Models have executable capability closure`);
