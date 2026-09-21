import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { patchConversationExt, conversationExt } from "../packages/nexogenesis-web-host/lib/meta.js";
import { workSnapshot, projectWorkPhase, settleWorkTurn, observeWork, handleNativeAnswer, handleWorkStop, validateNativeAnswers, withInstanceMutation } from "../packages/nexogenesis-web-host/lib/work.js";

function fixture(t) {
 const root = mkdtempSync(join(tmpdir(), "nexo-work-")), priorHome = process.env.DSH_HOME, priorFetch = globalThis.fetch;
 process.env.DSH_HOME = root;
 const sessions = [{ sessionId: "chat", running: true, updatedAt: Date.now() }, { sessionId: "task", running: false, updatedAt: Date.now() + 1 }], calls = [];
 patchConversationExt("chat", { title: "讨论通缩" }); patchConversationExt("task", { title: "建构测试", task_kind: "construct" });
 globalThis.fetch = async (_url, init) => {
  const call = JSON.parse(init.body); calls.push(call);
  const value = call.method === "session.list" ? { items: sessions } : {};
  if (call.method === "session.cancel") sessions.find(s => s.sessionId === call.payload.sessionId).running = false;
  return { json: async () => ({ type: "server-response", result: { ok: true, value } }) };
 };
 t.after(() => { globalThis.fetch = priorFetch; if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome; rmSync(root, { recursive: true, force: true }); });
 const ctx = { webServer: { port: 8787 } }, runtime = getCognitiveRuntime(root);
 const run = runtime.start({ session_id: "task", mode: "construct", skill: "nexo-construct", goal: "检查局部知识结构", scope: { card_ids: ["card-a"] } });
 const req = body => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { "content-type": "application/json" } });
 const res = { writeHead() {}, end() {} };
 return { root, ctx, runtime, run, sessions, calls, req, res };
}
const question = { rpc_id: "question-1", session_id: "chat", questions: [{ id: "scope", question: "聚焦哪个层面？", options: [{ label: "机制" }, { label: "历史" }] }] };

test("全局状态显示旧普通对话的待答问题，不被最近任务遮住", async t => {
 const f = fixture(t); patchConversationExt("chat", { native_question: question });
 f.runtime.setStatus(f.run.run.run_id, "completed");
 const snapshot = await workSnapshot(f.ctx, f.root);
 assert.equal(snapshot.items[0].id, "chat"); assert.equal(snapshot.items[0].phase, "waiting_user");
 assert.equal(snapshot.items[1].phase, "completed");
 assert.equal(snapshot.items[0].native_question.questions[0].id, "scope");
});

test("正常回合结束不冒充验收通过，重复收尾幂等且保留冻结范围", async t => {
 const f = fixture(t), event = { seq: 7, time: Date.now(), data: { reason: "completed" } };
 const results = await Promise.all([settleWorkTurn(f.ctx, f.root, "task", event), settleWorkTurn(f.ctx, f.root, "task", event)]);
 assert.deepEqual(results, [{ continued: false }, { continued: false }]);
 assert.equal(f.runtime.current("task").run.status, "paused");
 assert.deepEqual(f.runtime.current("task").workspace.scope.card_ids, ["card-a"]);
 assert.equal(projectWorkPhase({ running: false }, f.runtime.current("task")), "paused");
 f.runtime.setStatus(f.run.run.run_id, "running"); assert.equal(f.runtime.current("task").run.finished_at, undefined);
});

test("浏览器没有聊天流连接时，后台观察者仍处理失败与原生提问", async t => {
 const f = fixture(t); let resolveWait, failAnswer = true;
 f.ctx.apiProxy = { events: { async *mux(_request, signal) {
  yield { rpcId: question.rpc_id, payload: { type: "question/requested", sessionId: "chat", questions: question.questions } };
  yield { payload: { type: "session/event", sessionId: "task", event: { seq: 88, time: Date.now(), type: "turn/end", data: { reason: { kind: "error", message: "provider failure" } } } } };
  await new Promise(resolve => { resolveWait = resolve; signal.addEventListener("abort", resolve, { once: true }); });
 } }, respond: async message => { if (failAnswer) throw new Error("temporary transport failure"); f.calls.push(message); return { accepted: true }; } };
 const stop = observeWork(f.ctx, () => f.root); t.after(() => { stop(); resolveWait?.(); });
 await new Promise(resolve => setTimeout(resolve, 10));
 assert.equal(f.runtime.current("task").run.status, "failed");
 assert.equal((await workSnapshot(f.ctx, f.root)).items[0].native_question.live, true);
 await assert.rejects(handleNativeAnswer(f.ctx, f.req({ rpc_id: question.rpc_id, answers: [{ id: "scope", selected: ["机制"] }] }), f.res, [], f.root, "chat"), /temporary transport/);
 assert.ok(conversationExt("chat").native_question);
 failAnswer = false;
 await handleNativeAnswer(f.ctx, f.req({ rpc_id: question.rpc_id, answers: [{ id: "scope", selected: ["机制"] }] }), f.res, [], f.root, "chat");
 assert.equal(f.calls.at(-1).type, "client-response");
 assert.equal(f.calls.at(-1).result.value.sessionId, "chat");
 assert.equal(conversationExt("chat").native_question, null);
 await assert.rejects(handleNativeAnswer(f.ctx, f.req({ rpc_id: question.rpc_id, answers: [] }), f.res, [], f.root, "chat"), /已经处理/);
});

test("暂停保留待答问题，重启后回答明确接续原会话，停止则清除", async t => {
 const f = fixture(t); patchConversationExt("chat", { native_question: { ...question, rpc_id: "recovered" } });
 await handleWorkStop(f.ctx, f.req({ action: "pause" }), f.res, [], f.root, "chat");
 assert.ok(conversationExt("chat").native_question);
 await handleNativeAnswer(f.ctx, f.req({ rpc_id: "recovered", answers: [{ id: "scope", selected: [], custom: "研究债务机制" }] }), f.res, [], f.root, "chat");
 const prompt = f.calls.find(c => c.method === "session.prompt"); assert.equal(prompt.payload.sessionId, "chat"); assert.match(prompt.payload.content[0].text, /研究债务机制/);
 patchConversationExt("chat", { native_question: question });
 await handleWorkStop(f.ctx, f.req({ action: "stop" }), f.res, [], f.root, "chat");
 assert.equal(conversationExt("chat").native_question, null);
});

test("会话已随服务重启脱离时，停止任务仍作为幂等成功处理", async t => {
 const f = fixture(t), response = { status: null, body: null };
 globalThis.fetch = async (_url, init) => {
  const call = JSON.parse(init.body); f.calls.push(call);
  if (call.method === "session.cancel") return { json: async () => ({ type: "server-response", result: { ok: false, error: { code: "session-not-found", message: 'session "task" not found (not attached)' } } }) };
  const value = call.method === "session.list" ? { items: f.sessions } : {};
  return { json: async () => ({ type: "server-response", result: { ok: true, value } }) };
 };
 const res = { writeHead(status) { response.status = status; }, end(body) { response.body = JSON.parse(body); } };
 await handleWorkStop(f.ctx, f.req({ action: "stop" }), res, [], f.root, "task");
 assert.equal(response.status, 200);
 assert.equal(response.body.accepted, true);
 assert.equal(f.runtime.current("task").run.status, "cancelled");
});

test("不接受跨会话问题、失配选项或空回答，失败保留待答", async t => {
 const f = fixture(t); patchConversationExt("chat", { native_question: question });
 await assert.rejects(handleNativeAnswer(f.ctx, f.req({ rpc_id: "other", answers: [] }), f.res, [], f.root, "chat"), /已经处理/);
 for (const answers of [[], [{ id: "scope", selected: ["无效"] }], [{ id: "scope", selected: [] }]]) assert.throws(() => validateNativeAnswers(question.questions, answers));
 assert.ok(conversationExt("chat").native_question);
 await assert.rejects(handleNativeAnswer(f.ctx, f.req({}), f.res, [], f.root, "foreign"));
});

test("实例切换不能穿过正在启动或恢复的命令，失败会释放锁", async () => {
 let release;
 const command = withInstanceMutation({ method: "POST", url: "/api/work/chat/answer" }, () => new Promise(resolve => { release = resolve; }));
 await assert.rejects(withInstanceMutation({ method: "POST", url: "/api/instances/switch" }, async () => {}), /正在处理/);
 release(); await command;
 await assert.rejects(withInstanceMutation({ method: "POST", url: "/api/instances/switch" }, async () => { throw new Error("failed"); }), /failed/);
 assert.equal(await withInstanceMutation({ method: "POST", url: "/api/instances/switch" }, async () => "switched"), "switched");
});

test("单选加补充转成原生工具接受的完整自由回答", () => {
 assert.deepEqual(validateNativeAnswers(question.questions, [{ id: "scope", selected: ["机制"], custom: "侧重债务" }]), [{ id: "scope", selected: [], custom: "我选择“机制”。补充：侧重债务" }]);
});

test("后台可信任务接续只投递一次，边界暂停不再自动进入下一轮", async t => {
 const f = fixture(t);
 const started = f.runtime.start({ session_id: "task", mode: "construct", skill: "nexo-construct", goal: "检查局部知识结构", write_authority: "trusted", scope: { card_ids: ["card-a"] } });
 const event = { seq: 200, time: Date.now(), data: { reason: "completed" } };
 await Promise.all([settleWorkTurn(f.ctx, f.root, "task", event), settleWorkTurn(f.ctx, f.root, "task", event)]);
 assert.equal(f.calls.filter(c => c.method === "session.prompt").length, 1);
 assert.equal(f.runtime.current("task").run.status, "running");
 f.runtime.requestPauseAfterBoundary(started.run.run_id);
 await settleWorkTurn(f.ctx, f.root, "task", { ...event, seq: 201 });
 assert.equal(f.runtime.current("task").run.status, "paused");
 assert.equal(f.calls.filter(c => c.method === "session.prompt").length, 1);
 f.runtime.resume(started.run.run_id);
 assert.equal(f.runtime.current("task").run.pause_after_boundary, false);
 assert.deepEqual(f.runtime.current("task").workspace.scope.card_ids, ["card-a"]);
});
