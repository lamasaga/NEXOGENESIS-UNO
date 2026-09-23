import { getCognitiveRuntime } from "../../nexogenesis-tools/lib/cognition/run-store.js";
import { listProposalsForSession } from "../../nexogenesis-tools/lib/pending.js";
/**
 * /api/projects and /api/conversations compatibility handlers.
 *
 * DSH has no native project concept, so the compatibility layer maps:
 *   project       → a record in the meta store, grouping sessions
 *   conversation  → a DSH session (id = session id)
 * Pinned / task_kind / soft-delete live in the meta store. Message history
 * is folded from the session event log via the gateway's session.history.
 */
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { CONSTRUCT_CONTEXT_MARKER } from "../../nexogenesis-tools/lib/construct-options.js";
import { isQuickThinkingRunning } from "./quick-thinking.js";
import { QUICK_MESSAGE_EVENT } from "./session-events.js";
import { endUnoJob, isUnoFocusedMaintenanceJob, isUnoJobRunning, unoConversationJob, unoJobEnded } from "./uno-jobs.js";
import { withConversationAdmission } from "./conversation-control.js";
import {
	conversationExt, createProjectRecord, ensureDefaultProject,
	isNexogenesisConversation, patchConversationExt, readMeta, softDeleteConversation
} from "./meta.js";

const PIPELINE_STAGES = ["compile", "theme_compile", "digest", "construct"];
const PIPELINE_LABELS = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" };
const PIPELINE_RECENT_RUNS = 3;
const PIPELINE_HISTORY_PREVIEWS = 8;

/** Fold the session event log into frontend ChatMessage[] (M1: user + assistant). */
export function foldMessages(history, { unoTask = false, sessionId = "" } = {}) {
	const messages = [];
	for (const entry of history.events ?? []) {
		const event = entry.event ?? entry;
		const identity = Number.isInteger(event.seq) && sessionId
			? { id: `${sessionId}:${event.seq}`, seq: event.seq }
			: {};
		if (event.type === QUICK_MESSAGE_EVENT) {
			const data = event.data;
			if (data?.content?.trim()) messages.push({ role: data.role, content: data.content,
				...(data.sources ? { sources: data.sources } : {}), ...(data.status ? { status: data.status } : {}),
				...(data.detail ? { detail: data.detail } : {}), ...(data.thinking_route ? { thinking_route: data.thinking_route } : {}),
				...(data.intent ? { intent: { action: data.intent.action, judgment: data.intent.judgment, route: data.intent.route } } : {}),
				...identity, ts: new Date(event.time).toISOString() });
			continue;
		}
		if (event.type !== "user/message" && event.type !== "assistant/message") continue;
		const role = event.type === "user/message" ? "user" : "assistant";
		// UNO native user turns are host orchestration. Human discussion uses
		// nexo/quick-message; retain the raw native log for auditing.
		if (unoTask && role === "user") continue;
		// DSH stores the two sides of a turn in different envelope shapes:
		// user/message carries ContentBlock[] directly as data.content, whereas
		// assistant/message carries it as data.message.content.  Read both;
		// otherwise a history refresh silently drops every user turn.
		const content = textOf(event.data?.message ?? event.data).trim();
		// DSH may emit structural message events without a text block. They are
		// audit noise, not a user turn or an assistant answer for the Web surface.
		if (content === "") continue;
		if (role === "user" && !isVisibleUserMessage(event, content)) continue;
		messages.push({
			...identity,
			role,
			content: role === "user" ? content.split(CONSTRUCT_CONTEXT_MARKER)[0].split(/\n\n\[(?:THINKING|DISCUSSION)_CONTEXT\]\n/)[0] : content,
			...event.time !== void 0 ? { ts: new Date(event.time).toISOString() } : {}
		});
	}
	return messages;
}

/**
 * DSH records its runtime snapshot, skill catalog, and orchestration signals
 * as user/message events so the model can receive them. They are not authored
 * by the person in the browser and must never become a visible chat turn.
 */
function isVisibleUserMessage(event, content) {
	const source = event.data?.source;
	if (source?.kind !== "user") return false;
	return !/^\[(?:PIPELINE_CONTINUATION|USER_STEERING|HARNESS_RECEIPT)\]\s*/.test(content);
}

/** Extract plain text from a DSH message (string or ContentBlock[]). */
function textOf(message) {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((b) => b?.type === "text" ? b.text : "").join("");
	return "";
}

/** Last session/title event in the log, if any. */
function titleFromHistory(history) {
	let title;
	for (const entry of history.events ?? []) {
		const event = entry.event ?? entry;
		if (event.type === "session/title") title = event.data?.title;
	}
	return title;
}

/** GET /api/projects → { projects: Project[] } */
export async function handleProjectsGet(ctx, _req, res, _trustedHosts, projectRoot) {

	const meta = readMeta();
	// Older focused repairs were pinned as if they were long-running primary
	// workflows. Clear only those task-owned legacy pins; an explicit user pin
	// remains authoritative.
	if(projectRoot)for(const [id,ext] of Object.entries(meta.conversations)){
		if(!ext?.pinned||ext.pin_source==='user'||!ext.uno_job_id)continue;
		try{
			const job=unoConversationJob(projectRoot,id);
			if(isUnoFocusedMaintenanceJob(job))patchConversationExt(id,{pinned:false,pin_source:null});
		}catch(error){if(error?.status!==404)throw error;}
	}
	const list = await rpcCall(ctx, "session.list", {});
	const sessions = list.items ?? [];
	// 隔离纪律：只展示「本界面登记过」的会话（meta.conversations 有记录），
	// 官方 agent 的会话不进入本列表（两个项目共享 $DSH_HOME/sessions，但互不污染）。
	const known = sessions.filter((s) => meta.conversations[s.sessionId] !== void 0 && meta.deleted[s.sessionId] !== true
		&& !(meta.conversations[s.sessionId].uno_job_id && meta.conversations[s.sessionId].parent_session_id));
	const projects = Object.values(meta.projects).map((project) => ({
		id: project.id,
		name: project.name,
		created_at: project.created_at,
		conversations: known
			.filter((s) => meta.conversations[s.sessionId]?.project_id === project.id)
			.map((s) => summaryFromSession(s, conversationExt(s.sessionId)))
	}));
	// 本界面创建但未归入任何项目 → 默认项目桶。
	const defaultProject = ensureDefaultProject();
	const byId = projects.find((p) => p.id === defaultProject.id);
	if (byId !== void 0) {
		byId.conversations = [
			...byId.conversations,
			...known
				.filter((s) => meta.conversations[s.sessionId]?.project_id === void 0)
				.map((s) => summaryFromSession(s, conversationExt(s.sessionId)))
		];
	}
	json(res, 200, { projects });
}

/** POST /api/projects {name} → Project */
export async function handleProjectsPost(ctx, req, res, _trustedHosts) {
	const body = await readJsonBody(req);
	const project = createProjectRecord(typeof body.name === "string" ? body.name : void 0);
	json(res, 200, { id: project.id, name: project.name, created_at: project.created_at, conversations: [] });
}

/** One conversation summary row from a session.list item. */
function summaryFromSession(s, ext) {
	return {
		id: s.sessionId,
		title: ext.title ?? s.projections?.values?.title ?? "新会话",
		updated_at: new Date(s.updatedAt).toISOString(),
		...ext.uno_job_id ? { uno_job_id: ext.uno_job_id } : {},
		...ext.pinned ? { pinned: true } : {},
		...ext.task_kind ? { task_kind: ext.task_kind } : {}
	};
}

/** Agent preset composed for every conversation created through this surface. */
export const NEXOGENESIS_AGENT_PRESET = "nexogenesis";

/** POST /api/conversations {project_id} → Conversation */
export async function handleConversationCreate(ctx, req, res, _trustedHosts, projectRoot) {
	const body = await readJsonBody(req);
	if (body.thinking_mode !== undefined && body.thinking_mode !== "quick") throw new HttpError(400, "未知对话方式。");
	const projectId = typeof body.project_id === "string" && body.project_id !== ""
		? body.project_id
		: ensureDefaultProject().id;
	if (readMeta().projects[projectId] === void 0) throw new HttpError(404, "项目不存在");
	const created = await rpcCall(ctx, "session.create", {
		cwd: projectRoot,
		agentPreset: NEXOGENESIS_AGENT_PRESET
	});
	const id = created.sessionId;
	patchConversationExt(id, { project_id: projectId, created_at: new Date().toISOString(), ...(body.thinking_mode === "quick" ? { thinking_mode: "quick" } : {}) });
	const detail = await conversationDetail(ctx, id);
	json(res, 200, detail);
}

/** GET /api/conversations/:id → Conversation */
export async function handleConversationGet(ctx, _req, res, _trustedHosts, id, root) {
	assertOwnedConversation(id);
	json(res, 200, await conversationDetail(ctx, id, root));
}

const DEFAULT_HISTORY_MESSAGES = 30;
const MAX_HISTORY_MESSAGES = 50;

function historyLimit(value) {
	const parsed = Number(value ?? DEFAULT_HISTORY_MESSAGES);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_MESSAGES) {
		throw new HttpError(400, `历史窗口须为 1–${MAX_HISTORY_MESSAGES} 条消息。`);
	}
	return parsed;
}

function optionalSequence(value, name) {
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(400, `${name} 必须是非负整数。`);
	return parsed;
}

function historySequence(entry) {
	const event = entry?.event ?? entry;
	return Number.isInteger(event?.seq) ? event.seq : null;
}

/** A bounded conversation window for fast switching and backwards paging. */
export async function conversationHistoryWindow(ctx, id, root, { beforeSeq, afterSeq, limit = DEFAULT_HISTORY_MESSAGES } = {}) {
	assertOwnedConversation(id);
	if (beforeSeq !== undefined && afterSeq !== undefined) throw new HttpError(400, 'before_seq 与 after_seq 不能同时使用。');
	const ext = conversationExt(id);
	const pageLimit = historyLimit(limit);
	const history = await rpcCall(ctx, "session.history", {
		sessionId: id,
		maxMessages: pageLimit,
		...(beforeSeq !== undefined ? { beforeSeq } : {})
	});
	const entries = history.events ?? [];
	const sequences = entries.map(historySequence).filter(Number.isInteger);
	const rawOldestSeq = sequences.length ? Math.min(...sequences) : null;
	const newestSeq = sequences.length ? Math.max(...sequences) : null;
	const nativeGap = afterSeq !== undefined && history.hasMore === true && rawOldestSeq !== null && afterSeq < rawOldestSeq - 1;
	const selected = afterSeq === undefined || nativeGap
		? entries
		: entries.filter(entry => {
			const seq = historySequence(entry);
			return seq !== null && seq > afterSeq;
		});
	const foldedMessages = foldMessages({ events: selected }, { unoTask: Boolean(ext.uno_job_id), sessionId: id });
	const resetRequired = afterSeq !== undefined && (nativeGap || foldedMessages.length > pageLimit);
	let messages = foldedMessages.slice(-pageLimit);
	const oldestSeq = messages.find(message => Number.isInteger(message.seq))?.seq ?? null;
	const hasOlder = history.hasMore === true || foldedMessages.length > pageLimit;
	const job = root ? unoConversationJob(root, id) : null;
	if (job) {
		const recentSessions = (job.sessions ?? []).filter(sessionId => sessionId !== id).slice(-PIPELINE_RECENT_RUNS);
		const internal = await Promise.all(recentSessions.map(async sessionId => {
			try {
				return foldMessages(await rpcCall(ctx, "session.history", { sessionId, maxMessages: pageLimit }), { unoTask: true, sessionId });
			} catch (error) {
				if (error?.code !== "session-not-found") throw error;
				return [];
			}
		}));
		messages = [...messages,...internal.flat()].sort((a,b)=>String(a.ts??'').localeCompare(String(b.ts??''))||String(a.id??'').localeCompare(String(b.id??''))).slice(-pageLimit);
	}
	const title = ext.title ?? ctx.get?.("sessions")?.get(id)?.projections?.values?.title ?? titleFromHistory(history) ?? "新会话";
	const latestEventTime = entries.map(entry => entry?.time ?? entry?.event?.time).filter(value => value !== undefined).at(-1);
	const latestEventDate = latestEventTime === undefined ? null : new Date(latestEventTime);
	const ownerUpdatedAt = latestEventDate && !Number.isNaN(latestEventDate.getTime()) ? latestEventDate.toISOString() : null;
	const updatedAt = [ownerUpdatedAt, messages.at(-1)?.ts, ext.created_at].filter(Boolean).sort().at(-1) ?? new Date().toISOString();
	return {
		id,
		project_id: ext.project_id ?? ensureDefaultProject().id,
		...(ext.thinking_mode === "quick" ? { thinking_mode: "quick" } : {}),
		...(ext.uno_job_id ? { uno_job_id: ext.uno_job_id } : {}),
		title,
		created_at: ext.created_at ?? new Date().toISOString(),
		updated_at: updatedAt,
		...(ext.pinned ? { pinned: true } : {}),
		...(ext.task_kind ? { task_kind: ext.task_kind } : {}),
		...(ext.pipeline_history ? { pipeline_history: ext.pipeline_history } : {}),
		messages,
		history: { oldest_seq: oldestSeq, newest_seq: newestSeq, has_older: hasOlder, reset_required: resetRequired }
	};
}

/** GET /api/conversations/:id/history → bounded tail, delta, or older page. */
export async function handleConversationHistoryGet(ctx, req, res, _trustedHosts, id, root) {
	const url = new URL(req.url ?? "/", "http://x");
	const beforeSeq = optionalSequence(url.searchParams.get("before_seq"), "before_seq");
	const afterSeq = optionalSequence(url.searchParams.get("after_seq"), "after_seq");
	json(res, 200, await conversationHistoryWindow(ctx, id, root, {
		beforeSeq,
		afterSeq,
		limit: historyLimit(url.searchParams.get("limit"))
	}));
}

/** PATCH /api/conversations/:id {title?, pinned?} → Conversation */
export async function handleConversationPatch(ctx, req, res, _trustedHosts, id) {
	assertOwnedConversation(id);
	const body = await readJsonBody(req);
	if (typeof body.title === "string" && body.title !== "") {
		try {
			await rpcCall(ctx, "session.rename", { sessionId: id, title: body.title });
		} catch (error) {
			if (error?.code !== "session-not-found") throw error;
		}
		patchConversationExt(id, { title: body.title });
	}
	if (typeof body.pinned === "boolean") patchConversationExt(id, { pinned: body.pinned, pin_source: body.pinned ? "user" : null });
	json(res, 200, await conversationDetail(ctx, id));
}

/** DELETE /api/conversations/:id → 204 (DSH has no session removal; soft-delete in meta). */
export async function handleConversationDelete(ctx, _req, res, _trustedHosts, id, root) {
	assertOwnedConversation(id);
	if (isQuickThinkingRunning(id) || isUnoJobRunning(id)) throw new HttpError(409, "请先停止任务，再删除对话。");
	return withConversationAdmission(id, async () => {
		const native=((await rpcCall(ctx,'session.list',{})).items??[]).find(s=>s.sessionId===id);
		const job=root?unoConversationJob(root,id):null,runtime=root?getCognitiveRuntime(root):null,task=runtime?.discussionTask(id)??runtime?.current(id);
		if(native?.running || conversationExt(id).execution_control || conversationExt(id).native_question || runtime?.currentInteraction(id) || listProposalsForSession(id).length || (task&&PIPELINE_STAGES.includes(task.run.mode)&&!['completed','closed'].includes(task.run.status)))throw new HttpError(409,'请先结束原会话的工作或处理待答事项，再删除记录。');
		if(job&&!unoJobEnded(job)){
			if(!isUnoFocusedMaintenanceJob(job))throw new HttpError(409,'请先结束原会话的工作或处理待答事项，再删除记录。');
			endUnoJob(root,job.id);
		}
		softDeleteConversation(id);
		res.writeHead(204);
		res.end();
	});
}

/** Build the full Conversation DTO (history folded into messages). */
async function conversationDetail(ctx, id, root) {
	assertOwnedConversation(id);
	const ext = conversationExt(id);
	const history = await rpcCall(ctx, "session.history", { sessionId: id, maxMessages: 500 });
	const quickEvents = ext.thinking_mode === "quick" ? ctx.get?.("sessions")?.get(id)?.events : null;
	let rawMessages = foldMessages(quickEvents ? { events: quickEvents } : history, {unoTask:Boolean(ext.uno_job_id),sessionId:id});
	const job=root?unoConversationJob(root,id):null;
	if(job){
		const internal=await Promise.all((job.sessions??[]).filter(s=>s!==id).map(async sessionId=>{
			try {return foldMessages(await rpcCall(ctx,'session.history',{sessionId,maxMessages:100}),{unoTask:true,sessionId});}
			catch(error){if(error?.code!=='session-not-found')throw error;return [{role:'system',content:'部分内部执行历史暂不可用；任务进度和成果收据保留。'}];}
		}));
		rawMessages=[...rawMessages,...internal.flat()].sort((a,b)=>String(a.ts??'').localeCompare(String(b.ts??'')));
	}

	const compacted = compactPipelineTranscript(ext, rawMessages);
	if (compacted.changed) patchConversationExt(id, compacted.metaPatch);
	const activeExt = compacted.changed ? { ...ext, ...compacted.metaPatch } : ext;
	const messages = compacted.messages;
	const title = activeExt.title ?? ctx.get?.("sessions")?.get(id)?.projections?.values?.title ?? titleFromHistory(history) ?? "新会话";
	return {
		id,
		project_id: activeExt.project_id ?? ensureDefaultProject().id,
		...(activeExt.thinking_mode === "quick" ? { thinking_mode: "quick" } : {}),
		...(activeExt.uno_job_id ? { uno_job_id: activeExt.uno_job_id } : {}),
		title,
		created_at: ext.created_at ?? new Date().toISOString(),
		updated_at: messages.length > 0
			? (messages[messages.length - 1].ts ?? new Date().toISOString())
			: ext.created_at ?? new Date().toISOString(),
		...activeExt.pinned ? { pinned: true } : {},
		...activeExt.task_kind ? { task_kind: activeExt.task_kind } : {},
		...activeExt.pipeline_history ? { pipeline_history: activeExt.pipeline_history } : {},
		messages
	};
}

export function assertOwnedConversation(id) {
	if (!isNexogenesisConversation(id)) throw new HttpError(404, "会话不存在");
}

/**
 * Keep the user-facing task transcript bounded by task runs. The DSH event
 * log is left untouched as the audit record; this only changes the Web view.
 */
export function compactPipelineTranscript(ext, messages) {
	const stage = ext.task_kind;
	if (!PIPELINE_STAGES.includes(stage)) return { changed: false, messages };
	const { prefix, runs } = splitPipelineRuns(messages, stage);
	if (runs.length <= PIPELINE_RECENT_RUNS) return { changed: false, messages };
	const archivedThrough = String(ext.pipeline_compacted_through ?? "");
	const archived = runs.slice(0, -PIPELINE_RECENT_RUNS);
	const fresh = archived.filter((run) => run.key > archivedThrough);
	const latestKey = archived.at(-1)?.key ?? archivedThrough;
	const visible = prefix.concat(runs.slice(-PIPELINE_RECENT_RUNS).flatMap((run) => run.messages));
	if (fresh.length === 0 && latestKey === archivedThrough) return { changed: false, messages: visible };
	const history = normalizePipelineHistory(ext.pipeline_history);
	for (const record of fresh.map((run) => pipelineRunRecord(stage, run.messages)).reverse()) {
		history.archived_runs += 1;
		history.completed_runs += record.status === "completed" ? 1 : 0;
		history.failed_runs += record.status === "failed" ? 1 : 0;
		history.paused_runs += record.status === "paused" ? 1 : 0;
		history.buffers += record.buffers;
		history.cards_created += record.cards_created;
		history.cards_enriched += record.cards_enriched;
		history.cards_adjusted += record.cards_adjusted;
		history.recent.unshift(record);
	}
	history.recent = history.recent.slice(0, PIPELINE_HISTORY_PREVIEWS);
	return {
		changed: true, messages: visible,
		metaPatch: { pipeline_compacted_through: latestKey, pipeline_history: history }
	};
}

function splitPipelineRuns(messages, stage) {
	const prefix = [];
	const runs = [];
	let current = null;
	for (const message of messages) {
		const normalized = message.content.trim().toLowerCase();
		const startsRun = normalized === `/${stage}` || (stage === "theme_compile" && ["/主题编译", "/theme-compile"].includes(normalized));
		if (message.role === "user" && startsRun) {
			if (current !== null) runs.push(current);
			current = [message];
		} else if (current !== null) current.push(message);
		else prefix.push(message);
	}
	if (current !== null) runs.push(current);
	return {
		prefix,
		runs: runs.map((run, index) => ({ messages: run, key: `${String(run[0]?.ts ?? "")}:${String(index).padStart(4, "0")}` }))
	};
}

function normalizePipelineHistory(value) {
	const n = (key) => Number.isFinite(value?.[key]) ? value[key] : 0;
	return {
		archived_runs: n("archived_runs"), completed_runs: n("completed_runs"), failed_runs: n("failed_runs"), paused_runs: n("paused_runs"),
		buffers: n("buffers"), cards_created: n("cards_created"), cards_enriched: n("cards_enriched"), cards_adjusted: n("cards_adjusted"),
		recent: Array.isArray(value?.recent) ? value.recent : []
	};
}

function pipelineRunRecord(stage, messages) {
	const content = messages.map((message) => message.content).join("\n");
	const failed = /任务未完成|失败|错误|受阻/.test(content);
	const paused = !failed && /暂停|待继续|等待你的判断/.test(content);
	return {
		stage, ts: String(messages.at(-1)?.ts ?? new Date().toISOString()), status: failed ? "failed" : paused ? "paused" : "completed",
		summary: plainExcerpt(content),
		buffers: metric(content, [/写入\s*(\d+)\s*个\s*Buffer/i, /处理\s*(\d+)\s*片\s*Buffer/i]),
		cards_created: metric(content, [/新建\s*(\d+)\s*(?:张)?卡片/i, /创建\s*(\d+)\s*(?:张)?卡片/i]),
		cards_enriched: metric(content, [/丰富\s*(\d+)\s*(?:张)?卡片/i, /enrich(?:ed)?\s*(\d+)/i]),
		cards_adjusted: metric(content, [/调整\s*(\d+)\s*(?:个)?节点/i, /提交\s*(\d+)\s*个原子事务/i])
	};
}

function metric(content, patterns) {
	for (const pattern of patterns) {
		const match = pattern.exec(content);
		if (match) return Number(match[1]) || 0;
	}
	return 0;
}

function plainExcerpt(content) {
	const text = content.replace(/\s+/g, " ").trim();
	return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export { HttpError };
