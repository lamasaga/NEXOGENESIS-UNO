import { expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { CognitiveRunSnapshot, WorkItem } from "../api/client";
import { AnalysisDeliveryCard } from "./AnalysisDeliveryCard";
import { presentWorkItem } from "./workPresentation";

const snapshot: CognitiveRunSnapshot = { run: { run_id: "r", mode: "general", status: "closed", step_count: 4, analysis_policy_version: "conversation-v2",
  delivery: { state: "delivered", coverage: "partial", review_ref: "f", message_ref: "s:9", limitations: [{ claim_id: "C2", code: "request_unfinished", detail: "历史预测未做事后检验" }] } },
  delivery_review: { fingerprint: "f", cautions: [], relation_findings: [{ claim_id: "C1", path: ["甲", "乙"], anchors: ["甲", "乙"], finding: "长期条件不同，不能直接接合", conditions: "国家、部门不同", outcome: "rejected", provenance: "observed_and_read", observation_step: 3, edges: [{ from: "甲", to: "乙", type: "supports", note: "只在条件相容时支持" }] }] },
  workspace: { goal: "比较机制", scope: {}, hypotheses: [], evidence: [], counter_evidence: [], open_questions: [], conflicts: [], candidate_actions: [], observed_nodes: [], deferred_items: [], budget: {} },
  episode: { episode_id: "e", steps: [] }, interaction: null,
};
it("shows partial request coverage and a real rejected composition without claiming semantic proof", () => {
  const html = renderToString(<AnalysisDeliveryCard snapshot={snapshot} />);
  for (const label of ["历史预测未做事后检验", "未采用", "国家、部门不同", "不是自动推导出的因果方向", "推断已被证明"]) expect(html).toContain(label);
  expect(html).not.toContain("研究已完成");
});
it("never renders unverified paths as clickable adopted evidence", () => {
  const altered = structuredClone(snapshot); altered.delivery_review!.relation_findings[0].provenance = "unverified";
  const html = renderToString(<AnalysisDeliveryCard snapshot={altered} />);
  expect(html).toContain("路径依据尚未核验"); expect(html).not.toContain("<button");
});
it("separates closed execution from delivered answers and real pending questions", () => {
  const item: WorkItem = { id: "s", title: "问题", stage: null, phase: "closed", executing: false, proposals: [], detail: "已停止", delivery: snapshot.run.delivery,
    outcome: "closed", goal: "比较机制", updated_at: "2026-09-08", can_continue: false, native_question: null, interaction: null };
  expect(presentWorkItem(item).label).toBe("已回答部分");
  expect(presentWorkItem({ ...item, delivery: { ...item.delivery!, state: "prepared" } }).label).toBe("本轮已结束");
  expect(presentWorkItem({ ...item, native_question: { rpc_id: "q", session_id: "s", live: false, questions: [] } }).kind).toBe("waiting");
});
