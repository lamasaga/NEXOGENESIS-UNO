import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import {
  constructCompletionReadiness, constructRunAudit, constructWriteReadiness
} from "../packages/nexogenesis-tools/lib/cognition/construct-governance.js";

const root = mkdtempSync(join(tmpdir(), "nexo-construct-governance-"));
try {
  const runtime = new CognitiveRuntime(root);
  const { run } = runtime.start({
    session_id: "construct-session", mode: "construct", skill: "nexo-construct",
    goal: "修复一个局部关系问题", budget: { max_steps: 20, max_reads: 10, max_writes: 3 }
  });
  let state = runtime.get(run.run_id);
  assert.equal(constructWriteReadiness(state).reason_code, "construct_thinking_model_required");

  runtime.selectThinkingModel(run.run_id, {
    id: "relation-integrity-audit", version: "1.0.0", purpose: "测试",
    required_capabilities: [], stop_conditions: []
  }, { operators: {} });
  runtime.record(run.run_id, {
    action: { operator: "inspect_structure_issues", mode: "read" },
    observation: {
      status: "partial", summary: "发现一个关系问题。", data_digest: "audit-1",
      evidence: [{ card_id: "甲" }], data: {
        issues: [{ kind: "ghost_relation_target", card_id: "甲", target_id: "乙" }],
        cursor: 0, next_cursor: 12, issue_total: 24, totals: { ghost_relation_target: 24 }
      }
    }
  });
  runtime.updateWorkspace(run.run_id, { candidate_actions: ["核对甲到乙的关系后做最小修复"] });
  state = runtime.get(run.run_id);
  assert.equal(state.workspace.observed_nodes.length, 2, "真实 Observation 应自动投影到 observed_nodes");
  assert.equal(state.workspace.evidence.length, 1, "真实 Observation 应自动投影为可审计证据");
  assert.equal(state.workspace.extension.checkpoint.next_cursor, 12, "结构问题队列游标必须可恢复");
  assert.equal(constructWriteReadiness(state).ready, true);

  runtime.record(run.run_id, {
    action: { operator: "inspect_relation_case", mode: "read" },
    observation: {
      status: "ok", summary: "已形成关系案件。", data_digest: "case-1",
      evidence: [{ card_id: "甲" }, { card_id: "乙" }],
      data: { case_fingerprint: "case-fp", source_id: "甲", target_id: "乙", nodes: [{ id: "甲" }, { id: "乙" }] }
    }
  });
  runtime.record(run.run_id, {
    action: { operator: "simulate_relation_patch", mode: "simulate" },
    observation: {
      status: "ok", summary: "关系裁决与影响模拟通过。", data_digest: "simulation-1",
      evidence: [{ card_id: "甲" }, { card_id: "乙" }],
      data: {
        case_fingerprint: "case-fp", preflight_passed: true,
        requires_critical_review: false, critical_review_completed: true,
        adjudication: { decision: "remove", evidence: ["正文证据"], counterevidence: ["局部连通性下降"], risk_level: "low" },
        nodes: [{ id: "甲" }, { id: "乙" }]
      }
    }
  });
  state = runtime.get(run.run_id);
  assert.equal(constructWriteReadiness(state, { layer: "relation" }).ready, true, "关系写入必须有同版本案件和通过的模拟");

  runtime.record(run.run_id, {
    action: { operator: "propose_write", mode: "write", layer: "relation" },
    observation: {
      status: "ok", reason_code: "committed", summary: "已提交一个原子操作。",
      scope: { card_ids: ["甲"], layer: "relation" }, data: { operation_count: 1 }, data_digest: "write-1"
    }
  });
  state = runtime.get(run.run_id);
  assert.equal(constructCompletionReadiness(state).reason_code, "construct_post_write_check_required");

  runtime.record(run.run_id, {
    action: { operator: "graph_walk", mode: "read" },
    observation: {
      status: "ok", summary: "写后邻域已复核。", data_digest: "check-1",
      evidence: [{ card_id: "甲" }], data: { nodes: [{ id: "甲" }] }
    }
  });
  state = runtime.get(run.run_id);
	assert.equal(constructCompletionReadiness(state).reason_code, "construct_post_write_check_required", "无关读取不能替代原检测器复验");
  runtime.record(run.run_id, {
    action: { operator: "inspect_structure_issues", mode: "read" },
    observation: {
      status: "ok", summary: "原关系问题已消失。", data_digest: "check-2",
      evidence: [{ card_id: "甲" }], data: { issues: [], checked_card_ids: ["甲"], resolved_card_ids: ["甲"] }
    }
  });
  state = runtime.get(run.run_id);
  assert.equal(constructCompletionReadiness(state).ready, true);
	assert.equal(state.workspace.extension.post_write_checks.length, 2);
  assert.deepEqual(constructRunAudit(state), {
    step_count: 6, read_count: 4, graph_observation_count: 5,
    committed_transactions: 1, atomic_operations: 1,
    affected_card_count: 1, affected_cards: ["甲"],
    rejected_write_count: 0, rejected_reason_codes: [],
    improvement: null, rejected_observation_count: 0,
    issue_closure: { discovered: 0, fixed: 0, excluded: 0, deferred: 0, kept: 0, open: 0, reopened: 0, new_errors: 0 }
  });

  const isolated = runtime.start({
    session_id: "isolated-session", mode: "construct", skill: "nexo-construct",
    goal: "核对一张孤立卡", budget: { max_steps: 20, max_reads: 10, max_writes: 3 }
  });
  runtime.selectThinkingModel(isolated.run.run_id, {
    id: "isolated-card-integration", version: "1.1.0", purpose: "测试",
    required_capabilities: [], stop_conditions: []
  }, { operators: {} });
  runtime.record(isolated.run.run_id, {
    action: { operator: "inspect_unconnected_cards", mode: "read" },
    observation: { status: "ok", summary: "发现孤立卡。", data_digest: "isolated-scan", evidence: [{ card_id: "孤立甲" }], data: { scope: "without_relations", nodes: [{ id: "孤立甲" }] } }
  });
  runtime.record(isolated.run.run_id, {
    action: { operator: "inspect_integration_candidates", mode: "read" },
    observation: { status: "ok", summary: "已比较候选。", data_digest: "isolated-candidates", evidence: [{ card_id: "候选乙" }], data: { focus_card_id: "孤立甲", issue_scope: "without_relations", nodes: [{ id: "候选乙" }] } }
  });
  let isolatedState = runtime.get(isolated.run.run_id);
  assert.equal(constructCompletionReadiness(isolatedState).reason_code, "construct_disposition_required", "无写入孤立卡也必须留下处置");
  runtime.record(isolated.run.run_id, {
    action: { operator: "record_structure_review", mode: "runtime-write" },
    observation: { status: "ok", summary: "已记录暂时独立。", data_digest: "isolated-review", data: { card_id: "孤立甲", card_fingerprint: "fp", issue_kind: "without_relations", status: "intentionally_standalone" } }
  });
  isolatedState = runtime.get(isolated.run.run_id);
  assert.equal(constructCompletionReadiness(isolatedState).ready, true);

  const closureRun = runtime.start({
    session_id: "closure-session", mode: "construct", skill: "nexo-construct",
    goal: "延期一项证据不足的关系", budget: { max_steps: 20, max_reads: 10, max_writes: 3 }
  });
  runtime.selectThinkingModel(closureRun.run.run_id, {
    id: "relation-integrity-audit", version: "1.0.0", purpose: "测试",
    required_capabilities: [], stop_conditions: []
  }, { operators: {} });
  runtime.record(closureRun.run.run_id, {
    action: { operator: "inspect_structure_issues", mode: "read" },
    observation: { status: "ok", summary: "发现关系证据缺口。", data_digest: "closure-scan", evidence: [{ card_id: "甲" }, { card_id: "乙" }], data: {
      issues: [{ kind: "relation_evidence_gap", priority: "P1", fingerprint: "issue-fp", card_id: "甲", target_id: "乙" }],
      issue_total: 1, totals: { relation_evidence_gap: 1 }, totals_by_priority: { P0: 0, P1: 1, P2: 0, P3: 0 }
    } }
  });
  runtime.updateWorkspace(closureRun.run.run_id, { candidate_actions: ["核对甲乙之间是否有足够关系证据"] });
  runtime.record(closureRun.run.run_id, {
    action: { operator: "inspect_relation_case", mode: "read" },
    observation: { status: "ok", summary: "已读取关系案件。", data_digest: "closure-case", evidence: [{ card_id: "甲" }, { card_id: "乙" }], data: { case_fingerprint: "closure-case-fp", source_id: "甲", target_id: "乙", nodes: [{ id: "甲" }, { id: "乙" }] } }
  });
  runtime.record(closureRun.run.run_id, {
    action: { operator: "simulate_relation_patch", mode: "simulate" },
    observation: { status: "ok", summary: "证据不足，延期。", data_digest: "closure-defer", evidence: [{ card_id: "甲" }, { card_id: "乙" }], data: {
      case_fingerprint: "closure-case-fp", preflight_passed: true,
      adjudication: { decision: "defer", issue_fingerprint: "issue-fp", evidence: [], counterevidence: ["缺少方向证据"], risk_level: "low" },
      nodes: [{ id: "甲" }, { id: "乙" }]
    } }
  });
  const closureState = runtime.get(closureRun.run.run_id);
  assert.equal(closureState.workspace.extension.issue_ledger[0].status, "deferred");
  assert.equal(constructCompletionReadiness(closureState).ready, true, "defer 是无写入建构的一等闭合结果");
  assert.equal(constructRunAudit(closureState).issue_closure.deferred, 1);
  console.log("PASS construct governance: TM gate, observable Workspace, post-write verification, receipt audit");
} finally {
  rmSync(root, { recursive: true, force: true });
}
