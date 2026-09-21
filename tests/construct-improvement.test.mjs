import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { commitCard, readCard, loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway } from "../packages/nexogenesis-tools/lib/harness/gateway.js";
import { buildWorkingMemory } from "../packages/nexogenesis-tools/lib/cognition/working-memory.js";
import { constructCompletionReadiness, constructWriteReadiness, constructRunAudit } from "../packages/nexogenesis-tools/lib/cognition/construct-governance.js";
import { inspectKnowledgeGap } from "../packages/nexogenesis-tools/lib/cognition/construct-improvement.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

const anchorA = "流动性支持只能缓解被迫抛售，不能消除资不抵债。";
const anchorB = "外币债务缺少本币发行支持，存在额外的汇率约束。";
const body = (anchor) => `## 诠释\n\n  资金紧张通过被迫抛售传导至资产估值与抵押能力，形成自我强化的融资收缩。需要区分流动性与偿付能力，不能依据价格反弹宣称结构风险已经消失。\n\n## 模式描述\n\n  ${anchor}\n\n## 典型实例\n\n  来源材料中的融资案例显示，短期授信能够改变出售资产的时点，但最终效果仍取决于现金流、债务币种与可接受抵押品的范围。\n\n## 反例与失效条件\n\n  ${anchor}\n\n## 原文摘录\n\n> 信贷并不自动改善资产质量。`;
function card(id, anchor = anchorA, extra = {}) { return { id, title: id, type: "phenomenon", maturity: "growing", lifecycle: "active", origin: "document", domains: ["领域"], sources: [`材料-${id}`], relations: [], created: "2026-09-05", updated: "2026-09-05", body: body(anchor), ...extra }; }
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "nexo-construct-improvement-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeDomainFixture(root, "领域");
	commitCard(root, card("甲")); commitCard(root, card("乙", anchorB));
	const tools = new Map(), ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
	apply(ctx, { projectRoot: root }); registerCognitionTools(ctx, root);
	const runtime = getCognitiveRuntime(root), exec = { agent: { session: { id: "construct-test" } } };
	const state = runtime.start({ session_id: "construct-test", mode: "construct", skill: "nexo-construct", goal: "使融资约束更易找到与比较", write_authority: "trusted", budget: { max_steps: 100, max_reads: 80, max_writes: 20 } });
	runtime.selectThinkingModel(state.run.run_id, JSON.parse(readFileSync(new URL("../schemes/default/thinking-models/knowledge-organization.yaml", import.meta.url))), { operators: {} });
	runtime.updateWorkspace(state.run.run_id, { hypotheses: ["重复材料应聚合而边界必须保留"] });
	return { root, runtime, state: () => runtime.current("construct-test"), call: (name, args = {}) => tools.get(name).execute(args, exec) };
}
async function plan(f, overrides = {}) {
	await f.call("read_card", { id: "甲", max_chars: 12000 }); await f.call("read_card", { id: "乙", max_chars: 12000 });
	await f.call("compare_cards", { card_ids: ["甲", "乙"], dimensions: ["mechanism", "counterevidence"] });
	return f.call("plan_construct_improvement", { kind: "merge", problem: "融资约束分散重复", benefit: "同时发现流动性和币种边界", card_ids: ["甲", "乙"], target_ids: ["甲"], retire_ids: ["乙"], alternatives: ["保持两卡会重复解释同一融资机制；只补边不解决表达重复"], preservation: [{ from: "甲", excerpt: anchorA, to: ["甲"] }, { from: "乙", excerpt: anchorB, to: ["甲"] }], probes: [{ query: "外币债务", expected_ids: ["甲"] }], ...overrides });
}
const finish = { status: "completed", stop_reason: "当前局部问题已复核", changed: [], unchanged: [], pending: [] };

test("全文缺口复查可定位长卡尾部与别名；未找到不宣称缺卡", (t) => {
	const f = fixture(t);
	commitCard(f.root, card("政策", anchorA, { aliases: ["资本购买计划"], body: body(anchorA) + "\n" + "历史材料。".repeat(300) + "\n  TARP 转向优先股资本注入。" }));
	const r = inspectKnowledgeGap(f.root, { queries: ["TARP", "资本购买计划", "不存在的具体机制"] });
	assert.equal(r.searches[0].hits[0].id, "政策"); assert.match(r.searches[0].hits[0].excerpt, /优先股/);
	assert.equal(r.searches[1].hits[0].title_hit, true);
	assert.equal(inspectKnowledgeGap(f.root, { queries: ["不存在的具体机制"] }).conclusion, "not_located");
});

test("关键词组合与连续短语显式区分，不再把空格关键词误当连续句子", (t) => {
	const f = fixture(t);
	commitCard(f.root, card("复本位", anchorA, { body: body(anchorA) + "\n  市场金银比价形成约束。" }));
	assert.ok(inspectKnowledgeGap(f.root, { queries: ["复本位 金银比价"] }).searches[0].hits.some((h) => h.id === "复本位"));
	assert.equal(inspectKnowledgeGap(f.root, { queries: ["复本位 金银比价"], match_mode: "all" }).searches[0].total, 1);
	assert.equal(inspectKnowledgeGap(f.root, { queries: ["复本位 金银比价"], match_mode: "phrase" }).conclusion, "not_located");
	assert.equal(inspectKnowledgeGap(f.root, { queries: ["复本位 未存在词"], match_mode: "all" }).conclusion, "not_located");
});

test("Web 预建 Run 后重复启动返回无损 JSON，不重复创建或替换目标", async (t) => {
	const f = fixture(t), before = f.state();
	for (let i = 0; i < 2; i++) {
		const result = await f.call("start_cognitive_run", { mode: "construct", skill: "nexo-construct", goal: "旧目标不应覆盖新诊断" });
		assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
		assert.equal(result.run.run_id, before.run.run_id);
		assert.equal(result.workspace.goal, before.workspace.goal);
	}
});

test("合理独立要求真实阅读比较，旁支待办持久化且不覆盖已有待办", async (t) => {
	const f = fixture(t), args = { card_id: "甲", candidate_ids: ["乙"], issue_kind: "without_relations", status: "intentionally_standalone", reason: "只看摘要不能判断所有候选都不成立" };
	assert.equal((await f.call("record_structure_review", args)).status, "rejected");
	await plan(f);
	f.runtime.updateWorkspace(f.state().run.run_id, { deferred_items: ["保留先前待办"] });
	assert.equal((await f.call("record_structure_review", { ...args, follow_up: "核对甲卡领域，存在错归属风险" })).status, "ok");
	assert.ok(f.state().workspace.deferred_items.includes("保留先前待办"));
	assert.ok(f.state().workspace.deferred_items.some((d) => d.card_id === "甲"));
});

test("提前拒绝会进入写入审计，但只消耗步骤而非成功写入额度", async (t) => {
	const f = fixture(t), id = f.state().run.run_id;
	const result = await f.call("propose_relation_patch", { action: "upsert", source_id: "甲", target_id: "乙", relation_type: "supports", note: "尚未完成任何计划与关系比较", summary: "预期拒绝" });
	assert.equal(result.status, "rejected");
	assert.equal(constructRunAudit(f.state()).rejected_write_count, 1);
	assert.equal(f.runtime.governance(id).usage.writes, 0);
	assert.equal(f.runtime.governance(id).usage.steps, 1);
});

test("合并计划完整阅读、来源承接和入边迁移后才能退役；真实工具完成验收", async (t) => {
	const f = fixture(t);
	commitCard(f.root, card("丙", anchorA, { relations: [{ target: "乙", type: "supports", note: "融资案例为外币债务的约束提供有限证据，限于对应制度条件。" }] }));
	assert.equal((await plan(f)).status, "ok");
	assert.equal(f.state().workspace.extension.improvement_plan.baseline[0].missing_expected[0], "甲");
	let retire = await f.call("propose_write", { layer: "lifecycle", summary: "合并旧对象", operations: [{ ...readCard(f.root, "乙"), lifecycle: "superseded" }] });
	assert.equal(retire.status, "rejected"); assert.match(retire.summary, /未保留|来源|指向/);
	const content = await f.call("propose_write", { layer: "content", summary: "汇合两类融资边界", operations: [{ ...readCard(f.root, "甲"), body: body(`${anchorA}\n\n  ${anchorB}`) }] });
	assert.equal(content.status, "committed", JSON.stringify(content));
	const sources = await f.call("propose_write", { layer: "sources", summary: "承接原始来源", operations: [{ ...readCard(f.root, "甲"), sources: ["材料-甲", "材料-乙"] }] });
	assert.equal(sources.status, "committed", JSON.stringify(sources));
	retire = await f.call("propose_write", { layer: "lifecycle", summary: "退役旧对象", operations: [{ ...readCard(f.root, "乙"), lifecycle: "superseded" }] });
	assert.equal(retire.status, "rejected"); assert.match(retire.summary, /活跃卡仍指向/);
	// A migration uses the same Gateway; semantic relation adjudication is tested separately below.
	const gateway = new HarnessGateway(f.root), moved = { ...readCard(f.root, "丙"), relations: [{ target: "甲", type: "supports", note: "融资案例为聚合后的融资约束判断提供证据，保留币种和制度边界。" }] };
	const checked = gateway.preflight({ operations: [moved], layer: "relation" });
	const receipt = gateway.commit({ ...checked, operations: checked.cards, proposal_id: "move-inbound" });
	f.runtime.record(f.state().run.run_id, { action: { operator: "propose_relation_patch", mode: "write" }, observation: receipt });
	retire = await f.call("propose_write", { layer: "lifecycle", summary: "来源与入边已承接", operations: [{ ...readCard(f.root, "乙"), lifecycle: "superseded" }] });
	assert.equal(retire.status, "committed", JSON.stringify(retire));
	assert.match(readFileSync(join(f.root, "01-Cards/乙.md"), "utf8"), /superseded/);
	assert.equal(readCard(f.root, "乙").lifecycle, "superseded", "旧 ID 仍可直接回查，但不回到活跃搜索");
	assert.equal(loadCards(f.root).has("乙"), false);
	assert.equal((await f.call("finish_cognitive_run", finish)).status, "rejected");
	await f.call("read_card", { id: "甲", max_chars: 12000 });
	const review = await f.call("review_construct_improvement", { outcome: "verify", reason: "两类边界均保留，使用同一概念可找到聚合对象；未把类比写成因果。" });
	assert.equal(review.data.status, "verified", JSON.stringify(review));
	const end = await f.call("finish_cognitive_run", finish);
	assert.equal(end.run?.status, "completed", JSON.stringify(end));
});

test("拆分通过真实 creation 写入保留来源与边界，未完成不能误报成功", async (t) => {
	const f = fixture(t);
	commitCard(f.root, card("甲", `${anchorA}\n\n  ${anchorB}`));
	assert.equal((await plan(f, { kind: "split", card_ids: ["甲"], target_ids: ["甲", "币种约束"], retire_ids: [], preservation: [{ from: "甲", excerpt: anchorA, to: ["甲"] }, { from: "甲", excerpt: anchorB, to: ["币种约束"] }], probes: [{ query: "外币债务", expected_ids: ["币种约束"] }] })).status, "ok");
	assert.equal((await f.call("review_construct_improvement", { outcome: "verify", reason: "检查拆分结果" })).status, "partial");
	const write = await f.call("propose_write", { layer: "creation", summary: "独立呈现币种约束", operations: [card("币种约束", anchorB, { sources: ["材料-甲"] })] });
	assert.equal(write.status, "committed", JSON.stringify(write));
	const refined = await f.call("propose_write", { layer: "content", summary: "原卡保留融资机制，不再重复币种解释", operations: [card("甲")] });
	assert.equal(refined.status, "committed", JSON.stringify(refined));
	await f.call("read_card", { id: "甲", max_chars: 12000 }); await f.call("read_card", { id: "币种约束", max_chars: 12000 });
	assert.equal((await f.call("review_construct_improvement", { outcome: "verify", reason: "拆分后各自保留成立条件，原问题可以定位两个知识对象。" })).data.status, "verified");
});

test("工作区不能伪造运行事实，未读新版本和超范围计划被拒绝", async (t) => {
	const f = fixture(t);
	assert.equal((await f.call("update_cognitive_workspace", { patch: { extension: { issue_ledger: [{ status: "linked" }] } } })).status, "rejected");
	await assert.rejects(() => f.call("update_cognitive_workspace", { patch: { extension: { improvement_plan: { status: "verified" } } } }), /not a declared property/);
	assert.equal((await plan(f)).status, "ok");
	const before = JSON.stringify(f.state().workspace);
	const memory = buildWorkingMemory(f.state(), 1600);
	assert.equal(memory.version, "construct-1"); assert.ok(JSON.stringify(memory).length <= 1600);
	assert.equal(JSON.stringify(f.state().workspace), before);
	commitCard(f.root, card("乙", anchorB + "外部新增约束。"));
	const write = await f.call("propose_write", { layer: "content", summary: "尝试沿用旧计划", operations: [card("甲")] });
	assert.equal(write.status, "rejected"); assert.match(write.summary, /版本已变化/);
	const deferred = await f.call("review_construct_improvement", { outcome: "defer", reason: "外部改动了来源对象；下一步重新读取并比较新增约束。" });
	assert.equal(deferred.data.status, "deferred");
});

test("写入后不能声称保持现状；验收后变化使完成门失效", async (t) => {
	const f = fixture(t);
	assert.equal((await plan(f, { kind: "refine", card_ids: ["甲"], target_ids: ["甲"], retire_ids: [], preservation: [{ from: "甲", excerpt: anchorA, to: ["甲"] }], probes: [{ query: "资不抵债", expected_ids: ["甲"] }] })).status, "ok");
	await f.call("propose_write", { layer: "content", summary: "补清适用对象", operations: [{ ...readCard(f.root, "甲"), body: body(anchorA) + "\n\n  该判断不适用于缺少可接受抵押品的对象。" }] });
	assert.equal((await f.call("review_construct_improvement", { outcome: "keep", reason: "保持不变" })).status, "rejected");
	await f.call("read_card", { id: "甲", max_chars: 12000 });
	assert.equal((await f.call("review_construct_improvement", { outcome: "verify", reason: "表达更加清晰，保留原有失效边界。" })).data.status, "verified");
	commitCard(f.root, card("甲", anchorA + "新的外部修改。"));
	assert.equal(constructCompletionReadiness(f.state(), f.root).reason_code, "construct_improvement_review_stale");
});

test("同任务连续完成四个局部计划并逐次写后验收，保留历史且不重写上一项", async (t) => {
	const f = fixture(t);
	for (let i = 0; i < 4; i++) {
		const id = `连续改善${i}`;
		commitCard(f.root, card(id));
		await f.call("read_card", { id, max_chars: 12000 });
		const planned = await f.call("plan_construct_improvement", { kind: "refine", problem: "融资约束的适用对象需说明", benefit: "避免把条件判断泛化", card_ids: [id], target_ids: [id], alternatives: ["保持原文会遗漏适用对象，补边不能解决该表达问题"], preservation: [{ from: id, excerpt: anchorA, to: [id] }], probes: [{ query: "资不抵债", expected_ids: [id] }] });
		assert.equal(planned.status, "ok", JSON.stringify(planned));
		const written = await f.call("propose_write", { layer: "content", summary: "补充适用对象", operations: [{ ...readCard(f.root, id), body: body(anchorA) + "\n\n  该判断不适用于缺少可接受抵押品的对象。" }] });
		assert.equal(written.status, "committed", JSON.stringify(written));
		await f.call("read_card", { id, max_chars: 12000 });
		assert.equal((await f.call("review_construct_improvement", { outcome: "verify", reason: "保留原始边界并明确适用对象，检索可定位。" })).data.status, "verified");
	}
	assert.equal(f.state().workspace.extension.improvement_history.length, 3);
	assert.equal(constructRunAudit(f.state()).committed_transactions, 4);
	assert.equal(new Set(f.state().workspace.extension.improvement_history.map((p) => p.id)).size, 3);
});

test("同题语义比较必须发生在关系模拟前，不能用收尾补一次交差", () => {
	const step = (n, operator, data) => ({ step: n, action: { operator, mode: "read" }, observation: { status: "ok", data } });
	const state = { run: { mode: "construct", thinking_model: { id: "isolated-card-integration" } }, workspace: { evidence: [{}], observed_nodes: [{}], hypotheses: ["依据"], extension: {} }, episode: { steps: [
		step(1, "read_card", { id: "甲", reading: { coverage: "full" } }), step(2, "read_card", { id: "乙", reading: { coverage: "full" } }),
		step(3, "inspect_relation_case", { source_id: "甲", target_id: "乙", case_fingerprint: "fp" }),
		step(4, "simulate_relation_patch", { case_fingerprint: "fp", preflight_passed: true, adjudication: { decision: "change" } })
	] } };
	assert.equal(constructWriteReadiness(state, { layer: "relation" }).reason_code, "construct_pair_comparison_required");
	state.episode.steps.push(step(5, "compare_cards", { compared: ["甲", "乙"] }));
	assert.equal(constructWriteReadiness(state, { layer: "relation" }).ready, false);
	state.episode.steps.push(step(6, "simulate_relation_patch", { case_fingerprint: "fp", preflight_passed: true, adjudication: { decision: "change" } }));
	assert.equal(constructWriteReadiness(state, { layer: "relation" }).ready, true);
	state.episode.steps.at(-1).observation.data.adjudication.proposed_relation = { from: "甲", to: "乙", type: "supports", note: "证据与边界" };
	assert.equal(constructWriteReadiness(state, { layer: "relation", relationRequest: { action: "upsert", source_id: "甲", target_id: "乙", relation_type: "supports", note: "证据与边界" } }).ready, true);
	assert.equal(constructWriteReadiness(state, { layer: "relation", relationRequest: { action: "upsert", source_id: "甲", target_id: "乙", relation_type: "supports", note: "偷换了理由" } }).reason_code, "construct_relation_simulation_mismatch");
});

test("禁止绕过专用关系裁决，也不能在精简前丢失声明的关键锚点", async (t) => {
	const f = fixture(t);
	assert.equal((await plan(f)).status, "ok");
	const relation = await f.call("propose_write", { layer: "relation", summary: "绕过专用关系裁决", operations: [readCard(f.root, "甲")] });
	assert.equal(relation.reason_code, "construct_relation_tool_required");
	const content = await f.call("propose_write", { layer: "content", summary: "提前移除边界", operations: [{ ...readCard(f.root, "乙"), body: body(anchorA) }] });
	assert.equal(content.status, "rejected"); assert.match(content.summary, /先承接关键锚点/);
});

test("Harness 独立阻止带活跃入边退役，不依赖模型是否建立计划", (t) => {
	const f = fixture(t);
	commitCard(f.root, card("丙", anchorA, { relations: [{ target: "乙", type: "supports", note: "融资案例为外币债务约束提供有限证据，限于对应制度条件。" }] }));
	assert.throws(() => new HarnessGateway(f.root).preflight({ layer: "lifecycle", operations: [{ ...readCard(f.root, "乙"), lifecycle: "superseded" }] }), (error) => error.receipt?.reason_code === "retirement_has_active_inbound");
	assert.equal(readCard(f.root, "乙").lifecycle, "active");
});

test("实际关系工具能通过同一计划内的端点阅读、比较、模拟和写后验收", async (t) => {
	const f = fixture(t);
	assert.equal((await plan(f, { kind: "relation", target_ids: ["甲", "乙"], retire_ids: [], preservation: [{ from: "甲", excerpt: anchorA, to: ["甲"] }, { from: "乙", excerpt: anchorB, to: ["乙"] }], probes: [{ query: "外币债务", expected_ids: ["乙"] }] })).status, "ok");
	await f.call("inspect_relation_case", { source_id: "甲", target_id: "乙" });
	const note = "本币流动性支持的约束为外币债务案例的政策适用边界提供对照证据，不推出跨币种的普遍适用性。";
	const simulation = await f.call("simulate_relation_patch", { decision: "change", source_id: "甲", target_id: "乙", proposed_relation_type: "supports", note, evidence: [anchorA], counterevidence: ["外币发行主体与本币支持主体不同，不能直接外推政策效果。"], direction_reason: "源卡为目标的政策约束判断补充有限证据", scope_or_boundary: "只限流动性工具适用边界，不作为偿付能力的充分解释" });
	assert.equal(simulation.preflight_passed, true, JSON.stringify(simulation));
	const write = await f.call("propose_relation_patch", { action: "upsert", source_id: "甲", target_id: "乙", relation_type: "supports", note, summary: "显式记录政策适用边界的有限支持" });
	assert.equal(write.status, "committed", JSON.stringify(write));
	await f.call("read_card", { id: "甲", max_chars: 12000 }); await f.call("read_card", { id: "乙", max_chars: 12000 });
	assert.equal((await f.call("review_construct_improvement", { outcome: "verify", reason: "验证写入契约与检索保持；本测试不代表关系语义的独立验收。" })).data.status, "verified");
});

test("预算到线后仅保留两步复核，不允许继续探索或写卡；可诚实保持现状", async (t) => {
	const f = fixture(t);
	assert.equal((await plan(f)).status, "ok");
	const id = f.state().run.run_id;
	f.runtime.updateWorkspace(id, { budget: { max_steps: f.state().episode.steps.length + 1 } });
	f.runtime.record(id, { action: { operator: "compare_cards", mode: "read" }, observation: { status: "ok", summary: "没有足够改善收益" } });
	assert.equal(f.state().run.status, "running");
	assert.equal(f.runtime.canOperate(id, { mode: "read", operator: "inspect_knowledge_gap" }).allowed, false);
	assert.equal(f.runtime.canOperate(id, { mode: "proposal", operator: "propose_write" }).allowed, false);
	assert.equal((await f.call("review_construct_improvement", { outcome: "keep", reason: "两卡承担不同的检索职责，暂不合并，保留边界对照价值。" })).data.status, "kept");
	assert.equal((await f.call("finish_cognitive_run", finish)).run?.status, "completed");
});

test("未接入问题自动进入账本，复核闭合后不再显示 open=5", async (t) => {
	const f = fixture(t), id = f.state().run.run_id;
	f.runtime.record(id, { action: { operator: "inspect_integration_candidates", mode: "read" }, observation: { status: "ok", data: { focus_card_id: "甲", issue_scope: "without_relations", nodes: [{ id: "甲" }] } } });
	assert.equal(constructRunAudit(f.state()).issue_closure.open, 1);
	f.runtime.record(id, { action: { operator: "inspect_unconnected_cards", mode: "read" }, observation: { status: "ok", data: { scope: "without_relations", checked_card_ids: ["甲"], resolved_card_ids: ["甲"], nodes: [] } } });
	assert.equal(constructRunAudit(f.state()).issue_closure.fixed, 1);
	assert.equal(constructRunAudit(f.state()).issue_closure.open, 0);
});

test("共同因素并非论证支持的实质争议触发额外复核", (t) => {
	const f = fixture(t), graph = loadGraphOps(f.root);
	const result = graph.simulateRelationPatch({ decision: "change", sourceId: "甲", targetId: "乙", proposedRelationType: "supports", note: "同一融资环境下两因素有关，需要区分共同作用与证据支持。", evidence: ["两个现象同时发生"], counterevidence: ["两卡是平行现象，方向存在争议"], directionReason: "源因素支持目标因素", scopeOrBoundary: "同一时期的融资环境" });
	assert.equal(result.critical_review_reasons?.includes("support_semantics_disputed"), true);
	assert.equal(result.preflight_passed, false);
});
