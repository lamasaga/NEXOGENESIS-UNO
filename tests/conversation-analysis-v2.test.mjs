import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { reviewConversationDelivery } from "../packages/nexogenesis-tools/lib/cognition/conversation-analysis.js";
import { deliveryFromHistory, reconcileAnalysisDelivery } from "../packages/nexogenesis-web-host/lib/analysis-delivery.js";
import { settleGeneralRunAtTurnBoundary } from "../packages/nexogenesis-web-host/lib/turn-state.js";

function fixture(t, skill = "nexo-talk", policy = "conversation-v2") {
  const root = mkdtempSync(join(tmpdir(), "nexo-conversation-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = new Map(), ctx = { tools: { register(tool) { tools.set(tool.name, tool); } } };
  apply(ctx, { projectRoot: root }); registerCognitionTools(ctx, root, undefined, process.cwd());
  const runtime = getCognitiveRuntime(root);
  runtime.admitConversationTurn("s", { policy, request: "检验机制与边界" });
  runtime.bindConversationTurn("s", { type: "turn/start", time: Date.now() + 1, data: { turn: 1 } });
  const { run } = runtime.start({ session_id: "s", mode: "general", skill, goal: "检验机制与边界", scope: { analysis_depth: "iterative", complexity_level: "deep" } });
  const call = (name, args = {}) => tools.get(name).execute(args, { agent: { session: { id: "s" } } });
  const card = (id, relations = [], body = "## 机制\n\n缓冲在短期可以吸收冲击，但长期可能耗尽。") => commitCard(root, { id, title: id, type: "claim", maturity: "growing", lifecycle: "active", origin: "document", domains: [], sources: ["隔离测试材料"], relations, body });
  return { root, runtime, id: run.run_id, call, card, state: () => runtime.get(run.run_id) };
}
const finish = (extra = {}) => ({ status: "completed", coverage: "answered", changed: ["给出机制解释"], unchanged: [], pending: [], stop_reason: "现有材料足够解释，实证另行核查", evidence_anchors: [], ...extra });
const anchor = id => ({ anchor: id, claim_id: "C1", role: "support" });
const end = (kind = "completed", turn = 1) => ({ type: "turn/end", seq: 10, time: Date.now() + 20, data: { turn, reason: { kind } } });
const message = (blocks = [{ type: "text", text: "现有理论支持局部解释，尚未检验实证。" }]) => ({ type: "assistant/message", seq: 9, time: Date.now() + 10, data: { turn: 1, message: { role: "assistant", content: blocks } } });

test("新版缺少TM/特殊OPS不阻断局部交付，未知锚点不被核验，相同准备幂等", async t => {
  const f = fixture(t);
  const args = finish({ pending: ["未做预测事后检验"], evidence_anchors: [anchor("幽灵")] });
  const first = await f.call("finish_cognitive_run", args);
  assert.equal(first.run.status, "running"); assert.equal(first.run.delivery.state, "prepared");
  assert.equal(first.review.evidence.valid_count, 0); assert.equal(first.review.coverage, "partial");
  const steps = f.state().episode.steps.length;
  const second = await f.call("finish_cognitive_run", args);
  assert.equal(second.idempotent_replay, true); assert.equal(f.state().episode.steps.length, steps);
  assert.equal(f.runtime.canOperate(f.id, { mode: "read", operator: "graph_walk" }).reason_code, "delivery_prepared");
});

test("预算已耗尽仍有有界收尾；插入使准备失效但不重置预算", async t => {
  const f = fixture(t);
  for (let i = 0; i < 48; i++) f.runtime.record(f.id, { action: { operator: "test", mode: "read" }, observation: { status: "ok" } });
  assert.equal(f.runtime.canOperate(f.id, { operator: "retrieve" }).allowed, false);
  await f.call("finish_cognitive_run", finish({ coverage: "partial", pending: ["资源已用尽"] }));
  const budget = f.state().workspace.budget;
  f.runtime.updateWorkspace(f.id, { user_directives: [{ text: "先回答，验证稍后" }] });
  assert.equal(f.state().run.delivery.state, "none"); assert.deepEqual(f.state().workspace.budget, budget);
  assert.equal(f.state().run.delivery_history.length, 1);
  for (let i = 0; i < 2; i++) { await f.call("finish_cognitive_run", finish({ pending: [`缺口${i}`] })); f.runtime.invalidateDelivery(f.id, "修正"); }
  assert.equal((await f.call("finish_cognitive_run", finish())).reason_code, "delivery_review_exhausted");
});

test("策略、预算、目标与只读权限不可由工作区覆盖；同回合不能换Run洗预算", async t => {
  const f = fixture(t);
  for (const patch of [{ analysis_policy_version: "legacy" }, { delivery: { state: "delivered" } }, { budget: { max_steps: 9999 } }, { scope: { analysis_depth: "quick" } }, { goal: "换个问题" }]) assert.throws(() => f.runtime.updateWorkspace(f.id, patch));
  assert.equal(f.runtime.canOperate(f.id, { mode: "proposal" }).reason_code, "analysis_read_only");
  f.runtime.setStatus(f.id, "blocked");
  await assert.rejects(f.call("start_cognitive_run", { mode: "general", skill: "nexo-talk", goal: "重新" }), /预算/);
  f.runtime.admitConversationTurn("s", { policy: "conversation-v2", request: "用户新问题" });
  assert.notEqual((await f.call("start_cognitive_run", { mode: "general", skill: "nexo-talk", goal: "新问题" })).run.run_id, f.id);
});

test("旧策略和固定执行测试不被新版交付参数豁免", async t => {
  for (const [skill, policy] of [["nexo-deep-think", "conversation-v2"], ["nexo-talk", "legacy"]]) {
    const f = fixture(t, skill, policy);
    assert.equal(f.state().run.analysis_policy_version, "legacy");
    const result = await f.call("finish_cognitive_run", finish());
    assert.equal(result.status, "rejected"); assert.equal(f.state().run.delivery, undefined);
  }
});

test("持久最终消息才算交付，准备/工具过程/隐藏内容/取消片段不算完成答案", async t => {
  const f = fixture(t); await f.call("finish_cognitive_run", finish({ coverage: "partial" }));
  const e = end(), m = message();
  assert.equal(deliveryFromHistory(f.state(), { events: [m] }, e), null);
  assert.equal(deliveryFromHistory(f.state(), { events: [message([{ type: "reasoning", text: "不展示" }]), e] }, e), null);
  assert.equal(deliveryFromHistory(f.state(), { events: [message([{ type: "text", text: "正在审计" }, { type: "tool-call", name: "finish_cognitive_run" }]), e] }, e), null);
  assert.equal(deliveryFromHistory(f.state(), { events: [m, e] }, e).state, "delivered");
  const cancelled = end("interrupted");
  assert.equal(deliveryFromHistory(f.state(), { events: [m, cancelled] }, cancelled).state, "interrupted");
  assert.equal(deliveryFromHistory(f.state(), { events: [m, end("completed", 2)] }, end("completed", 2)), null);
});

test("正常结束与实际交付分离，重启可对账且不重复生成，不覆盖用户待答", async t => {
  const f = fixture(t); await f.call("finish_cognitive_run", finish({ coverage: "partial", pending: ["预测未检验"] }));
  const e = end();
  f.runtime.settleAnalysisDelivery(f.id, { end: e, kind: "completed", detail: "结束", delivery: null });
  assert.equal(f.state().run.status, "closed"); assert.equal(f.state().run.delivery.state, "prepared");
  assert.throws(() => f.runtime.resume(f.id), /已经结束/);
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.method, "session.history");
    return new Response(JSON.stringify({ type: "server-response", result: { ok: true, value: { events: [message(), e] } } }));
  };
  const ctx = { webServer: { port: 1 }, sessions: { get: () => ({ events: [message(), e] }), flush: async () => true }, sessionPersistence: { readFrom: async () => ({ events: [message(), e] }) } };
  await reconcileAnalysisDelivery(ctx, f.runtime, f.state());
  assert.equal(f.state().run.delivery.state, "delivered"); assert.equal(f.state().run.delivery.message_ref, "s:9");
  const stamp = f.state().run.delivery.delivered_at;
  await reconcileAnalysisDelivery(ctx, f.runtime, f.state()); assert.equal(f.state().run.delivery.delivered_at, stamp);
});

test("正文修改使相同引用检查失效，不沿用旧可用锚点", async t => {
  const f = fixture(t); f.card("甲"); await f.call("read_card", { id: "甲" });
  const args = finish({ evidence_anchors: [anchor("甲")] });
  const first = await f.call("finish_cognitive_run", args); assert.equal(first.review.evidence.valid_count, 1);
  f.card("甲", [], "## 新正文\n\n原来条件已发生变化。");
  const second = await f.call("finish_cognitive_run", args);
  assert.notEqual(second.review.fingerprint, first.review.fingerprint); assert.equal(second.review.evidence.valid_count, 0);
});

test("真实桥接路径加逐节点阅读可回查；捏造路径/漏读/旧关系不能冒充采用", async t => {
  const f = fixture(t);
  f.card("甲", [{ target: "乙", type: "supports", note: "仅当资本缓冲充足时提供机制依据" }]);
  f.card("乙", [{ target: "丙", type: "supports", note: "长期缓冲耗尽会限制该判断的适用范围" }]); f.card("丙");
  const graph = await f.call("graph_walk", { card_id: "甲", direction: "out", hops: 2, plane: "argument" });
  assert.ok(graph.nodes.some(node => node.id === "丙"));
  for (const id of ["甲", "乙", "丙"]) await f.call("read_card", { id });
  const findings = [{ claim_id: "C1", path: ["甲", "乙", "丙"], anchors: ["甲", "乙", "丙"], outcome: "narrowed", finding: "不能从短期缓冲推出长期稳定", conditions: "需核对同一资产负债表与冲击期限；支持边不是因果证明。" }];
  const args = finish({ evidence_anchors: ["甲", "乙", "丙"].map(anchor), relation_findings: findings });
  let review = reviewConversationDelivery(f.root, f.state(), args);
  assert.equal(review.relation_findings[0].provenance, "observed_and_read");
  assert.equal(review.relation_findings[0].edges[0].from, "甲");
  review = reviewConversationDelivery(f.root, f.state(), { ...args, relation_findings: [{ ...findings[0], path: ["丙", "甲"] }] });
  assert.equal(review.relation_findings[0].provenance, "unverified");
  f.card("甲");
  assert.equal(reviewConversationDelivery(f.root, f.state(), args).relation_findings[0].provenance, "unverified");
});

test("不同口径不应接合：保留拒绝结论，路径真实也不认证语义", async t => {
  const f = fixture(t);
  f.card("短期", [{ target: "长期", type: "supports", note: "提供对照而非直接的跨时推论" }], "## 机制\n\n甲国金融机构的短期流动性比率。");
  f.card("长期", [], "## 机制\n\n乙国企业的长期偿付能力。");
  await f.call("graph_path", { from_id: "短期", to_id: "长期" });
  for (const id of ["短期", "长期"]) await f.call("read_card", { id });
  const review = reviewConversationDelivery(f.root, f.state(), finish({ evidence_anchors: ["短期", "长期"].map(anchor), relation_findings: [{ claim_id: "C1", path: ["短期", "长期"], anchors: ["短期", "长期"], outcome: "rejected", finding: "不能直接接合", conditions: "国家、部门、期限与度量不同，只能保留对照。" }] }));
  assert.equal(review.relation_findings[0].provenance, "observed_and_read");
  assert.equal(review.relation_findings[0].outcome, "rejected");
  assert.equal(review.relation_findings[0].semantic_status, "model_synthesis_not_certified");
});

test("隐式侦察不能用补丁升级并越过预算，正常升级保留已用量", async t => {
  const f = fixture(t); f.runtime.admitConversationTurn("quick", { policy: "conversation-v2" });
  const quick = f.runtime.start({ session_id: "quick", mode: "general", skill: "implicit", goal: "窄问题" });
  assert.throws(() => f.runtime.updateWorkspace(quick.run.run_id, { scope: { analysis_depth: "iterative" }, budget: { max_steps: 9999, max_reads: 9999 } }), /受控分配/);
  f.runtime.record(quick.run.run_id, { action: { operator: "read_card", mode: "read" }, observation: { status: "ok" } });
  f.runtime.promoteAnalysis(quick.run.run_id, { skill: "nexo-talk", goal: "窄问题", scope: { complexity_level: "deep" }, budget: { max_steps: 9999 } });
  assert.equal(f.runtime.get(quick.run.run_id).workspace.budget.max_steps, 60);
  assert.ok(f.runtime.get(quick.run.run_id).episode.steps.length > 0);
});

test("新冲突、延期和pending更新使准备失效，不能继续显示answered", async t => {
  const f = fixture(t);
  for (const patch of [{ conflicts: [{ description: "时期不相容" }] }, { deferred_items: [{ reason: "数据未取得" }] }, { extension: { result: { pending: ["需要新样本"] } } }]) {
    await f.call("finish_cognitive_run", finish());
    f.runtime.updateWorkspace(f.id, patch);
    assert.equal(f.state().run.delivery.state, "none"); assert.equal(f.state().run.delivery.coverage, "unknown");
  }
});

test("实际待答问题不能被收尾覆盖；回答后新turn延续原预算，旧end不落状态", async t => {
  const f = fixture(t);
  const question = f.runtime.requestInteraction(f.id, { type: "choice", request_key: "q", question: "选择时期", options: [] });
  assert.equal((await f.call("finish_cognitive_run", finish())).reason_code, "pending_user_decision");
  const before = f.state().workspace.budget;
  f.runtime.answerInteraction(question.interaction_id, { text: "短期" }); f.runtime.continueAnalysisTurn(f.id); f.runtime.resume(f.id);
  f.runtime.bindConversationTurn("s", { type: "turn/start", time: Date.now() + 1, data: { turn: 2 } });
  assert.deepEqual(f.state().workspace.budget, before);
  f.runtime.settleAnalysisDelivery(f.id, { end: end(), kind: "completed", detail: "旧回合", delivery: null });
  assert.equal(f.state().run.status, "running"); assert.equal(f.state().run.host_turn_id, "2");
});

test("内存history或失败的flush不能宣称持久交付", async t => {
  const f = fixture(t); await f.call("finish_cognitive_run", finish());
  const e = end(), oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ type: "server-response", result: { ok: true, value: { events: [message(), e] } } }));
  for (const flush of [async () => false, async () => { throw new Error("磁盘失败"); }]) {
    await reconcileAnalysisDelivery({ webServer: { port: 1 }, sessions: { get: () => ({ events: [e] }), flush }, sessionPersistence: { readFrom: async () => { throw new Error("失败的flush不应读取"); } } }, f.runtime, f.state(), e);
    assert.equal(f.state().run.delivery.state, "prepared"); assert.equal(f.state().run.status, "closed");
  }
});

test("冷会话从物理记录恢复交付；没做准备则覆盖度仍为unknown", async t => {
  const f = fixture(t);
  let reads = 0;
  await reconcileAnalysisDelivery({ get: key => key === "sessionPersistence" ? { readFrom: async id => {
    assert.equal(id, "s"); reads++; return { events: [message(), end()] };
  } } : { get: () => undefined } }, f.runtime, f.state());
  assert.equal(reads, 1); assert.equal(f.state().run.status, "closed");
  assert.equal(f.state().run.delivery.state, "delivered"); assert.equal(f.state().run.delivery.coverage, "unknown");
});

test("无结束记录的旧回合隔离为失败，不能猜测正常完成", t => {
  const f = fixture(t);
  settleGeneralRunAtTurnBoundary(f.runtime, "s", { phase: "start" });
  assert.equal(f.state().run.status, "failed"); assert.notEqual(f.state().run.delivery?.state, "delivered");
});
