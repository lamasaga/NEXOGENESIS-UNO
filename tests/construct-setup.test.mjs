import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { handleChatStream } from "../packages/nexogenesis-web-host/lib/chat.js";
import { patchConversationExt } from "../packages/nexogenesis-web-host/lib/meta.js";
import { foldMessages } from "../packages/nexogenesis-web-host/lib/projects.js";
import { commitCard, loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { apply } from "../packages/nexogenesis-tools/lib/index.js";
import { prepareConstruct, buildConstructContract, constructPrompt } from "../packages/nexogenesis-web-host/lib/construct.js";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { constructWriteReadiness, constructCompletionReadiness } from "../packages/nexogenesis-tools/lib/cognition/construct-governance.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

const card = (id, extra = {}) => ({ id, title: id, type: "claim", origin: "document", lifecycle: "active", maturity: "growing", sources: ["测试原文"], domains: [], relations: [], body: "## 主张\n\n融资约束通过资产出售影响估值，有明确适用条件。", ...extra });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nexo-construct-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeDomainFixture(root, "领域");
  commitCard(root, card("甲", { domains: ["领域"], relations: [{ target: "乙", type: "supports", note: "支持价格判断" }] }));
  commitCard(root, card("乙")); commitCard(root, card("独立", { domains: ["领域"] }));
  const request = { snapshot: prepareConstruct(root).snapshot, goal: "connect", workload: "group", scope: { kind: "instance" }, changes: "organization", notes: "保留细节" };
  const runtime = new CognitiveRuntime(root);
  const start = (patch = {}) => {
    const contract = buildConstructContract(root, { ...request, ...patch });
    const state = runtime.start({ session_id: "setup", mode: "construct", skill: "nexo-construct", goal: contract.goal_label, scope: { construct_request: contract }, budget: contract.budget, write_authority: "trusted" });
    return { contract, state: runtime.get(state.run.run_id) };
  };
  return { root, request, runtime, start };
}

test("preparation distinguishes domain membership, incoming edges and isolation", t => {
  const f = fixture(t), prepared = prepareConstruct(f.root, "trusted");
  assert.equal(prepared.summary.cards, 3); assert.equal(prepared.summary.isolated, 1);
  assert.deepEqual(prepared.cards.find(c => c.id === "乙").neighbors, ["甲"]);
  assert.equal(prepared.authority, "trusted");
});
test("server freezes domain and incoming/outgoing neighborhood scope", t => {
  const f = fixture(t);
  const domain = buildConstructContract(f.root, { ...f.request, scope: { kind: "domain", id: "领域" } });
  assert.deepEqual(new Set(domain.card_ids), new Set(["甲", "独立"]));
  const neighborhood = buildConstructContract(f.root, { ...f.request, scope: { kind: "neighborhood", id: "乙" } });
  assert.deepEqual(new Set(neighborhood.card_ids), new Set(["甲", "乙"]));
});
test("rejects stale snapshots, other instances, bad options and missing scope", t => {
  const f = fixture(t), other = fixture(t);
  assert.throws(() => buildConstructContract(other.root, f.request), /知识体已变化/);
  for (const patch of [{ goal: "invalid" }, { workload: "unbounded" }, { notes: "x".repeat(2001) }, { scope: { kind: "domain", id: "missing" } }]) {
    assert.throws(() => buildConstructContract(f.root, { ...f.request, ...patch }));
  }
  commitCard(f.root, card("新增"));
  assert.throws(() => buildConstructContract(f.root, f.request), /知识体已变化/);
});
test("workload budgets are server-owned; systematic is larger, advice has zero writes", t => {
  const f = fixture(t);
  const contract = workload => buildConstructContract(f.root, { ...f.request, workload, budget: { max_steps: 999999 } });
  assert.equal(contract("advice").budget.max_writes, 0);
  assert.ok(contract("systematic").budget.max_steps > contract("group").budget.max_steps);
  assert.equal(contract("group").budget.max_steps, 600);
});
test("advice rejects writes and proposals but allows reading and bookkeeping", t => {
  const f = fixture(t), { state } = f.start({ workload: "advice" });
  for (const mode of ["write", "proposal"]) assert.equal(f.runtime.canOperate(state.run.run_id, { mode }).reason_code, "construct_advice_only");
  for (const mode of ["read", "runtime-write"]) assert.equal(f.runtime.canOperate(state.run.run_id, { mode }).allowed, true);
  assert.equal(constructWriteReadiness(state, { layer: "content" }).reason_code, "construct_advice_only");
  assert.equal(constructCompletionReadiness(state, f.root).ready, false);
  const observed = structuredClone(state);
  observed.run.thinking_model = { id: "knowledge-organization" };
  observed.workspace.evidence = [{ card_id: "甲" }];
  observed.episode.steps = [{ action: { mode: "read" }, observation: { status: "ok", data: { card_id: "甲" } } }];
  assert.equal(constructCompletionReadiness(observed, f.root, { pending: ["建议日后调整"] }).ready, true);
});
test("workspace edits and restarting a session cannot widen authorization; resume retains contract", t => {
  const f = fixture(t), { contract, state } = f.start({ workload: "advice" });
  const id = state.run.run_id;
  f.runtime.updateWorkspace(id, { scope: {} });
  assert.deepEqual(f.runtime.get(id).workspace.scope.construct_request, contract);
  assert.throws(() => f.runtime.updateWorkspace(id, { scope: { construct_request: { ...contract, workload: "systematic" } } }), /冻结/);
  assert.throws(() => f.runtime.updateWorkspace(id, { budget: { max_steps: 99999 } }), /预算/);
  f.runtime.setStatus(id, "paused", "test"); f.runtime.resume(id);
  assert.deepEqual(f.runtime.get(id).workspace.scope.construct_request, contract);
  f.runtime.setStatus(id, "completed", "test");
  assert.throws(() => f.runtime.start({ session_id: "setup", mode: "general" }), /绕过/);
});
test("layer and source-scope guards reject unintended mutations before semantic checks", t => {
  const f = fixture(t), { state } = f.start({ scope: { kind: "neighborhood", id: "乙" }, changes: "relations" });
  assert.equal(constructWriteReadiness(state, { layer: "content", operations: [{ id: "甲" }] }).reason_code, "construct_layer_out_of_scope");
  assert.equal(constructWriteReadiness(state, { layer: "relation", operations: [{ id: "独立" }] }).reason_code, "construct_card_out_of_scope");
  assert.notEqual(constructWriteReadiness(state, { layer: "relation", operations: [{ id: "甲" }], relationRequest: { source_id: "甲", target_id: "独立" } }).reason_code, "construct_card_out_of_scope");
});
test("base prompt carries choices and distinguishes workload without prescribing tool sequence", t => {
  const f = fixture(t);
  for (const workload of ["advice", "group", "systematic"]) {
    const contract = buildConstructContract(f.root, { ...f.request, workload });
    const prompt = constructPrompt("/construct", contract);
    assert.match(prompt, /接通知识孤岛/); assert.match(prompt, /保留细节/); assert.match(prompt, /工具结果决定下一步/);
    assert.match(prompt, workload === "advice" ? /强制不写知识/ : workload === "group" ? /一个紧密相关/ : /连续处理原范围/);
    const visible = foldMessages({ events: [{ type: "user/message", data: { source: { kind: "user" }, content: prompt } }] })[0].content;
    assert.match(visible, /本次建构：接通知识孤岛/);
    assert.match(visible, /保留细节/);
    assert.doesNotMatch(visible, /workspace|request_user_choice|CONSTRUCT_CONTEXT/);
  }
});

test("HTTP startup and resume persist the same contract without calling a real model", async t => {
  const f = fixture(t), previousHome = process.env.DSH_HOME, previousFetch = globalThis.fetch;
  process.env.DSH_HOME = f.root;
  t.after(() => { globalThis.fetch = previousFetch; if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; });
  patchConversationExt("http-construct", { project_id: "test", task_kind: "construct" });
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    return { json: async () => ({ type: "server-response", result: { ok: true, value: body.method === "session.list" ? { items: [] } : {} } }) };
  };
  const ctx = { webServer: { port: 9999 }, settings: { get: () => ({ pipeline_authority: "trusted" }) }, on: () => () => {} };
  const invoke = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify({ conversation_id: "http-construct", ...body }))]);
    req.headers = { "content-type": "application/json" };
    const res = new EventEmitter(); res.writeHead = () => {}; res.write = () => {}; res.end = () => {};
    try { await handleChatStream(ctx, req, res, [], f.root); } finally { res.emit("close"); }
  };
  await invoke({ message: "/construct", construct_request: { ...f.request, workload: "advice" } });
  const first = f.runtime.current("http-construct");
  assert.equal(first.workspace.scope.construct_request.workload, "advice");
  assert.equal(first.workspace.budget.max_writes, 0);
  assert.equal(first.run.write_authority, "trusted");
  assert.match(JSON.stringify(calls.find(call => call.method === "session.prompt")), /本轮强制不写知识/);
  await assert.rejects(invoke({ message: "/construct", construct_request: f.request }), /已有任务不能/);
  f.runtime.setStatus(first.run.run_id, "paused", "test pause");
  await invoke({ message: "继续任务", resume_task: true });
  const resumed = f.runtime.current("http-construct");
  assert.equal(resumed.run.run_id, first.run.run_id);
  assert.deepEqual(resumed.workspace.scope.construct_request, first.workspace.scope.construct_request);
});

test("real proposal tool cannot write under advice, even with trusted authority", async t => {
  const f = fixture(t); f.start({ workload: "advice" });
  const tools = new Map();
  apply({ tools: { register(tool) { tools.set(tool.name, tool); } } }, { projectRoot: f.root });
  const before = loadCards(f.root).get("甲").body;
  const result = await tools.get("propose_relation_patch").execute({ action: "upsert", source_id: "甲", target_id: "独立", relation_type: "supports", note: "本次只看建议，不应写入", summary: "预期拒绝" }, { agent: { session: { id: "setup" } } });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason_code, "construct_advice_only");
  assert.equal(loadCards(f.root).get("甲").body, before);
  assert.equal(loadCards(f.root).get("甲").meta.relations.length, 1);
});
