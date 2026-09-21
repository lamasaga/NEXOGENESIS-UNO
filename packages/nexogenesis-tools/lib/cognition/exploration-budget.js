import { readingEntries } from "./reading-coverage.js";
import { observationSatisfiesCapability } from "./thinking-models.js";

export const DISCOVERY_OPERATORS = new Set(["retrieve", "graph_search", "graph_walk", "graph_path", "graph_analogize", "trace_support_to_tension", "probe_assumption_inversion"]);
const AUDITS = new Set(["inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency"]);
const list = (value) => Array.isArray(value) ? value : [];

/** Reserve capacity to consume discoveries. No automatic tool dispatch or budget increase. */
export function explorationBudget(state) {
	const workspace = state.workspace ?? {};
	const applicable = ["general", "assess", "report"].includes(state.run?.mode) && workspace.scope?.analysis_depth === "iterative" && workspace.scope?.complexity_level === "deep";
	const all = state.episode?.steps ?? [];
	const steps = all.filter((step) => observationSatisfiesCapability(step.observation));
	const remainingReads = Math.max(0, Number(workspace.budget?.max_reads ?? 24) - all.filter((step) => step.action?.mode === "read" && !AUDITS.has(step.action?.operator)).length);
	const remainingSteps = Math.max(0, Number(workspace.budget?.max_steps ?? 48) - all.length);
	const seen = new Set(), read = new Set(), rounds = [];
	for (const step of steps) {
		for (const entry of readingEntries(step)) {
			if (entry.reading?.coverage === "full" || entry.reading?.unit_addresses?.length) read.add(entry.card_id);
			seen.add(entry.card_id);
		}
		if (!DISCOVERY_OPERATORS.has(step.action?.operator)) continue;
		const data = step.observation?.data ?? {};
		const ids = [...new Set([
			...list(data.nodes).map((node) => node.id), ...list(data.results).map((item) => item.card_id),
			...list(data.candidate_ids), ...list(data.tension?.opponent_ids), ...list(data.tension?.conflict_card_ids),
			...list(data.paths).flatMap((path) => list(path.node_ids))
		].filter(Boolean))];
		const fresh = ids.filter((id) => !seen.has(id));
		ids.forEach((id) => seen.add(id));
		rounds.push({ step: step.step, operator: step.action.operator, new_candidate_count: fresh.length });
	}
	const walks = steps.filter((step) => step.action?.operator === "graph_walk" && step.observation.data?.layers);
	const lastWalk = walks.at(-1);
	const data = lastWalk?.observation?.data ?? {};
	const frontier = list(data.nodes).filter((node) => node.edge?.ready && node.id !== data.start)
		.sort((a, b) => Number(b.hop ?? 0) - Number(a.hop ?? 0) || Number(b.discovery_score ?? 0) - Number(a.discovery_score ?? 0))
		.slice(0, 4).map((node) => ({ card_id: node.id, hop: node.hop, read: read.has(node.id),
			path: node.path, next_action: read.has(node.id) ? "graph_walk" : "read_card",
			suggested_args: read.has(node.id) ? { card_id: node.id, hops: 2, limit: 12, plane: data.plane ?? "argument", focus_query: String(data.focus_query || workspace.goal || "").slice(0, 600) } : { id: node.id } }));
	const questions = list(workspace.open_questions).filter((item) => typeof item === "string" || !["resolved", "closed"].includes(item?.status))
		.map((item) => typeof item === "string" ? item : item?.question ?? item?.description).filter(Boolean);
	const pendingClaims = list(workspace.hypotheses).filter((item) => item?.status === "unresolved").map((item) => item.statement).filter(Boolean);
	const gaps = [...new Set([...questions, ...pendingClaims])].slice(0, 3).map((value) => String(value).slice(0, 300));
	const recent = rounds.slice(-2);
	const readSinceLastDiscovery = steps.some((step) => step.step > (rounds.at(-1)?.step ?? Infinity) && readingEntries(step).some((entry) => entry.reading?.coverage === "full" || entry.reading?.unit_addresses?.length));
	const stagnant = recent.length === 2 && recent.every((round) => round.new_candidate_count === 0) && !readSinceLastDiscovery;
	const unreadCandidates = [...seen].filter((id) => !read.has(id)).length;
	const reserveReads = Math.min(4, Math.max(2, unreadCandidates));
	const reserveSteps = reserveReads + 2;
	const discoveryAvailable = Math.max(0, Math.min(remainingReads - reserveReads, remainingSteps - reserveSteps));
	if (!discoveryAvailable || stagnant) for (const item of frontier) {
		if (!item.read) continue;
		item.next_action = "inspect_argument";
		item.suggested_args = { card_id: item.card_id };
	}
	return {
		applicable, remaining_reads: remainingReads, remaining_steps: remainingSteps,
		unread_candidate_count: unreadCandidates,
		reserved_read_calls: Math.min(reserveReads, remainingReads), reserved_steps: Math.min(reserveSteps, remainingSteps),
		discovery_calls_available: discoveryAvailable,
		phase: !discoveryAvailable ? "read_and_close" : stagnant ? "change_branch_or_read" : gaps.length ? "gap_directed_exploration" : "bounded_exploration",
		gaps, recent_discovery: recent, frontier,
		deferred_branches: [...new Map(walks.slice(-3).flatMap((step) => list(step.observation.data?.deferred_frontier))
			.filter((item) => !seen.has(item.card_id)).map((item) => [item.card_id, item])).values()].slice(0, 4),
		note: "新节点只是发现信号，不代表解释有效。缺口仍重要时，可补读桥接节点再继续 1–3 跳；累计路径可超过三跳，不提高单次或整轮硬上限。连续无新增应换分支、反转前提或阅读，不机械加深。"
	};
}
