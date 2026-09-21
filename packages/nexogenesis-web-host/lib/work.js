import { isRetiredIngestion, assertCurrentKnowledgeExecution, RETIRED_INGESTION_MESSAGE } from './knowledge-task-access.js';
import { suspendInbox, heldPauseMessages } from "./resume-inbox.js";
import { randomUUID } from "node:crypto";
import { isQuickThinkingRunning, cancelQuickThinking } from "./quick-thinking.js";
import { unoConversationJob, unoJobEnded, unoJobCanResume, assertUnoVersion, isUnoJobRunning, endUnoJob, readUnoJob, cancelUnoJob, isCurrentUnoJob } from "./uno-jobs.js";
import { readMeta, conversationExt, patchConversationExt } from "./meta.js";
import { assertOwnedConversation } from "./projects.js";
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { listProposalsForSession, takeProposal } from "../../nexogenesis-tools/lib/pending.js";
import { queueCognitiveContinuation } from "./cognition.js";
import { reasonOf, settleGeneralRunAtTurnBoundary, settlePipelineRunAtTurnBoundary } from "./turn-state.js";
import { withConversationAdmission, completeRequestedDiscussion, assertCurrentRun } from "./conversation-control.js";
import { reconcileAnalysisDelivery } from "./analysis-delivery.js";

const labels = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" };
const endings = new Map();
const liveQuestions = new Map();
const settlingSessions = new Set();
let nativeReady = false;
let nativeApi = null;
let pendingMutations = 0;
let switching = false;
export const instanceMutationsInFlight = () => pendingMutations;

/** The tool root is still shared: never switch it while an admitted command is starting or resuming work. */
export async function withInstanceMutation(req, action) {
	if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return action();
	const isSwitch = /\/switch\/?$/.test(new URL(req.url ?? "/", "http://local").pathname);
	if (switching || (isSwitch && (pendingMutations > 0 || settlingSessions.size > 0))) throw new HttpError(409, "有任务指令正在处理，请稍后切换或重试。");
	if (isSwitch) switching = true;
	pendingMutations++;
	try { return await action(); } finally { pendingMutations--; if (isSwitch) switching = false; }
}

export function projectWorkPhase(session, state, waiting = false) {
	if (waiting || state?.run?.status === "waiting_user") return "waiting_user";
	if (session.running) return "running";
	const status = state?.run?.status;
	if (status === "running") return "paused";
	return status ?? "idle";
}

/** One owner for turn settlement, used by both the host observer and a connected chat stream. */
export function settleWorkTurn(ctx, root, sessionId, event) {
	const key = `${root}:${sessionId}:${event.seq ?? event.time}`;
	if (endings.has(key)) return endings.get(key);
	settlingSessions.add(sessionId);
	const promise = settleTurn(ctx, root, sessionId, event).finally(() => settlingSessions.delete(sessionId));
	endings.set(key, promise);
	if (endings.size > 256) endings.delete(endings.keys().next().value);
	return promise;
}

async function settleTurn(ctx, root, sessionId, event) {
	const runtime = getCognitiveRuntime(root);
	const { kind, detail } = reasonOf(event.data?.reason);
	const original = runtime.current(sessionId);
	if (original?.run.analysis_policy_version === "conversation-v2" && original.run.host_turn_id != null && String(event.data?.turn) !== original.run.host_turn_id) return { continued: false };
	patchConversationExt(sessionId, { last_turn: { kind, detail, at: new Date(event.time ?? Date.now()).toISOString() } });
	if (conversationExt(sessionId).execution_control) { await completeExecutionControl(ctx,runtime,sessionId); return {continued:false}; }
	settlePipelineRunAtTurnBoundary(runtime, sessionId, { kind, detail });
	if (completeRequestedDiscussion(runtime,sessionId)) return {continued:false};
	let state = runtime.current(sessionId);
	if (!labels[state?.run.mode]) {
		if (await reconcileAnalysisDelivery(ctx, runtime, state, event)) return { continued: false };
		settleGeneralRunAtTurnBoundary(runtime, sessionId, { kind, detail });
		return { continued: false };
	}
	if (kind !== "completed" || state.run.status !== "running") return { continued: false };
	if (state.run.pause_after_boundary) {
		runtime.settlePauseAfterBoundary(state.run.run_id);
		return { continued: false };
	}
	if (state.run.mode === "construct") { runtime.setStatus(state.run.run_id,"paused","本批执行结束，进度保留；可以讨论或继续工作。"); return {continued:false}; }
	if (state.run.write_authority === "trusted") {
		const count = runtime.continuations(state.run.run_id).filter((e) => e.kind === "pipeline_auto_continue").length;
		if (count < 24) {
			const continued = await queueCognitiveContinuation(ctx, root, {
				runId: state.run.run_id, sessionId, kind: "pipeline_auto_continue",
				prompt: `[PIPELINE_CONTINUATION]\n当前${labels[state.run.mode]}任务尚未闭合。继续本任务冻结范围内的剩余工作或复核，不扩大目标，不重复已提交操作。完成验收或记录具体延期后调用 finish_cognitive_run。`
			});
			if (continued) return { continued: true };
		}
	}
	runtime.setStatus(state.run.run_id, "paused", "执行回合已结束，任务尚未通过完成验收。进度已保留，可明确继续此任务。");
	return { continued: false };
}

/** The native provider replays unanswered requests when this subscription opens. */
export function observeWork(ctx, getRoot) {
	nativeApi = ctx.apiProxy;
	const controller = new AbortController();
	let disposed = false;
	const consume = async () => {
		while (!disposed) {
			try {
				liveQuestions.clear();
				nativeReady = true;
				for await (const envelope of ctx.apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, controller.signal)) {
					const frame = envelope.payload;
					const meta = readMeta();
					if (!meta.conversations[frame?.sessionId] || meta.deleted[frame.sessionId]) continue;
					if (frame.type === "question/requested") {
						const current = getCognitiveRuntime(getRoot()).current(frame.sessionId);
						const question = { rpc_id: envelope.rpcId, session_id: frame.sessionId, questions: frame.questions,
							run_id: ["running", "waiting_user"].includes(current?.run.status) ? current.run.run_id : null };
						liveQuestions.set(envelope.rpcId, question);
						patchConversationExt(frame.sessionId, { native_question: question });
					} else if (frame.type === "question/resolved") {
						liveQuestions.delete(frame.questionRpcId);
						const ext = conversationExt(frame.sessionId);
						if (ext.native_question?.rpc_id === frame.questionRpcId && !ext.suspend_requested) patchConversationExt(frame.sessionId, { native_question: null });
					} else if (frame.type === "session/event" && frame.event?.type === "turn/start") {
						getCognitiveRuntime(getRoot()).bindConversationTurn(frame.sessionId, frame.event);
					} else if (frame.type === "session/event" && frame.event?.type === "turn/end") {
						void settleWorkTurn(ctx, getRoot(), frame.sessionId, frame.event).catch((error) => console.error("work settlement:", error));
					}
				}
			} catch (error) { if (!disposed) console.error("work observer:", error.message); }
			nativeReady = false;
			if (!disposed) await new Promise((resolve) => { const timer = setTimeout(resolve, 1000); controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
		}
	};
	void consume();
	return () => { disposed = true; controller.abort(); nativeReady = false; };
}

export async function workSnapshot(ctx, root) {
	const sessions = ((await rpcCall(ctx, "session.list", {})).items ?? []).map(s => isQuickThinkingRunning(s.sessionId) ? { ...s, running: true } : s);
	const meta = readMeta(), runtime = getCognitiveRuntime(root);
	for (const session of sessions) if (!session.running && conversationExt(session.sessionId).execution_control) await completeExecutionControl(ctx,runtime,session.sessionId);
	const items = sessions.filter((s) => meta.conversations[s.sessionId] && !meta.deleted[s.sessionId]
		&& !(meta.conversations[s.sessionId].uno_job_id && meta.conversations[s.sessionId].parent_session_id)).map((session) => {
		const ext = meta.conversations[session.sessionId], state = runtime.current(session.sessionId);
		if (ext.uno_job_id) {
			const job=unoConversationJob(root,session.sessionId), ended=unoJobEnded(job);
			const executing=isUnoJobRunning(session.sessionId)||isQuickThinkingRunning(session.sessionId);
			const discussing=Boolean(ext.uno_discussing)||ended;
			const resumable=unoJobCanResume(root,job);
			const phase=executing?'running':job.status==='review'&&!discussing?'waiting_user':job.status==='ended'?'closed':job.status==='partial'?(resumable?'paused':'closed'):job.status;
			return {id:session.sessionId,uno_job_id:job.id,job_version:job.version,title:job.title,stage:job.mode,
				run_id:null,task_run_id:job.id,task_status:job.status,discussing,discussion_requested:false,
				control_pending:job.end_requested&&job.status!=='ended'?'finish':isUnoJobRunning(session.sessionId)&&job.pause_requested?'pause':null,
				can_discuss:!executing&&!discussing,can_continue:!executing&&!ended&&job.status!=='review'&&Boolean(resumable),can_finish:!ended,
				phase,executing,outcome:job.status,delivery:null,goal:job.title,detail:job.detail,updated_at:job.updated_at,
				held_inputs:(job.user_directives??[]).map(d=>({id:d.id,text:d.text})),native_question:null,interaction:null,proposals:[]};
		}

    if (isRetiredIngestion(state) || isRetiredIngestion(ext.task_kind)) return {
      id:session.sessionId,title:ext.title??session.projections?.values?.title??'历史知识任务',stage:ext.task_kind??state?.run.mode,
      run_id:state?.run.run_id??null,task_run_id:state?.run.run_id??null,task_status:state?.run.status,
      phase:'history',executing:session.running===true,outcome:state?.run.status??null,readonly:true,
      can_discuss:false,can_continue:false,can_finish:Boolean(state&&!['completed','closed'].includes(state.run.status)),
      discussing:false,discussion_requested:false,control_pending:ext.execution_control?.action??null,
      detail:RETIRED_INGESTION_MESSAGE,goal:state?.workspace?.goal??null,updated_at:state?.run.updated_at??new Date(session.updatedAt).toISOString(),
      held_inputs:[],native_question:null,interaction:null,proposals:[]
    };
		const discussion = runtime.discussionTask(session.sessionId);
		const interaction = runtime.currentInteraction(session.sessionId);
		const proposals = listProposalsForSession(session.sessionId).filter(p => !discussion || p.run_id === state?.run.run_id);
		const native = ext.native_question && (!discussion || ext.native_question.run_id === state?.run.run_id) ? { ...ext.native_question, live: liveQuestions.has(ext.native_question.rpc_id) } : null;
		const waiting = Boolean(native || interaction?.status === "pending" || proposals.length);
		let phase = projectWorkPhase(session, state, waiting);
		if (!state && !session.running && !waiting && ext.last_turn) phase = ext.last_turn.kind === "completed" ? "completed" : ["cancelled", "interrupted"].includes(ext.last_turn.kind) ? "cancelled" : "failed";
		if (!state && !session.running && !waiting && !ext.last_turn && session.blank === false) phase = "history";
		return { id: session.sessionId, title: ext.title ?? session.projections?.values?.title ?? "新对话", stage: ext.task_kind ?? null,
			run_id: state?.run.run_id ?? null, task_run_id: discussion?.run.run_id ?? (labels[state?.run.mode] ? state.run.run_id : null),
			discussing: Boolean(discussion), discussion_requested: Boolean(ext.discussion_requested),
			can_discuss: !discussion && Boolean(labels[state?.run.mode]) && !["completed","closed"].includes(state?.run.status),
			can_finish: Boolean(labels[(discussion??state)?.run.mode]) && !["completed","closed"].includes((discussion??state)?.run.status),
			task_status: (discussion??state)?.run.status, control_pending: ext.execution_control?.action??null,
			held_inputs: heldPauseMessages(runtime,discussion??state).map(m=>({id:m.id,text:(m.content??[]).filter(b=>b.type==="text").map(b=>b.text).join("\n")})),
			phase, executing: session.running === true, outcome: state?.run.status ?? null,
			delivery: state?.run.delivery ?? null,
			goal: native?.questions[0]?.question ?? state?.workspace.goal ?? null, detail: native ? "有问题等待你的选择；回答后继续原对话。" : interaction?.status === "pending" ? interaction.question : proposals.length ? "有知识写入等待确认。" : session.running ? "模型或工具正在执行，可打开对话查看进展。" : state?.workspace.stop_reason ?? (phase === "paused" ? "执行回合已结束，任务尚未验收；可以继续原任务。" : phase === "history" ? "历史对话保留；没有可恢复的任务状态，可以查看记录或新建任务。" : phase === "completed" ? "本轮已结束，可以查看结果。" : ext.last_turn?.detail ?? "尚未开始"),
			updated_at: state?.run.updated_at ?? new Date(session.updatedAt).toISOString(),
			native_question: native, interaction: interaction?.status === "pending" ? interaction : null, proposals,
			can_continue: !session.running && !waiting && Boolean(ext.task_kind) && ["paused", "blocked", "failed", "cancelled"].includes(discussion?.run.status ?? phase) };
	});
	const priority = { waiting_user: 0, running: 1, paused: 2, failed: 3, blocked: 3, cancelled: 4, completed: 5, idle: 6 };
	items.sort((a,b) => (priority[a.phase] ?? 9) - (priority[b.phase] ?? 9) || b.updated_at.localeCompare(a.updated_at));
	return { items, native_ready: nativeReady, controls_version: 1, start_request_version: 1 };
}

export async function handleWorkGet(ctx, _req, res, _hosts, root) { json(res, 200, await workSnapshot(ctx, root)); }

export function validateNativeAnswers(questions, answers) {
	if (!Array.isArray(answers) || answers.length !== questions.length) throw new HttpError(400, "请回答每一个问题");
	return questions.map((q, i) => {
		const answer = answers[i];
		if (answer?.id !== q.id || !Array.isArray(answer.selected)) throw new HttpError(400, "问题或选项不匹配");
		const selected = [...new Set(answer.selected)];
		if (selected.some((v) => !q.options?.some((o) => o.label === v)) || (!q.multiSelect && selected.length > 1)) throw new HttpError(400, "所选项不属于此问题");
		const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
		if (!selected.length && !custom) throw new HttpError(400, "请选择一项或填写回答");
		if (!q.multiSelect && custom && selected.length) return { id: q.id, selected: [], custom: `我选择“${selected[0]}”。补充：${custom}` };
		return { id: q.id, selected, ...(custom ? { custom } : {}) };
	});
}

const responding = new Set();
export async function handleNativeAnswer(ctx, req, res, _hosts, root, sessionId) {
	assertOwnedConversation(sessionId);
	assertCurrentKnowledgeExecution(getCognitiveRuntime(root).current(sessionId));
	assertCurrentKnowledgeExecution(conversationExt(sessionId).task_kind);
	const body = await readJsonBody(req), question = conversationExt(sessionId).native_question;
	if (!question || question.rpc_id !== body.rpc_id) throw new HttpError(409, "这个问题已经处理或更新，请刷新待办");
	if (getCognitiveRuntime(root).discussionTask(sessionId) && question.run_id !== getCognitiveRuntime(root).current(sessionId)?.run.run_id) throw new HttpError(409, "此问题属于原建构，请先返回原任务。");
	if (question.run_id) assertCurrentRun(getCognitiveRuntime(root), getCognitiveRuntime(root).get(question.run_id));
	if (responding.has(question.rpc_id)) throw new HttpError(409, "回答正在提交");
	const answers = validateNativeAnswers(question.questions, body.answers);
	responding.add(question.rpc_id);
	try {
		if (liveQuestions.has(question.rpc_id)) {
			const result = await nativeApi.respond({ type: "client-response", rpcId: question.rpc_id, result: { ok: true, value: { sessionId, answer: { answers } } } });
			if (!result.accepted) throw new HttpError(409, "原问题已经失效，请刷新待办后重试");
		} else {
			const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find((s) => s.sessionId === sessionId);
			if (session?.running) throw new HttpError(409, "正在恢复原问题的连接，请稍后重试");
			const text = question.questions.map((q, i) => `${q.question}\n我的回答：${[...answers[i].selected, answers[i].custom].filter(Boolean).join("；")}`).join("\n\n");
			const runtime = getCognitiveRuntime(root), state = runtime.current(sessionId);
			const resume = state && !["completed", "closed"].includes(state.run.status) && (question.run_id === state.run.run_id || labels[state.run.mode]);
			if (resume) { runtime.resume(state.run.run_id); runtime.continueAnalysisTurn(state.run.run_id); }
			try { await rpcCall(ctx, "session.prompt", { sessionId, mode: "queue", content: [{ type: "text", text: `此前等待已中断，现在回答原问题。请沿用原任务范围，核对已有进度后继续。\n${text}` }] }); }
			catch (error) { if (resume) runtime.setStatus(state.run.run_id, "paused", "回答暂未投递，待答问题保留，可重试。"); throw error; }
		}
		patchConversationExt(sessionId, { native_question: null, suspend_requested: false });
		json(res, 200, { accepted: true });
	} finally { responding.delete(question.rpc_id); }
}

/** Suspending preserves the question; cancelling explicitly dismisses it. */
export async function handleWorkStop(ctx, req, res, _hosts, root, sessionId) {
	assertOwnedConversation(sessionId);
	const body = await readJsonBody(req);
	const result = await requestExecutionControl(ctx, root, sessionId, body);
	json(res, result.pending ? 202 : 200, result);
}

/** All immediate stop endpoints use this admission and settlement path. */
export async function requestExecutionControl(ctx, root, sessionId, body) {
	assertOwnedConversation(sessionId);
	if (!["pause", "stop", "finish"].includes(body.action)) throw new HttpError(400, "请选择暂停或结束工作");
	const job = unoConversationJob(root,sessionId);
	if (job) {
		const owner=job.owner_session_id ?? job.session_id;
		const control = async () => {
			assertUnoVersion(job,body);
			if (isQuickThinkingRunning(owner)) cancelQuickThinking(owner);
			if (body.action === "finish") endUnoJob(root,job.id);
			else if (!conversationExt(owner).uno_discussing) cancelUnoJob(root,job.id);
			return {accepted:true,pending:isUnoJobRunning(owner)||isQuickThinkingRunning(owner)};
		};
		// A live quick discussion holds admission until its stream exits. Its
		// explicit stop must reach the controller instead of waiting on that lock.
		return isQuickThinkingRunning(owner)?control():withConversationAdmission(owner,control);
	}
	if (isQuickThinkingRunning(sessionId)) {
		if (Object.hasOwn(body, "expected_run_id") && body.expected_run_id !== null) throw new HttpError(409, "快速思考没有可恢复的研究任务。");
		cancelQuickThinking(sessionId);
		return { accepted: true, pending: true };
	}
	return withConversationAdmission(sessionId, async () => {
		const runtime = getCognitiveRuntime(root), state = runtime.current(sessionId);
		const task = runtime.discussionTask(sessionId) ?? state;
		if (Object.hasOwn(body, "expected_run_id") && body.expected_run_id !== (state?.run.run_id ?? null)) throw new HttpError(409, "当前运行已变化，请刷新后操作。");
		const previous = conversationExt(sessionId).execution_control;
		if (previous) return { accepted: true, pending: true };
		const control = { action: body.action, run_id: state?.run.run_id ?? null, task_run_id: task?.run.run_id ?? null, at: new Date().toISOString() };
		patchConversationExt(sessionId, { execution_control: control, suspend_requested: true, discussion_requested: null });
		try {
			await suspendInbox(ctx, sessionId, task?.run.run_id, body.action);
			await rpcCall(ctx, "session.cancel", { sessionId });
		} catch (error) {
			if (error?.code !== "session-not-found") { patchConversationExt(sessionId, { execution_control: null }); throw error; }
		}
		if (state && conversationExt(sessionId).execution_control && !["completed", "closed"].includes(runtime.get(state.run.run_id).run.status)) runtime.setStatus(state.run.run_id, body.action === "pause" ? "paused" : "cancelled", "停止请求已接收，正在等待底层执行退出；已有结果保留。");
		const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === sessionId);
		if (!session?.running) await completeExecutionControl(ctx, runtime, sessionId);
		return { accepted: true, pending: Boolean(session?.running) };
	});
}

async function completeExecutionControl(ctx, runtime, sessionId) {
	const control = conversationExt(sessionId).execution_control;
	if (!control) return;
	await suspendInbox(ctx, sessionId, control.task_run_id, control.action);
	if (control.action !== "pause") {
		const ids = control.action === "finish" ? [control.run_id, control.task_run_id] : [control.run_id];
		for (const id of new Set(ids.filter(Boolean))) runtime.cancelInteraction(id);
		for (const proposal of listProposalsForSession(sessionId)) if (control.action === "finish" || !runtime.discussionTask(sessionId) || proposal.run_id === control.run_id) takeProposal(proposal.proposal_id);
		if (control.action === "finish" || !runtime.discussionTask(sessionId) || conversationExt(sessionId).native_question?.run_id === control.run_id) patchConversationExt(sessionId, { native_question: null });
	}
	if (control.action === "finish") runtime.closeConversationWork(sessionId);
	else {
		const state = runtime.current(sessionId);
		if (state && !["completed", "closed"].includes(state.run.status)) runtime.setStatus(state.run.run_id, control.action === "pause" ? "paused" : "cancelled", control.action === "pause" ? "执行已暂停；进度和待答事项保留。" : "本轮已停止；已提交结果保留。");
	}
	patchConversationExt(sessionId, { execution_control: null, suspend_requested: true });
}
