import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CognitiveRuntime, WorkspaceContractError, workspaceContract } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { makeHarnessReceipt, makeObservation } from "../packages/nexogenesis-tools/lib/cognition/observations.js";
import { prepareCognitiveInteractionAnswer, resumeCognitiveInteraction } from "../packages/nexogenesis-web-host/lib/cognition.js";

const root = mkdtempSync(join(tmpdir(), "nexo-cognition-"));
try {
	const runtime = new CognitiveRuntime(root);
	const first = runtime.start({ session_id: "session-a", mode: "construct", skill: "nexo-construct", goal: "梳理领域关系", scope: { domain_id: "领域甲" } });
	assert.equal(first.run.status, "running");
	assert.equal(first.workspace.goal, "梳理领域关系");

	runtime.updateWorkspace(first.run.run_id, { hypotheses: ["可能存在两个低连接簇"], open_questions: ["桥接卡是什么"] });
	const workspaceChange = runtime.updateWorkspaceWithDiff(first.run.run_id, {
		evidence: [{ card_id: "领域甲", reason: "可作为结构诊断的起点" }],
		open_questions: ["桥接卡是什么", "是否存在跨域关系"]
	}, {
		action: { operator: "update_cognitive_workspace", mode: "runtime-write" },
		observation: makeObservation({ operator: "update_cognitive_workspace", summary: "已加入一个证据锚点。" })
	});
	assert.equal(workspaceChange.delta.added.evidence.length, 1, "Workspace 更新应生成可回放的新增项");
	assert.equal(workspaceChange.delta.added.open_questions.length, 1, "Workspace 更新应区分新增与原有问题");
	assert.equal(runtime.get(first.run.run_id).episode.steps.at(-1).workspace_delta.revision_after, workspaceChange.delta.revision_after, "Episode 应保存 Workspace 版本差异");
	const rejected = makeHarnessReceipt({
		operator: "harness.preflight", accepted: false, summary: "关系签名不合法",
		reason_code: "invalid_relation_signature",
		alternatives: [{ action: "remove_relation" }, { action: "use_specialized_operator" }, { action: "too_many" }]
	});
	assert.equal(rejected.next_actions.length, 2, "拒绝收据最多给两个替代动作");
	runtime.record(first.run.run_id, { action: { operator: "propose_write" }, observation: rejected, rationale: "改用专用操作" });

	const restored = new CognitiveRuntime(root).get(first.run.run_id);
	assert.equal(restored.workspace.hypotheses[0], "可能存在两个低连接簇");
	assert.equal(restored.episode.steps.length, 2, "Workspace 差异与 Harness 拒绝都应保留为独立 Episode 步骤");
	assert.equal(restored.episode.steps.at(-1).observation.reason_code, "invalid_relation_signature");

	const second = runtime.start({ session_id: "session-b", mode: "construct", skill: "nexo-construct", goal: "检查另一个领域" });
	assert.notEqual(first.run.run_id, second.run.run_id, "并行任务必须使用独立 run");
	assert.equal(runtime.current("session-a").run.run_id, first.run.run_id);
	assert.equal(runtime.current("session-b").run.run_id, second.run.run_id);
	const interaction = runtime.requestInteraction(first.run.run_id, {
		type: "choice", request_key: "domain-direction", question: "如何处理两个空领域？",
		options: [{ id: "retire", label: "退役", description: "停止把空壳作为领域使用" }, { id: "keep", label: "保留", description: "先补足成员证据" }]
	});
	assert.equal(interaction.status, "pending");
	assert.equal(runtime.current("session-a").run.status, "waiting_user");
	assert.equal(runtime.currentInteraction("session-a").interaction_id, interaction.interaction_id);
	const prepared = prepareCognitiveInteractionAnswer(root, interaction.interaction_id, { option_id: "retire" });
	assert.equal(prepared.interaction.status, "pending", "准备回答只能校验，不能提前改变持久状态");
	assert.match(prepared.prompt, /我选择“退役”/);
	assert.throws(
		() => prepareCognitiveInteractionAnswer(root, interaction.interaction_id, { option_id: "retire" }, "session-b"),
		/不属于当前会话/
	);
	assert.equal(runtime.currentInteraction("session-a").status, "pending", "错误会话提交不能污染待答状态");
	const delivered = await resumeCognitiveInteraction({ webServer: { port: 9 } }, root, prepared);
	assert.equal(delivered, false, "下游不可用时应报告未投递");
	assert.equal(runtime.getInteraction(first.run.run_id).status, "answered", "用户决定应持久保存");
	assert.equal(runtime.current("session-a").run.status, "paused", "投递失败必须进入可恢复暂停状态");
	assert.equal(runtime.pendingContinuations(first.run.run_id).length, 1, "未投递指令必须保留以便重试");
	assert.equal(runtime.currentInteraction("session-a"), null, "回答后不能继续显示旧的待答问题");
	assert.throws(()=>runtime.updateWorkspace(second.run.run_id,{checkpoint:'misplaced'}),error=>error instanceof WorkspaceContractError&&error.hint==='extension.checkpoint');
 runtime.updateWorkspace(second.run.run_id,{extension:{focus:'反例条件',checkpoint:{phase:'inspection'}},candidate_actions:['回查适用条件'],deferred_items:[{scope:'来源',reason:'限定条件未核验'}]});
 assert.equal(runtime.get(second.run.run_id).workspace.extension.focus,'反例条件');
 assert.equal(runtime.updateWorkspace(second.run.run_id,{}).extension.checkpoint.phase,'inspection');
 assert.ok(workspaceContract('construct').extension_fields.includes('focus'));
 assert.throws(()=>runtime.updateWorkspace(second.run.run_id,{extension:{arbitrary_notes:'不可写'}}),error=>error instanceof WorkspaceContractError&&error.field==='extension.arbitrary_notes');
 for(const mode of ['compile','theme_compile','digest'])assert.throws(()=>runtime.start({session_id:'retired-'+mode,mode,goal:'禁止重新执行'}),/退役/);
	const observation = makeObservation({ operator: "read_source_slice", summary: "读取有限片段", data: { content: "证据" } });
	assert.equal(observation.status, "ok");
	assert.ok(observation.data_digest);
	const largeObservation = makeObservation({ operator: "read_source_slice", summary: "读取大段", data: { content: "证据".repeat(1000) } });
	runtime.record(second.run.run_id, { action: { operator: "read_source_slice" }, observation: largeObservation });
	const compactStep = runtime.get(second.run.run_id).episode.steps.at(-1);
	assert.equal(compactStep.observation.data.content, undefined, "Episode 不保存大段原文");
	assert.ok(compactStep.observation.data.content_preview.length <= 600);
	console.log("PASS cognitive runtime: 会话隔离、建构 Workspace 契约、结构化拒绝及旧编译退役");
} finally {
	rmSync(root, { recursive: true, force: true });
}
