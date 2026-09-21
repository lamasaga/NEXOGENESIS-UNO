import { createHash } from "node:crypto";
import { inspectEvidenceSet } from "./evidence-inspection.js";
import { loadCards, parseCardFile } from "../cards.js";

export const CONVERSATION_POLICY = "conversation-v2";
export function isConversationAnalysis(state) {
  return state?.run?.analysis_policy_version === CONVERSATION_POLICY
    && ["general", "assess", "report"].includes(state.run.mode)
    && (state.run.mode !== "general" || state.workspace?.scope?.analysis_depth === "iterative");
}
export function isStrictAnalysis(skill, scope = {}) {
  return ["nexo-deep-think", "nexo-judge"].includes(skill)
    || scope.execution_profile || scope.allowed_ops || scope.as_of || scope.previous_output;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export function analysisFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

/** Public path claims reference actual observations; neither discovery nor reading proves semantics. */
export function reviewRelationFindings(state, findings, evidence, root) {
  const cards = root ? new Map(loadCards(root)) : null;
  const paths = [];
  for (const step of state.episode.steps) {
    if (!["graph_walk", "graph_path"].includes(step.action?.operator)
      || !["ok", "partial"].includes(step.observation?.status)) continue;
    const data = step.observation.data ?? {};
    if (data.error || data.misuse) continue;
    for (const path of data.paths ?? []) if (Array.isArray(path.node_ids)) paths.push({ path: path.node_ids, edges: path.edges ?? [], step: step.step });
    for (const node of data.nodes ?? []) {
      if (Array.isArray(node.path)) paths.push({ path: node.path, edges: node.path_edges ?? [], step: step.step });
    }
    if (Array.isArray(data.path) && data.path.every(id => typeof id === "string")) {
      paths.push({ path: data.path, edges: data.edges ?? [], step: step.step });
    }
  }
  return (findings ?? []).slice(0, 8).map(finding => {
    const match = paths.find(item => item.path.length >= 2 && item.edges.length === item.path.length - 1 && item.edges.every(edge => edge.ready === true) && JSON.stringify(item.path) === JSON.stringify(finding.path));
    const anchors = (finding.anchors ?? []).map(anchor => evidence.results.find(item => item.anchor === anchor && item.claim_id === finding.claim_id));
    const readPath = finding.path?.every(id => anchors.some(item => item?.card_id === id && item.usable));
    const currentEdges = match?.edges.every(edge => {
      if (!cards) return false;
      try { return (parseCardFile(cards.get(edge.from)?.file).meta.relations ?? []).some(relation => relation.target === edge.to
        && relation.type === (edge.declared_type ?? edge.type) && String(relation.note ?? "") === String(edge.note ?? "")); }
      catch { return false; }
    });
    return { ...finding, observation_step: match?.step ?? null, edges: match?.edges ?? [],
      provenance: match && currentEdges && anchors.length && anchors.every(item => item?.usable) && readPath ? "observed_and_read" : "unverified",
      semantic_status: "model_synthesis_not_certified" };
  });
}

/** One bounded deterministic review. Invalid evidence stays visible; method quotas are not delivery gates. */
export function reviewConversationDelivery(root, state, args) {
  if ((args.evidence_anchors?.length ?? 0) > 32 || (args.relation_findings?.length ?? 0) > 8) throw new Error("交付检查最多 32 个锚点、8 项关系发现；请聚焦关键判断。");
  const evidence = inspectEvidenceSet(root, state, args.evidence_anchors ?? []);
  const unresolved = [...(state.workspace.deferred_items ?? []), ...(state.workspace.conflicts ?? []), ...(state.workspace.open_questions ?? [])]
    .filter(item => !["resolved", "closed", "excluded", "rejected"].includes(item?.status));
  const limitations = [
    ...evidence.results.filter(item => !item.usable).map(item => ({ claim_id: item.claim_id, code: "anchor_not_verified", detail: `${item.anchor} 未通过当前版本与实际阅读核验，不能声明该引用已核验。` })),
    ...evidence.uncovered_claims.map(claim_id => ({ claim_id, code: "claim_not_grounded", detail: "此判断没有可用支持锚点；撤回、降为猜想或明确未验证。" })),
    ...(args.pending ?? []).map(detail => ({ claim_id: null, code: "request_unfinished", detail })),
    ...unresolved.map(item => ({ claim_id: item?.claim_id ?? null, code: "recorded_gap", detail: typeof item === "string" ? item : item.question ?? item.description ?? item.reason ?? "仍有未解决的冲突或待验证项。" })),
  ];
  const relations = reviewRelationFindings(state, args.relation_findings, evidence, root);
  for (const item of relations.filter(item => item.provenance !== "observed_and_read")) limitations.push({ claim_id: item.claim_id, code: "path_not_verified", detail: "关系发现未匹配本轮真实路径及逐节点阅读，不展示为已采用的可回查论证路径。" });
  const coverage = ["answered", "partial", "unanswered"].includes(args.coverage) ? args.coverage : "unknown";
  const review = {
    can_deliver: true, evidence, relation_findings: relations,
    coverage: coverage === "answered" && limitations.length ? "partial" : coverage,
    coverage_basis: "model_declared_with_deterministic_limits",
    limitations,
    cautions: [
      ...evidence.single_point_claims.map(claim_id => ({ claim_id, code: "source_dependence", detail: "单点或同源支撑，不能宣称独立验证。" })),
      ...evidence.role_review_needed.map(item => ({ ...item, code: "counter_role_needs_explanation" })),
    ],
    process_notes: ["不以 TM 调用配额、特殊 OPS、固定跳数或复盘字段阻断本轮交流；未做的验证仍是未做。"],
    next_actions: limitations.length ? ["补读或修正受影响的引用；也可撤回该声明并带缺口回答，不必消灭所有缺口。"] : ["直接回答原问题，保留来源立场与条件；本检查不认证最终自然语言全文。"],
  };
  // Exclude audit steps and presentation-only notes: checking must not invalidate its own key.
  review.fingerprint = analysisFingerprint({ root, run_id: state.run.run_id, turn: state.run.host_admission_id,
    policy: state.run.analysis_policy_version, original_request: state.run.original_request, goal: state.workspace.goal, scope: state.workspace.scope,
    claims: state.workspace.hypotheses, directives: state.workspace.user_directives, conflicts: state.workspace.conflicts,
    deferred: state.workspace.deferred_items, open_questions: state.workspace.open_questions,
    evidence: evidence.results, relations, coverage: args.coverage, pending: args.pending, stop_reason: args.stop_reason,
    observations: state.episode.steps.filter(step => step.action?.mode === "read" && !["inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency"].includes(step.action.operator)).map(step => ({ action: step.action, observation: step.observation })) });
  return review;
}
