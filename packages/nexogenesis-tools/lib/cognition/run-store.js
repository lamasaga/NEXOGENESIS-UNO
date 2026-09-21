import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { observationSatisfiesCapability } from "./thinking-models.js";
import { allocateGeneralAnalysisBudget, isAnalyticalRun } from "./general-analysis.js";
import { explorationBudget, DISCOVERY_OPERATORS } from "./exploration-budget.js";
import { isConversationAnalysis, isStrictAnalysis } from "./conversation-analysis.js";

const retiredModes=new Set(['compile','theme_compile','digest']);
function assertExecutableMode(mode){
  if(retiredModes.has(mode))throw new Error('旧编译已退役，历史任务只读；请使用新版图书编译入口。');
}

export const COGNITIVE_RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertCognitiveRunId(runId) {
	if (typeof runId !== "string" || !COGNITIVE_RUN_ID_RE.test(runId)) throw new Error("CognitiveRun id 格式非法");
	return runId;
}

const WORKSPACE_KEYS = new Set([
	"goal", "scope", "user_directives", "hypotheses", "evidence", "counter_evidence",
	"open_questions", "conflicts", "candidate_actions", "observed_nodes", "deferred_items",
	"budget", "stop_reason", "read_revisions", "extension"
]);

const EXTENSION_FIELDS = {
	construct: new Set([
		"focus", "simulations", "structural_debts", "affected_scope", "write_proposals",
		"post_write_checks", "focus_issue", "review_records", "issue_ledger", "relation_cases",
		"relation_adjudications", "checkpoint", "result", "improvement_plan", "improvement_history", "recovery_review"
	]),
	assess: new Set(["lenses", "comparisons", "checkpoint", "result", "insight_reviews", "challenge_reviews"]),
	report: new Set(["audience", "outline", "citations", "checkpoint", "result", "insight_reviews", "challenge_reviews"]),
	general: new Set(["checkpoint", "result", "insight_reviews", "challenge_reviews"])
};

const MISPLACED_HINTS = {
	checkpoint: "extension.checkpoint",
	next_candidate: "candidate_actions",
	deferred: "deferred_items"
};

export class WorkspaceContractError extends Error {
	constructor(field, { mode, allowed, hint } = {}) {
		super(hint ? `Workspace 字段位置不合法: ${field}；请改用 ${hint}` : `Workspace 字段不允许修改: ${field}`);
		this.name = "WorkspaceContractError";
		this.field = field;
		this.mode = mode;
		this.allowed = allowed ?? [];
		this.hint = hint ?? null;
	}
}

export function workspaceContract(mode) {
	if(retiredModes.has(mode))return {contract_version:"history-readonly-v1",mode,read_only:true,core_fields:[],extension_fields:[],placement_examples:{}};
	return {
		contract_version: "1.0",
		mode,
		core_fields: [...WORKSPACE_KEYS].filter((key) => key !== "extension"),
		extension_fields: [...(EXTENSION_FIELDS[mode] ?? EXTENSION_FIELDS.general)],
		placement_examples: {}
	};
}

function readJson(path, fallback) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function atomicJson(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	const staging = `${path}.staging-${process.pid}-${Date.now()}`;
	writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
	renameSync(staging, path);
}

function sessionIdOf(exec) {
	return exec?.agent?.session?.id ?? exec?.session?.id;
}

function now() { return new Date().toISOString(); }

function baseWorkspace(goal, scope, budget, extension) {
	return {
		workspace_version: "1.0",
		goal,
		scope: scope ?? {},
		user_directives: [], hypotheses: [], evidence: [], counter_evidence: [],
		open_questions: [], conflicts: [], candidate_actions: [], observed_nodes: [],
		deferred_items: [], budget: budget ?? { max_steps: 24, max_reads: 12, max_writes: 3 },
		stop_reason: null, read_revisions: {}, extension: extension ?? {}
	};
}

function summarizeWorkspace(workspace) {
	const extension = { ...workspace.extension };
	if (extension.improvement_plan) {
		const p = extension.improvement_plan;
		extension.improvement_plan = { id: p.id, status: p.status, kind: p.kind, problem: p.problem, benefit: p.benefit,
			card_ids: p.card_ids, target_ids: p.target_ids, retire_ids: p.retire_ids, probe_count: p.probes?.length,
			review_errors: p.review?.errors?.slice(0, 4), detail_hint: "保留映射与检索基线见本轮 working_memory；完整计划由运行态保存。" };
	}
	for (const key of ["relation_cases", "relation_adjudications", "post_write_checks", "review_records", "issue_ledger", "improvement_history"]) {
		if (!Array.isArray(extension[key])) continue;
		const values = extension[key];
		extension[`${key}_count`] = values.length;
		extension[key] = values.slice(-6).map((item) => key === "relation_adjudications"
			? { decision: item.decision, proposed_relation: item.proposed_relation, preflight_passed: item.preflight_passed, recorded_at_step: item.recorded_at_step }
			: item);
	}
	if (extension.source_coverage) {
		const entries = Object.entries(extension.source_coverage);
		extension.source_coverage_omitted = Math.max(0, entries.length - 8);
		extension.source_coverage = Object.fromEntries(entries.slice(-8).map(([source, { dispositions, ...audit }]) => [source, { ...audit, missing: audit.missing?.slice(0, 3), deferred: audit.deferred?.slice(0, 2), truncated: audit.truncated || audit.missing?.length > 3 || audit.deferred?.length > 2 }]));
	}
	if (extension.source_reads) {
		const entries = Object.entries(extension.source_reads);
		extension.source_reads_omitted = Math.max(0, entries.length - 8);
		extension.source_reads = Object.fromEntries(entries.slice(-8).map(([source, value]) => [source, { fingerprint: value.fingerprint, range_count: value.ranges.length, recent_ranges: value.ranges.slice(-4) }]));
	}
	if (extension.source_inventory?.items) extension.source_inventory = { ...extension.source_inventory, items: extension.source_inventory.items.slice(0, 4), items_omitted: Math.max(0, extension.source_inventory.items.length - 4) };
	if (extension.quality_audit) {
		const audit = extension.quality_audit;
		extension.quality_audit = { status: audit.status, fingerprint: audit.fingerprint, sources: audit.sources, chapter_sources: audit.chapter_sources, generated_cards: audit.generated_cards, caution_count: audit.cautions?.length ?? 0, cautions: audit.cautions?.slice(0, 4), detail_hint: "历史验收记录摘要；旧编译不可恢复。" };
	}
	for (const key of ["buffer_scope", "chapter_sources", "generated_buffers", "generated_cards", "artifact_registry", "knowledge_objects"]) {
		if (Array.isArray(extension[key]) && extension[key].length > 16) {
			extension[`${key}_omitted`] = extension[key].length - 16;
			extension[key] = extension[key].slice(-16);
		}
	}
	return {
		goal: workspace.goal,
		scope: workspace.scope,
		hypotheses: workspace.hypotheses.slice(-5),
		evidence_count: workspace.evidence.length,
		observed_node_count: workspace.observed_nodes.length,
		counter_evidence_count: workspace.counter_evidence.length,
		open_questions: workspace.open_questions.slice(-5),
		conflicts: workspace.conflicts.slice(-5),
		candidate_actions: workspace.candidate_actions.slice(-5),
		deferred_items: workspace.deferred_items.slice(-5),
		budget: workspace.budget,
		stop_reason: workspace.stop_reason,
		extension
	};
}

function appendByKey(items, additions, keyOf, limit = 80) {
	const merged = [...(Array.isArray(items) ? items : [])];
	const keys = new Set(merged.map(keyOf));
	for (const item of additions) {
		const key = keyOf(item);
		if (!key || keys.has(key)) continue;
		keys.add(key);
		merged.push(item);
	}
	return merged.slice(-limit);
}

function successfulKnowledgeWrite(step) {
	return ["write", "proposal"].includes(step?.action?.mode)
		&& step?.observation?.status === "ok"
		&& ["committed", "contributions_skipped"].includes(step?.observation?.reason_code);
}

/** Project observable construct facts into Workspace; never stores hidden reasoning. */
function projectConstructObservation(state, step) {
	if (state.run.mode !== "construct") return false;
	state.workspace.extension ??= {};
	const observation = step.observation ?? {};
	const isObservation = ["read", "simulate"].includes(step.action?.mode)
		&& observationSatisfiesCapability(observation);
	let changed = false;
	if (isObservation) {
		const ids = [...new Set([
			...(observation.evidence ?? []).map((item) => item?.card_id),
			...(observation.data?.nodes ?? []).map((item) => item?.id),
			...(observation.data?.issues ?? []).flatMap((item) => [item?.card_id, item?.target_id]),
			...(observation.data?.checked_card_ids ?? []), observation.data?.focus_card_id
		].filter(Boolean))];
		const observedNodes = ids.map((card_id) => ({
			card_id, operator: step.action?.operator, observed_at: step.at, status: observation.status
		}));
		state.workspace.observed_nodes = appendByKey(
			state.workspace.observed_nodes, observedNodes,
			(item) => `${item.card_id}|${item.operator}`, 120
		);
		state.workspace.evidence = appendByKey(state.workspace.evidence, [{
			id: observation.data_digest ?? `step-${step.step}`,
			operator: step.action?.operator,
			summary: observation.summary,
			card_ids: ids,
			observed_at: step.at
		}], (item) => String(item?.id ?? ""), 80);
		if (step.action?.operator === "inspect_structure_issues") {
			state.workspace.extension.checkpoint = {
				kind: "structure_issues",
				cursor: observation.data?.cursor ?? null,
				next_cursor: observation.data?.next_cursor ?? null,
				issue_total: Number(observation.data?.issue_total ?? 0),
				totals: observation.data?.totals ?? {},
				updated_at: step.at
			};
			const currentIssues = Array.isArray(observation.data?.issues) ? observation.data.issues : [];
			const priorLedger = Array.isArray(state.workspace.extension.issue_ledger)
				? state.workspace.extension.issue_ledger : [];
			const priorByFingerprint = new Map(priorLedger.map((item) => [item.fingerprint, item]));
			const currentFingerprints = new Set(observation.data?.unresolved_fingerprints ?? currentIssues.map((item) => item.fingerprint).filter(Boolean));
			const checkedKinds = new Set(observation.data?.checked_kinds ?? []);
			const checked = new Set(observation.data?.checked_card_ids ?? []);
			const priorKnowledgeWrite = state.episode.steps.slice(0, -1).reverse().find(successfulKnowledgeWrite);
			const affectedByWrite = new Set(priorKnowledgeWrite?.observation?.scope?.card_ids ?? []);
			const nextLedger = priorLedger.map((item) => {
				const inCheckedScope = checked.size && (checked.has(item.card_id) || checked.has(item.target_id)
					|| item.member_ids?.some((id) => checked.has(id))) && (!checkedKinds.size || checkedKinds.has(item.kind))
					&& (Array.isArray(observation.data?.unresolved_fingerprints) || !observation.data?.next_cursor);
				if (inCheckedScope && !currentFingerprints.has(item.fingerprint)) return {
					...item, status: "fixed", closed_at_step: step.step, last_checked_at_step: step.step
				};
				return item;
			});
			const nextByFingerprint = new Map(nextLedger.map((item) => [item.fingerprint, item]));
			for (const issue of currentIssues) {
				if (!issue.fingerprint) continue;
				const prior = priorByFingerprint.get(issue.fingerprint);
				const reopened = Boolean(prior && ["fixed", "excluded", "kept"].includes(prior.status));
				nextByFingerprint.set(issue.fingerprint, {
					...prior, ...issue,
					status: reopened ? "open" : prior?.status ?? "open",
					discovered_at_step: prior?.discovered_at_step ?? step.step,
					last_checked_at_step: step.step,
					reopened: Boolean(prior?.reopened || reopened),
					new_after_write: Boolean(prior?.new_after_write || (!prior && affectedByWrite.size
						&& (affectedByWrite.has(issue.card_id) || affectedByWrite.has(issue.target_id))))
				});
			}
			state.workspace.extension.issue_ledger = [...nextByFingerprint.values()].slice(-240);
			if (currentIssues.length === 1 || (checked.size && currentIssues.length)) {
				const issue = currentIssues[0];
				state.workspace.extension.focus_issue = {
					issue_id: issue.fingerprint, detector: "inspect_structure_issues", issue_kind: issue.kind,
					card_id: issue.card_id, target_id: issue.target_id, relation_type: issue.relation_type,
					discovered_at_step: priorByFingerprint.get(issue.fingerprint)?.discovered_at_step ?? step.step,
					last_checked_at_step: step.step, resolved: false
				};
			}
		}
		if (step.action?.operator === "inspect_unconnected_cards") {
			const checkedIds = observation.data?.checked_card_ids ?? [];
			const resolvedIds = observation.data?.resolved_card_ids ?? [];
			state.workspace.extension.issue_ledger = (state.workspace.extension.issue_ledger ?? []).map((item) => {
				if (item.detector !== "inspect_unconnected_cards" || item.kind !== observation.data?.scope || !checkedIds.includes(item.card_id)) return item;
				return { ...item, status: resolvedIds.includes(item.card_id) ? "fixed" : "open", last_checked_at_step: step.step,
					reopened: Boolean(item.reopened || (item.status === "fixed" && !resolvedIds.includes(item.card_id))) };
			});
			state.workspace.extension.checkpoint = {
				kind: "unconnected_cards",
				scope: observation.data?.scope,
				cursor: Number(observation.data?.cursor ?? 0),
				next_cursor: observation.data?.next_cursor ?? null,
				candidate_total: Number(observation.data?.candidate_total ?? 0),
				reviewed_excluded_total: Number(observation.data?.reviewed_excluded_total ?? 0),
				updated_at: step.at
			};
			if ((observation.data?.checked_card_ids ?? []).length === 1) {
				const cardId = observation.data.checked_card_ids[0];
				const priorFocus = state.workspace.extension.focus_issue;
				state.workspace.extension.focus_issue = {
					issue_id: `unconnected:${observation.data.scope}:${cardId}`,
					detector: "inspect_unconnected_cards", issue_kind: observation.data.scope,
					card_id: cardId,
					discovered_at_step: priorFocus?.card_id === cardId && priorFocus?.issue_kind === observation.data.scope
						? priorFocus.discovered_at_step : step.step,
					last_checked_at_step: step.step,
					resolved: (observation.data?.resolved_card_ids ?? []).includes(cardId)
				};
			}
		}
		if (step.action?.operator === "inspect_integration_candidates" && observation.data?.focus_card_id) {
			const cardId = observation.data.focus_card_id;
			const issueKind = observation.data.issue_scope ?? state.workspace.extension.checkpoint?.scope ?? "without_relations";
			const fingerprint = `unconnected:${issueKind}:${cardId}`;
			const ledger = state.workspace.extension.issue_ledger ?? [];
			const prior = ledger.find((item) => item.fingerprint === fingerprint);
			state.workspace.extension.issue_ledger = appendByKey(ledger, [{ ...prior, fingerprint,
				card_id: cardId, kind: issueKind, detector: "inspect_unconnected_cards", status: "open",
				discovered_at_step: prior?.discovered_at_step ?? step.step, last_checked_at_step: step.step,
				reopened: Boolean(prior?.reopened || prior?.status === "fixed") }], (item) => item.fingerprint, 240);
			state.workspace.extension.focus_issue = {
				issue_id: `unconnected:${issueKind}:${cardId}`,
				detector: "inspect_unconnected_cards", issue_kind: issueKind, card_id: cardId,
				card_fingerprint: observation.data.focus_fingerprint,
				discovered_at_step: step.step, last_checked_at_step: step.step, resolved: false
			};
		}
		if (step.action?.operator === "inspect_relation_case" && observation.data?.case_fingerprint) {
			state.workspace.extension.relation_cases = appendByKey(
				state.workspace.extension.relation_cases,
				[{ case_fingerprint: observation.data.case_fingerprint,
					source_id: observation.data.source_id, target_id: observation.data.target_id,
					observed_at_step: step.step, observed_at: step.at }],
				(item) => String(item.case_fingerprint ?? ""), 30
			);
		}
		if (step.action?.operator === "simulate_relation_patch" && observation.data?.adjudication) {
			const adjudication = {
				...observation.data.adjudication,
				case_fingerprint: observation.data.case_fingerprint,
				preflight_passed: Boolean(observation.data.preflight_passed),
				requires_critical_review: Boolean(observation.data.requires_critical_review),
				critical_review_completed: Boolean(observation.data.critical_review_completed),
				recorded_at_step: step.step, recorded_at: step.at
			};
			state.workspace.extension.relation_adjudications = appendByKey(
				state.workspace.extension.relation_adjudications, [adjudication],
				(item) => `${item.case_fingerprint}|${item.decision}|${item.recorded_at_step}`, 60
			);
			const issueFingerprint = adjudication.issue_fingerprint;
			if (issueFingerprint) state.workspace.extension.issue_ledger = (state.workspace.extension.issue_ledger ?? []).map((item) =>
				item.fingerprint === issueFingerprint ? {
					...item,
					status: adjudication.decision === "defer" ? "deferred"
						: adjudication.decision === "keep" ? "excluded" : "pending_verification",
					decision: adjudication.decision,
					adjudicated_at_step: step.step
				} : item);
		}
		changed = true;

		const priorWrite = state.episode.steps.slice(0, -1).reverse().find(successfulKnowledgeWrite);
		if (priorWrite) {
			state.workspace.extension.post_write_checks = appendByKey(
				state.workspace.extension.post_write_checks,
				[{ id: observation.data_digest ?? `step-${step.step}`, operator: step.action?.operator,
					summary: observation.summary, checked_at: step.at,
					after_step: priorWrite.step, card_ids: ids,
					issue_kind: observation.data?.scope ?? observation.data?.issue_scope,
					checked_card_ids: observation.data?.checked_card_ids ?? [],
					resolved_card_ids: observation.data?.resolved_card_ids ?? [] }],
				(item) => String(item?.id ?? ""), 30
			);
		}
	}
	if (successfulKnowledgeWrite(step)) {
		const cardIds = Array.isArray(observation.scope?.card_ids) ? observation.scope.card_ids : [];
		state.workspace.extension.write_proposals = appendByKey(
			state.workspace.extension.write_proposals,
			[{ id: observation.data_digest ?? `step-${step.step}`, step: step.step,
				layer: observation.scope?.layer ?? step.action?.layer,
				card_ids: cardIds, operation_count: Number(observation.data?.operation_count ?? cardIds.length),
				committed_at: step.at }],
			(item) => String(item?.id ?? ""), 30
		);
		changed = true;
	}
	if (step.action?.operator === "record_structure_review" && observation.status === "ok" && observation.data?.card_id) {
		const record = observation.data;
		const fingerprint = `unconnected:${record.issue_kind}:${record.card_id}`;
		const status = record.status === "linked" ? "fixed" : record.status === "intentionally_standalone" ? "kept" : "deferred";
		state.workspace.extension.issue_ledger = (state.workspace.extension.issue_ledger ?? []).map((item) => item.fingerprint === fingerprint
			? { ...item, status, disposition: record.status, reason: record.reason, closed_at_step: step.step } : item);
		state.workspace.extension.review_records = appendByKey(
			state.workspace.extension.review_records,
			[{ ...observation.data, recorded_at_step: step.step }],
			(item) => `${item.issue_kind}|${item.card_id}|${item.card_fingerprint}`, 60
		);
		if (state.workspace.extension.focus_issue?.card_id === observation.data.card_id
			&& state.workspace.extension.focus_issue?.issue_kind === observation.data.issue_kind) {
			state.workspace.extension.focus_issue = {
				...state.workspace.extension.focus_issue,
				disposition: observation.data.status,
				reviewed_at_step: step.step
			};
		}
		changed = true;
	}
	return changed;
}

function analyticalCardIds(observation) {
	const address = String(observation?.data?.address ?? "");
	return [...new Set([
		...(observation?.evidence ?? []).map((item) => item?.card_id),
		...(observation?.data?.nodes ?? []).map((item) => item?.id),
		...(observation?.data?.results ?? []).map((item) => item?.card_id),
		...(observation?.data?.compared ?? []),
		...(observation?.data?.parties ?? []),
		observation?.data?.id,
		address ? address.split("#", 1)[0] : null
	].filter(Boolean).map(String))];
}

/** Project observable analysis facts into Workspace; never stores hidden reasoning. */
function projectAnalyticalObservation(state, step) {
	if (!["general", "assess", "report"].includes(state.run.mode)) return false;
	const observation = step.observation ?? {};
	if (!["read", "simulate"].includes(step.action?.mode) || !observationSatisfiesCapability(observation)) return false;
	state.workspace.extension ??= {};
	const operator = step.action?.operator;
	const ids = analyticalCardIds(observation);
	const hopById = new Map((observation.data?.nodes ?? []).map((node) => [String(node.id), Number(node.hop ?? 0)]));
	if (ids.length) {
		state.workspace.observed_nodes = appendByKey(
			state.workspace.observed_nodes,
			ids.map((card_id) => ({
				card_id, operator, ...(hopById.has(card_id) ? { hop: hopById.get(card_id) } : {}),
				observed_at: step.at, status: observation.status
			})),
			(item) => `${item.card_id}|${item.operator}|${item.hop ?? ""}`, 160
		);
	}

	if (operator === "verify_evidence_anchors") {
		// Latest verification replaces the previous role assignment rather than accumulating contradictions.
		for (const bucket of ["evidence", "counter_evidence"]) state.workspace[bucket] = state.workspace[bucket].filter((item) => item.operator !== operator);
		for (const item of observation.data?.results ?? []) {
			if (!item?.usable) continue;
			const entry = {
				id: `${item.anchor}|${item.role}|${item.claim_id ?? ""}`,
				anchor: item.anchor, card_id: item.card_id, role: item.role,
				claim_id: item.claim_id, operator, observed_at: step.at
			};
			const bucket = item.role === "counter" ? "counter_evidence" : "evidence";
			state.workspace[bucket] = appendByKey(state.workspace[bucket], [entry], (candidate) => String(candidate?.id ?? ""), 100);
		}
	} else if (!["retrieve", "graph_search"].includes(operator)) {
		state.workspace.evidence = appendByKey(state.workspace.evidence, [{
			id: observation.data_digest ?? `step-${step.step}`,
			operator, summary: observation.summary, card_ids: ids,
			roles_present: observation.data?.roles_present ?? [],
			structural_depth: Number(observation.data?.reached_hops ?? 0), observed_at: step.at
		}], (item) => String(item?.id ?? ""), 100);
	}

	if (operator === "inspect_evidence_set") {
		state.workspace.open_questions = state.workspace.open_questions.filter((item) => item.source !== operator);
		for (const claimId of observation.data?.uncovered_claims ?? []) {
			state.workspace.open_questions = appendByKey(state.workspace.open_questions, [{
				id: `evidence-gap:${claimId}`, question: `结论 ${claimId} 尚缺支持证据。`,
				source: operator, observed_at: step.at
			}], (item) => String(item?.id ?? item?.question ?? ""), 60);
		}
	}
	state.workspace.extension.checkpoint = operator === "inspect_cognitive_sufficiency"
		? {
			phase: observation.data?.ready ? "sufficient" : "evidence_gap",
			ready: Boolean(observation.data?.ready), missing: observation.data?.missing ?? [],
			checked_at_step: step.step, updated_at: step.at
		}
		: { phase: "observing", last_operator: operator, last_step: step.step, updated_at: step.at };
	return true;
}

const WORKSPACE_DIFF_BUCKETS = [
	"hypotheses", "evidence", "counter_evidence", "open_questions",
	"conflicts", "candidate_actions", "observed_nodes", "deferred_items"
];

function itemKey(value, index) {
	if (typeof value === "string") return `text:${value}`;
	if (value && typeof value === "object") {
		for (const key of ["id", "card_id", "question", "description", "title", "label"]) {
			if (value[key] !== void 0 && value[key] !== "") return `${key}:${String(value[key])}`;
		}
	}
	return `index:${index}:${JSON.stringify(value)}`;
}

function diffWorkspace(before, after, revisionBefore, revisionAfter) {
	const added = {};
	const changed = {};
	const removed = {};
	for (const bucket of WORKSPACE_DIFF_BUCKETS) {
		const left = Array.isArray(before?.[bucket]) ? before[bucket] : [];
		const right = Array.isArray(after?.[bucket]) ? after[bucket] : [];
		const leftByKey = new Map(left.map((value, index) => [itemKey(value, index), value]));
		const rightByKey = new Map(right.map((value, index) => [itemKey(value, index), value]));
		const bucketAdded = [];
		const bucketChanged = [];
		for (const [key, value] of rightByKey) {
			if (!leftByKey.has(key)) bucketAdded.push(value);
			else if (JSON.stringify(leftByKey.get(key)) !== JSON.stringify(value)) bucketChanged.push(value);
		}
		const bucketRemoved = [...leftByKey.keys()].filter((key) => !rightByKey.has(key));
		if (bucketAdded.length) added[bucket] = bucketAdded.slice(-12);
		if (bucketChanged.length) changed[bucket] = bucketChanged.slice(-12);
		if (bucketRemoved.length) removed[bucket] = bucketRemoved.slice(-12);
	}
	return { revision_before: revisionBefore, revision_after: revisionAfter, added, changed, removed };
}

function compactObservation(observation) {
	const compact = structuredClone(observation);
	const content = compact?.data?.content;
	if (typeof content === "string" && content.length > 1200) {
		compact.data.content_preview = content.slice(0, 600);
		compact.data.content_length = content.length;
		delete compact.data.content;
	}
	return compact;
}

const GENERAL_CLOSURE_OPERATORS = new Set([
	"inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency"
]);
const GENERAL_CLOSURE_STEP_RESERVE = 3;

function usageFromEpisode(episode) {
	const steps = episode?.steps ?? [];
	return {
		steps: steps.length,
		reads: steps.filter((step) => step.action?.mode === "read"
			&& !GENERAL_CLOSURE_OPERATORS.has(step.action?.operator)).length,
		closure_audits: steps.filter((step) => GENERAL_CLOSURE_OPERATORS.has(step.action?.operator)).length,
		writes: steps.filter((step) => ["write", "proposal"].includes(step.action?.mode)
			&& !["rejected", "error", "conflict"].includes(step.observation?.status)).length
	};
}

function budgetState(workspace, episode) {
	const budget = workspace?.budget ?? {};
	const usage = usageFromEpisode(episode);
	const limit = (name, fallback) => Number.isFinite(Number(budget[name])) ? Math.max(0, Number(budget[name])) : fallback;
	const limits = { steps: limit("max_steps", 24), reads: limit("max_reads", 12), writes: limit("max_writes", 3) };
	const exhausted = Object.entries(limits).filter(([key, max]) => usage[key] >= max).map(([key]) => key);
	const recentReads = (episode?.steps ?? []).filter((step) => step.action?.mode === "read").slice(-3);
	const lowNovelty = recentReads.length === 3 && recentReads.every((step) => step.observation?.data?.on_topic_new === 0);
	return {
		usage, limits,
		remaining: Object.fromEntries(Object.entries(limits).map(([key, max]) => [key, Math.max(0, max - usage[key])])),
		exhausted,
		loop_signal: lowNovelty ? "连续三次读取没有新增焦点卡，应改换检索角度、读卡或结束侦察" : null
	};
}

export class CognitiveRuntime {
	constructor(root) {
		this.root = resolve(root);
		this.base = join(this.root, ".nexogenesis", "cognition");
		this.indexPath = join(this.base, "session-runs.json");
		this.interactionIndexPath = join(this.base, "interaction-runs.json");
		this.discussionIndexPath = join(this.base, "session-discussions.json");
		this.turnIndexPath = join(this.base, "session-turns.json");
	}

	/** Host admission is durable and is never accepted in model tool arguments. */
	admitConversationTurn(session_id, { policy = "legacy", request = "" } = {}) {
		const index = readJson(this.turnIndexPath, {});
		index[session_id] = { id: randomUUID(), policy, request, admitted_at: now(), turn_id: null, run_id: null };
		atomicJson(this.turnIndexPath, index);
		return index[session_id];
	}

	conversationTurn(session_id) { return readJson(this.turnIndexPath, {})[session_id] ?? null; }

	/** Explicit user answer resumes the same research and budget, with a new native turn identity. */
	continueAnalysisTurn(run_id) {
		const state = this.get(run_id);
		if (!isConversationAnalysis(state)) return;
		if (state.run.status === "closed" || this.current(state.run.session_id)?.run.run_id !== run_id) throw new Error("已结束或旧分析不能自动恢复。");
		this.invalidateDelivery(run_id, "用户继续原待答问题");
		const fresh = this.get(run_id);
		if (fresh.run.delivery) {
			fresh.run.delivery_history = [...(fresh.run.delivery_history ?? []), fresh.run.delivery].slice(-8);
			fresh.run.delivery = { state: "none", coverage: "unknown", limitations: [], message_ref: null, review_ref: null };
		}
		const admission = this.admitConversationTurn(state.run.session_id, { policy: state.run.analysis_policy_version, request: state.workspace.goal });
		const turns = readJson(this.turnIndexPath, {});
		turns[state.run.session_id].run_id = run_id;
		atomicJson(this.turnIndexPath, turns);
		fresh.run.host_admission_id = admission.id; fresh.run.host_turn_id = null;
		delete fresh.run.host_turn_seq;
		delete fresh.run.delivery_end;
		this._write(run_id, "run.json", fresh.run);
	}

	bindConversationTurn(session_id, event) {
		const index = readJson(this.turnIndexPath, {}), admission = index[session_id];
		if (!admission || event.type !== "turn/start" || event.data?.turn == null || admission.turn_id != null
			|| new Date(event.time).getTime() < Date.parse(admission.admitted_at)) return;
		admission.turn_id = String(event.data.turn);
		admission.turn_seq = event.seq;
		atomicJson(this.turnIndexPath, index);
		if (admission.run_id) {
			const state = this.get(admission.run_id);
			if (state?.run.host_admission_id === admission.id) {
				state.run.host_turn_id = admission.turn_id;
				state.run.host_turn_seq = event.seq;
				this._write(admission.run_id, "run.json", state.run);
			}
		}
	}

	prepareDelivery(run_id, review, args) {
		const state = this.get(run_id);
		if (!isConversationAnalysis(state) || state.run.status !== "running") throw new Error("只有当前新版分析可准备交付。");
		const previous = state.run.delivery;
		if (previous?.state === "prepared" && previous.review_ref === review.fingerprint) return { ...state.run, idempotent_replay: true };
		const count = state.run.delivery_review_count ?? 0;
		if (this.governance(run_id).remaining.steps === 0 && count >= 3) throw new Error("收尾检查额度已用尽；直接说明现有成果与未核查项，不再研究或重试审计。");
		state.run.delivery_review_count = count + 1;
		state.run.delivery = { state: "prepared", turn_id: state.run.host_turn_id ?? null, message_ref: null,
			coverage: review.coverage, stop_reason: args.stop_reason, review_ref: review.fingerprint,
			limitations: review.limitations, prepared_at: now() };
		this._write(run_id, "delivery-review.json", review);
		this._write(run_id, "run.json", state.run);
		return state.run;
	}

	invalidateDelivery(run_id, reason) {
		const state = this.get(run_id);
		if (state?.run.delivery?.state !== "prepared") return;
		state.run.delivery_history = [...(state.run.delivery_history ?? []), { ...state.run.delivery, invalidated_at: now(), reason }].slice(-8);
		state.run.delivery = { state: "none", coverage: "unknown", limitations: [], message_ref: null, review_ref: null };
		this._write(run_id, "run.json", state.run);
	}

	settleAnalysisDelivery(run_id, { end, kind, detail, delivery }) {
		const state = this.get(run_id);
		if (!isConversationAnalysis(state) || String(end.data?.turn) !== String(state.run.host_turn_id)) return;
		if (state.run.delivery_end && state.run.delivery_end.seq !== end.seq) return;
		state.run.delivery_end = end;
		const prior = state.run.delivery ?? { state: "none", coverage: "unknown", limitations: [], review_ref: null };
		if (prior.state !== "delivered") state.run.delivery = { ...prior, ...(delivery ?? {}), turn_id: state.run.host_turn_id,
			...(delivery?.state === "delivered" ? { delivered_at: now() } : {}) };
		this._write(run_id, "run.json", state.run);
		// Waiting questions, explicit stop/failure and pipeline states retain their own authority.
		if (state.run.status === "running") this.setStatus(run_id, kind === "completed" ? "closed"
			: ["cancelled", "canceled", "interrupted"].includes(kind) ? "cancelled" : "failed", prior.stop_reason ?? detail);
	}

	start({ session_id, mode, skill, goal, scope = {}, budget, extension = {}, write_authority = "manual" }) {
		if (!["construct","general","assess","report"].includes(mode)) throw new Error("该运行模式已退役或不受支持；图书编译使用独立的新入口。");
		if (!session_id) throw new Error("CognitiveRun 必须绑定 DSH session_id");
		const admission = this.conversationTurn(session_id);
		if (admission?.policy === "conversation-v2" && admission.run_id && this.get(admission.run_id)?.run.host_admission_id === admission.id) throw new Error("本回合已有运行；不能通过新建任务重置预算或权限。请保留结果，等待用户发起下一轮。");
		const discussion = this.discussionTask(session_id);
		if (discussion && !["general", "assess", "report"].includes(mode)) throw new Error("当前处于只读讨论；请通过继续建构恢复原任务，不能另起写入任务。");
		const previous = this.current(session_id);
		const released = ["completed", "closed"].includes(previous?.run.status) && Object.hasOwn(previous.run, "closed_admission_id") && ["general", "assess", "report"].includes(mode) && admission && admission.id !== previous.run.closed_admission_id;
		if (!discussion && !released && previous?.workspace?.scope?.construct_request) throw new Error("此会话已有冻结的建构任务；请沿用原任务，不能另起运行绕过范围或预算。");
		if (discussion) write_authority = "manual";
		const allocation = allocateGeneralAnalysisBudget(mode, scope, budget);
		scope = allocation.scope;
		budget = allocation.budget;
		const run_id = randomUUID();
		const stamp = now();
		const run = {
			run_version: "1.0", run_id, session_id, mode, skill,
			status: "running", created_at: stamp, updated_at: stamp,
			thinking_model: null, step_count: 0, checkpoint_revision: 1,
			write_authority: write_authority === "trusted" ? "trusted" : "manual"
		};
		if (admission) {
			run.host_admission_id = admission.id;
			run.original_request = admission.request;
			run.host_turn_id = admission.turn_id;
			if (Number.isSafeInteger(admission.turn_seq)) run.host_turn_seq = admission.turn_seq;
			run.analysis_policy_version = ["general", "assess", "report"].includes(mode) && !isStrictAnalysis(skill, scope) ? admission.policy : "legacy";
		}
		const workspace = baseWorkspace(goal, scope, budget, extension);
		const episode = { episode_version: "1.0", episode_id: randomUUID(), run_id, started_at: stamp, steps: [] };
		this._write(run_id, "run.json", run);
		this._write(run_id, "workspace.json", workspace);
		this._write(run_id, "episode.json", episode);
		const index = readJson(this.indexPath, {});
		index[session_id] = run_id;
		atomicJson(this.indexPath, index);
		if (admission) {
			const turns = readJson(this.turnIndexPath, {});
			turns[session_id] = { ...admission, run_id };
			atomicJson(this.turnIndexPath, turns);
		}
		return { run, workspace: summarizeWorkspace(workspace) };
	}

	/** Promote this question's read-only reconnaissance without copying another run's evidence. */
	promoteAnalysis(run_id, { skill, goal, scope = {}, budget }) {
		const state = this.get(run_id);
		if (!state || state.run.status !== "running" || state.run.mode !== "general" || isAnalyticalRun(state)
			|| state.episode.steps.some((step) => ["write", "proposal"].includes(step.action?.mode))) {
			throw new Error("只有尚未提出写入的活动只读侦察可以升级；先结束原任务或处理待确认项。");
		}
		// Preserve pre-existing scope restrictions. Promotion can tighten rights, never broaden them.
		const allocation = allocateGeneralAnalysisBudget("general", { ...scope, ...state.workspace.scope,
			analysis_depth: "iterative", complexity_level: scope.complexity_level ?? "standard" }, budget);
		state.workspace.goal = goal;
		state.workspace.scope = allocation.scope;
		state.workspace.budget = allocation.budget;
		state.workspace.extension.checkpoint = { phase: "observing", ready: false, updated_at: now() };
		state.run.skill = skill;
		if (isStrictAnalysis(skill, scope)) state.run.analysis_policy_version = "legacy";
		state.run.updated_at = now();
		state.run.checkpoint_revision += 1;
		this._write(run_id, "workspace.json", state.workspace);
		this._write(run_id, "run.json", state.run);
		this.record(run_id, { action: { operator: "start_cognitive_run", mode: "runtime-write" },
			observation: { operator: "start_cognitive_run", status: "ok", summary: "本题侦察已升级为只读分析；保留实际检索与阅读，最终仍须核对当前版本。",
				data: { promoted: true, retained_steps: state.episode.steps.length } } });
		return this.get(run_id);
	}

	ensure(exec, defaults = {}) {
		const session_id = sessionIdOf(exec) ?? `process-${process.pid}`;
		const current = this.current(session_id);
		assertExecutableMode(current?.run.mode);
		assertExecutableMode(defaults.mode);
		if (current && ["running", "waiting_user"].includes(current.run.status)) return current;
		return this.start({
			session_id,
			mode: defaults.mode ?? "general",
			skill: defaults.skill ?? "implicit",
			goal: defaults.goal ?? "处理当前知识任务",
			scope: defaults.scope ?? {}
		});
	}

	current(session_id) {
		const run_id = readJson(this.indexPath, {})[session_id];
		return run_id ? this.get(run_id) : null;
	}

	/** Host-only conversation transition. Not exposed as a model tool or mutable Workspace field. */
	discussionTask(session_id) {
		const id = readJson(this.discussionIndexPath, {})[session_id];
		const state = id ? this.get(id) : null;
		return state?.run.session_id === session_id ? state : null;
	}

	beginDiscussion(session_id) {
		if (this.discussionTask(session_id)) return this.current(session_id);
		const task = this.current(session_id);
		if (task?.run.mode !== "construct" || ["running", "waiting_user", "closed"].includes(task.run.status)) throw new Error("请先暂停建构，再进入只读讨论。");
		const index = readJson(this.discussionIndexPath, {});
		index[session_id] = task.run.run_id;
		atomicJson(this.discussionIndexPath, index);
		this.admitConversationTurn(session_id);
		const discussion = this.start({ session_id, mode: "general", skill: "implicit", goal: "讨论建构发现；原建构已暂停，本轮不修改知识" });
		this.setStatus(discussion.run.run_id, "completed", "只读讨论已就绪，等待用户提问。");
		return this.current(session_id);
	}

	restoreDiscussionTask(session_id, run_id) {
		const task = this.discussionTask(session_id), current = this.current(session_id);
		assertExecutableMode(task?.run.mode);
		if (!task || task.run.run_id !== run_id || ["completed", "closed"].includes(task.run.status)) throw new Error("原建构不存在、已完成或恢复目标已变化。");
		if (current && ["running", "waiting_user"].includes(current.run.status)) throw new Error("请先结束当前讨论或处理其待答事项。");
		const index = readJson(this.indexPath, {});
		index[session_id] = run_id;
		atomicJson(this.indexPath, index);
		const discussions = readJson(this.discussionIndexPath, {});
		delete discussions[session_id];
		atomicJson(this.discussionIndexPath, discussions);
		return task;
	}

	getInteraction(run_id) {
		return this._read(run_id, "interaction.json");
	}

	/** User ends the business work, without claiming unfinished acceptance checks passed. */
	closeConversationWork(session_id) {
		const task = this.discussionTask(session_id) ?? this.current(session_id);
		const current = this.current(session_id);
		for (const id of new Set([task?.run.run_id, current?.run.run_id].filter(Boolean))) {
			this.cancelInteraction(id);
			if (this.get(id).run.status !== "completed") this.setStatus(id, "closed", "用户结束这项工作；已提交结果和未完成记录保留，不再自动继续。");
			const ended = this.get(id).run;
			ended.closed_admission_id = this.conversationTurn(session_id)?.id ?? null;
			this._write(id, "run.json", ended);
		}
		const discussions = readJson(this.discussionIndexPath, {});
		delete discussions[session_id];
		atomicJson(this.discussionIndexPath, discussions);
		if (task) atomicJson(this.indexPath, { ...readJson(this.indexPath, {}), [session_id]: task.run.run_id });
		return task;
	}

	continuations(run_id) {
		return this._read(run_id, "continuations.json") ?? [];
	}

	enqueueContinuation(run_id, { kind, content }) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		const queue = this.continuations(run_id);
		const entry = { id: randomUUID(), kind: String(kind ?? "resume"), content: String(content ?? ""), status: "pending", created_at: now() };
		queue.push(entry);
		this._write(run_id, "continuations.json", queue.slice(-24));
		return entry;
	}

	markContinuationDelivered(run_id, continuationId) {
		const queue = this.continuations(run_id);
		const entry = queue.find((item) => item.id === continuationId);
		if (!entry) throw new Error("找不到待投递的 continuation");
		entry.status = "delivered";
		entry.delivered_at = now();
		this._write(run_id, "continuations.json", queue);
		return entry;
	}

	pendingContinuations(run_id) {
		return this.continuations(run_id).filter((entry) => entry.status === "pending");
	}

	getInteractionById(interaction_id) {
		const run_id = readJson(this.interactionIndexPath, {})[interaction_id];
		return run_id ? this.getInteraction(run_id) : null;
	}

	currentInteraction(session_id) {
		const state = this.current(session_id);
		if (!state) return null;
		const interaction = this.getInteraction(state.run.run_id);
		return interaction?.status === "pending" ? interaction : null;
	}

	requestInteraction(run_id, { type, request_key, question, options }) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		const existing = this.getInteraction(run_id);
		if (existing?.status === "pending" && existing.request_key !== request_key) {
			throw new Error("当前任务已有待答问题；应先等待用户回答，不能并行提出新的判断请求。");
		}
		const stamp = now();
		const replacePending = existing?.status === "pending";
		const interaction = {
			interaction_version: "1.0",
			interaction_id: replacePending ? existing.interaction_id : randomUUID(),
			run_id, session_id: state.run.session_id, type, status: "pending",
			request_key, question, options,
			created_at: replacePending ? existing.created_at : stamp, updated_at: stamp
		};
		this._write(run_id, "interaction.json", interaction);
		const index = readJson(this.interactionIndexPath, {});
		index[interaction.interaction_id] = run_id;
		atomicJson(this.interactionIndexPath, index);
		this.setStatus(run_id, "waiting_user");
		return interaction;
	}

	answerInteraction(interaction_id, answer) {
		const run_id = readJson(this.interactionIndexPath, {})[interaction_id];
		if (!run_id) throw new Error("找不到这项待答问题。");
		const interaction = this.getInteraction(run_id);
		if (!interaction || interaction.interaction_id !== interaction_id) throw new Error("待答问题记录不完整。");
		if (interaction.status !== "pending") throw new Error("这项问题已经回答，不能重复提交。");
		interaction.status = "answered";
		interaction.answer = answer;
		interaction.answered_at = now();
		interaction.updated_at = interaction.answered_at;
		this._write(run_id, "interaction.json", interaction);
		return interaction;
	}

	cancelInteraction(run_id) {
		const interaction = this.getInteraction(run_id);
		if (!interaction || interaction.status !== "pending") return;
		interaction.status = "cancelled";
		interaction.updated_at = now();
		this._write(run_id, "interaction.json", interaction);
	}

	get(run_id) {
		const run = this._read(run_id, "run.json");
		if (!run) return null;
		return { run, workspace: this._read(run_id, "workspace.json"), episode: this._read(run_id, "episode.json"),
			...(run.delivery?.review_ref ? { delivery_review: this._read(run_id, "delivery-review.json") } : {}) };
	}

	updateWorkspace(run_id, patch) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		if (state.run.analysis_policy_version === "conversation-v2" && !isConversationAnalysis(state)
			&& (patch?.scope?.analysis_depth === "iterative" || patch?.scope?.complexity_level || patch?.budget)) throw new WorkspaceContractError("scope", { hint: "请使用 start_cognitive_run 升级本题侦察，受控分配预算并保留阅读" });
		if (isConversationAnalysis(state)) {
			if (state.run.status !== "running" && state.run.status !== "waiting_user") throw new WorkspaceContractError("status", { hint: "已结束的分析不能改写；由用户启动新问题" });
			if (patch?.budget && JSON.stringify(patch.budget) !== JSON.stringify(state.workspace.budget)) throw new WorkspaceContractError("budget", { hint: "本轮预算已冻结" });
			if (patch?.scope) for (const key of ["analysis_depth", "complexity_level", "execution_profile", "allowed_ops", "read_only"]) {
				if (Object.hasOwn(patch.scope, key) && JSON.stringify(patch.scope[key]) !== JSON.stringify(state.workspace.scope[key])) throw new WorkspaceContractError(`scope.${key}`, { hint: "运行约束由宿主冻结" });
			}
			if (patch?.goal && patch.goal !== state.workspace.goal) throw new WorkspaceContractError("goal", { hint: "不能改写原问题以隐藏未完成要求" });
			if (["scope", "hypotheses", "evidence", "counter_evidence", "user_directives", "open_questions", "conflicts", "deferred_items"].some(key => Object.hasOwn(patch ?? {}, key))
				|| (patch?.extension?.result && JSON.stringify(patch.extension.result.pending) !== JSON.stringify(state.workspace.extension?.result?.pending))) {
				this.invalidateDelivery(run_id, "判断、证据或用户要求发生变化");
				state.run = this.get(run_id).run;
			}
		}
		const workspace = structuredClone(state.workspace);
		const constructRequest = state.workspace.scope?.construct_request;
		if (constructRequest) {
			if (patch?.scope?.construct_request && JSON.stringify(patch.scope.construct_request) !== JSON.stringify(constructRequest)) throw new Error("建构启动选项已冻结；不能修改原目标、范围或工作量。");
			if (patch?.budget && JSON.stringify(patch.budget) !== JSON.stringify(state.workspace.budget)) throw new Error("不能通过工作区补丁扩大本轮建构预算。");
		}
		const contract = workspaceContract(state.run.mode);
		for (const [key, value] of Object.entries(patch ?? {})) {
			if (!WORKSPACE_KEYS.has(key)) {
				throw new WorkspaceContractError(key, {
					mode: state.run.mode,
					allowed: contract.core_fields,
					hint: MISPLACED_HINTS[key]
				});
			}
			if (key === "extension") {
				if (value === null || typeof value !== "object" || Array.isArray(value)) {
					throw new WorkspaceContractError("extension", { mode: state.run.mode, allowed: contract.extension_fields });
				}
				for (const extensionKey of Object.keys(value)) {
					if (!(EXTENSION_FIELDS[state.run.mode] ?? EXTENSION_FIELDS.general).has(extensionKey)) {
						throw new WorkspaceContractError(`extension.${extensionKey}`, { mode: state.run.mode, allowed: contract.extension_fields });
					}
				}
				workspace.extension = { ...workspace.extension, ...value };
			} else {
				workspace[key] = value;
			}
		}
		if (constructRequest) workspace.scope = { ...workspace.scope, construct_request: constructRequest, continuous_construct: constructRequest.workload === "systematic" };
		if (isConversationAnalysis(state)) workspace.scope = { ...state.workspace.scope, ...workspace.scope };
		if (isAnalyticalRun(state)) {
			const levels = ["light", "standard", "deep"];
			const level = levels[Math.max(levels.indexOf(state.workspace.scope?.complexity_level ?? "standard"), levels.indexOf(workspace.scope?.complexity_level ?? "standard"))];
			const allocation = allocateGeneralAnalysisBudget(state.run.mode, { ...state.workspace.scope, ...workspace.scope, analysis_depth: "iterative", complexity_level: level }, workspace.budget);
			workspace.scope = allocation.scope;
			workspace.budget = allocation.budget;
		}
		this._write(run_id, "workspace.json", workspace);
		state.run.updated_at = now();
		state.run.checkpoint_revision += 1;
		this._write(run_id, "run.json", state.run);
		return summarizeWorkspace(workspace);
	}

	/**
	 * 更新 Workspace 并同时留下可审计的差异步骤。
	 * Workspace 仍是状态真相；delta 只用于 Episode 与 Web 的可视化投影。
	 */
	updateWorkspaceWithDiff(run_id, patch, { action, observation, rationale = "", evidence_anchors = [] } = {}) {
		const beforeState = this.get(run_id);
		if (!beforeState) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		const revisionBefore = beforeState.run.checkpoint_revision;
		const beforeWorkspace = structuredClone(beforeState.workspace);
		const workspace = this.updateWorkspace(run_id, patch);
		const afterState = this.get(run_id);
		const delta = diffWorkspace(beforeWorkspace, afterState.workspace, revisionBefore, afterState.run.checkpoint_revision);
		const step = this.record(run_id, {
			action: action ?? { operator: "update_cognitive_workspace", mode: "runtime-write" },
			observation: observation ?? { operator: "update_cognitive_workspace", status: "ok", summary: "已更新思维工作区。" },
			rationale,
			evidence_anchors,
			workspace_revision_before: revisionBefore,
			workspace_revision_after: afterState.run.checkpoint_revision,
			workspace_delta: delta
		});
		return { workspace, delta, step };
	}

	selectThinkingModel(run_id, model, coverage = {}) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		if (isConversationAnalysis(state) && model.id === "deep-inquiry") throw new Error("固定执行测试需要用户另行启动，不在普通分析中变更验收策略。");
		if (isConversationAnalysis(state) && state.run.delivery?.state === "prepared") throw new Error("已准备交付，请直接回答；若确需修正，先更新受影响的判断。");
		if (state.run.thinking_model?.id === model.id && state.run.thinking_model?.version === model.version) return state.run.thinking_model;
		state.run.thinking_model = {
			id: model.id,
			version: model.version,
			purpose: model.purpose,
			applicable_modes: [...(model.applicable_modes ?? [])],
			required_capabilities: [...model.required_capabilities],
			observation_obligations: structuredClone(model.observation_obligations ?? []),
			evidence_roles: [...(model.evidence_roles ?? [])],
			output_obligations: [...(model.output_obligations ?? [])],
			stop_conditions: [...model.stop_conditions],
			operators: coverage.operators ?? {},
			selected_at: now(),
			selected_at_step: state.episode.steps.length
		};
		state.run.updated_at = now();
		this._write(run_id, "run.json", state.run);
		return state.run.thinking_model;
	}

	governance(run_id) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		return { ...budgetState(state.workspace, state.episode), exploration: explorationBudget(state) };
	}

	canOperate(run_id, { mode = "read", operator } = {}) {
		const state = this.get(run_id);
		if (!state) return { allowed: false, reason: "找不到当前 CognitiveRun。" };
		if (retiredModes.has(state.run.mode)) return { allowed:false,reason_code:"legacy_compile_retired",reason:"旧编译已退役，历史任务只读。" };
		if (this.current(state.run.session_id)?.run.run_id !== run_id) return { allowed: false, reason: "此运行已暂停或不再是当前运行。", reason_code: "inactive_run" };
		if (this.discussionTask(state.run.session_id) && ["write", "proposal"].includes(mode)) return { allowed: false, reason: "建构后的讨论只读；请明确恢复原建构或新建已授权任务。", reason_code: "discussion_read_only" };
		if (state.run.status !== "running") return { allowed: false, reason: `当前任务状态为 ${state.run.status}，请先开始新的任务或处理等待中的用户选择。`, governance: this.governance(run_id) };
		const governance = this.governance(run_id);
		if (isConversationAnalysis(state) && state.run.delivery?.state === "prepared") return { allowed: false, reason_code: "delivery_prepared", reason: "已准备交付，请直接回答；用户插入或修正判断后旧快照才会失效。", governance };
		if (state.workspace.scope?.construct_request?.workload === "advice" && ["write", "proposal"].includes(mode)) {
			return { allowed: false, reason: "本轮选择了先看建议，不允许修改知识或提交写入提案。", reason_code: "construct_advice_only", governance };
		}
		const allowedOps = state.workspace.scope?.allowed_ops;
		if (operator && Array.isArray(allowedOps) && !allowedOps.includes(operator)) {
			return { allowed: false, reason: `当前受控任务不允许调用 ${operator}。`, reason_code: "operator_not_allowed_in_scope", governance };
		}
		if (state.workspace.scope?.read_only === true && ["write", "proposal", "runtime-write"].includes(mode)) {
			return { allowed: false, reason: "当前任务是只读运行，不能执行写入或提案操作。", reason_code: "read_only_scope", governance };
		}
		if (isAnalyticalRun(state) && ["write", "proposal"].includes(mode)) return {
			allowed: false, reason: "分析任务只读；保存想法须结束分析后转捕获或精修并生成用户确认。", reason_code: "analysis_read_only", governance
		};
		const unboundedByRun = state.run.mode === "general" && state.workspace.scope?.analysis_depth !== "iterative";
		if (unboundedByRun) return { allowed: true, governance };
		const iterativeGeneral = isAnalyticalRun(state);
		if (iterativeGeneral && GENERAL_CLOSURE_OPERATORS.has(operator)) {
			return governance.usage.steps < governance.limits.steps + GENERAL_CLOSURE_STEP_RESERVE
				? { allowed: true, governance }
				: {
					allowed: false,
					reason: "本轮分析预算及闭合审计保留额度均已用尽；请以 blocked 结束并说明尚未闭合的证据。",
					reason_code: "closure_reserve_exhausted", governance
				};
		}
		const counter = mode === "read" ? "reads" : ["write", "proposal"].includes(mode) ? "writes" : "steps";
		// Only close an existing plan in this reserve; it cannot fund more exploration or card writes.
		if (state.run.mode === "construct" && state.workspace.extension?.improvement_plan
			&& operator === "review_construct_improvement") return governance.usage.steps < governance.limits.steps + 2
			? { allowed: true, governance }
			: { allowed: false, reason_code: "closure_reserve_exhausted", reason: "建构复核保留额度已耗尽；请如实报告未完成内容。", governance };
		if (governance.exploration.applicable && DISCOVERY_OPERATORS.has(operator)
			&& governance.exploration.discovery_calls_available === 0) return {
			allowed: false, reason_code: "exploration_read_reserve",
			reason: "本轮剩余资源已留给候选精读、挑战验证与收尾；请先读取尚未核验的关键候选，或带缺口结束，不再扩大候选范围。",
			next_actions: [{ action: "read_cards", description: "从 exploration.frontier 或已有候选选取能回答缺口的正文；仍不足就明确待验证。" }], governance
		};
		if (governance.usage.steps >= governance.limits.steps || governance.usage[counter] >= governance.limits[counter]) {
			return { allowed: false, reason: `本轮 ${counter} 预算已用尽。请总结现有证据、请求新授权或结束任务。`, governance };
		}
		return { allowed: true, governance };
	}

	record(run_id, { action, observation, rationale = "", evidence_anchors = [], workspace_revision_before, workspace_revision_after, workspace_delta } = {}) {
		const state = this.get(run_id);
		if (!state) return null;
		if (observation) observation.step = state.episode.steps.length + 1;
		const step = {
			step: state.episode.steps.length + 1,
			at: now(),
			state: summarizeWorkspace(state.workspace),
			action,
			observation: compactObservation(observation),
			rationale: String(rationale).slice(0, 400),
			evidence_anchors: evidence_anchors.slice(0, 12),
			...(Number.isFinite(workspace_revision_before) ? { workspace_revision_before } : {}),
			...(Number.isFinite(workspace_revision_after) ? { workspace_revision_after } : {}),
			...(workspace_delta ? { workspace_delta } : {})
		};
		state.episode.steps.push(step);
		const workspaceProjected = projectConstructObservation(state, step)
			|| projectAnalyticalObservation(state, step);
		state.run.step_count = state.episode.steps.length;
		state.run.updated_at = step.at;
		const governance = budgetState(state.workspace, state.episode);
		const unboundedByRun = state.run.mode === "general" && state.workspace.scope?.analysis_depth !== "iterative";
		const iterativeGeneral = isAnalyticalRun(state);
		const constructClosureReserve = state.run.mode === "construct" && state.workspace.extension?.improvement_plan
			&& governance.usage.steps < governance.limits.steps + 2;
		if (state.run.status === "running" && !unboundedByRun && !iterativeGeneral && !constructClosureReserve && governance.exhausted.includes("steps")) {
			state.run.status = "blocked";
			state.run.finished_at = step.at;
			state.workspace.stop_reason = "步骤预算已用尽";
			this._write(run_id, "workspace.json", state.workspace);
		}
		if (workspaceProjected) this._write(run_id, "workspace.json", state.workspace);
		this._write(run_id, "episode.json", state.episode);
		this._write(run_id, "run.json", state.run);
		return step;
	}

	recordForExec(exec, payload, defaults) {
		const state = this.ensure(exec, defaults);
		return this.record(state.run.run_id, payload);
	}

	setStatus(run_id, status, stop_reason = null) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		state.run.status = status;
		state.run.updated_at = now();
		if (["completed", "closed", "cancelled", "blocked", "failed", "paused"].includes(status)) state.run.finished_at = state.run.updated_at;
		else delete state.run.finished_at;
		if (stop_reason !== null) {
			state.workspace.stop_reason = stop_reason;
			this._write(run_id, "workspace.json", state.workspace);
		}
		this._write(run_id, "run.json", state.run);
		return state.run;
	}

	resume(run_id) {
		assertExecutableMode(this.get(run_id)?.run.mode);
		if (this.get(run_id)?.run.status === "closed") throw new Error("此分析已经结束；继续核查需用户发起新的问题，不恢复旧预算。");
		this.setStatus(run_id, "running");
		const state = this.get(run_id);
		state.run.pause_after_boundary = false;
		state.workspace.stop_reason = null;
		this._write(run_id, "run.json", state.run);
		this._write(run_id, "workspace.json", state.workspace);
		return state;
	}

	requestPauseAfterBoundary(run_id) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		if (state.run.status === "waiting_user") {
			return this.setStatus(run_id, "paused", "用户要求在当前工作单元结束后暂停；任务已处于安全边界。");
		}
		if (state.run.status !== "running") return state.run;
		state.run.pause_after_boundary = true;
		state.run.pause_requested_at = now();
		state.run.updated_at = state.run.pause_requested_at;
		this._write(run_id, "run.json", state.run);
		return state.run;
	}

	settlePauseAfterBoundary(run_id) {
		const state = this.get(run_id);
		if (!state) throw new Error(`CognitiveRun 不存在: ${run_id}`);
		if (state.run.status !== "running" || state.run.pause_after_boundary !== true) return state.run;
		return this.setStatus(run_id, "paused", "已完成当前最小工作单元，并按用户要求暂停。");
	}

	_runPath(run_id, file) {
		assertCognitiveRunId(run_id);
		const runsRoot = resolve(this.base, "runs");
		const target = resolve(runsRoot, run_id, file);
		if (!target.startsWith(`${runsRoot}\\`) && !target.startsWith(`${runsRoot}/`)) throw new Error("CognitiveRun 路径越界");
		return target;
	}

	_read(run_id, file) { return readJson(this._runPath(run_id, file), null); }
	_write(run_id, file, value) {
		assertExecutableMode(readJson(this._runPath(run_id,"run.json"),null)?.mode);
		if(file==="run.json")assertExecutableMode(value?.mode);
		atomicJson(this._runPath(run_id, file), value);
	}
}

const runtimes = new Map();
export function getCognitiveRuntime(root) {
	const key = resolve(root);
	if (!runtimes.has(key)) runtimes.set(key, new CognitiveRuntime(key));
	return runtimes.get(key);
}

export { sessionIdOf, summarizeWorkspace };
