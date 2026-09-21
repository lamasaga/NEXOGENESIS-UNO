import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { commitCard, loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { modelOutput, renderModelOutput } from "../packages/nexogenesis-tools/lib/cognition/model-output.js";
import { createChatLatencyTrace } from "../packages/nexogenesis-web-host/lib/latency-telemetry.js";
import { missingModelCapabilities } from "../packages/nexogenesis-tools/lib/cognition/thinking-models.js";
import { operatorRegistry } from "../packages/nexogenesis-tools/lib/cognition/operator-registry.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexo-performance-"));
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  mkdirSync(join(root, "01-Cards"));
  const tools = new Map(); const ctx = { tools: { register(t) { tools.set(t.name, t); } } };
  apply(ctx, { projectRoot: root }); registerCognitionTools(ctx, root, undefined, process.cwd());
  const runtime = getCognitiveRuntime(root);
  return { root, runtime, tools, call: (id, name, args = {}) => tools.get(name).execute(args, { agent: { session: { id } } }), close: () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousDshHome;
    rmSync(root, { recursive: true, force: true });
  } };
}
const card = (id, body = "## 核心思想\n\n缓冲耗尽会导致阈值突破。\n\n## 反例与失效条件\n\n仅适用于共同冲击。") => ({ id, title: id, type: "claim", body, domains: [], relations: [], sources: ["测试来源"], origin: "document", maturity: "growing" });
const items = [{ anchor: "甲", role: "support", claim_id: "c" }, { anchor: "乙", role: "boundary", claim_id: "c" }];
const finish = { status: "completed", changed: [], unchanged: [], pending: [], stop_reason: "完成隔离比较", evidence_anchors: items, audit_evidence: true };
async function prepare(f, mode) {
  await f.call(mode, "start_cognitive_run", { mode, skill: `nexo-${mode}`, goal: "比较缓冲机制", complexity_level: "standard", scope: { analysis_depth: "iterative" }, thinking_model: "mechanism-contrast" });
  await f.call(mode, "retrieve", { query: "缓冲机制" });
  await f.call(mode, "read_cards", { ids: ["甲", "乙"] });
  await f.call(mode, "compare_cards", { card_ids: ["甲", "乙"], dimensions: ["mechanism", "counterevidence"] });
}

test("统一启动与合并验收保留三种分析入口的全部真实审计", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲")); commitCard(f.root, card("乙"));
    for (const mode of ["general", "assess", "report"]) {
      await prepare(f, mode);
      const result = await f.call(mode, "finish_cognitive_run", finish);
      assert.equal(result.run?.status, "completed", JSON.stringify(result));
      const steps = f.runtime.current(mode).episode.steps;
      assert.deepEqual(steps.slice(-4).map(x => x.action.operator), ["inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency", "finish_cognitive_run"]);
      assert.ok(steps.slice(-4, -1).every(x => x.action.invoked_by === "finish_cognitive_run"));
      assert.equal(steps.at(-2).observation.data.ready, true);
      const rendered = JSON.parse(f.tools.get("finish_cognitive_run").output.render(finish, result)[0].text);
      assert.ok(rendered.working_memory.readings.length >= 2);
      const replay = await f.call(mode, "finish_cognitive_run", finish);
      assert.equal(replay.idempotent_replay, true);
      assert.equal(f.runtime.current(mode).episode.steps.length, steps.length);
    }
  } finally { f.close(); }
});

test("合并不能跳过阅读、受控工具范围、TM 或版本变化", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲")); commitCard(f.root, card("乙"));
    await f.call("empty", "start_cognitive_run", { mode: "assess", skill: "nexo-assess", goal: "缺证据" });
    assert.equal((await f.call("empty", "finish_cognitive_run", finish)).status, "rejected");
    await prepare(f, "report");
    const path = loadCards(f.root).get("甲").file;
    writeFileSync(path, readFileSync(path, "utf8").replace("缓冲耗尽会导致阈值突破", "该机制已被当前材料否定"));
    assert.equal((await f.call("report", "finish_cognitive_run", finish)).status, "rejected");
    await prepare(f, "general");
    const state = f.runtime.current("general");
    f.runtime.updateWorkspace(state.run.run_id, { scope: { allowed_ops: ["inspect_evidence_set"] } });
    assert.equal((await f.call("general", "finish_cognitive_run", finish)).reason_code, "operator_not_allowed_in_scope");
    assert.equal(f.runtime.current("general").run.status, "running");
    const scoped = await f.call("scope", "start_cognitive_run", { mode: "assess", skill: "nexo-assess", goal: "受控选择", scope: { allowed_thinking_models: ["scenario-conditions"] }, thinking_model: "mechanism-contrast" });
    assert.equal(scoped.selection.status, "rejected");
    assert.equal(scoped.run.thinking_model, null);
  } finally { f.close(); }
});

test("合并审计使用有限尾部额度且不豁免深度探索", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲")); commitCard(f.root, card("乙"));
    await prepare(f, "report");
    const state = f.runtime.current("report");
    while (f.runtime.current("report").episode.steps.length < state.workspace.budget.max_steps) {
      f.runtime.record(state.run.run_id, { action: { operator: "test_observation", mode: "simulate" }, observation: { status: "ok" } });
    }
    assert.equal((await f.call("report", "finish_cognitive_run", finish)).run.status, "completed");
    await prepare(f, "general");
    const deep = f.runtime.current("general");
    f.runtime.updateWorkspace(deep.run.run_id, { scope: { complexity_level: "deep" } });
    const rejected = await f.call("general", "finish_cognitive_run", finish);
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.data.missing.includes("distinct_read_targets"));
    assert.equal(f.runtime.current("general").run.status, "running");
  } finally { f.close(); }
});

test("真实路径：先检索再声明标准分析，遗漏嵌套标志仍升级并复用本题阅读", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲")); commitCard(f.root, card("乙"));
    await f.call("upgrade", "retrieve", { query: "缓冲" });
    await f.call("upgrade", "read_cards", { ids: ["甲", "乙"] });
    const prior = f.runtime.current("upgrade");
    f.runtime.updateWorkspace(prior.run.run_id, { scope: { allowed_thinking_models: ["mechanism-contrast"], read_only: true } });
    const started = await f.call("upgrade", "start_cognitive_run", { mode: "general", skill: "nexo-talk", goal: "比较缓冲机制", complexity_level: "standard", thinking_model: "mechanism-contrast", scope: { read_only: false } });
    assert.equal(started.run.run_id, prior.run.run_id);
    assert.equal(started.episode, undefined, "升级不能把完整历史工具正文重新发送给模型");
    const renderedStart = JSON.parse(f.tools.get("start_cognitive_run").output.render({}, started)[0].text);
    assert.equal(renderedStart.working_memory.view, "brief");
    const current = f.runtime.current("upgrade");
    assert.equal(current.run.skill, "nexo-talk");
    assert.equal(current.workspace.scope.analysis_depth, "iterative");
    assert.equal(current.workspace.scope.read_only, true);
    assert.equal(current.workspace.budget.max_writes, 0);
    assert.ok(current.episode.steps.some(x => x.action.operator === "read_cards"));
    assert.equal((await f.call("upgrade", "finish_cognitive_run", finish)).status, "rejected", "缺机制比较不能通过");
    await f.call("upgrade", "compare_cards", { card_ids: ["甲", "乙"], dimensions: ["mechanism"] });
    await f.call("upgrade", "update_cognitive_workspace", { patch: { hypotheses: [{ id: "c", statement: "共同冲击下缓冲可能耗尽", status: "inference", scope: "共同冲击", uncertainty: "尚无独立样本", anchors: ["甲", "乙"] }] } });
    const done = await f.call("upgrade", "finish_cognitive_run", finish);
    assert.equal(done.run?.status, "completed", JSON.stringify(done));
    assert.ok(done.working_memory.claims.length > 0);
    assert.equal(done.working_memory.claims[0].evidence.length, 2);
  } finally { f.close(); }
});

test("不适用不能误报审计通过，轻量结束与显式分析互不混淆", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲"));
    await f.call("quick", "read_card", { id: "甲" });
    const check = await f.call("quick", "inspect_cognitive_sufficiency");
    assert.equal(check.status, "rejected");
    assert.equal(check.reason_code, "analysis_run_required");
    assert.equal(check.data.ready, false);
    assert.equal((await f.call("quick", "finish_cognitive_run", finish)).reason_code, "analysis_run_required");
    assert.equal((await f.call("quick", "finish_cognitive_run", { ...finish, audit_evidence: false, evidence_anchors: [] })).run.status, "completed");
    const started = await f.call("explicit", "start_cognitive_run", { mode: "general", skill: "nexo-talk", goal: "分析机制" });
    assert.equal(f.runtime.current("explicit").workspace.scope.analysis_depth, "iterative");
    assert.equal(started.run.thinking_model, null);
    assert.equal((await f.call("explicit", "finish_cognitive_run", finish)).status, "rejected");
  } finally { f.close(); }
});

test("本题检索复用不放松固定深思测试的选择后执行要求", async () => {
  const f = fixture();
  try {
    await f.call("reuse", "retrieve", { query: "缓冲" });
    const state = f.runtime.current("reuse");
    state.workspace.scope.analysis_depth = "iterative";
    state.run.thinking_model = { id: "mechanism-contrast", selected_at_step: 99, required_capabilities: ["retrieve-candidates"] };
    assert.deepEqual(missingModelCapabilities(state, operatorRegistry), []);
    state.run.thinking_model.id = "deep-inquiry";
    assert.deepEqual(missingModelCapabilities(state, operatorRegistry), ["retrieve-candidates"]);
    state.run.thinking_model.id = "mechanism-contrast";
    state.run.skill = "nexo-deep-think";
    assert.deepEqual(missingModelCapabilities(state, operatorRegistry), ["retrieve-candidates"]);
  } finally { f.close(); }
});

test("全文定位是通用只读能力，未命中、受限与建构写入权限分开", async () => {
  const f = fixture();
  try {
    commitCard(f.root, card("甲", "## 核心思想\n\n派生需求的规模效应需要考虑替代条件。"));
    const found = await f.call("gap", "inspect_knowledge_gap", { queries: ["派生需求"], match_mode: "any" });
    assert.equal(found.status, "ok");
    assert.equal(found.data.conclusion, "candidates_found");
    assert.equal(f.runtime.current("gap").run.mode, "general");
    const empty = await f.call("gap", "inspect_knowledge_gap", { queries: ["不存在的测试词"] });
    assert.equal(empty.data.conclusion, "not_located");
    const blocked = await f.call("gap", "review_construct_improvement", { outcome: "keep", reason: "只读任务不能进入建构验收" });
    assert.equal(blocked.reason_code, "construct_run_required");
    const state = f.runtime.current("gap");
    f.runtime.updateWorkspace(state.run.run_id, { scope: { allowed_ops: ["retrieve"] } });
    assert.equal((await f.call("gap", "inspect_knowledge_gap", { queries: ["派生需求"] })).reason_code, "operator_not_allowed_in_scope");
  } finally { f.close(); }
});

test("分析升级不能覆盖待确认或另一种在途任务", async () => {
  const f = fixture();
  try {
    const prior = f.runtime.start({ session_id: "pending", mode: "general", skill: "nexo-emerge", goal: "等待选择" });
    f.runtime.requestInteraction(prior.run.run_id, { type: "choice", request_key: "test", question: "保留哪项？", options: [] });
    const request = { mode: "general", skill: "nexo-talk", goal: "另一个分析" };
    assert.equal((await f.call("pending", "start_cognitive_run", request)).reason_code, "active_run_requires_finish");
    assert.equal(f.runtime.current("pending").run.run_id, prior.run.run_id);
    assert.equal(f.runtime.currentInteraction("pending").status, "pending");
    const construct = f.runtime.start({ session_id: "construct", mode: "construct", skill: "nexo-construct", goal: "正在建构" });
    assert.equal((await f.call("construct", "start_cognitive_run", request)).reason_code, "active_run_requires_finish");
    assert.equal(f.runtime.current("construct").run.run_id, construct.run.run_id);
  } finally { f.close(); }
});

test("涌现系统综合不能用正文标题冒充 sources，真实来源仍须用户确认", async () => {
  const f = fixture();
  try {
    const operation = { ...card("缓冲阈值新假设", "## 一句话主张\n\n共同冲击可能耗尽缓冲。\n\n## 依据\n\n本轮讨论提出缓冲容量与冲击规模的比较，不是已验证定律。\n\n## 已知限制\n\n没有独立样本，不能外推到所有系统。\n\n## 来源与证据边界\n\n来自隔离测试对话的系统假设，仍需样本核验。"), origin: "system", maturity: "seed", lifecycle: "active", created: "2026-09-05", updated: "2026-09-05", sources: [] };
    const proposal = { layer: "creation", summary: "保留待验证假设", operations: [operation] };
    const rejected = await f.call("capture", "propose_write", proposal);
    assert.equal(rejected.reason_code, "capture_sources_required");
    assert.equal(f.runtime.current("capture").run.status, "running");
    operation.sources = ["对话 session:capture — 隔离测试中的缓冲假设"];
    writeDomainFixture(f.root, "测试领域");
    operation.domains = ["测试领域"];
    const pending = await f.call("capture", "propose_write", proposal);
    assert.equal(pending.status, "pending_approval", JSON.stringify(pending));
    assert.equal(loadCards(f.root).has(operation.id), false, "预检通过不是落盘");
  } finally { f.close(); }
});

test("内容索引共享但注意力隔离，写入版本失效，局部建构不扫描整队列", () => {
  const f = fixture();
  try {
    for (const id of ["甲", "乙", "丙"]) commitCard(f.root, card(id));
    const a = loadGraphOps(f.root, new Set(["甲"])); a._ensureSemanticIndex(); a._ensureDiscoveryAnchorIndex();
    const b = loadGraphOps(f.root);
    assert.equal(a.semanticTokenIndex, b.semanticTokenIndex);
    assert.equal(a.discoveryAnchorIndex, b.discoveryAnchorIndex);
    assert.equal(b.seenIds.has("甲"), false);
    let checks = 0; const original = b._unconnectedPriority.bind(b);
    b._unconnectedPriority = (...args) => { checks++; return original(...args); };
    const local = b.unconnected({ scope: "without_relations", cardIds: ["甲"], excludeReviewed: false });
    assert.equal(checks, 1); assert.equal(local.counts_scope, "requested_cards");
    assert.equal(local.candidate_total, 1);
    const limited = b.unconnected({ scope: "without_relations", cardIds: ["甲", "乙"], limit: 1, excludeReviewed: false });
    assert.deepEqual(limited.resolved_card_ids, [], "分页不能把未显示的问题冒充已解决");
    commitCard(f.root, card("甲", "## 核心思想\n\n地理与制度条件发生变化。"));
    const c = loadGraphOps(f.root); c._ensureSemanticIndex();
    assert.notEqual(c.semanticTokenIndex, b.semanticTokenIndex);
  } finally { f.close(); }
});

test("模型投影去重且不截正文，完整审计和显式工作记忆仍可回查", () => {
  const body = "保留条件、反例与来源。".repeat(1200);
  const original = { body, nodes: [{ id: "甲" }], observation: { step: 3, status: "partial", data: { body, nodes: [{ id: "甲" }], reason: "还有缺口" } } };
  const projected = modelOutput(original);
  assert.equal(projected.body, body);
  assert.equal(projected.observation.data.reason, "还有缺口");
  assert.deepEqual(projected.observation.data_fields_at_top_level, ["body", "nodes"]);
  assert.equal(original.observation.data.body, body);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(original).length * .6);
  assert.deepEqual(modelOutput(original, { full: true }), original);
  const memory = { working_memory: { version: "1.0", claims: [{ statement: body }], next_actions: ["补充验证"], exploration_budget: { frontier: ["乙"] } } };
  assert.equal(JSON.parse(renderModelOutput({}, memory)[0].text).working_memory.view, "brief");
  assert.deepEqual(JSON.parse(renderModelOutput({ view: "memory" }, memory)[0].text), memory);
  for (const version of ["construct-1", "ingestion-1"]) assert.deepEqual(modelOutput({ working_memory: { ...memory.working_memory, version } }).working_memory.claims, memory.working_memory.claims);
});

test("逐轮延迟记录只保存时间与用量，不保存模型内容和工具正文", () => {
  const f = fixture();
  try {
    const trace = createChatLatencyTrace(f.root, { pipeline: true }); const data = { turn: 1, step: 1 };
    trace.stepStarted(data); trace.modelChunk({ ...data, chunk: { text: "不记录的推理" } });
    trace.modelMessage({ ...data, message: "不记录的回答", usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 1000, secret: "不记录" } });
    trace.toolStarted({ id: "c", name: "read_cards" }); trace.toolFinished({ id: "c" }, { content: [{ text: "不记录的正文" }] });
    trace.stepFinished(data); trace.finish(); trace.finish();
    const text = readFileSync(join(f.root, ".nexogenesis/telemetry/chat-latency.jsonl"), "utf8").trim();
    assert.ok(!text.includes("不记录")); const log = JSON.parse(text);
    assert.equal(log.model_steps.length, 1); assert.equal(log.model_steps[0].usage.inputTokens, 500);
    assert.ok(log.model_steps[0].first_chunk_ms >= 0); assert.ok(log.tool_result_characters > 0);
  } finally { f.close(); }
});
