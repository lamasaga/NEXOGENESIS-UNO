import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { CognitiveRuntime, getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { patchConversationExt, conversationExt } from "../packages/nexogenesis-web-host/lib/meta.js";
import { handleConversationControl, assertCurrentRun, withConversationAdmission } from "../packages/nexogenesis-web-host/lib/conversation-control.js";
import { handleCognitiveSessionSteer, prepareCognitiveInteractionAnswer, queueCognitiveContinuation, resumeCognitiveInteraction, handleCognitiveRunResume } from "../packages/nexogenesis-web-host/lib/cognition.js";
import { handleChatStream, handleChat } from "../packages/nexogenesis-web-host/lib/chat.js";
import { workSnapshot, handleWorkStop } from "../packages/nexogenesis-web-host/lib/work.js";
import { handleWriteConfirm } from "../packages/nexogenesis-web-host/lib/write.js";
import { storeProposal, getProposal } from "../packages/nexogenesis-tools/lib/pending.js";
import { prepareThinking } from "../packages/nexogenesis-web-host/lib/thinking.js";
import { foldMessages } from "../packages/nexogenesis-web-host/lib/projects.js";

function fixture(t, construct = true) {
  const root = mkdtempSync(join(tmpdir(), "nexo-conversation-control-"));
  const prevHome = process.env.DSH_HOME, prevFetch = globalThis.fetch;
  process.env.DSH_HOME = root;
  const runtime = getCognitiveRuntime(root), calls = [], sessions = [{ sessionId: "chat", running: true, updatedAt: Date.now() }];
  patchConversationExt("chat", { project_id: "p", ...(construct ? { task_kind: "construct" } : {}) });
  const task = construct ? runtime.start({ session_id: "chat", mode: "construct", skill: "nexo-construct", goal: "局部建构",
    scope: { construct_request: { workload: "group", changes: "organization", card_ids: ["甲"] } }, budget: { max_steps: 600, max_reads: 400, max_writes: 100 }, write_authority: "trusted" }) : null;
  globalThis.fetch = async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    return { json: async () => ({ type: "server-response", result: { ok: true, value: call.method === "session.list" ? { items: sessions } : {} } }) };
  };
  t.after(() => { globalThis.fetch = prevFetch; if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome; rmSync(root, { recursive: true, force: true }); });
  const ctx = { webServer: { port: 9999 }, on: () => () => {} };
  const req = body => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { "content-type": "application/json" } });
  let response;
  const res = { writeHead() {}, end(value) { response = JSON.parse(value); } };
  const control = async body => { await handleConversationControl(ctx, req(body), res, [], root, "chat"); return response; };
  const steer = async body => { await handleCognitiveSessionSteer(ctx, req(body), res, [], root, "chat"); return response; };
  const stream = async body => {
    const output = new EventEmitter(); output.writeHead = () => {}; output.write = () => {}; output.end = () => {};
    try { await handleChatStream(ctx, req({ conversation_id: "chat", ...body }), output, [], root); }
    finally { output.emit("close"); }
  };
  return { root, runtime, calls, sessions, task, ctx, control, steer, stream, req, res };
}

test("新版分析后的无工具追问按新admission接收文本与结束，不被旧Run吞掉", async t => {
  const f = fixture(t, false); f.sessions[0].running = false;
  patchConversationExt("chat", { analysis_trial: true });
  f.runtime.admitConversationTurn("chat", { policy: "conversation-v2" });
  f.runtime.bindConversationTurn("chat", { type: "turn/start", time: Date.now() + 1, data: { turn: 1 } });
  const old = f.runtime.start({ session_id: "chat", mode: "general", skill: "nexo-talk", goal: "原分析", scope: { analysis_depth: "iterative" } });
  f.runtime.setStatus(old.run.run_id, "closed");
  let listener, ended = false; const frames = [];
  const ctx = { ...f.ctx, on: (_name, fn) => { listener = fn; return () => {}; } };
  const output = new EventEmitter(); output.writeHead = () => {}; output.write = data => frames.push(data); output.end = () => { ended = true; output.writableEnded = true; };
  try {
    await handleChatStream(ctx, f.req({ conversation_id: "chat", message: "谢谢，用一句话解释" }), output, [], f.root);
    await listener({ id: "chat" }, { type: "turn/start", seq: 11, time: Date.now() + 1, data: { turn: 2 } });
    await listener({ id: "chat" }, { type: "assistant/chunk", seq: 12, data: { turn: 2, chunk: { type: "text-delta", text: "短期缓冲不等于长期稳定。" } } });
    await listener({ id: "chat" }, { type: "turn/end", seq: 13, time: Date.now() + 2, data: { turn: 2, reason: { kind: "completed" } } });
    assert.ok(frames.join("").includes("短期缓冲不等于长期稳定。")); assert.ok(frames.join("").includes('"type":"done"')); assert.equal(ended, true);
    assert.equal(f.runtime.current("chat").run.run_id, old.run.run_id);
  } finally { output.emit("close"); }
});

test("新版暂停待答先恢复并保存约束，投递失败也留下可恢复记录", async t => {
  const f = fixture(t, false); f.sessions[0].running = false;
  f.runtime.admitConversationTurn("chat", { policy: "conversation-v2" });
  const run = f.runtime.start({ session_id: "chat", mode: "general", skill: "nexo-talk", goal: "问题", scope: { analysis_depth: "iterative" } }).run;
  const question = f.runtime.requestInteraction(run.run_id, { type: "choice", request_key: "period", question: "什么时期", options: [] });
  f.runtime.setStatus(run.run_id, "paused");
  const prepared = prepareCognitiveInteractionAnswer(f.root, question.interaction_id, { answer: "短期" });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (JSON.parse(init.body).method === "session.prompt") throw new Error("test offline"); return original(url, init); };
  assert.equal(await resumeCognitiveInteraction(f.ctx, f.root, prepared), false);
  assert.equal(f.runtime.getInteraction(run.run_id).status, "answered");
  assert.equal(f.runtime.get(run.run_id).workspace.user_directives.at(-1).text, "短期");
  assert.equal(f.runtime.get(run.run_id).run.status, "paused"); assert.equal(f.runtime.pendingContinuations(run.run_id).length, 1);
  globalThis.fetch = original;
  await handleCognitiveRunResume(f.ctx, null, f.res, [], f.root, run.run_id);
  assert.equal(f.runtime.get(run.run_id).run.status, "running"); assert.equal(f.runtime.pendingContinuations(run.run_id).length, 0);
  assert.doesNotThrow(() => f.runtime.updateWorkspace(run.run_id, { open_questions: [] }));
  assert.equal(f.runtime.canOperate(run.run_id, { mode: "read", operator: "read_card" }).allowed, true);
});

test("非流式拒绝试用与忙碌会话，也遵守同一admission互斥", async t => {
  const f = fixture(t, false);
  await assert.rejects(handleChat(f.ctx, f.req({ conversation_id: "chat", message: "问题" }), f.res, [], f.root), /当前回合/);
  f.sessions[0].running = false; patchConversationExt("chat", { analysis_trial: true });
  await assert.rejects(handleChat(f.ctx, f.req({ conversation_id: "chat", message: "问题" }), f.res, [], f.root), /流式入口/);
  await withConversationAdmission("chat", () => assert.rejects(handleChat(f.ctx, f.req({ conversation_id: "chat", message: "问题" }), f.res, [], f.root), /另一条对话/));
  assert.equal(f.calls.filter(c => c.method === "session.prompt").length, 0);
});

test("暂停等待宿主 idle；讨论与恢复保留原 Run、范围、用量，不重复取消", async t => {
  const f = fixture(t), id = f.task.run.run_id;
  f.runtime.record(id, { action: { operator: "read_cards", mode: "read" }, observation: { status: "ok", summary: "已读甲" } });
  const before = f.runtime.get(id);
  assert.equal((await f.control({ action: "discuss", run_id: id })).ready, false);
  assert.equal((await f.control({ action: "discuss", run_id: id })).ready, false);
  assert.equal(f.calls.filter(c => c.method === "session.cancel").length, 1);
  assert.equal(f.runtime.current("chat").run.run_id, id);
  f.sessions[0].running = false;
  await f.control({ action: "discuss", run_id: id });
  assert.notEqual(f.runtime.current("chat").run.run_id, id);
  assert.equal(f.runtime.discussionTask("chat").run.run_id, id);
  const discussion = f.runtime.start({ session_id: "chat", mode: "general", skill: "nexo-talk", goal: "解释依据", scope: { analysis_depth: "iterative" }, write_authority: "trusted" });
  assert.equal(discussion.run.write_authority, "manual");
  assert.equal(f.runtime.canOperate(discussion.run.run_id, { mode: "proposal" }).reason_code, "discussion_read_only");
  assert.throws(() => f.runtime.start({ session_id: "chat", mode: "construct" }), /只读讨论/);
  assert.throws(() => assertCurrentRun(f.runtime, before), /暂停/);
  await assert.rejects(queueCognitiveContinuation(f.ctx, f.root, { runId: id, sessionId: "chat", kind: "old", prompt: "旧续跑" }), /暂停/);
  await f.control({ action: "restore", run_id: id });
  const restored = f.runtime.current("chat");
  assert.equal(restored.run.run_id, id);
  assert.deepEqual(restored.workspace.scope, before.workspace.scope);
  assert.deepEqual(restored.workspace.budget, before.workspace.budget);
  assert.equal(restored.episode.steps.length, before.episode.steps.length);
  assert.equal(f.calls.filter(c => c.method === "session.prompt").length, 0);
});

test("待答问题在只读讨论时保留但不能回答，恢复后回到 waiting_user", async t => {
  const f = fixture(t), id = f.task.run.run_id;
  const question = f.runtime.requestInteraction(id, { type: "clarification", request_key: "q", question: "如何调整", options: [{ id: "a", label: "保持", description: "不修改" }] });
  f.sessions[0].running = false;
  await f.control({ action: "discuss", run_id: id });
  assert.equal(f.runtime.getInteraction(id).status, "pending");
  assert.throws(() => prepareCognitiveInteractionAnswer(f.root, question.interaction_id, { option_id: "a" }, "chat"), /暂停/);
  const snapshot = await workSnapshot(f.ctx, f.root);
  assert.equal(snapshot.items[0].interaction, null);
  assert.equal(snapshot.items[0].discussing, true);
  assert.equal((await f.control({ action: "restore", run_id: id })).waiting, true);
  assert.equal(f.runtime.current("chat").run.status, "waiting_user");
  assert.doesNotThrow(() => prepareCognitiveInteractionAnswer(f.root, question.interaction_id, { option_id: "a" }, "chat"));
});

test("已完成知识工作自动回到普通交流，重启后不继承原写入权限或恢复已完成运行", async t => {
  const f = fixture(t), id = f.task.run.run_id;
  f.sessions[0].running = false; f.runtime.setStatus(id, "completed", "测试终态");
  await f.stream({ message: "为什么这样改？" });
  const reopened = new CognitiveRuntime(f.root);
  assert.equal(reopened.discussionTask("chat"), null);
  assert.equal(reopened.get(id).run.status, "completed");
  const state = reopened.ensure({ agent: { session: { id: "chat" } } });
  assert.equal(state.run.mode, "general");
  assert.equal(state.run.write_authority, "manual");
  assert.equal(state.workspace.scope.construct_request, undefined);
  assert.notEqual(state.run.run_id, id);
  reopened.setStatus(state.run.run_id, "completed");
  assert.throws(() => reopened.restoreDiscussionTask("chat", id), /已完成/);
});

test("停止讨论不撤销原建构提案；旧确认拒绝并保留，恢复后可处理", async t => {
  const f = fixture(t), id = f.task.run.run_id;
  const proposal = storeProposal({ root: f.root, summary: "保留原提案", operations: [], session_id: "chat", run_id: id });
  f.sessions[0].running = false;
  await f.control({ action: "discuss", run_id: id });
  await assert.rejects(handleWriteConfirm(f.ctx, f.req({ proposal_id: proposal.proposal_id, decision: "confirm" }), f.res, [], f.root), /暂停/);
  await handleWorkStop(f.ctx, f.req({ action: "stop" }), f.res, [], f.root, "chat");
  assert.ok(getProposal(proposal.proposal_id));
  assert.equal((await workSnapshot(f.ctx, f.root)).items[0].proposals.length, 0);
  assert.equal((await f.control({ action: "restore", run_id: id })).waiting, true);
  assert.equal((await workSnapshot(f.ctx, f.root)).items[0].proposals.length, 1);
});

test("普通无 Run 会话原生插入，不创建任务；相同请求只投递一次", async t => {
  const f = fixture(t, false), body = { message: "先解释概念", request_id: "insert-001", expected_run_id: null };
  assert.equal((await f.steer(body)).accepted, true);
  assert.equal((await f.steer(body)).accepted, true);
  assert.equal(f.runtime.current("chat"), null);
  assert.equal(f.calls.filter(c => c.method === "session.prompt").length, 1);
  assert.equal(f.calls.find(c => c.method === "session.prompt").payload.mode, "steer");
  await assert.rejects(f.steer({ ...body, message: "另一要求" }), /另一条/);
});

test("插入不重置建构权限用量，拒绝旧运行、待答和已结束的回合", async t => {
  const f = fixture(t), id = f.task.run.run_id, body = { message: "保留反例", request_id: "insert-002", expected_run_id: id };
  const before = f.runtime.get(id);
  await f.steer(body);
  assert.equal(f.runtime.current("chat").run.run_id, id);
  assert.deepEqual(f.runtime.current("chat").workspace.budget, before.workspace.budget);
  assert.equal(f.runtime.current("chat").run.write_authority, "trusted");
  await assert.rejects(f.steer({ ...body, request_id: "insert-003", expected_run_id: null }), /运行已变化/);
  f.runtime.setStatus(id, "waiting_user");
  await assert.rejects(f.steer({ ...body, request_id: "insert-004" }), /等待处理/);
  f.runtime.setStatus(id, "running"); f.sessions[0].running = false;
  await assert.rejects(f.steer({ ...body, request_id: "insert-005" }), /本轮已结束/);
});

test("插入回执不确定时禁止盲重发，队列不会被假成功清除", async t => {
  const f = fixture(t, false), original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url, init) => { if (JSON.parse(init.body).method === "session.prompt") { attempts++; throw new Error("network lost"); } return original(url, init); };
  const body = { message: "缩小问题", request_id: "insert-006", expected_run_id: null };
  await assert.rejects(f.steer(body), { name: "RpcCallError", method: "session.prompt", code: "transport", details: { method: "session.prompt", transport: "http", transport_code: "RPC_TRANSPORT_ERROR" } });
  assert.equal(conversationExt("chat").steering_receipts.find(r => r.id === body.request_id)?.status, "pending");
  await assert.rejects(f.steer(body), /尚不确定/);
  assert.equal(attempts, 1, "uncertain insertion must not be dispatched twice");
  assert.equal(conversationExt("chat").steering_receipts.find(r => r.id === body.request_id)?.message, body.message);
});

test("普通下一轮尚未建 Run 时仍能插入，但不重开上一题或改其账本", async t => {
  const f = fixture(t, false);
  const old = f.runtime.start({ session_id: "chat", mode: "general", skill: "implicit", goal: "上一题" });
  f.runtime.setStatus(old.run.run_id, "completed");
  await f.steer({ message: "补充本轮", request_id: "insert-007", expected_run_id: old.run.run_id });
  assert.equal(f.runtime.current("chat").run.status, "completed");
  assert.equal(f.runtime.current("chat").workspace.user_directives.length, 0);
});

test("并发的会话转换互斥，不接收跨任务恢复标识", async t => {
  const f = fixture(t);
  await withConversationAdmission("chat", async () => {
    await assert.rejects(f.control({ action: "discuss", run_id: f.task.run.run_id }), /另一条对话/);
  });
  f.sessions[0].running = false;
  await assert.rejects(f.control({ action: "discuss", run_id: "wrong" }), /运行已变化/);
  await assert.rejects(f.stream({ message: "旧队列", expected_run_id: null }), /运行已变化/);
});

test("思考选项校验与新对话启动，报告后普通追问不强制重复报告", async t => {
  const f = fixture(t, false); f.sessions[0].running = false;
  assert.throws(() => prepareThinking({ goal: "__proto__", depth: "deep" }, "问题"), /有效/);
  await f.stream({ message: "比较信用机制", thinking_request: { goal: "report", depth: "deep", budget: { max_writes: 999 } } });
  const report = f.runtime.current("chat");
  assert.equal(report.run.mode, "report");
  assert.equal(report.workspace.budget.max_writes, 0);
  const prompt = f.calls.find(c => c.method === "session.prompt").payload.content[0].text;
  const visible = foldMessages({ events: [{ event: { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: prompt }] } } }] })[0].content;
  assert.match(visible, /比较信用机制/);
  assert.doesNotMatch(visible, /THINKING_CONTEXT|nexo-report|OPS/);
  f.runtime.setStatus(report.run.run_id, "completed", "测试已通过");
  await f.stream({ message: "用一句话解释" });
  assert.equal(f.calls.filter(c => c.method === "session.prompt").at(-1).payload.content[0].text, "用一句话解释");
  await assert.rejects(f.stream({ message: "重新选", thinking_request: { goal: "assess", depth: "deep" } }), /首轮/);
});
