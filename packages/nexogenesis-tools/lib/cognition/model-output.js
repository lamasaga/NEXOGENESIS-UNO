import { isDeepStrictEqual } from "node:util";

/** A model-facing projection only. Durable observations and UI metadata stay intact. */
export function modelOutput(value, { memory = "brief", full = false } = {}) {
	const result = structuredClone(value);
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	if (full) return result;
	// Graph tools return both their data and the same data inside an Observation.
	if (result.observation?.data) {
		const duplicates = [];
		for (const [key, item] of Object.entries(result.observation.data)) {
			if (Object.hasOwn(result, key) && isDeepStrictEqual(result[key], item)) {
				delete result.observation.data[key]; duplicates.push(key);
			}
		}
		if (duplicates.length) result.observation.data_fields_at_top_level = duplicates;
	}
	for (const container of [result, result.data]) {
		if (!container?.working_memory) continue;
		if (memory === "brief" && container.working_memory.version === "1.0") {
			const wm = container.working_memory;
			// Do not repeat evidence excerpts/claim text on every bookkeeping call.
			container.working_memory = Object.fromEntries(Object.entries(wm).filter(([key]) =>
				["version", "run_id", "goal", "next_actions", "open_questions", "pending", "exploration_budget", "evidence_cautions", "truncated"].includes(key)));
			container.working_memory.view = "brief";
			container.working_memory.detail_available = "inspect_cognitive_workspace(view=memory); finish returns full working_memory";
		}
		if (container.workspace && result.delta) {
			// The caller just supplied the patch; delta acknowledges changes, not a new ledger copy.
			container.workspace = { budget: container.workspace.budget, stop_reason: container.workspace.stop_reason };
			container.workspace_view = "budget_and_stop_only; changes in delta; full view available via inspect_cognitive_workspace(view=full)";
		}
	}
	if (result.recent_steps) {
		result.recent_steps = result.recent_steps.map((step) => ({ step: step.step, action: step.action,
			observation: { status: step.observation?.status, summary: step.observation?.summary, reason_code: step.observation?.reason_code, next_actions: step.observation?.next_actions } }));
		if (result.workspace) {
			result.workspace = Object.fromEntries(Object.entries(result.workspace).filter(([key]) => ["goal", "scope", "budget", "stop_reason", "open_questions", "deferred_items", "user_directives"].includes(key)));
			result.workspace_view = "brief; use view=memory for synthesis or view=full for complete state";
		}
	}
	if (result.episode) {
		result.episode = { run_id: result.episode.run_id, step_count: result.episode.steps?.length ?? 0 };
		result.episode_view = "summary; full audit remains in run storage";
		if (result.workspace) {
			result.workspace = Object.fromEntries(Object.entries(result.workspace).filter(([key]) => ["goal", "scope", "budget", "stop_reason", "open_questions", "deferred_items", "user_directives"].includes(key)));
			result.workspace_view = "startup_summary; inspect_cognitive_workspace(view=memory) restores current task memory";
		}
	}
	return result;
}

export function renderModelOutput(args, value) {
	const finished = Boolean(value?.run?.finished_at) || value?.run?.delivery?.state === "prepared" || value?.observation?.operator === "finish_cognitive_run";
	return [{ type: "text", text: JSON.stringify(modelOutput(value, {
		full: args?.view === "full", memory: finished || args?.view === "memory" ? "full" : "brief"
	})) }];
}
