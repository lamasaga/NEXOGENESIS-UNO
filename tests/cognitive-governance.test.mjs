// CognitiveRun 的预算、停止和可恢复 continuation 治理回归。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";

const root = mkdtempSync(join(tmpdir(), "nexo-governance-"));
try {
  const runtime = new CognitiveRuntime(root);
  const { run } = runtime.start({ session_id: "session-a", mode: "construct", skill: "test", goal: "治理测试", budget: { max_steps: 3, max_reads: 1, max_writes: 1 } });
  assert.equal(runtime.canOperate(run.run_id, { mode: "read" }).allowed, true);
  runtime.record(run.run_id, { action: { operator: "read_card", mode: "read" }, observation: { status: "ok", data: { on_topic_new: 1 } } });
  assert.equal(runtime.canOperate(run.run_id, { mode: "read" }).allowed, false, "read budget must stop a second read");
  assert.equal(runtime.canOperate(run.run_id, { mode: "proposal" }).allowed, true, "write budget is independent from read budget");
  runtime.record(run.run_id, { action: { operator: "propose_write", mode: "proposal" }, observation: { status: "ok" } });
  assert.equal(runtime.canOperate(run.run_id, { mode: "proposal" }).allowed, false, "write budget must stop a second proposal");
  runtime.record(run.run_id, { action: { operator: "inspect_workspace", mode: "runtime-write" }, observation: { status: "ok" } });
  const blocked = runtime.get(run.run_id);
  assert.equal(blocked.run.status, "blocked", "step budget must block the run");
	assert.match(blocked.workspace.stop_reason, /步骤预算/);

	const boundedConstruct = runtime.start({
		session_id: "session-construct", mode: "construct", skill: "test", goal: "有限建构",
		write_authority: "trusted", budget: { max_steps: 1, max_reads: 1, max_writes: 1 }
	});
	runtime.record(boundedConstruct.run.run_id, { action: { operator: "inspect_unconnected_cards", mode: "read" }, observation: { status: "ok" } });
	assert.equal(runtime.get(boundedConstruct.run.run_id).run.status, "blocked", "完全信任的建构仍必须遵从轮次上限，避免过度调整");

	const general = runtime.start({
		session_id: "session-general", mode: "general", skill: "nexo-talk", goal: "跨多轮对话",
		budget: { max_steps: 1, max_reads: 1, max_writes: 0 }
	});
	runtime.record(general.run.run_id, { action: { operator: "read_card", mode: "read" }, observation: { status: "ok" } });
	assert.equal(runtime.canOperate(general.run.run_id, { mode: "read" }).allowed, true, "普通对话不应被过去轮次的累计读取量永久阻断");
	assert.equal(runtime.get(general.run.run_id).run.status, "running");

	const iterativeGeneral = runtime.start({
		session_id: "session-iterative-general", mode: "general", skill: "nexo-talk", goal: "单轮复杂分析",
		scope: { analysis_depth: "iterative" }, budget: { max_steps: 1, max_reads: 1, max_writes: 0 }
	});
	assert.deepEqual(iterativeGeneral.workspace.budget, { max_steps: 20, max_reads: 12, max_writes: 0 }, "缺省 standard 档不能被模型压缩到失去分析能力");
	for (let index = 0; index < 12; index += 1) {
		runtime.record(iterativeGeneral.run.run_id, { action: { operator: "read_card", mode: "read" }, observation: { status: "ok" } });
	}
	assert.equal(runtime.canOperate(iterativeGeneral.run.run_id, { mode: "read" }).allowed, false, "显式迭代问答仍必须受档位读取上限控制");
	assert.equal(runtime.canOperate(iterativeGeneral.run.run_id, { mode: "read", operator: "inspect_evidence_set" }).allowed, true, "知识读取用尽后仍须保留闭合审计能力");
	for (let index = 0; index < 8; index += 1) {
		runtime.record(iterativeGeneral.run.run_id, { action: { operator: "analysis_step", mode: "simulate" }, observation: { status: "ok" } });
	}
	assert.equal(runtime.get(iterativeGeneral.run.run_id).run.status, "running", "达到分析步数上限后应保留尾部审计窗口，而不是立即阻断");
	for (const operator of ["inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency"]) {
		assert.equal(runtime.canOperate(iterativeGeneral.run.run_id, { mode: "read", operator }).allowed, true);
		runtime.record(iterativeGeneral.run.run_id, { action: { operator, mode: "read" }, observation: { status: "ok", data: {} } });
	}
	const exhaustedClosure = runtime.canOperate(iterativeGeneral.run.run_id, { mode: "read", operator: "inspect_cognitive_sufficiency" });
	assert.equal(exhaustedClosure.allowed, false, "闭合审计保留额度不能演变为无限额读取");
	assert.equal(exhaustedClosure.reason_code, "closure_reserve_exhausted");

	const evaluated = runtime.start({
		session_id: "session-eval", mode: "assess", skill: "nexo-judge", goal: "只读评测",
		scope: { read_only: true, allowed_ops: ["read_card", "propose_write"] },
		budget: { max_steps: 8, max_reads: 4, max_writes: 0 }
	});
	assert.equal(runtime.canOperate(evaluated.run.run_id, { mode: "read", operator: "read_card" }).allowed, true);
	const offProfile = runtime.canOperate(evaluated.run.run_id, { mode: "read", operator: "graph_walk" });
	assert.equal(offProfile.allowed, false);
	assert.equal(offProfile.reason_code, "operator_not_allowed_in_scope");
	const writeDenied = runtime.canOperate(evaluated.run.run_id, { mode: "proposal", operator: "propose_write" });
	assert.equal(writeDenied.allowed, false);
	assert.equal(writeDenied.reason_code, "read_only_scope");

  const entry = runtime.enqueueContinuation(run.run_id, { kind: "harness_receipt", content: "resume me" });
  assert.equal(runtime.pendingContinuations(run.run_id).length, 1);
  runtime.markContinuationDelivered(run.run_id, entry.id);
  assert.equal(runtime.pendingContinuations(run.run_id).length, 0);
  console.log("PASS CognitiveRun budget, stop state, and durable continuation queue");
} finally {
  rmSync(root, { recursive: true, force: true });
}
