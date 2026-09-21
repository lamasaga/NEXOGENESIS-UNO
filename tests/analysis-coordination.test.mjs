import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { modelRequirementStatus } from "../packages/nexogenesis-tools/lib/cognition/thinking-models.js";
import { operatorRegistry } from "../packages/nexogenesis-tools/lib/cognition/operator-registry.js";
import { buildWorkingMemory } from "../packages/nexogenesis-tools/lib/cognition/working-memory.js";
import { commitCard, loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { settleGeneralRunAtTurnBoundary } from "../packages/nexogenesis-web-host/lib/chat.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

const record = (id, body = "## 核心思想\n\n<!-- unit: core-claim -->\n缓冲耗尽后，阈值突破触发正反馈。\n\n## 适用条件\n\n仅在冲击共同发生时成立。", extra = {}) => ({
  id, title: id, type: "claim", maturity: "growing", lifecycle: "active", origin: "document", domains: ["共同领域"], sources: ["隔离材料"], relations: [], body, ...extra
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexo-analysis-coordination-"));
  const tools = new Map(), ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
  apply(ctx, { projectRoot: root }); registerCognitionTools(ctx, root, undefined, process.cwd());
  const runtime = getCognitiveRuntime(root);
  const call = (session, name, args = {}) => tools.get(name).execute(args, { agent: { session: { id: session } } });
  return { root, runtime, call, close: () => rmSync(root, { recursive: true, force: true }) };
}
const completion = (items = []) => ({ status: "completed", stop_reason: "隔离验收", changed: [], unchanged: [], pending: [], evidence_anchors: items });

test("三个分析入口共享深度、只读边界、尾部额度，零证据不能完成", async () => {
  const f = fixture();
  try {
    for (const mode of ["general", "assess", "report"]) {
      const state = await f.call(mode, "start_cognitive_run", { mode, skill: `nexo-${mode}`, goal: "比较缓冲机制", complexity_level: "deep", scope: { analysis_depth: "iterative" } });
      assert.deepEqual(state.workspace.budget, { max_steps: 48, max_reads: 24, max_writes: 0 });
      const result = await f.call(mode, "finish_cognitive_run", completion());
      assert.equal(result.reason_code, "general_analysis_incomplete");
      assert.equal(f.runtime.canOperate(state.run.run_id, { mode: "proposal" }).reason_code, "analysis_read_only");
      f.runtime.updateWorkspace(state.run.run_id, { scope: { analysis_depth: "quick", complexity_level: "light" }, budget: { max_steps: 9999, max_reads: 9999, max_writes: 9 } });
      const updated = f.runtime.current(mode);
      assert.equal(updated.workspace.scope.complexity_level, "deep");
      assert.equal(updated.workspace.budget.max_steps, 60);
      assert.equal(updated.workspace.budget.max_writes, 0);
      assert.equal(f.runtime.governance(state.run.run_id).exploration.applicable, true);
      while (f.runtime.current(mode).episode.steps.length < 60) f.runtime.record(state.run.run_id, { action: { operator: "test_observation", mode: "simulate" }, observation: { status: "ok" } });
      assert.equal(f.runtime.current(mode).run.status, "running");
      assert.equal(f.runtime.canOperate(state.run.run_id, { mode: "read", operator: "inspect_evidence_set" }).allowed, true);
      assert.equal(f.runtime.canOperate(state.run.run_id, { mode: "read", operator: "retrieve" }).allowed, false);
    }
  } finally { f.close(); }
});

test("标准研判与报告的真实精读和验收可完成，新增观察使充分性失效", async () => {
  const f = fixture();
  try {
    for (const id of ["甲", "乙"]) commitCard(f.root, record(id));
    for (const mode of ["assess", "report"]) {
      await f.call(mode, "start_cognitive_run", { mode, skill: `nexo-${mode}`, goal: "比较缓冲", complexity_level: "standard" });
      await f.call(mode, "select_thinking_model", { id: "mechanism-contrast" });
      await f.call(mode, "retrieve", { query: "缓冲" });
      await f.call(mode, "read_card", { id: "甲" });
      await f.call(mode, "read_card", { id: "乙" });
      await f.call(mode, "compare_cards", { card_ids: ["甲", "乙"], dimensions: ["mechanism", "counterevidence"] });
      const items = [{ anchor: "甲", role: "support", claim_id: "c" }, { anchor: "乙", role: "boundary", claim_id: "c" }];
      await f.call(mode, "inspect_evidence_set", { items }); await f.call(mode, "verify_evidence_anchors", { items });
      const sufficient = await f.call(mode, "inspect_cognitive_sufficiency");
      assert.equal(sufficient.data.ready, true, JSON.stringify(sufficient.data.missing));
      await f.call(mode, "read_card", { id: "甲" });
      assert.equal((await f.call(mode, "finish_cognitive_run", completion(items))).reason_code, "general_analysis_incomplete");
      await f.call(mode, "inspect_cognitive_sufficiency");
      assert.equal((await f.call(mode, "finish_cognitive_run", completion(items))).run.status, "completed");
    }
  } finally { f.close(); }
});

test("切换 TM 保留精读而不豁免新方法观察；重复选择不重置", async () => {
  const f = fixture();
  try {
    commitCard(f.root, record("甲")); commitCard(f.root, record("乙"));
    await f.call("switch", "start_cognitive_run", { mode: "report", skill: "nexo-report", goal: "比较机制" });
    await f.call("switch", "select_thinking_model", { id: "mechanism-contrast" });
    await f.call("switch", "read_card", { id: "甲" }); await f.call("switch", "read_card", { id: "乙" });
    await f.call("switch", "compare_cards", { card_ids: ["甲", "乙"] });
    await f.call("switch", "select_thinking_model", { id: "scenario-conditions" });
    const state = f.runtime.current("switch");
    const checks = modelRequirementStatus(state, operatorRegistry);
    assert.ok(!checks.missing_capabilities.includes("read-evidence-slice"));
    assert.ok(checks.missing_capabilities.includes("compare-semantic-dimensions"));
    assert.equal(buildWorkingMemory(state).readings.length, 2);
    const selected = state.run.thinking_model.selected_at_step;
    await f.call("switch", "select_thinking_model", { id: "scenario-conditions" });
    assert.equal(f.runtime.current("switch").run.thinking_model.selected_at_step, selected);
    await f.call("switch", "compare_cards", { card_ids: ["甲", "乙"] });
    assert.ok(!modelRequirementStatus(f.runtime.current("switch"), operatorRegistry).missing_capabilities.includes("compare-semantic-dimensions"));
  } finally { f.close(); }
});

test("工作记忆按判断保留 unit 摘录与解释，内容变化使旧锚点失效", async () => {
  const f = fixture();
  try {
    commitCard(f.root, record("甲"));
    await f.call("unit", "start_cognitive_run", { mode: "report", skill: "nexo-report", goal: "检查证据" });
    await f.call("unit", "read_card_unit", { address: "甲#core-claim" });
    const items = [{ anchor: "甲#core-claim", role: "support", claim_id: "c", explanation: "明确说明阈值突破后的反馈，而不是普遍结论" }];
    await f.call("unit", "verify_evidence_anchors", { items });
    await f.call("unit", "update_cognitive_workspace", { patch: { hypotheses: [{ id: "c", statement: "冲击存在阈值", status: "supported", scope: "共同冲击", uncertainty: "样本待核", anchors: ["甲#core-claim"] }] } });
    const memory = buildWorkingMemory(f.runtime.current("unit"));
    assert.match(memory.claims[0].evidence[0].excerpt, /阈值突破/);
    assert.equal(memory.claims[0].evidence[0].explanation, items[0].explanation);
    commitCard(f.root, record("甲", "## 核心思想\n\n<!-- unit: core-claim -->\n已修改：该系统不存在这个阈值。"));
    assert.equal((await f.call("unit", "verify_evidence_anchors", { items })).data.valid_count, 0);
    await f.call("unit", "read_card", { id: "甲" });
    assert.equal((await f.call("unit", "verify_evidence_anchors", { items })).data.valid_count, 1);
    commitCard(f.root, record("甲", "## 核心思想\n\n<!-- unit: core-claim -->\n再次修改。"));
    assert.equal((await f.call("unit", "verify_evidence_anchors", { items })).data.valid_count, 0);
  } finally { f.close(); }
});

test("机制线索类比可发现同领域跨类型无边候选，不把候选写成关系", async () => {
  const f = fixture();
  try {
    commitCard(f.root, record("金融缓冲"));
    commitCard(f.root, record("组织承载", undefined, { type: "model" }));
    commitCard(f.root, record("无关材料", "## 核心思想\n\n历史地理与地名。", { type: "model" }));
    const ops = loadGraphOps(f.root);
    assert.equal(ops.analogize("金融缓冲").nodes.length, 0);
    const value = ops.analogize("金融缓冲", { mechanismQuery: "缓冲耗尽 阈值突破 正反馈" });
    assert.ok(value.nodes.some((node) => node.id === "组织承载"));
    assert.ok(!value.nodes.some((node) => node.id === "无关材料"));
    assert.equal(value.nodes[0].candidate_status, "unverified_analogy");
    const delivered = await f.call("analogy", "graph_analogize", { card_id: "金融缓冲", mechanism_query: "缓冲耗尽 阈值突破 正反馈", limit: 3 });
    assert.equal(delivered.nodes[0].candidate_status, "unverified_analogy");
    assert.ok(delivered.observation.step > 0);
    assert.ok([...loadCards(f.root).values()].every((card) => (card.meta.relations ?? []).length === 0));
    assert.match(ops.analogize("金融缓冲", { mechanismQuery: "毫不相干的天文学星座" }).misuse, /未在焦点正文定位/);
  } finally { f.close(); }
});

test("deep 可诚实记录挑战未果，但虚构操作和漏掉核心判断不能通过", async () => {
  const f = fixture();
  try {
    for (const id of ["甲", "乙", "丙", "丁"]) commitCard(f.root, record(id));
    const state = await f.call("challenge", "start_cognitive_run", { mode: "assess", skill: "nexo-assess", goal: "检查缓冲边界", complexity_level: "deep" });
    f.runtime.selectThinkingModel(state.run.run_id, { id: "bounded-test", version: "1", required_capabilities: [], observation_obligations: [], output_obligations: ["evidence_anchors"], stop_conditions: ["明确局限"] });
    await f.call("challenge", "read_cards", { ids: ["甲", "乙", "丙"] }); await f.call("challenge", "read_card", { id: "丁" });
    const probe = await f.call("challenge", "trace_support_to_tension", { card_id: "甲" });
    const check = await f.call("challenge", "inspect_conflicts", { card_id: "甲" });
    const items = [{ anchor: "甲", role: "support", claim_id: "c" }, { anchor: "乙", role: "boundary", claim_id: "c" }];
    const claim = { id: "c", statement: "共同冲击下缓冲可能失效", status: "supported", scope: "共同冲击", uncertainty: "仅有库内材料", anchors: ["甲", "乙"] };
    const review = { claim_id: "c", operation_step: 9999, outcome: "not_found", finding: "检查焦点的显式反对关系未定位反例", limitation: "未覆盖正文中隐含反例与库外材料" };
    await f.call("challenge", "update_cognitive_workspace", { patch: { hypotheses: [claim], extension: {
      insight_reviews: [{ operation_step: probe.observation.step, outcome: "empty", finding: "支持链无可用张力", next_check: "直接检查焦点冲突" }], challenge_reviews: [review]
    } } });
    await f.call("challenge", "inspect_evidence_set", { items }); await f.call("challenge", "verify_evidence_anchors", { items });
    assert.ok((await f.call("challenge", "inspect_cognitive_sufficiency")).data.missing.includes("counter_evidence_or_reviewed_search"));
    review.operation_step = check.observation.step;
    await f.call("challenge", "update_cognitive_workspace", { patch: { extension: { challenge_reviews: [review] } } });
    assert.equal((await f.call("challenge", "inspect_cognitive_sufficiency")).data.ready, true);
    await f.call("challenge", "update_cognitive_workspace", { patch: { hypotheses: [claim, { ...claim, id: "missing", statement: "另一个没有证据的判断" }] } });
    assert.ok((await f.call("challenge", "inspect_evidence_set", { items })).data.uncovered_claims.includes("missing"));
    await f.call("challenge", "update_cognitive_workspace", { patch: { hypotheses: [claim] } });
    await f.call("challenge", "inspect_evidence_set", { items }); await f.call("challenge", "verify_evidence_anchors", { items });
    await f.call("challenge", "inspect_cognitive_sufficiency");
    commitCard(f.root, record("甲", "## 核心思想\n\n材料已修订，原命题不能原样沿用。"));
    assert.equal((await f.call("challenge", "finish_cognitive_run", completion(items))).reason_code, "final_evidence_changed");
  } finally { f.close(); }
});

test("研判与报告在回答结束、模型失败和用户中断后不遗留运行态", () => {
  const f = fixture();
  try {
    for (const mode of ["assess", "report"]) for (const [kind, expected] of [["completed", "blocked"], ["error", "failed"], ["interrupted", "cancelled"]]) {
      const id = `${mode}-${kind}`;
      f.runtime.start({ session_id: id, mode, skill: `nexo-${mode}`, goal: "第一问" });
      settleGeneralRunAtTurnBoundary(f.runtime, id, { kind });
      assert.equal(f.runtime.current(id).run.status, expected);
    }
  } finally { f.close(); }
});

test("分析到捕获的交接可以生成确认卡，但确认前正文不变", async () => {
  const f = fixture();
  try {
    writeDomainFixture(f.root, "共同领域");
    const body = "## 一句话主张\n\n缓冲能力会影响共同冲击向系统损失的传导，但不能无条件外推。\n\n## 依据\n\n隔离样本以缓冲耗尽与阈值突破说明机制，供验证提案与确认边界。\n\n## 已知限制\n\n这里只验证操作流程，尚没有实际系统的独立证据。\n\n## 来源与证据边界\n\n来自隔离测试材料，不进入生产知识体。";
    commitCard(f.root, record("甲", body));
    await f.call("capture", "start_cognitive_run", { mode: "assess", skill: "nexo-assess", goal: "讨论一个想法" });
    const args = { summary: "补充用户提出的待验证边界", layer: "content", operations: [{ id: "甲", mode: "enrich", append_sections: { "用户补充": "用户认为共同冲击之外还需比较错峰冲击；这是待核查的想法，不是已证实结论。" } }] };
    assert.equal((await f.call("capture", "propose_write", args)).reason_code, "analysis_read_only");
    await f.call("capture", "finish_cognitive_run", { ...completion(), status: "blocked", stop_reason: "分析尚未闭合，用户转向捕获明确的待核想法" });
    await f.call("capture", "read_card", { id: "甲" }); await f.call("capture", "list_domains");
    const proposed = await f.call("capture", "propose_write", args);
    assert.equal(proposed.status, "pending_approval", JSON.stringify(proposed));
    assert.ok(proposed.proposal_id);
    assert.equal(loadCards(f.root).get("甲").body, body);
    assert.equal(f.runtime.current("capture").run.status, "waiting_user");
  } finally { f.close(); }
});
