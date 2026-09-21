import { requestExecutionControl } from "./work.js";
/**
 * /api/pipeline and /api/events compatibility handlers (M3).
 *
 * Pipeline state is derived from the task_kind sessions + the knowledge-body
 * directories:
 *   GET  /api/pipeline/status           → { inbox, scratch } file counts
 *   GET  /api/pipeline/job              → running/state of the newest task_kind session
 *   POST /api/pipeline/:stage/conversation → create/reuse a task_kind session
 *   POST /api/pipeline/jobs/:id/stop    → cancel the session turn
 *   GET  /api/events                    → SSE keep-alive stream
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { HttpError, json, rpcCall, sse } from "./rpc.js";
import { ensureDefaultProject, patchConversationExt, readMeta, softDeleteConversation } from "./meta.js";
import { handleConversationGet } from "./projects.js";
import { assertOwnedConversation } from "./projects.js";
import { subscribeGraphEvents } from "./events-bus.js";
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { reconcileDormantCognitiveRun } from "./cognition.js";
import { projectWorkPhase } from "./work.js";
import { listBuffer } from "../../nexogenesis-tools/lib/cards.js";

const PIPELINE_STAGES = new Set(["compile", "theme_compile", "digest", "construct"]);

const PIPELINE_LABELS = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" };
/** Recursively count files under a directory (0 when absent). */
function countFiles(dir) {
	try {
		let total = 0;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
			else total += 1;
		}
		return total;
	} catch {
		return 0;
	}
}

/** GET /api/pipeline/status → PipelineStatus */
export async function handlePipelineStatus(ctx, _req, res, _trustedHosts, projectRoot) {
	json(res, 200, {
		inbox: countFiles(join(projectRoot, "00-Inbox")),
		// `scratch` is the legacy API field consumed by the web client. Its value
		// must mean "awaiting digestion", not "every file under 05-Buffer".
		scratch: listBuffer(projectRoot, { status: "pending" }).length
	});
}

/**
 * POST /api/pipeline/:stage/conversation → Conversation
 * Creates an independent session marked with the given task_kind, so the
 * frontend pipeline flow works end to end. The user then sends `/${stage}`
 * through chat; the agent performs the pipeline with the knowledge tools.
 */
export async function handlePipelineConversation(ctx, _req, res, _trustedHosts, projectRoot, stage) {
	if (!PIPELINE_STAGES.has(stage)) throw new HttpError(404, `未知阶段: ${stage}`);
	const created = await rpcCall(ctx, "session.create", { cwd: projectRoot, agentPreset: "nexogenesis" });
	const id = created.sessionId;
	patchConversationExt(id, { project_id: ensureDefaultProject().id, task_kind: stage, pinned: true, title: PIPELINE_LABELS[stage], created_at: new Date().toISOString() });
	await handleConversationGet(ctx, _req, res, _trustedHosts, id);
}

/**
 * Replace one fixed task session with a fresh one. DSH retains its event log
 * as an audit record, so only a new session can remove stale context from the
 * model as well as from the visible conversation.
 */
export async function handlePipelineConversationReset(ctx, _req, res, _trustedHosts, projectRoot, stage) {
	if (!PIPELINE_STAGES.has(stage)) throw new HttpError(404, `未知阶段: ${stage}`);
	const meta = readMeta();
	const list = await rpcCall(ctx, "session.list", {});
	const existing = (list.items ?? []).find((s) =>
		meta.conversations[s.sessionId]?.task_kind === stage && meta.deleted[s.sessionId] !== true
	);
	if (existing?.running === true) {
		throw new HttpError(409, `${PIPELINE_LABELS[stage]}正在运行，停止任务后才能清理对话内容。`);
	}
	const cognitive = existing ? await reconcileDormantCognitiveRun(ctx, projectRoot, existing.sessionId) : null;
	if (cognitive?.run?.status === "running" || cognitive?.run?.status === "waiting_user") {
		throw new HttpError(409, `${PIPELINE_LABELS[stage]}仍有待完成的任务，停止或处理完当前任务后才能清理。`);
	}
	const created = await rpcCall(ctx, "session.create", { cwd: projectRoot, agentPreset: "nexogenesis" });
	const id = created.sessionId;
	patchConversationExt(id, {
		project_id: ensureDefaultProject().id,
		task_kind: stage,
		pinned: true,
		title: PIPELINE_LABELS[stage],
		created_at: new Date().toISOString()
	});
	if (existing !== void 0) softDeleteConversation(existing.sessionId);
	await handleConversationGet(ctx, _req, res, _trustedHosts, id);
}

/** POST /api/pipeline/jobs/:id/stop → 区分安全边界暂停与立即停止。 */
export async function handlePipelineStop(ctx, req, res, _trustedHosts, projectRoot, jobId) {
	if (typeof jobId === "string" && jobId !== "") {
		assertOwnedConversation(jobId);
		const afterWave = new URL(req.url ?? "/", "http://x").searchParams.get("after_wave") === "true";
		const runtime = getCognitiveRuntime(projectRoot);
		const cognitive = runtime.current(jobId);
		if (afterWave) {
			if (cognitive?.run?.status === "running" || cognitive?.run?.status === "waiting_user") {
				const run = runtime.requestPauseAfterBoundary(cognitive.run.run_id);
				json(res, 202, {
					accepted: true,
					mode: "after_wave",
					state: run.status,
					detail: run.status === "paused" ? "任务已在安全边界暂停。" : "将在当前最小工作单元结束后暂停。"
				});
				return;
			}
			json(res, 200, { accepted: false, mode: "after_wave", state: cognitive?.run?.status ?? "idle", detail: "当前没有可暂停的运行任务。" });
			return;
		}
		const result=await requestExecutionControl(ctx,projectRoot,jobId,{action:'pause'});
		return json(res,result.pending?202:200,{...result,mode:'immediate',state:result.pending?'stopping':'paused',detail:result.pending?'正在等待执行退出。':'执行已暂停。'});
	}
	json(res, 200, { accepted: true, mode: "immediate", state: "cancelled", detail: "任务正在安全停止。" });
}

/**
 * GET /api/pipeline/job → { job: PipelineJobRecord | null }
 * The active pipeline job is the newest non-deleted task_kind session that
 * has ever run a turn; its state mirrors the session's agent status.
 */
export async function handlePipelineJob(ctx, _req, res, _trustedHosts, projectRoot) {
	const meta = readMeta();
	const list = await rpcCall(ctx, "session.list", {});
	const sessions = (list.items ?? []).filter((s) => meta.conversations[s.sessionId]?.task_kind !== void 0 && meta.deleted[s.sessionId] !== true);
	if (sessions.length === 0) {
		json(res, 200, { job: null });
		return;
	}
	sessions.sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt);
	const s = sessions[0];
	const stage = meta.conversations[s.sessionId].task_kind;
	const label = PIPELINE_LABELS[stage] ?? stage;
	const cognitive = getCognitiveRuntime(projectRoot).current(s.sessionId);
	const cognitiveStatus = cognitive?.run?.status;
	const waitingForUser = cognitiveStatus === "waiting_user";
	const pauseRequested = cognitiveStatus === "running" && cognitive?.run?.pause_after_boundary === true;
	// Host 正在实际执行时，实时会话状态优先于上一轮已停止的 CognitiveRun。
	// 正常的“继续”入口会同步创建新 run；这里的优先级同时避免轮询窗口显示互斥状态。
	const state = projectWorkPhase(s, cognitive);
	const job = {
		id: s.sessionId,
		stage,
		state,
		label: waitingForUser ? `${label}正在等你处理` : pauseRequested ? `${label}将在本波结束后暂停` : state === "running" ? `${label}进行中` : state === "paused" ? `${label}已暂停` : state === "cancelled" ? `${label}已停止` : state === "failed" ? `${label}未完成` : state === "blocked" ? `${label}需要处理` : state === "idle" ? `${label}尚未开始` : `${label}已完成`,
		pause_requested: pauseRequested,
		...waitingForUser ? { detail: "请处理下方的选择卡或确认卡；处理后会在同一任务中继续。" }
			: pauseRequested ? { detail: "当前最小工作单元仍在执行；完成写入与复核后会暂停，不再自动进入下一波。" }
			: state === "paused" ? { detail: "已完成当前最小工作单元并暂停；再次执行会从剩余材料接续。" }
			: state === "cancelled" ? { detail: "任务已停止；未提交的提案不会写入知识体。" }
			: state === "blocked" ? { detail: cognitive?.workspace?.stop_reason ?? "本轮预算或治理条件已触发，请查看任务记录后重新开始。" }
			: state === "failed" ? { detail: cognitive?.workspace?.stop_reason ?? "模型会话已结束，任务尚未闭合；已提交内容保留。" }
			: !s.running ? { detail: "等待下一轮" } : {},
		updated_at: new Date(s.updatedAt).toISOString()
	};
	json(res, 200, { job });
}

/**
 * GET /api/events?conversation_id= → SSE keep-alive stream.
 * Registers with the graph event bus so chat-bridge animation frames reach
 * the frontend ActivationEngine; heartbeat comments keep the connection open.
 */
export async function handleEventsGet(ctx, req, res, _trustedHosts) {
	const url = new URL(req.url ?? "/", "http://x");
	const conversationId = url.searchParams.get("conversation_id") ?? "";
	if (conversationId !== "") assertOwnedConversation(conversationId);
	const cursor=String(req.headers?.['last-event-id']??'').split(':');
	const afterText=cursor.length===2?cursor[1]:url.searchParams.get('after');
	const afterRaw=afterText===null?NaN:Number(afterText);
	const after = Number.isFinite(afterRaw) && afterRaw >= 0 ? afterRaw : null;
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive"
	});
	res.write(": connected\n\n");
	const unsub = conversationId === "" ? () => {} : subscribeGraphEvents(conversationId, res, { after, epoch:cursor.length===2?cursor[0]:null });
	const timer = setInterval(() => {
		if (!res.writableEnded && !res.destroyed && !res.writableNeedDrain) res.write(": keep-alive\n\n");
	}, 25000);
	res.on("close", () => {
		clearInterval(timer);
		unsub();
	});
}

export { HttpError };
