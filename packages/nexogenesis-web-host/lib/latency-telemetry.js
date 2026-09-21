import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { knowledgeSnapshotStats } from "../../nexogenesis-tools/lib/cards.js";

function elapsed(startedAt, now = Date.now()) {
	return Math.max(0, now - startedAt);
}

function routeOf(toolNames, analytical) {
	if (analytical) return "analytical";
	return toolNames.some((name) => ["retrieve", "graph_search", "read_card", "read_cards"].includes(name))
		? "grounded_quick" : "direct";
}

/** Collect timing only; prompts, answers and card bodies are deliberately excluded. */
export function createChatLatencyTrace(projectRoot, { pipeline = false } = {}) {
	const startedAt = Date.now();
	const before = knowledgeSnapshotStats(projectRoot);
	const toolNames = [];
	const toolStarts = new Map();
	const toolDurations = [];
	const modelSteps = new Map();
	let toolResultCharacters = 0;
	const stepKey = (data) => `${data?.turn}:${data?.step}`;
	const stepOf = (data) => modelSteps.get(stepKey(data));
	let retrievalCalls = 0;
	let retrievalIntentCalls = 0;
	let firstEventMs = null;
	let firstTextMs = null;
	let selected = null;
	let written = false;
	const touch = () => { if (firstEventMs === null) firstEventMs = elapsed(startedAt); };
	return {
		stepStarted(data) {
			if (modelSteps.size < 1024) modelSteps.set(stepKey(data), { started_at_ms: elapsed(startedAt), duration_ms: null, first_chunk_ms: null, ...(data.phase ? { phase: data.phase } : {}) });
		},
		modelChunk(data) {
			const step = stepOf(data);
			if (step && step.first_chunk_ms === null) step.first_chunk_ms = elapsed(startedAt) - step.started_at_ms;
		},
		modelMessage(data) {
			const step = stepOf(data);
			if (!step) return;
			step.usage = Object.fromEntries(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
				.filter((key) => Number.isFinite(data?.usage?.[key])).map((key) => [key, data.usage[key]]));
		},
		stepFinished(data) {
			const step = stepOf(data);
			if (step) step.duration_ms = elapsed(startedAt) - step.started_at_ms;
		},
		selectModel(value) { selected = value ? { provider: value.provider, model: value.model } : null; },
		text(value) {
			if (!value) return;
			touch();
			if (firstTextMs === null) firstTextMs = elapsed(startedAt);
		},
		toolStarted(call) {
			touch();
			toolNames.push(String(call.name));
			if (["retrieve", "graph_search"].includes(String(call.name))) {
				retrievalCalls++;
				const intent = call?.args?.intent;
				if (intent && typeof intent === "object" && Object.values(intent).some((value) => Array.isArray(value) && value.length)) retrievalIntentCalls++;
			}
			toolStarts.set(call.id, { name: String(call.name), at: Date.now() });
		},
		toolFinished(call, message) {
			touch();
			const pending = toolStarts.get(call.id);
			if (!pending) return;
			toolStarts.delete(call.id);
			toolDurations.push({ name: pending.name, duration_ms: elapsed(pending.at) });
			if (message?.content) toolResultCharacters += JSON.stringify(message.content).length;
		},
		finish({ status = "completed", analytical = false, route, thinkingRoute } = {}) {
			if (written) return;
			written = true;
			const after = knowledgeSnapshotStats(projectRoot);
			const record = {
				at: new Date().toISOString(), kind: pipeline ? "pipeline" : "chat", status,
				route: route ?? (pipeline ? "pipeline" : routeOf(toolNames, analytical)),
				...(thinkingRoute ? { thinking_route: thinkingRoute } : {}),
				provider: selected?.provider ?? null, model: selected?.model ?? null,
				total_ms: elapsed(startedAt), first_event_ms: firstEventMs, first_text_ms: firstTextMs,
				tool_count: toolNames.length, tools: toolDurations,
				model_steps: [...modelSteps.values()], tool_result_characters: toolResultCharacters,
				timing_boundary: "step duration includes tools; first chunk includes network/provider/model wait, not pure network latency",
				retrieval: { calls: retrievalCalls, intent_calls: retrievalIntentCalls },
				cache: {
					hits: after.hits - before.hits,
					misses: after.misses - before.misses,
					scans: after.scans - before.scans
				}
			};
			const dir = join(projectRoot, ".nexogenesis", "telemetry");
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "chat-latency.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
		}
	};
}
