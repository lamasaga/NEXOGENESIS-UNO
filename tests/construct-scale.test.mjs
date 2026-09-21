import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { constructBacklog } from "../packages/nexogenesis-tools/lib/cognition/construct-backlog.js";
import { constructCompletionReadiness } from "../packages/nexogenesis-tools/lib/cognition/construct-governance.js";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { projectCognitiveEvent } from "../packages/nexogenesis-web-host/lib/cognitive-events.js";
import { projectRunStatus } from "../packages/nexogenesis-web-host/lib/cognition.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "nexo-construct-scale-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const tools = new Map(), ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
	apply(ctx, { projectRoot: root });
	const runtime = getCognitiveRuntime(root);
	const run = runtime.start({ session_id: "test", mode: "construct", skill: "nexo-construct", goal: "结构检查", budget: { max_steps: 600, max_reads: 400, max_writes: 100 } }).run;
	const call = (name, args) => tools.get(name).execute(args, { agent: { session: { id: "test" } } });
	return { root, runtime, run, call };
}
const card = (id, extra = {}) => ({ id, title: id, type: "claim", origin: "document", lifecycle: "active", maturity: "growing", sources: ["测试原文"],
	domains: [], relations: [], body: "## 主张\n\n  测试材料说明融资约束通过资产出售影响估值，存在清晰条件与边界。", ...extra });
const edge = (target) => ({ target, type: "supports", note: "融资约束下的资产出售证据支持目标关于价格下降的判断。" });
function star(root, count = 51, centerRelations = []) {
	commitCard(root, card("中心", { relations: centerRelations }));
	for (let i = 0; i < count; i++) commitCard(root, card(`叶${i}`, { relations: [edge("中心")] }));
}

test("有领域无关系仍完全孤立；入边、旧边和归属分别计数", async (t) => {
	const f = fixture(t);
	writeDomainFixture(f.root, "领域");
	commitCard(f.root, card("孤立", { domains: ["领域"] }));
	commitCard(f.root, card("有入边"));
	commitCard(f.root, card("旧边", { relations: [{ target: "有入边", type: "supports" }] }));
	const result = await f.call("inspect_unconnected_cards", {});
	assert.equal(result.data.raw_candidate_total, 1);
	assert.equal(result.data.nodes[0].id, "孤立");
	assert.equal(result.data.without_ready_relations_total, 3);
});

test("51叶汇聚识别出向断点；50叶、归属星和多邻居不是同一问题", (t) => {
	const f = fixture(t); star(f.root);
	let issue = loadGraphOps(f.root).structureIssues({ kinds: ["single_neighbor_concentration"] }).issues[0];
	assert.equal(issue.leaf_count, 51); assert.equal(issue.ready_inward_leaf_count, 51);
	assert.equal(issue.argument_out_dead_end_leaf_count, 51); assert.equal(issue.argument_out_two_hop_leaf_count, 0);
	commitCard(f.root, card("后续")); commitCard(f.root, card("中心", { relations: [edge("后续")] }));
	issue = loadGraphOps(f.root).structureIssues({ kinds: ["single_neighbor_concentration"] }).issues[0];
	assert.equal(issue.argument_out_two_hop_leaf_count, 51);
	commitCard(f.root, card("中心"));
	commitCard(f.root, card("叶0", { relations: [edge("中心"), edge("后续")] }));
	assert.equal(loadGraphOps(f.root).structureIssues({ kinds: ["single_neighbor_concentration"] }).issue_total, 0);
	writeDomainFixture(f.root, "领域");
	for (let i = 0; i < 55; i++) commitCard(f.root, card(`成员${i}`, { domains: ["领域"] }));
	assert.equal(loadGraphOps(f.root).structureIssues({ kinds: ["single_neighbor_concentration"] }).issue_total, 0);
});

test("重复边不膨胀叶计数，旧边不证明两跳；中心或成员均可定向复验", async (t) => {
	const f = fixture(t); star(f.root);
	commitCard(f.root, card("叶0", { relations: [edge("中心"), edge("中心")] }));
	commitCard(f.root, card("叶1", { relations: [{ target: "中心", type: "supports" }] }));
	const result = await f.call("inspect_structure_issues", { kinds: ["single_neighbor_concentration"], card_ids: ["叶0"] });
	assert.deepEqual(result.checked_card_ids, ["叶0"]);
	assert.equal(result.issues[0].leaf_count, 51); assert.equal(result.issues[0].ready_inward_leaf_count, 50);
	const unrelated = await f.call("inspect_structure_issues", { kinds: ["single_neighbor_concentration"], card_ids: ["不存在"] });
	assert.equal(unrelated.issue_total, 0);
});

test("分页与类别过滤不能误闭合另一页问题", (t) => {
	const f = fixture(t);
	const record = (data) => f.runtime.record(f.run.run_id, { action: { operator: "inspect_structure_issues", mode: "read" }, observation: { status: "ok", data, summary: "检查结构" } });
	const issue = { fingerprint: "second", kind: "ghost_relation_target", card_id: "甲" };
	record({ issues: [issue] });
	record({ issues: [], checked_card_ids: ["甲"], next_cursor: 1, unresolved_fingerprints: ["second"], checked_kinds: [] });
	assert.equal(f.runtime.get(f.run.run_id).workspace.extension.issue_ledger[0].status, "open");
	record({ issues: [], checked_card_ids: ["甲"], unresolved_fingerprints: [], checked_kinds: ["duplicate_relation"] });
	assert.equal(f.runtime.get(f.run.run_id).workspace.extension.issue_ledger[0].status, "open");
	record({ issues: [], checked_card_ids: ["甲"], unresolved_fingerprints: [], checked_kinds: [] });
	assert.equal(f.runtime.get(f.run.run_id).workspace.extension.issue_ledger[0].status, "fixed");
});

test("历次待办可分页查回，处置保留标识，实例与新目标隔离", async (t) => {
	const f = fixture(t);
	f.runtime.updateWorkspace(f.run.run_id, { deferred_items: ["核验甲的机制条件", "比较乙的反例"], extension: { improvement_history: [{ id: "old-plan", status: "deferred", problem: "甲的混合表达", card_ids: ["甲"] }] } });
	f.runtime.setStatus(f.run.run_id, "blocked", "部分完成");
	const newer = f.runtime.start({ session_id: "test", mode: "construct", goal: "只看乙" }).run;
	const page = await f.call("inspect_cognitive_workspace", { view: "backlog", limit: 1 });
	assert.equal(page.total, 3); assert.equal(page.next_cursor, 1);
	assert.equal(page.items[0].prior_run_id, f.run.run_id);
	assert.equal(f.runtime.get(newer.run_id).workspace.goal, "只看乙");
	f.runtime.updateWorkspace(newer.run_id, { deferred_items: [{ backlog_id: page.items[0].backlog_id, status: "resolved", reason: "已重读甲并复核当前结构，原问题不再成立。" }] });
	assert.equal(constructBacklog(f.root).total, 2);
	assert.equal(constructBacklog(join(f.root, "another-instance")).total, 0);
	assert.deepEqual((await f.call("inspect_cognitive_workspace", { view: "full" })).workspace.deferred_items, f.runtime.get(newer.run_id).workspace.deferred_items);
});

test("一般建构不能用一个已验收计划掩盖未决问题", (t) => {
	const f = fixture(t), state = f.runtime.get(f.run.run_id);
	state.workspace.scope.continuous_construct = true;
	state.workspace.extension.improvement_plan = { status: "kept" };
	state.workspace.extension.issue_ledger = [{ fingerprint: "remaining", status: "open" }];
	assert.equal(constructCompletionReadiness(state).reason_code, "construct_scope_remaining");
	state.workspace.extension.issue_ledger = [];
	assert.equal(constructCompletionReadiness(state).ready, true);
	assert.equal(constructCompletionReadiness(state, undefined, { pending: ["还有下一簇"] }).ready, false);
	state.workspace.extension.improvement_history = [{ id: "previous", status: "deferred" }];
	assert.equal(constructCompletionReadiness(state).ready, false);
});

test("进度事件和刷新投影不泄露函数字段名，原始诊断仍可查", (t) => {
	const f = fixture(t), state = f.runtime.get(f.run.run_id);
	state.run.thinking_model = { id: "knowledge-organization" };
	state.episode.steps.push({ action: { operator: "update_cognitive_workspace" }, observation: { status: "ok", summary: "已整理思维工作区：candidate_actions。新建 run。" } });
	const event = projectCognitiveEvent({ state, sessionId: "test", operator: "update_cognitive_workspace", phase: "observed", projectRoot: f.root });
	assert.doesNotMatch(event.presentation.detail, /candidate_actions|\brun\b/);
	assert.match(event.observation.summary, /candidate_actions/);
	const snapshot = projectRunStatus(state);
	assert.doesNotMatch(snapshot.attention + snapshot.finding, /knowledge-organization|candidate_actions|\brun\b/);
});
