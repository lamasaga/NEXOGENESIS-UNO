import { isAnalyticalRun } from "../../nexogenesis-tools/lib/cognition/general-analysis.js";
import { isConversationAnalysis } from "../../nexogenesis-tools/lib/cognition/conversation-analysis.js";
const PIPELINE_LABELS = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" };
/** Normalize a turn/end reason (string or {kind, error}) into {kind, detail}. */
export function reasonOf(raw) {
	if (typeof raw === "string") {
		return raw === "completed" || raw === "complete"
			? { kind: "completed", detail: "turn 完成" }
			: { kind: raw, detail: `turn 结束：${raw}` };
	}
	if (raw === null || typeof raw !== "object") return { kind: "unknown", detail: "turn 结束" };
	const kind = raw.kind ?? "unknown";
	if (kind === "completed") return { kind, detail: "turn 完成" };
	const message = raw.error?.message ?? raw.message ?? raw.code ?? kind;
	return { kind, detail: `turn 结束：${message}` };
}

/** Ensure one user turn cannot leak an unfinished general run into the next question. */
export function settlePipelineRunAtTurnBoundary(runtime, sessionId, { kind, detail = "" }) {
	const state = runtime.current(sessionId);
	if (!state || !Object.hasOwn(PIPELINE_LABELS, state.run.mode) || state.run.status !== "running" || kind === "completed") return state?.run ?? null;
	const cancelled = ["interrupted", "cancelled", "canceled"].includes(kind);
	runtime.record(state.run.run_id, { action: { operator: "model_turn_end", mode: "runtime-write" }, observation: {
		status: cancelled ? "partial" : "error", reason_code: cancelled ? "model_turn_interrupted" : "model_turn_failed",
		summary: detail || "模型回合异常结束；已提交内容保留，尚未完成复核。"
	} });
	return runtime.setStatus(state.run.run_id, cancelled ? "cancelled" : "failed", detail || "模型回合未正常完成；已提交内容保留。");
}

/** Ensure one user turn cannot leak an unfinished general run into the next question. */
export function settleGeneralRunAtTurnBoundary(runtime, sessionId, { phase = "end", kind = "completed", detail = "" } = {}) {
	const state = runtime.current(sessionId);
	if (!["general", "assess", "report"].includes(state?.run?.mode) || state.run.status !== "running") return state?.run ?? null;
	const iterative = isAnalyticalRun(state);
	if (isConversationAnalysis(state)) {
		// Delivery is reconciled separately from persisted history; never claim it here.
		if (phase === "start") return runtime.setStatus(state.run.run_id, "failed", "上一轮已停止执行，但未取得正常结束记录；交付待核对，旧预算不复用。");
		return state.run;
	}
	if (!iterative && kind === "completed") {
		return runtime.setStatus(state.run.run_id, "completed", "本轮轻量检索已随回答结束。");
	}
	if (phase === "start") {
		return runtime.setStatus(state.run.run_id, "blocked", "新的用户问题开始前，上一轮普通问答仍未通过完成门；已隔离该运行。");
	}
	if (kind === "completed") {
		return runtime.setStatus(state.run.run_id, "blocked", "回答已经结束，但本轮没有通过基准思考完成门；该运行不会被下一问题复用。");
	}
	const cancelled = ["interrupted", "cancelled", "canceled"].includes(kind);
	return runtime.setStatus(state.run.run_id, cancelled ? "cancelled" : "failed", detail || "模型回合异常结束，分析运行已关闭。");
}
