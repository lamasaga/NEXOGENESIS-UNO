import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDormantEmptyRun } from "../packages/nexogenesis-web-host/lib/cognition.js";
import { handlePipelineConversationReset, handlePipelineStatus, handlePipelineStop } from "../packages/nexogenesis-web-host/lib/pipeline.js";
import { pipelineStageForMessage } from "../packages/nexogenesis-web-host/lib/chat.js";
import { foldMessages } from "../packages/nexogenesis-web-host/lib/projects.js";
import { CognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { patchConversationExt, readMeta } from "../packages/nexogenesis-web-host/lib/meta.js";

assert.equal(pipelineStageForMessage("继续", "construct", "cancelled"), "construct");
assert.equal(pipelineStageForMessage("继续建构吧", "construct", "cancelled"), "construct");
assert.equal(pipelineStageForMessage("补充一条材料范围", "construct", "running"), "construct");
assert.equal(pipelineStageForMessage("为什么停止了？", "digest", "cancelled"), undefined);
assert.equal(isDormantEmptyRun({
	run: { status: "running", step_count: 0, updated_at: "2026-08-01T00:00:00.000Z" }, continuations: []
}, null, Date.parse("2026-08-01T00:06:00.000Z")), true);
assert.equal(isDormantEmptyRun({
	run: { status: "running", step_count: 1, updated_at: "2026-08-01T00:00:00.000Z" }, continuations: []
}, null, Date.parse("2026-08-01T00:06:00.000Z")), false);
console.log("PASS dormant zero-step run is distinguishable from active work");
assert.deepEqual(foldMessages({ events: [
	{ event: { type: "user/message", data: { content: "" } } },
	{ event: { type: "user/message", data: { content: [{ type: "text", text: "Current runtime context." }], source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } } } },
	{ event: { type: "user/message", data: { content: [{ type: "text", text: "<system-reminder>技能目录</system-reminder>" }], source: { kind: "skill-catalog" } } } },
	{ event: { type: "user/message", data: { content: [{ type: "text", text: "[PIPELINE_CONTINUATION] 内部续办" }], source: { kind: "user" } } } },
	{ event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "  " }] } } } },
	{ event: { type: "user/message", data: { content: [{ type: "text", text: "用户输入" }], source: { kind: "user" } } } },
	{ event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "有效结果" }] } } } }
] }), [{ role: "user", content: "用户输入" }, { role: "assistant", content: "有效结果" }]);
console.log("PASS DSH user and assistant envelopes retain only visible turns");
assert.equal(pipelineStageForMessage("继续", undefined, "cancelled"), undefined);

assert.equal(pipelineStageForMessage("继续", "digest", "cancelled"), undefined);

const root = mkdtempSync(join(tmpdir(), "nexogenesis-pipeline-status-"));
const previousDshHome = process.env.DSH_HOME;
try {
	process.env.DSH_HOME = root;
	mkdirSync(join(root, "00-Inbox"), { recursive: true });
	mkdirSync(join(root, "05-Buffer", "meaning-unit"), { recursive: true });
	mkdirSync(join(root, ".nexogenesis", "cognition"), { recursive: true });
	writeFileSync(join(root, "00-Inbox", "source.md"), "待编译", "utf8");
	for (const name of ["already-settled.md", "still-pending.md", "also-pending.md"]) {
		writeFileSync(join(root, "05-Buffer", "meaning-unit", name), `---\ntitle: ${name}\nrole: meaning-unit\n---\n质料`, "utf8");
	}
	writeFileSync(join(root, ".nexogenesis", "cognition", "contributions.json"), JSON.stringify({
		"meaning-unit/already-settled.md": { status: "settled" }
	}), "utf8");
	let body = "";
	const response = { writeHead() {}, end(value) { body = value; } };
	await handlePipelineStatus(null, null, response, [], root);
	assert.deepEqual(JSON.parse(body), { inbox: 1, scratch: 2 });
	console.log("PASS pipeline status reports only Buffers awaiting digestion");

	const runtime = new CognitiveRuntime(root);
	patchConversationExt("construct-session", { project_id: "test-project", task_kind: "construct" });
	const started = runtime.start({ session_id: "construct-session", mode: "construct", skill: "nexo-construct", goal: "检查结构" });
	let stopStatus = 0;
	let stopBody = "";
	await handlePipelineStop(null, { url: "/api/pipeline/jobs/construct-session/stop?after_wave=true" }, {
		writeHead(status) { stopStatus = status; },
		end(value) { stopBody = value; }
	}, [], root, "construct-session");
	assert.equal(stopStatus, 202);
	assert.deepEqual(JSON.parse(stopBody), {
		accepted: true,
		mode: "after_wave",
		state: "running",
		detail: "将在当前最小工作单元结束后暂停。"
	});
	assert.equal(runtime.get(started.run.run_id).run.pause_after_boundary, true, "本波暂停只能登记边界请求，不能立刻取消当前 turn");
	assert.equal(runtime.settlePauseAfterBoundary(started.run.run_id).status, "paused");
	console.log("PASS pipeline after-wave pause waits for a safe boundary");

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		const request = JSON.parse(String(init.body));
		let value;
		if (request.method === "session.list") value = { items: [{ sessionId: "construct-before-clear", running: false, updatedAt: 1 }] };
		else if (request.method === "session.create") value = { sessionId: "construct-after-clear" };
		else if (request.method === "session.history") value = { events: [] };
		else throw new Error(`unexpected RPC ${request.method}`);
		return { json: async () => ({ type: "server-response", result: { ok: true, value } }) };
	};
	try {
		patchConversationExt("construct-before-clear", { project_id: "test-project", task_kind: "construct", pinned: true, title: "建构" });
		let clearStatus = 0;
		let clearBody = "";
		await handlePipelineConversationReset({ webServer: { port: 8787 } }, null, {
			writeHead(status) { clearStatus = status; },
			end(value) { clearBody = value; }
		}, [], root, "construct");
		assert.equal(clearStatus, 200);
		assert.equal(JSON.parse(clearBody).id, "construct-after-clear");
		assert.equal(readMeta().deleted["construct-before-clear"], true, "旧固定线程只退出当前界面，保留 DSH 审计记录");
		assert.equal(readMeta().conversations["construct-after-clear"].task_kind, "construct");
		console.log("PASS pipeline conversation clearing creates a fresh fixed session");
	} finally {
		globalThis.fetch = originalFetch;
	}
} finally {
	if (previousDshHome === void 0) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousDshHome;
	rmSync(root, { recursive: true, force: true });
}
