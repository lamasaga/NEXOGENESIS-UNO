import { isRetiredIngestion, assertCurrentKnowledgeExecution, RETIRED_INGESTION_MESSAGE } from './knowledge-task-access.js';
import { requestExecutionControl } from "./work.js";
import { prepareResumeInbox } from "./resume-inbox.js";
/**
 * /api/chat and /api/chat/stream compatibility handlers.
 *
 * Sends a user message through the gateway's session.prompt (queue mode),
 * then bridges the host-side session/event feed into the frontend's SSE
 * frame protocol (delta / step / sources / done / error). The listener is
 * registered BEFORE the prompt so no event is missed.
 */
import { HttpError, json, readJsonBody, rpcCall, sse } from "./rpc.js";
import { broadcastCognitiveEvent, broadcastGraphEvent } from "./events-bus.js";
import { randomUUID } from "node:crypto";
import { hasUnoJobRunning, startUnoJob, unoConversationJob, unoJobEnded, isUnoJobRunning, DEFAULT_COMPILE_PROFILE } from "./uno-jobs.js";
import { parseCompileCommand } from '../../nexogenesis-tools/lib/compile-options.js';
import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { reasonOf, settleGeneralRunAtTurnBoundary, settlePipelineRunAtTurnBoundary } from "./turn-state.js";
export { settleGeneralRunAtTurnBoundary, settlePipelineRunAtTurnBoundary } from "./turn-state.js";
import { settleWorkTurn, projectWorkPhase } from "./work.js";
import { listProposalsForSession } from "../../nexogenesis-tools/lib/pending.js";
import { prepareCognitiveInteractionAnswer, resumeCognitiveInteraction } from "./cognition.js";
import { projectCognitiveEvent, toolCallIdOf } from "./cognitive-events.js";
import { pipelineAuthorityOf, selectActiveModel } from "./settings.js";
import { conversationExt, patchConversationExt } from "./meta.js";
import { assertOwnedConversation } from "./projects.js";
import { createChatLatencyTrace } from "./latency-telemetry.js";
import { buildConstructContract, constructPrompt } from "./construct.js";
import { withConversationAdmission } from "./conversation-control.js";
import { prepareThinking } from "./thinking.js";
import { streamQuickThinking, cancelQuickThinking } from "./quick-thinking.js";
import { reconcileAnalysisDelivery } from "./analysis-delivery.js";

const STREAM_TIMEOUT_MS = 10 * 60 * 1000;
const PIPELINE_LABELS = { construct: "建构" };
const PIPELINE_STAGES = new Set(Object.keys(PIPELINE_LABELS));
const PIPELINE_CONTINUE = /^\s*(?:继续(?:执行|处理|建构|任务)?|恢复(?:执行|处理|任务)?|重新(?:开始|执行|处理))(?:吧)?[。.!！]?\s*$/;

/**
 * 固定知识处理线程中的自然语言“继续”应恢复对应工作流，而不是只启动一轮
 * 与 CognitiveRun 脱节的普通模型对话。活跃任务中的补充指令也沿用当前工作流。
 */
export function pipelineStageForMessage(message, taskKind, currentStatus) {
	const raw = String(message ?? "");
	const explicit = /^\s*\/(construct)\s*$/.exec(raw)?.[1];
	if (explicit) return explicit;
	if (!PIPELINE_STAGES.has(taskKind)) return void 0;
	if (["running", "waiting_user"].includes(currentStatus)) return taskKind;
	return PIPELINE_CONTINUE.test(String(message ?? "")) ? taskKind : void 0;
}

function scopedPipelinePrompt(message, stage) {
	if (stage === "construct" && /^\s*\/construct\s*$/u.test(message)) return `${message}\n\n  本次在当前授权范围内连续建构多个局部问题，不以完成一个局部计划或三项操作作为整轮停止条件。用 inspect_cognitive_workspace(view=backlog) 查回历史待办，结合当前诊断选择有价值的下一项；历史待办不代替当前证据与授权。先读取当前 .agent/skills/nexo-construct/SKILL.md；一般组织问题使用 knowledge-organization，按观察比较内容、关系与领域调整，不默认逐张补边。Workspace 的 recovery_review 若有内容，只作为已提交未收束事项的核查线索，勿重放旧操作。`;
	return message;
}

/** One graph-animation event id (dedup token for the frontend engine). */
function graphEventId() {
	return randomUUID();
}

// Former theme compilation commands select the same current book compiler.
// Digest has no new execution path; its saved results are available as history.
function parseWebCompileCommand(message) {
  if (/^\s*\/(?:digest|消化)(?=\s|$)/iu.test(String(message))) throw new HttpError(409, RETIRED_INGESTION_MESSAGE);
  return parseCompileCommand(message);
}

export async function compileCommand(ctx,root,command,body={}) {
  const sources=body.pipeline_sources??body.sources;
  if(!Array.isArray(sources)||!sources.length)return {action:'select_compile_sources',notes:command.notes};
  return {action:'compile_started',job:await startUnoJob(ctx,root,{mode:'compile',compile_profile:DEFAULT_COMPILE_PROFILE,sources,material_kind:body.material_kind??'auto',notes:command.notes,theme:body.theme??'',budget_calls:body.budget_calls})};
}

/** Extract text from an assistant StreamChunk (text-delta only). */
function chunkText(chunk) {
	if (chunk?.type === "text-delta" && typeof chunk.text === "string") return chunk.text;
	return "";
}

/** POST /api/chat {conversation_id, message} → {answer, conversation_id} (non-streaming). */
export async function handleChat(ctx, req, res, _trustedHosts, projectRoot) {
	const body = await readJsonBody(req);
	const { conversation_id, message } = body;
	if (typeof conversation_id !== "string" || typeof message !== "string") {
		throw new HttpError(400, "conversation_id 和 message 为必填");
	}
	assertOwnedConversation(conversation_id);
	const compile=parseWebCompileCommand(message);
	if(compile){const result=await compileCommand(ctx,projectRoot,compile,body);return json(res,result.job?202:200,result);}
	if (conversationExt(conversation_id).uno_job_id) throw new HttpError(409, "请在编译或建构面板中继续此任务，讨论请新建对话。");
	if (hasUnoJobRunning(projectRoot)) throw new HttpError(409,"编译或建构正在处理，请暂停后使用旧对话入口。");
	return withConversationAdmission(conversation_id, async () => {
		if (conversationExt(conversation_id).thinking_mode === "quick") throw new HttpError(409, "预设路线思考请使用流式入口。");
		const runtime = getCognitiveRuntime(projectRoot);
		assertCurrentKnowledgeExecution(runtime.current(conversation_id));
		assertCurrentKnowledgeExecution(conversationExt(conversation_id).task_kind);
		if (conversationExt(conversation_id).task_kind || conversationExt(conversation_id).analysis_trial || runtime.discussionTask(conversation_id)) throw new HttpError(409, "任务与试用对话请使用支持状态校验的流式入口。");
		const native = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === conversation_id);
		if (native?.running || runtime.currentInteraction(conversation_id)) throw new HttpError(409, "当前回合仍在执行或等待回答，请使用流式入口处理。");
		const answer = await runTurn(ctx, conversation_id, message, projectRoot);
		json(res, 200, { answer, conversation_id });
	});
}

/** POST /api/chat/cancel {conversation_id} — stop the active DSH turn. */
export async function handleChatCancel(ctx, req, res, _trustedHosts, projectRoot) {
	const body = await readJsonBody(req);
	const conversationId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
	if (!conversationId) throw new HttpError(400, "conversation_id 为必填");
	assertOwnedConversation(conversationId);
	const result=await requestExecutionControl(ctx,projectRoot,conversationId,{action:'pause',...body});
	json(res,result.pending?202:200,{...result,cancelled:!result.pending,conversation_id:conversationId});
}

/** POST /api/chat/stream {conversation_id, message} → SSE frame stream. */
export async function handleChatStream(ctx, req, res, _trustedHosts, projectRoot) {
	const body = await readJsonBody(req);
	return withConversationAdmission(body.conversation_id, () => streamChatBody(ctx, res, projectRoot, body));
}

async function streamChatBody(ctx, res, projectRoot, body) {
	const { conversation_id } = body;
	const interactionId = typeof body.interaction_id === "string" ? body.interaction_id : null;
	if (typeof conversation_id !== "string" || (!interactionId && typeof body.message !== "string")) {
		throw new HttpError(400, "conversation_id 和 message 为必填");
	}
	assertOwnedConversation(conversation_id);
	const compile=parseWebCompileCommand(body.message);
	if(compile&&!interactionId){
		const result=await compileCommand(ctx,projectRoot,compile,body);
		res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
		sse(res,{type:'compile_request',...result});sse(res,{type:'delta',text:result.job?'已开始编译，请在编译面板查看进度。':'请选择本轮材料；编译提示词已保留。'});sse(res,{type:'done'});res.end();return;
	}
	if (conversationExt(conversation_id).execution_control) throw new HttpError(409,'正在停止当前执行，请稍后发送。');
	const unoJob=unoConversationJob(projectRoot,conversation_id);
	if(unoJob){
		if(conversation_id!==(unoJob.owner_session_id??unoJob.session_id))throw new HttpError(409,'请在主会话讨论。');
		if(isUnoJobRunning(conversation_id))throw new HttpError(409,'请先暂停执行，再讨论已有结果。');
		if(body.resume_task||body.construct_request||body.pipeline_sources?.length||interactionId)throw new HttpError(409,'讨论不恢复工作，请使用继续工作按钮。');
		patchConversationExt(conversation_id,{uno_discussing:true});
		const context=unoJobEnded(unoJob)?'此前工作已经结束。本轮是新的只读问题，不恢复旧任务或继承写入授权。':JSON.stringify({mode:unoJob.mode,goal:unoJob.notes,status:unoJob.status,phase:unoJob.phase,detail:unoJob.detail,checkpoint:unoJob.checkpoint,completed_batches:unoJob.completed_batches?.slice(-3),remaining_units:unoJob.remaining_units,issues:unoJob.issues?.slice(-8),budget:unoJob.budget,calls:unoJob.calls.length});
		return streamQuickThinking(ctx,res,projectRoot,conversation_id,body.message,{taskContext:context});
	}

	const preparedInteraction = interactionId ? prepareCognitiveInteractionAnswer(projectRoot, interactionId, body, conversation_id) : null;
	const requestedMessage = preparedInteraction?.prompt ?? body.message;
	// The native fallback retains construction and ordinary analysis only.
	// Compilation is handled by the current book entry above.
	const runtime = getCognitiveRuntime(projectRoot);
	let currentRun = runtime.current(conversation_id);
  if (isRetiredIngestion(currentRun) || isRetiredIngestion(conversationExt(conversation_id).task_kind)) {
    if (body.resume_task || preparedInteraction || body.construct_request || body.pipeline_sources?.length) throw new HttpError(409, RETIRED_INGESTION_MESSAGE);
    return streamQuickThinking(ctx,res,projectRoot,conversation_id,requestedMessage,{taskContext:JSON.stringify({readonly:true,message:RETIRED_INGESTION_MESSAGE,goal:currentRun?.workspace?.goal,status:currentRun?.run?.status})});
  }
	if (Object.hasOwn(body, "expected_run_id") && body.expected_run_id !== (currentRun?.run.run_id ?? null)) throw new HttpError(409, "排队消息所对应的运行已变化，请确认后重新发送。");
	const requestedThinking = body.thinking_request !== undefined ? prepareThinking(body.thinking_request, requestedMessage) : null;
	if (requestedThinking?.quick || conversationExt(conversation_id).thinking_mode === "quick") {
		if (currentRun || preparedInteraction || body.resume_task || body.construct_request || body.pipeline_sources?.length
			|| conversationExt(conversation_id).task_kind || runtime.discussionTask(conversation_id)
			|| conversationExt(conversation_id).native_question || runtime.currentInteraction(conversation_id)
			|| listProposalsForSession(conversation_id).length || (requestedThinking && !requestedThinking.quick)) throw new HttpError(409, "预设路线只读交流，请新建对话执行其他工作。");
		const native = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === conversation_id);
		if (native?.running) throw new HttpError(409, "当前回合仍在执行，请稍后发送。");
		if (conversationExt(conversation_id).thinking_mode !== "quick") {
			const history = await rpcCall(ctx, "session.history", { sessionId: conversation_id, maxMessages: 1 });
			if ((history.events ?? []).some(e => ["user/message", "assistant/message"].includes((e.event ?? e).type))) throw new HttpError(409, "请从思考入口新建对话。");
		}
		return streamQuickThinking(ctx, res, projectRoot, conversation_id, requestedMessage);
	}
	if (body.construct_request !== undefined && (currentRun || body.resume_task || preparedInteraction)) throw new HttpError(409, "已有任务不能重新设定建构范围；请继续原任务或新建任务");
	if (PIPELINE_STAGES.has(currentRun?.run.mode) && ["completed","closed"].includes(currentRun.run.status) && !body.resume_task && !preparedInteraction) {
		const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === conversation_id);
		if (session?.running) throw new HttpError(409, "上一轮仍在收尾，请稍后发送。");
		runtime.closeConversationWork(conversation_id);
		patchConversationExt(conversation_id,{task_kind:null});
		currentRun = runtime.current(conversation_id);
	}
	if (!runtime.discussionTask(conversation_id) && conversationExt(conversation_id).task_kind && currentRun && !["running", "waiting_user"].includes(currentRun.run.status) && body.resume_task !== true && !preparedInteraction) throw new HttpError(409, "此任务已停止；可以进入只读讨论，或明确继续原任务。");
	if (body.resume_task === true) {
		const session = ((await rpcCall(ctx, "session.list", {})).items ?? []).find((item) => item.sessionId === conversation_id);
		if (session?.running || runtime.currentInteraction(conversation_id) || listProposalsForSession(conversation_id).length || !currentRun || !PIPELINE_STAGES.has(currentRun.run.mode) || !["running", "paused", "blocked", "failed", "cancelled"].includes(currentRun.run.status)) throw new HttpError(409, "此任务当前不能继续，请先处理待办或等待当前执行结束");
		runtime.resume(currentRun.run.run_id);
		currentRun = runtime.current(conversation_id);
	}
	const pipelineStage = pipelineStageForMessage(
		requestedMessage,
		runtime.discussionTask(conversation_id) || ["completed","closed"].includes(currentRun?.run.status) ? undefined : conversationExt(conversation_id).task_kind,
		currentRun?.run?.status
	);
	if (runtime.discussionTask(conversation_id) && pipelineStage) throw new HttpError(409, "当前是只读讨论；请通过继续建构返回原任务。");
	const thinking = requestedThinking;
	if (thinking && (currentRun || pipelineStage || preparedInteraction || body.resume_task)) throw new HttpError(409, "思考选项只用于新对话的首轮。");
	if (thinking) patchConversationExt(conversation_id, { analysis_trial: thinking.trial });
	const pipelineActive = pipelineStage !== void 0;
	const latency = createChatLatencyTrace(projectRoot, { pipeline: pipelineActive });
	const finishLatency = (options) => {
		try { latency.finish(options); } catch (error) { console.warn("[NEXOGENESIS] latency telemetry write failed:", error?.message ?? error); }
	};
	if (!pipelineActive && !preparedInteraction) {
		const native = ((await rpcCall(ctx, "session.list", {})).items ?? []).find(s => s.sessionId === conversation_id);
		if (native?.running) throw new HttpError(409, "当前回合仍在执行；请使用立即插入或等待结束。");
		if (runtime.currentInteraction(conversation_id)) throw new HttpError(409, "请先回答当前待答问题，不能用新题覆盖它。");
		await reconcileAnalysisDelivery(ctx, runtime, runtime.current(conversation_id));
		settleGeneralRunAtTurnBoundary(runtime, conversation_id, { phase: "start" });
	}
	if (!preparedInteraction && !body.resume_task) runtime.admitConversationTurn(conversation_id, {
		policy: !pipelineActive && conversationExt(conversation_id).analysis_trial === true && process.env.NEXO_CONVERSATION_V2 !== "0" && !/(?:\/(?:deep-think|judge)\b|测试\s*(?:TM|OPS)|运行思维体测试)/i.test(requestedMessage) ? "conversation-v2" : "legacy",
		request: requestedMessage
	});
	if (body.pipeline_sources !== undefined && (!Array.isArray(body.pipeline_sources) || body.pipeline_sources.length)) throw new HttpError(409, "材料编译请使用当前编译入口选择原书。");
	if (body.construct_request !== undefined && pipelineStage !== "construct") throw new HttpError(400, "建构选项只能用于建构任务");
	const construct = body.construct_request !== undefined ? buildConstructContract(projectRoot, body.construct_request)
		: pipelineStage === "construct" ? currentRun?.workspace?.scope?.construct_request : null;
	let message = thinking ? thinking.prompt : construct ? constructPrompt(requestedMessage, construct)
		: runtime.discussionTask(conversation_id) ? `${requestedMessage}\n\n[DISCUSSION_CONTEXT]\n现在是只读讨论；此前建构暂停或已完成。不要恢复旧写入、沿用旧授权或重放操作。按本次问题自由交流，必要时另建只读分析。`
		: scopedPipelinePrompt(requestedMessage, pipelineStage);
	if (runtime.conversationTurn(conversation_id)?.policy === "conversation-v2") message += "\n\n[THINKING_CONTEXT]\n本次会话已由用户选择新版分析试用。只在运行回执 analysis_policy_version=conversation-v2 时采用新版交付契约：缺口可带入答案，不为了方法配额反复收尾。主动检查能改变判断的真实关系路径，精读关键节点并解释接合条件；无需固定跳数、特殊 OPS 或必有洞见。准备后直接回答，禁止把准备或局部验证称为完整研究完成。";
	if (thinking && !thinking.auto) runtime.start({ session_id: conversation_id, mode: thinking.mode, skill: thinking.skill, goal: requestedMessage, scope: thinking.scope, write_authority: "manual" });
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive"
	});
	if (pipelineActive) {
		const current = currentRun;
		if (!current || current.run.mode !== pipelineStage || !["running", "waiting_user"].includes(current.run.status)) {
			runtime.start({
				session_id: conversation_id,
				mode: pipelineStage,
				skill: "nexo-construct",
				goal: construct ? `${construct.goal_label} · ${construct.scope_label}` : "重新诊断知识的发现性、表达、关系与领域组织，在授权范围内连续改善多个局部问题，逐项复核并保留剩余待办",
				scope: construct ? { construct_request: construct, continuous_construct: construct.workload === "systematic" }
					: { continuous_construct: true },
				extension: { recovery_review: conversationExt(conversation_id).construct_recovery ?? null },
				write_authority: pipelineAuthorityOf(ctx),
				budget: construct ? construct.budget : { max_steps: 600, max_reads: 400, max_writes: 100 }
			});
		}
		sse(res, {
			type: "pipeline_status",
			state: "starting",
			label: `正在启动${PIPELINE_LABELS[pipelineStage]}任务`,
			job_id: conversation_id
		});
	}

	let finished = false;
	let disposer = () => {};
	const pendingCalls = new Map(); // tool_call_id -> { name, args }
	const pendingOrder = [];
	const emittedChoices = new Set();
	const emittedProposals = new Set();
	let callCounter = 0;
	const parseArgs = (raw) => {
		try { return JSON.parse(raw ?? "{}"); } catch { return {}; }
	};
	const rememberCall = (data, name) => {
		const id = toolCallIdOf(data, `${conversation_id}:${++callCounter}`);
		const call = { id, name, args: parseArgs(data?.arguments) };
		pendingCalls.set(id, call);
		pendingOrder.push(id);
		return call;
	};
	const takeCall = (data) => {
		const named = toolCallIdOf(data, "");
		const id = named && pendingCalls.has(named) ? named : pendingOrder.find((candidate) => pendingCalls.has(candidate));
		if (!id) return { id: named || `${conversation_id}:orphan`, name: String(data?.name ?? "tool"), args: {} };
		const call = pendingCalls.get(id);
		pendingCalls.delete(id);
		const orderIndex = pendingOrder.indexOf(id);
		if (orderIndex >= 0) pendingOrder.splice(orderIndex, 1);
		return call;
	};
	const emitChoiceRequest = (choice) => {
		if (!choice || choice.status !== "pending" || typeof choice.interaction_id !== "string" || typeof choice.question !== "string" || !Array.isArray(choice.options)) return;
		if (emittedChoices.has(choice.interaction_id)) return;
		emittedChoices.add(choice.interaction_id);
		sse(res, {
			type: "choice_request", ...choice,
			options: choice.options.filter((option) => option && typeof option.id === "string" && typeof option.label === "string" && typeof option.description === "string")
		});
	};
	const emitConfirmRequest = (proposal) => {
		if (!proposal || typeof proposal.proposal_id !== "string" || emittedProposals.has(proposal.proposal_id)) return;
		emittedProposals.add(proposal.proposal_id);
		sse(res, {
			type: "confirm_request",
			proposal_id: proposal.proposal_id,
			summary: proposal.summary ?? "",
			operations: Array.isArray(proposal.operations) ? proposal.operations : [],
			warnings: Array.isArray(proposal.warnings) ? proposal.warnings : [],
			presentation: proposal.presentation ?? null
		});
	};
	const emitCognitive = (call, phase, { broadcast = true } = {}) => {
		const state = getCognitiveRuntime(projectRoot).current(conversation_id);
		const event = projectCognitiveEvent({
			sessionId: conversation_id,
			state,
			operator: call.name,
			args: call.args,
			toolCallId: call.id,
			phase,
			projectRoot
		});
		if (broadcast) broadcastCognitiveEvent(conversation_id, event);
		return event;
	};
	const cleanup = () => {
		if (finished) return;
		finished = true;
		disposer();
		clearTimeout(timer);
	};
	const onEvent = async (session, event) => {
		if (session.id !== conversation_id || finished) return;
		if (event.type === "turn/start") runtime.bindConversationTurn(conversation_id, event);
		const admission = runtime.conversationTurn(conversation_id);
		if (admission?.policy === "conversation-v2" && event.data?.turn != null
			&& String(event.data.turn) !== String(admission.turn_id)) return;
		timer.refresh(); // Idle timeout, not a limit on the total duration of an active task.
		if (event.type === "step/start") latency.stepStarted(event.data);
		if (event.type === "step/end") latency.stepFinished(event.data);
		if (event.type === "assistant/message") latency.modelMessage(event.data);
		if (event.type === "assistant/chunk") {
			latency.modelChunk(event.data);
			const text = chunkText(event.data?.chunk);
			if (text !== "") {
				latency.text(text);
				sse(res, { type: "delta", text });
			}
		} else if (event.type === "tool/call") {
			const name = event.data?.name ?? "tool";
			const call = rememberCall(event.data, name);
			latency.toolStarted(call);
			const cognitive = emitCognitive(call, "started");
			sse(res, { type: "step", kind: name, label: cognitive.presentation.title });
		} else if (event.type === "tool/result") {
			const call = takeCall(event.data);
			latency.toolFinished(call, event.data?.message);
			const cognitive = emitCognitive(call, "observed");
			sse(res, { type: "step", kind: call.name, label: cognitive.presentation.title });
			emitChoiceRequest(event.data?.meta?.choice_request);
			// Knowledge-domain tools project touched cards via presentationMeta;
			// forward them as a sources frame (frontend SourceCard shape).
			const cards = event.data?.meta?.cards;
			if (Array.isArray(cards) && cards.length > 0) {
				sse(res, {
					type: "sources",
					cards: cards.map((c) => ({
						id: String(c.id),
						title: String(c.title ?? c.id),
						...typeof c.kind === "string" ? { kind: c.kind } : {}
					}))
				});
			}
			// propose_write projects its proposal; emit a confirm_request frame
			// so the UI shows the ConfirmCard (frontend WriteProposal shape).
			emitConfirmRequest(event.data?.meta?.proposal);
		} else if (event.type === "turn/end") {
			const { kind, detail } = reasonOf(event.data?.reason);
			// The tool bridge can lose its meta envelope on a reconnect. The run
			// and proposal stores are durable, so reconcile their real pending
			// state before closing the stream instead of leaving the user with a
			// textual instruction and nothing actionable to click.
			const runtime = getCognitiveRuntime(projectRoot);
			emitChoiceRequest(runtime.currentInteraction(conversation_id));
			for (const proposal of listProposalsForSession(conversation_id)) emitConfirmRequest(proposal);
			if (kind !== "completed") {
				for (const call of pendingCalls.values()) {
					const failed = emitCognitive(call, "observed", { broadcast: false });
					failed.kind = "op.observed";
					failed.observation = { status: "error", channel: null, summary: detail, reason_code: "turn_ended", on_topic_new: null, truncated: false };
					failed.presentation = { title: `${failed.presentation.title}未完成`, detail, tone: "warning" };
					broadcastCognitiveEvent(conversation_id, failed);
				}
				pendingCalls.clear();
				pendingOrder.length = 0;
			}
			const settlement = await settleWorkTurn(ctx, projectRoot, conversation_id, event);
			if (settlement.continued) {
				sse(res, { type: "pipeline_status", state: "running", label: "正在继续原任务", job_id: conversation_id });
				return;
			}
			const cognitive = runtime.current(conversation_id);
			finishLatency({
				status: kind,
				analytical: cognitive?.workspace?.scope?.analysis_depth === "iterative"
			});
			// Graph-animation turn lifecycle.
			if (kind === "completed") {
				broadcastGraphEvent(conversation_id, {
					type: "session.idle",
					payload: { event_id: graphEventId() }
				});
			} else {
				broadcastGraphEvent(conversation_id, {
					type: "session.failed",
					payload: { event_id: graphEventId(), reason: detail }
				});
			}
			if (pipelineActive) {
				const finalCognitive = getCognitiveRuntime(projectRoot).current(conversation_id);
				const waitingForUser = finalCognitive?.run?.status === "waiting_user";
				const blocked = finalCognitive?.run?.status === "blocked";
				const paused = finalCognitive?.run?.status === "paused";
				sse(res, {
					type: "pipeline_status",
					state: projectWorkPhase({ running: false }, finalCognitive),
					label: waitingForUser ? `${PIPELINE_LABELS[pipelineStage]}正在等你处理` : blocked ? `${PIPELINE_LABELS[pipelineStage]}需要处理` : paused ? `${PIPELINE_LABELS[pipelineStage]}已在本波结束后暂停` : `${PIPELINE_LABELS[pipelineStage]}任务${finalCognitive?.run?.status === "completed" ? "完成" : "未完成"}`,
					...waitingForUser ? { detail: "请处理下方的选择卡或确认卡；处理后会在同一任务中继续。" } : kind !== "completed" ? { detail } : {},
					...paused ? { detail: "当前最小工作单元已完成；任务不会自动进入下一波。" } : {},
					...blocked ? { detail: finalCognitive?.workspace?.stop_reason ?? "任务已达到治理上限。" } : {},
					job_id: conversation_id
				});
			}
			if (kind === "completed") sse(res, { type: "done" });
			else sse(res, { type: "error", detail });
			cleanup();
			if (!res.writableEnded) res.end();
		}
	};
	const timer = setTimeout(() => {
		if (!finished) {
			sse(res, { type: "error", detail: "连续十分钟未收到会话活动，连接已关闭；后台任务是否仍在执行请以任务状态为准。" });
			finishLatency({ status: "timeout" });
			cleanup();
			if (!res.writableEnded) res.end();
		}
	}, STREAM_TIMEOUT_MS);
	// Execution observation outlives its HTTP subscriber, until turn/end or timeout.
	timer.unref?.();

	// cordis: ctx.on returns the disposer; ctx.off needs inject and must not be used.
	const unsubscribe = ctx.on("session/event", onEvent);
	disposer = () => {
		try { unsubscribe(); } catch { /* already disposed */ }
	};
	try {
		if (preparedInteraction) await resumeCognitiveInteraction(ctx, projectRoot, preparedInteraction);
		else {
			const selected = await selectActiveModel(ctx, conversation_id);
			latency.selectModel(selected);
			if(body.resume_task && ctx.get?.("agents")) await prepareResumeInbox(ctx,runtime,currentRun,requestedMessage);
			await rpcCall(ctx, "session.prompt", {
				sessionId: conversation_id,
				mode: "queue",
				content: [{ type: "text", text: message }]
			});
		}
	} catch (error) {
		settlePipelineRunAtTurnBoundary(runtime, conversation_id, { kind: "error", detail: error?.message ?? String(error) });
		const failedStart = runtime.current(conversation_id);
		if (failedStart?.run.analysis_policy_version === "conversation-v2" && failedStart.run.host_turn_id == null && failedStart.run.status === "running") runtime.setStatus(failedStart.run.run_id, "failed", `模型未能启动：${error?.message ?? String(error)}`);
		sse(res, { type: "error", detail: error?.message ?? String(error) });
		finishLatency({ status: "error" });
		cleanup();
		if (!res.writableEnded) res.end();
	}
}

/**
 * Run one turn to completion and return the assembled assistant answer.
 * Used by the non-streaming /api/chat endpoint.
 */
async function runTurn(ctx, sessionId, message, projectRoot) {
	const runtime = getCognitiveRuntime(projectRoot);
	await reconcileAnalysisDelivery(ctx, runtime, runtime.current(sessionId));
	settleGeneralRunAtTurnBoundary(runtime, sessionId, { phase: "start" });
	let resolveTurn;
	let rejectTurn;
	const turnDone = new Promise((resolve, reject) => {
		resolveTurn = resolve;
		rejectTurn = reject;
	});
	let answerParts = [];
	let disposer = () => {};
	const onEvent = (session, event) => {
		if (session.id !== sessionId) return;
		if (event.type === "assistant/chunk") {
			const text = chunkText(event.data?.chunk);
			if (text !== "") answerParts.push(text);
		} else if (event.type === "turn/end") {
			const { kind, detail } = reasonOf(event.data?.reason);
			settleGeneralRunAtTurnBoundary(runtime, sessionId, { phase: "end", kind, detail });
			disposer();
			if (kind === "completed") resolveTurn();
			else rejectTurn(new Error(detail));
		}
	};
	// cordis: ctx.on returns the disposer; ctx.off needs inject and must not be used.
	const unsubscribe = ctx.on("session/event", onEvent);
	disposer = () => {
		try { unsubscribe(); } catch { /* already disposed */ }
	};
	try {
		await selectActiveModel(ctx, sessionId);
		await rpcCall(ctx, "session.prompt", {
			sessionId,
			mode: "queue",
			content: [{ type: "text", text: message }]
		});
		await Promise.race([
			turnDone,
			new Promise((_, reject) => setTimeout(() => reject(new Error("对话超时")), STREAM_TIMEOUT_MS))
		]);
		return answerParts.join("");
	} catch (error) {
		disposer();
		throw error;
	}
}

export { HttpError };
