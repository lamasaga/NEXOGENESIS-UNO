import { assertCurrentKnowledgeExecution } from './knowledge-task-access.js';
import { unoConversationJob, isUnoJobRunning } from "./uno-jobs.js";
import { saveCompileJob } from "../../nexogenesis-tools/lib/uno/state.js";
import { assertCognitiveRunId, getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { listProposalsForSession } from "../../nexogenesis-tools/lib/pending.js";
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { assertOwnedConversation } from "./projects.js";
import { selectActiveModel } from "./settings.js";
import { userFacingProgress } from "./cognitive-events.js";
import { assertCurrentRun, withConversationAdmission } from "./conversation-control.js";
import { conversationExt, patchConversationExt } from "./meta.js";
import { reconcileAnalysisDelivery } from "./analysis-delivery.js";

const DORMANT_EMPTY_RUN_MS = 5 * 60 * 1000;

function validRunId(runId) {
	try { return assertCognitiveRunId(runId); } catch { throw new HttpError(400, "CognitiveRun id 格式非法"); }
}

function assertOwnedRun(state) {
	if (!state) return;
	assertOwnedConversation(state.run.session_id);
}

/**
 * A run is only auto-closed when it never made an observation and the DSH
 * session is no longer executing. This repairs orphaned UI state without
 * cancelling a real long-running knowledge task.
 */
export function isDormantEmptyRun(state, interaction, nowMs = Date.now()) {
	if (state?.run?.status !== "running" || Number(state.run.step_count ?? 0) !== 0) return false;
	if (interaction?.status === "pending") return false;
	if (Array.isArray(state.continuations) && state.continuations.some((entry) => entry.status === "pending")) return false;
	const lastUpdated = Date.parse(state.run.updated_at ?? state.run.created_at ?? "");
	return Number.isFinite(lastUpdated) && nowMs - lastUpdated >= DORMANT_EMPTY_RUN_MS;
}

/** Reconcile an abandoned, zero-step runtime record with the actual DSH session. */
export async function reconcileDormantCognitiveRun(ctx, projectRoot, sessionId) {
	const runtime = getCognitiveRuntime(projectRoot);
	let state = runtime.current(sessionId);
	if (!state) return null;
	await reconcileAnalysisDelivery(ctx, runtime, state);
	state = runtime.current(sessionId);
	const interaction = runtime.currentInteraction(sessionId);
	const withContinuations = { ...state, continuations: runtime.continuations(state.run.run_id) };
	if (!isDormantEmptyRun(withContinuations, interaction)) return state;
	const sessions = await rpcCall(ctx, "session.list", {});
	const session = (sessions.items ?? []).find((item) => item.sessionId === sessionId);
	if (session?.running === true) return state;
	runtime.setStatus(state.run.run_id, "cancelled", "任务未实际进入执行，已自动关闭遗留状态。");
	state = runtime.current(sessionId);
	return state;
}

export function projectRunStatus(state) {
	if (!state) return null;
	const last = state.episode?.steps?.at(-1)?.observation;
	const openQuestion = state.workspace?.open_questions?.at(-1);
	const next = last?.next_actions?.[0]?.description
		?? state.workspace?.candidate_actions?.at(-1)?.description
		?? (typeof openQuestion === "string" ? openQuestion : openQuestion?.question)
		?? "根据当前证据决定继续观察或停止";
	return {
		run_id: state.run.run_id,
		mode: state.run.mode,
		status: state.run.status,
		attention: userFacingProgress(`正在关注：${state.workspace.goal}`),
		finding: userFacingProgress(last?.summary ?? "正在建立任务范围和第一项观察"),
		why_not_write: last?.status === "rejected" || last?.status === "conflict"
			? userFacingProgress(last.summary)
			: state.run.status === "waiting_user" ? "当前步骤需要你的判断，尚未继续写入" : null,
		next: state.run.status === "closed" ? "本轮已结束，可自由追问；继续核查由你发起。" : userFacingProgress(next),
		progress: {
			steps: state.run.step_count,
			evidence: state.workspace.evidence.length,
			counter_evidence: state.workspace.counter_evidence.length,
			open_questions: state.workspace.open_questions.length
		},
		continuation_pending: Array.isArray(state.continuations) ? state.continuations.filter((entry) => entry.status === "pending").length : 0,
		result: state.workspace.extension?.result ?? null
	};
}

/** GET /api/cognition/runs/:id */
export async function handleCognitiveRunGet(_ctx, _req, res, _trustedHosts, projectRoot, runId) {
	const runtime = getCognitiveRuntime(projectRoot);
	const state = runtime.get(validRunId(runId));
	if (!state) throw new HttpError(404, `CognitiveRun 不存在: ${runId}`);
	assertOwnedRun(state);
	const withContinuations = { ...state, continuations: runtime.continuations(runId) };
	json(res, 200, {
		...withContinuations,
		interaction: runtime.getInteraction(runId),
		pending_proposals: listProposalsForSession(state.run.session_id),
		projection: projectRunStatus(withContinuations)
	});
}

/** GET /api/cognition/sessions/:id → current run plus an unanswered interaction, if any. */
export async function handleCognitiveSessionGet(ctx, _req, res, _trustedHosts, projectRoot, sessionId) {
	assertOwnedConversation(sessionId);
	const runtime = getCognitiveRuntime(projectRoot);
	const state = await reconcileDormantCognitiveRun(ctx, projectRoot, sessionId);
	if (!state) {
		json(res, 200, { active: false });
		return;
	}
	const withContinuations = { ...state, continuations: runtime.continuations(state.run.run_id) };
	json(res, 200, {
		...withContinuations,
		interaction: runtime.currentInteraction(sessionId),
		pending_proposals: listProposalsForSession(sessionId).filter(p => !runtime.discussionTask(sessionId) || p.run_id === state.run.run_id),
		projection: projectRunStatus(withContinuations)
	});
}

/** POST /api/cognition/runs/:id/resume — 重投递因 DSH 会话短暂失败而滞留的 continuation。 */
export async function handleCognitiveRunResume(ctx, _req, res, _trustedHosts, projectRoot, runId) {
	const runtime = getCognitiveRuntime(projectRoot);
	const state = runtime.get(validRunId(runId));
	if (!state) throw new HttpError(404, `CognitiveRun 不存在: ${runId}`);
	assertOwnedRun(state);
	assertCurrentKnowledgeExecution(state);
	return withConversationAdmission(state.run.session_id, () => retryCognitiveContinuation(ctx, res, runtime, runId));
}

async function retryCognitiveContinuation(ctx, res, runtime, runId) {
	const state = runtime.get(runId);
	assertCurrentRun(runtime, state);
	assertCurrentKnowledgeExecution(state);
	const native = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === state.run.session_id);
	if (native?.running || runtime.currentInteraction(state.run.session_id)) throw new HttpError(409, "当前正在执行或仍有待答，不能重复恢复。");
	if (["closed", "completed", "cancelled"].includes(state.run.status)) throw new HttpError(409, "该运行已结束，不能重投旧指令。");
	const pending = runtime.pendingContinuations(runId);
	let delivered = 0;
	for (const entry of pending) {
		try {
			await selectActiveModel(ctx, state.run.session_id);
			runtime.resume(runId);
			runtime.continueAnalysisTurn(runId);
			await rpcCall(ctx, "session.prompt", { sessionId: state.run.session_id, mode: "queue", content: [{ type: "text", text: entry.content }] });
			runtime.markContinuationDelivered(runId, entry.id);
			delivered++;
			if (state.run.analysis_policy_version === "conversation-v2") break;
		} catch {
			runtime.setStatus(runId, "paused", "继续指令未确认投递，待恢复记录保留。");
			break;
		}
	}
	json(res, 200, { run_id: runId, delivered, pending: runtime.pendingContinuations(runId).length });
}

/** POST /api/cognition/runs/:id/steer {message} */
export async function handleCognitiveRunSteer(ctx, req, res, _trustedHosts, projectRoot, runId) {
	const runtime = getCognitiveRuntime(projectRoot);
	const state = runtime.get(validRunId(runId));
	assertOwnedRun(state);
	assertCurrentRun(runtime, state);
	assertCurrentKnowledgeExecution(state);
	return handleCognitiveSessionSteer(ctx, req, res, _trustedHosts, projectRoot, state.run.session_id);
}

export async function handleCognitiveSessionSteer(ctx, req, res, _trustedHosts, projectRoot, sessionId) {
	assertOwnedConversation(sessionId);
	if (conversationExt(sessionId).thinking_mode === "quick" && !conversationExt(sessionId).uno_job_id) throw new HttpError(409, "本轮资料已经提交，请将补充作为下一条问题发送。");
	const runtime = getCognitiveRuntime(projectRoot);
	const body = await readJsonBody(req);
	if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 12000) throw new HttpError(400, "请填写不超过 12000 字的插入消息。");
	if (typeof body.request_id !== "string" || !/^[\w-]{8,80}$/.test(body.request_id)) throw new HttpError(400, "缺少有效的插入消息标识。");
	return withConversationAdmission(sessionId, async () => {
		const job=unoConversationJob(projectRoot,sessionId);
		if(job){
			if(!isUnoJobRunning(sessionId)||job.end_requested)throw new HttpError(409,'工作已暂停或结束，请讨论结果或继续工作。');
			const prior=job.user_directives?.find(d=>d.id===body.request_id);
			if(prior){if(prior.text!==body.message)throw new HttpError(409,'补充编号已用于另一条消息。');return json(res,200,{accepted:true,run_id:null});}
			if((job.user_directives??[]).reduce((n,d)=>n+d.text.length,0)+body.message.length>12000)throw new HttpError(400,'本任务补充要求累计超过12000字，请结束后以新的范围开始工作。');
			job.user_directives=[...(job.user_directives??[]),{id:body.request_id,text:body.message,at:new Date().toISOString()}];
			saveCompileJob(projectRoot,job);
			// Durable task context is rebuilt at every step, including after a session handoff.
			return json(res,200,{accepted:true,run_id:null});
		}

		const state = runtime.current(sessionId), runId = state?.run.run_id ?? null;
		assertCurrentKnowledgeExecution(state);
		const receipts = conversationExt(sessionId).steering_receipts ?? [];
		const prior = receipts.find(r => r.id === body.request_id);
		if (prior) {
			if (prior.message !== body.message || prior.run_id !== body.expected_run_id) throw new HttpError(409, "插入标识已用于另一条消息。");
			if (prior.status !== "accepted") throw new HttpError(409, "上次插入结果尚不确定，请先核对对话记录，勿重复发送。");
			return json(res, 200, { accepted: true, run_id: prior.run_id });
		}
		if (body.expected_run_id !== runId) throw new HttpError(409, "当前运行已变化；消息保留在队列，请确认后重新发送。");
		const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === sessionId);
		const activeRun = state?.run.status === "running";
		const ordinaryTurn = !state || (["general", "assess", "report"].includes(state.run.mode) && state.run.status !== "waiting_user");
		if (!session?.running || (!activeRun && !ordinaryTurn)) throw new HttpError(409, "本轮已结束或正在等待处理，请使用普通发送。");
		const proposals = listProposalsForSession(sessionId).filter(p => p.run_id === runId);
		if (runtime.currentInteraction(sessionId) || proposals.length || conversationExt(sessionId).native_question || conversationExt(sessionId).discussion_requested) throw new HttpError(409, "请先处理待办或等待暂停完成；插入不代表批准。");
		const receipt = { id: body.request_id, run_id: runId, message: body.message, status: "pending" };
		patchConversationExt(sessionId, { steering_receipts: [...receipts, receipt].slice(-64) });
		// Native steer is consumed at the nearest step boundary; never restart the Run or reset rights.
		await rpcCall(ctx, "session.prompt", { sessionId, mode: "steer", content: [{ type: "text", text: body.message.trim().startsWith("/") ? `补充要求：\n${body.message.trim()}` : body.message.trim() }] });
		patchConversationExt(sessionId, { steering_receipts: [...receipts, { ...receipt, status: "accepted" }].slice(-64) });
		if (activeRun) runtime.updateWorkspace(runId, { user_directives: [...state.workspace.user_directives, { at: new Date().toISOString(), text: body.message.trim() }].slice(-20) });
		json(res, 200, { accepted: true, run_id: runId });
	});
}

/** POST /api/cognition/interactions/:id/respond — persist one answer, then resume the same session. */
export async function handleCognitiveInteractionAnswer(ctx, req, res, _trustedHosts, projectRoot, interactionId) {
	const body = await readJsonBody(req);
	const prepared = prepareCognitiveInteractionAnswer(projectRoot, interactionId, body);
	assertOwnedConversation(prepared.interaction.session_id);
	const resumed = await resumeCognitiveInteraction(ctx, projectRoot, prepared);
	json(res, 200, { accepted: true, resumed, interaction: prepared.interaction, run_id: prepared.interaction.run_id });
}

export function prepareCognitiveInteractionAnswer(projectRoot, interactionId, body, expectedSessionId) {
	const runtime = getCognitiveRuntime(projectRoot);
	const interaction = runtime.getInteractionById(interactionId);
	if (!interaction || interaction.interaction_id !== interactionId) throw new HttpError(404, "待答问题不存在");
	assertCurrentRun(runtime, runtime.get(interaction.run_id));
	assertCurrentKnowledgeExecution(runtime.get(interaction.run_id));
	if (expectedSessionId !== void 0 && interaction.session_id !== expectedSessionId) throw new HttpError(400, "待答问题不属于当前会话");
	const optionId = typeof body.option_id === "string" ? body.option_id.trim() : "";
	const freeform = typeof body.answer === "string" ? body.answer.trim() : "";
	let answer;
	if (optionId) {
		const option = interaction.options?.find((item) => item.id === optionId);
		if (!option) throw new HttpError(400, "所选项不属于这项问题");
		answer = { kind: "option", option_id: option.id, text: `我选择“${option.label}”。${option.description}` };
	} else if (freeform) {
		answer = { kind: "freeform", text: freeform };
	} else {
		throw new HttpError(400, "请选择一个选项，或填写其他想法");
	}
	return { interaction, answer, prompt: `关于“${interaction.question}”，我的决定是：${answer.text}\n请把这项决定作为本轮约束更新 Workspace，并从当前观察继续，不要从头开始。` };
}

export async function queueCognitiveContinuation(ctx, projectRoot, { runId, sessionId, kind, prompt }) {
	const runtime = getCognitiveRuntime(projectRoot);
	assertCurrentRun(runtime, runtime.get(runId));
	assertCurrentKnowledgeExecution(runtime.get(runId));
	const entry = runtime.enqueueContinuation(runId, { kind, content: prompt });
	try {
		await selectActiveModel(ctx, sessionId);
		runtime.continueAnalysisTurn(runId);
		await rpcCall(ctx, "session.prompt", {
			sessionId,
			mode: "queue",
			content: [{ type: "text", text: prompt }]
		});
		runtime.markContinuationDelivered(runId, entry.id);
		return true;
	} catch (error) {
		console.error("nexogenesis: CognitiveRun continuation 投递失败，已保留待重试记录", error);
		return false;
	}
}

export async function resumeCognitiveInteraction(ctx, projectRoot, prepared) {
	const runtime = getCognitiveRuntime(projectRoot);
	const interaction = runtime.getInteractionById(prepared.interaction.interaction_id);
	const state = runtime.get(interaction?.run_id);
	assertCurrentRun(runtime, state);
	assertCurrentKnowledgeExecution(state);
	if (interaction?.status !== "pending") throw new HttpError(409, "这项问题已经处理，请刷新待办。");
	if (!["running", "waiting_user", "paused"].includes(state.run.status)) throw new HttpError(409, "该运行已停止，不能消费旧问题的回答。");
	if (state.run.status === "paused") runtime.resume(state.run.run_id);
	const directives = [...state.workspace.user_directives.filter(item => item.interaction_id !== interaction.interaction_id), {
		at: new Date().toISOString(), text: prepared.answer.text, interaction_id: interaction.interaction_id
	}].slice(-20);
	// Validate and save constraints before consuming the decision. A rejected
	// workspace update leaves the pending question available for retry.
	try { runtime.updateWorkspace(state.run.run_id, { user_directives: directives }); }
	catch (error) { if (state.run.status === "paused") runtime.setStatus(state.run.run_id, "paused"); throw error; }
	const answered = runtime.answerInteraction(interaction.interaction_id, prepared.answer);
	const delivered = await queueCognitiveContinuation(ctx, projectRoot, {
		runId: answered.run_id, sessionId: answered.session_id,
		kind: "interaction_answer", prompt: prepared.prompt
	});
	if (delivered) runtime.setStatus(answered.run_id, "running");
	else runtime.setStatus(answered.run_id, "paused", "用户决定已保存，但继续指令暂未投递；可安全重试恢复。");
	prepared.interaction = answered;
	return delivered;
}
