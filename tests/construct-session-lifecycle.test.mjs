import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePipelineConversation, handlePipelineJob } from "../packages/nexogenesis-web-host/lib/pipeline.js";
import { settlePipelineRunAtTurnBoundary } from "../packages/nexogenesis-web-host/lib/chat.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { readMeta, patchConversationExt } from "../packages/nexogenesis-web-host/lib/meta.js";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "nexo-fresh-construct-")), originalHome = process.env.DSH_HOME, originalFetch = globalThis.fetch;
	process.env.DSH_HOME = root;
	t.after(() => { globalThis.fetch = originalFetch; if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome; rmSync(root, { recursive: true, force: true }); });
	const sessions = [{ sessionId: "old", running: false, updatedAt: 1 }], calls = [], flags = { failCreate: false };
	patchConversationExt("old", { task_kind: "construct", pinned: true, title: "建构" });
	globalThis.fetch = async (_url, init) => {
		const req = JSON.parse(init.body); calls.push(req);
		let value;
		if (req.method === "session.list") value = { items: sessions };
		else if (req.method === "session.create") {
			if (flags.failCreate) throw new Error("creation unavailable");
			const id = `new-${sessions.length}`; sessions.push({ sessionId: id, running: false, updatedAt: sessions.length + 1 }); value = { sessionId: id };
		} else if (req.method === "session.history") value = { events: [] };
		else throw new Error(`Unexpected ${req.method}`);
		return { json: async () => ({ type: "server-response", result: { ok: true, value } }) };
	};
	const ctx = { webServer: { port: 8787 } }, runtime = getCognitiveRuntime(root);
	const run = runtime.start({ session_id: "old", mode: "construct", skill: "nexo-construct", goal: "旧队列目标" });
	const request = async (stage = "construct") => { let result; await handlePipelineConversation(ctx, null, { writeHead() {}, end(v) { result = JSON.parse(v); } }, [], root, stage); return result; };
	return { root, ctx, runtime, run, sessions, calls, flags, request };
}

test("所有管线新建独立会话，旧任务和聊天继续可见", async (t) => {
 const f = fixture(t);
 for (const stage of ["compile", "theme_compile", "digest", "construct"]) {
  patchConversationExt("old", { task_kind: stage });
  const created = await f.request(stage);
  assert.notEqual(created.id, "old");
  assert.deepEqual(created.messages, []);
  assert.notEqual(readMeta().deleted.old, true);
  assert.equal(f.runtime.current("old").run.run_id, f.run.run.run_id);
  assert.equal(f.runtime.current(created.id), null);
 }
});
test("新建失败不影响旧任务，也不因旧待办继承其目标", async (t) => {
 const f = fixture(t);
 f.runtime.setStatus(f.run.run.run_id, "waiting_user");
 f.flags.failCreate = true;
 await assert.rejects(f.request(), { name: "RpcCallError", method: "session.create", code: "transport", details: { method: "session.create", transport: "http", transport_code: "RPC_TRANSPORT_ERROR" } });
 assert.equal(f.calls.filter(call => call.method === "session.create").length, 1, "uncertain creation is never retried");
 assert.deepEqual(f.sessions.map(session => session.sessionId), ["old"]);
 assert.notEqual(readMeta().deleted.old, true);
 assert.equal(f.runtime.current("old").run.status, "waiting_user");
 f.flags.failCreate = false;
 assert.notEqual((await f.request()).id, "old");
});

test("模型失败持久化，轮询不会误报完成，已经完成的任务不被覆盖", async (t) => {
	const f = fixture(t);
	settlePipelineRunAtTurnBoundary(f.runtime, "old", { kind: "error", detail: "The model refused to complete the request" });
	assert.equal(f.runtime.get(f.run.run.run_id).run.status, "failed");
	let body;
	await handlePipelineJob(f.ctx, null, { writeHead() {}, end(v) { body = JSON.parse(v); } }, [], f.root);
	assert.equal(body.job.state, "failed"); assert.match(body.job.detail, /refused/);
	f.runtime.setStatus(f.run.run.run_id, "completed", "真实完成");
	settlePipelineRunAtTurnBoundary(f.runtime, "old", { kind: "error", detail: "后续连接错误" });
	assert.equal(f.runtime.get(f.run.run.run_id).run.status, "completed");
});
