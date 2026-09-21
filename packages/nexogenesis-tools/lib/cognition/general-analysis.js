import { modelRequirementStatus, observationSatisfiesCapability } from "./thinking-models.js";
import { readingEntries } from "./reading-coverage.js";
import { explorationBudget } from "./exploration-budget.js";
import { latestVerifiedItems, workingMemoryReadiness, buildWorkingMemory } from "./working-memory.js";

export const GENERAL_ANALYSIS_BUDGET_POLICY = Object.freeze({
	light: Object.freeze({ default_steps: 12, default_reads: 6, min_steps: 8, max_steps: 16, min_reads: 4, max_reads: 8 }),
	standard: Object.freeze({ default_steps: 24, default_reads: 16, min_steps: 20, max_steps: 32, min_reads: 12, max_reads: 20 }),
	deep: Object.freeze({ default_steps: 48, default_reads: 24, min_steps: 40, max_steps: 60, min_reads: 20, max_reads: 32 })
});

export function isAnalyticalRun(state) {
	return ["assess", "report"].includes(state?.run?.mode)
		|| (state?.run?.mode === "general" && state?.workspace?.scope?.analysis_depth === "iterative");
}

function boundedInteger(value, fallback, minimum, maximum) {
	const number = Number(value);
	const requested = Number.isFinite(number) ? Math.floor(number) : fallback;
	return Math.min(maximum, Math.max(minimum, requested));
}

/** Runtime-owned allocation: the model selects a class, while deterministic limits prevent under/over-allocation. */
export function allocateGeneralAnalysisBudget(mode, scope = {}, requestedBudget) {
	if (!isAnalyticalRun({ run: { mode }, workspace: { scope } })) {
		return { scope, budget: requestedBudget, applied: false };
	}
	const complexity = Object.hasOwn(GENERAL_ANALYSIS_BUDGET_POLICY, scope.complexity_level)
		? scope.complexity_level : "standard";
	const policy = GENERAL_ANALYSIS_BUDGET_POLICY[complexity];
	return {
		applied: true,
		scope: { ...scope, analysis_depth: "iterative", complexity_level: complexity },
		budget: {
			max_steps: boundedInteger(requestedBudget?.max_steps, policy.default_steps, policy.min_steps, policy.max_steps),
			max_reads: boundedInteger(requestedBudget?.max_reads, policy.default_reads, policy.min_reads, policy.max_reads),
			max_writes: 0
		},
		policy
	};
}

const NON_SUBSTANTIVE_OPERATORS = new Set([
	"start_cognitive_run", "select_thinking_model", "inspect_cognitive_workspace",
	"update_cognitive_workspace", "inspect_cognitive_sufficiency", "finish_cognitive_run"
]);

function validStepsAfterModel(state) {
	return (state?.episode?.steps ?? []).filter((step) =>
		observationSatisfiesCapability(step.observation)
	);
}

function readCardIds(step) {
	return readingEntries(step).filter((entry) => entry.reading?.coverage === "full" || entry.reading?.unit_addresses?.length)
		.map((entry) => entry.card_id).filter(Boolean);
}

export function verifiedEvidenceAnchors(state) {
	return latestVerifiedItems(state).map(({ anchor, role, claim_id }) => ({ anchor, role, claim_id }));
}

function graphProgress(steps) {
	const walks = steps.filter((step) => step.action?.operator === "graph_walk");
	const attempted = walks.some((step) => Number(step.observation?.data?.requested_hops ?? step.observation?.data?.hops ?? 0) >= 2);
	const reached = walks.filter((step) => Number(step.observation?.data?.reached_hops ?? 0) >= 2);
	const hop2Cards = new Set(reached.flatMap((step) =>
		(step.observation?.data?.nodes ?? []).filter((node) => Number(node?.hop ?? 0) >= 2).map((node) => String(node.id))
	));
	const lastReachedStep = reached.reduce((maximum, step) => Math.max(maximum, Number(step.step ?? 0)), 0);
	const readHop2 = steps.some((step) =>
		Number(step.step ?? 0) > lastReachedStep
		&& readCardIds(step).some((cardId) => hop2Cards.has(cardId))
	);
	const gapRecorded = steps.some((step) => step.action?.operator === "graph_note")
		|| steps.some((step) => Boolean(step.observation?.data?.graph_gap));
	return {
		attempted_two_hops: attempted,
		reached_two_hops: reached.length > 0,
		hop2_card_count: hop2Cards.size,
		read_hop2_card: readHop2,
		gap_recorded: gapRecorded
	};
}

function evidenceProgress(steps) {
	const inspections = steps.filter((step) => step.action?.operator === "inspect_evidence_set");
	const latest = inspections.at(-1)?.observation?.data;
	const roles = new Set(latest?.roles_present ?? []);
	return {
		inspected: Boolean(latest),
		has_support: roles.has("support"),
		has_counter_or_boundary: roles.has("counter") || roles.has("boundary"),
		uncovered_claims: latest?.uncovered_claims ?? [],
		roles_present: [...roles]
	};
}

function distinctReadTargets(steps) {
	return new Set(steps
		.flatMap(readCardIds));
}

function insightCandidateIds(step) {
	const data = step?.observation?.data ?? {};
	if (step?.action?.operator === "probe_assumption_inversion") {
		return new Set((data.candidate_ids ?? []).map(String).filter(Boolean));
	}
	if (step?.action?.operator === "trace_support_to_tension") {
		return new Set([
			...(data.tension?.opponent_ids ?? []),
			...(data.tension?.conflict_card_ids ?? [])
		].map(String).filter(Boolean));
	}
	return new Set();
}

function deepThinkingProgress(steps) {
	const valid = (operator) => steps.filter((step) => step.action?.operator === operator);
	const argument = valid("inspect_argument").at(-1);
	const analysisStep = Number(argument?.step ?? Number.POSITIVE_INFINITY);
	const retrievalsBeforeAnalysis = steps.filter((step) =>
		step.action?.operator === "retrieve" && Number(step.step ?? 0) < analysisStep
	);
	const readsBeforeAnalysis = new Set(steps.filter((step) =>
		Number(step.step ?? 0) < analysisStep
	).flatMap(readCardIds));
	const twoHopBeforeAnalysis = steps.some((step) => step.action?.operator === "graph_walk"
		&& Number(step.step ?? 0) < analysisStep
		&& Number(step.observation?.data?.requested_hops ?? step.observation?.data?.hops ?? 0) >= 2);
	const comparison = valid("compare_cards").find((step) => Number(step.step ?? 0) > Number(argument?.step ?? Number.POSITIVE_INFINITY));
	const insight = steps.find((step) => ["trace_support_to_tension", "probe_assumption_inversion"].includes(step.action?.operator)
		&& Number(step.step ?? 0) > Number(comparison?.step ?? Number.POSITIVE_INFINITY));
	const insightTargets = insightCandidateIds(insight);
	const insightRead = insightTargets.size === 0 ? null : steps.find((step) =>
		Number(step.step ?? 0) > Number(insight?.step ?? Number.POSITIVE_INFINITY)
		&& readCardIds(step).some((cardId) => insightTargets.has(cardId))
	);
	const insightClosedAt = insightTargets.size === 0
		? Number(insight?.step ?? Number.POSITIVE_INFINITY)
		: Number(insightRead?.step ?? Number.POSITIVE_INFINITY);
	const analogy = valid("graph_analogize").find((step) => Number(step.step ?? 0) > insightClosedAt);
	const analogyTargets = new Set((analogy?.observation?.data?.nodes ?? []).map((item) => String(item?.id ?? "")).filter(Boolean));
	const analogyRead = analogyTargets.size === 0 ? null : steps.find((step) =>
		Number(step.step ?? 0) > Number(analogy?.step ?? Number.POSITIVE_INFINITY)
		&& readCardIds(step).some((cardId) => analogyTargets.has(cardId))
	);
	const analogyClosedAt = analogyTargets.size === 0 ? Number(analogy?.step ?? Number.POSITIVE_INFINITY) : Number(analogyRead?.step ?? Number.POSITIVE_INFINITY);
	const conflict = valid("inspect_conflicts").find((step) => Number(step.step ?? 0) > analogyClosedAt);
	const counterRead = steps.find((step) => Number(step.step ?? 0) > Number(conflict?.step ?? Number.POSITIVE_INFINITY)
		&& readCardIds(step).length > 0);
	const evidenceInspection = valid("inspect_evidence_set").find((step) => Number(step.step ?? 0) > Number(counterRead?.step ?? Number.POSITIVE_INFINITY));
	const anchorVerification = valid("verify_evidence_anchors").find((step) => Number(step.step ?? 0) > Number(evidenceInspection?.step ?? Number.POSITIVE_INFINITY));
	return {
		retrievals_before_analysis: retrievalsBeforeAnalysis.length,
		distinct_reads_before_analysis: readsBeforeAnalysis.size,
		two_hop_before_analysis: twoHopBeforeAnalysis,
		argument_inspected: Boolean(argument),
		comparison_after_argument: Boolean(comparison),
		insight_after_comparison: Boolean(insight),
		insight_operator: insight?.action?.operator ?? null,
		insight_candidate_count: insightTargets.size,
		insight_candidate_read: insightTargets.size === 0 || Boolean(insightRead),
		analogy_after_insight: Boolean(analogy),
		analogy_candidate_count: analogyTargets.size,
		analogy_candidate_read: analogyTargets.size === 0 || Boolean(analogyRead),
		conflict_check_after_analogy: Boolean(conflict),
		counter_read_after_conflict: Boolean(counterRead),
		evidence_inspection_after_counter: Boolean(evidenceInspection),
		anchor_verification_after_inspection: Boolean(anchorVerification)
	};
}

function action(action, description) { return { action, description }; }

/**
 * Check whether one iterative general-analysis run may be completed.
 * This records observable progress only; it does not expose or require hidden reasoning.
 */
export function generalAnalysisReadiness(state, registry, { require_sufficiency_observation = false } = {}) {
	if (!isAnalyticalRun(state)) {
		return { ready: true, applicable: false, missing: [], next_actions: [], evidence_anchors: [] };
	}
	const steps = validStepsAfterModel(state);
	const anchors = verifiedEvidenceAnchors(state);
	const graph = graphProgress(steps);
	const evidence = evidenceProgress(steps);
	const exploration = explorationBudget(state);
	const complexity = state.workspace.scope?.complexity_level ?? "standard";
	const readTargets = distinctReadTargets(steps);
	const minimumReadTargets = complexity === "deep" ? 4 : complexity === "light" ? 1 : 2;
	const deepThinking = state.run.skill === "nexo-deep-think"
		|| state.workspace.scope?.execution_profile === "deep-think-v1";
	const deepProgress = deepThinking ? deepThinkingProgress(steps) : null;
	const missing = [];
	const nextActions = [];

	if (!state.run.thinking_model?.id) {
		missing.push("thinking_model");
		nextActions.push(action("select_thinking_model", "先为当前问题选择一个适用的 Thinking Model。"));
	} else {
		const requirements = modelRequirementStatus(state, registry, { evidence_anchors: anchors });
		if (requirements.missing_capabilities.length) {
			missing.push(...requirements.missing_capabilities.map((item) => `capability:${item}`));
			nextActions.push(action("inspect_operator_contracts", "补齐当前 Thinking Model 尚未执行的能力。"));
		}
		if (requirements.unmet_observation_obligations.length) {
			missing.push("observation_obligations");
			nextActions.push(action("continue_observation", "补齐 Thinking Model 要求的观察对象、语义角色或精读。"));
		}
		if (requirements.missing_output_obligations.length) missing.push(...requirements.missing_output_obligations.map((item) => `output:${item}`));
	}

	if (!evidence.inspected) {
		missing.push("evidence_inspection");
		nextActions.push(action("inspect_evidence_set", "检查支持、反证、边界与来源独立性。"));
	} else {
		if (!evidence.has_support) missing.push("support_evidence");
		if (!evidence.has_counter_or_boundary) missing.push("counter_or_boundary_evidence");
		const reviewedAbsence = (state.workspace.extension?.challenge_reviews ?? []).some((review) =>
			review.outcome === "not_found" && String(review.finding ?? "").trim() && String(review.limitation ?? "").trim()
			&& (state.workspace.hypotheses ?? []).some((claim) => claim.id === review.claim_id)
			&& steps.some((step) => step.step === review.operation_step && ["retrieve", "inspect_conflicts", "inspect_argument", "probe_assumption_inversion"].includes(step.action?.operator)));
		if (complexity === "deep" && !evidence.roles_present.includes("counter") && (!reviewedAbsence || deepThinking)) missing.push("counter_evidence_or_reviewed_search");
		if (complexity === "deep" && !evidence.roles_present.includes("boundary")) missing.push("boundary_evidence");
		if (evidence.uncovered_claims.length) missing.push("uncovered_claims");
		if (!evidence.has_support || !evidence.has_counter_or_boundary || evidence.uncovered_claims.length
			|| (complexity === "deep" && ((!evidence.roles_present.includes("counter") && (!reviewedAbsence || deepThinking)) || !evidence.roles_present.includes("boundary")))) {
			nextActions.push(action("read_card", "精读缺失角色的证据；普通 deep 定向挑战后确无反例，可在 challenge_reviews 记录真实检查与局限，不能把边界改标反例。"));
		}
	}
	if (readTargets.size < minimumReadTargets) {
		missing.push("distinct_read_targets");
		nextActions.push(action("read_card", `当前档位至少精读 ${minimumReadTargets} 个不同对象；还需补充有区分度的正文证据。`));
	}
	if (!anchors.length) {
		missing.push("verified_evidence_anchors");
		nextActions.push(action("verify_evidence_anchors", "核验准备进入回答的核心证据地址。"));
	}
	const memoryReadiness = complexity === "deep" ? workingMemoryReadiness(state) : null;
	if (memoryReadiness && !memoryReadiness.ready) {
		missing.push(...memoryReadiness.missing);
		nextActions.push(action("update_cognitive_workspace", "根据 working_memory 的实际发现补读或探索；整理 hypotheses 的结论、范围、未知项和证据，以及 insight_reviews 的探索结果。不要伪造洞见。"));
	}
	const inspection = steps.filter((step) => step.action?.operator === "inspect_evidence_set").at(-1);
	const verification = steps.filter((step) => step.action?.operator === "verify_evidence_anchors").at(-1);
	const signature = (items) => JSON.stringify((items ?? []).map((item) => `${item.anchor}|${item.role}|${item.claim_id}`).sort());
	if (inspection && verification && signature(inspection.observation.data?.results) !== signature(verification.observation.data?.results)) {
		missing.push("evidence_snapshot_mismatch");
		nextActions.push(action("inspect_evidence_set", "证据角色或条目已经改变；对最终同一组证据重新检查并核验，不能混用旧快照。"));
	}

	if (deepThinking) {
		if (complexity !== "deep") {
			missing.push("deep_thinking_complexity");
			nextActions.push(action("start_cognitive_run", "深入思考测试必须以 deep 档建立独立 Run。"));
		}
		if (state.run.thinking_model?.id !== "deep-inquiry") {
			missing.push("deep_inquiry_model");
			nextActions.push(action("select_thinking_model", "深入思考测试必须选择 deep-inquiry。"));
		}
		for (const [condition, code, operator, description] of [
			[deepProgress.retrievals_before_analysis >= 2, "two_retrieval_angles", "retrieve", "在机制分析前使用第二个有区分度的查询角度。"],
			[deepProgress.distinct_reads_before_analysis >= 3, "collection_reads", "read_card", "进入机制分析前精读至少三张不同卡片。"],
			[deepProgress.two_hop_before_analysis, "collection_two_hop", "graph_walk", "在机制分析前从焦点卡执行一次两跳观察。"],
			[deepProgress.argument_inspected, "argument_inspection", "inspect_argument", "检查焦点判断的支持、冲突和边界。"],
			[deepProgress.comparison_after_argument, "semantic_comparison", "compare_cards", "在论证检查后比较至少两个对象。"],
			[deepProgress.insight_after_comparison, "controlled_insight_probe", "trace_support_to_tension", "在机制比较后，根据当前结构选择支持链寻张力或假设反转中的一种特殊 OPS。"],
			[deepProgress.insight_candidate_read, "insight_candidate_read", "read_card", "特殊 OPS 返回候选时，至少精读一张再判断它是否改变结论。"],
			[deepProgress.analogy_after_insight, "cross_domain_analogy", "graph_analogize", "在受控认知偏移后执行跨领域结构类比。"],
			[deepProgress.analogy_candidate_read, "analogy_candidate_read", "read_card", "精读至少一张类比候选，再判断对应结构和断裂点。"],
			[deepProgress.conflict_check_after_analogy, "counterexample_search", "inspect_conflicts", "在类比后主动检查冲突或反方。"],
			[deepProgress.counter_read_after_conflict, "counterexample_read", "read_card", "冲突检查后新增一次反例或边界正文精读。"],
			[deepProgress.evidence_inspection_after_counter, "fresh_evidence_inspection", "inspect_evidence_set", "在最后一次反例精读后重新检查证据集合。"],
			[deepProgress.anchor_verification_after_inspection, "fresh_anchor_verification", "verify_evidence_anchors", "在最终证据集合检查后重新核验锚点。"]
		]) {
			if (condition) continue;
			missing.push(code);
			nextActions.push(action(operator, description));
		}
	}

	if (state.workspace.scope?.structure_need === "required") {
		if (!graph.attempted_two_hops) {
			missing.push("two_hop_attempt");
			nextActions.push(action("graph_walk", "从焦点卡执行一次两跳结构观察。"));
		} else if (graph.reached_two_hops && !graph.read_hop2_card) {
			missing.push("hop2_card_read");
			nextActions.push(action("read_card", "精读至少一张两跳新到达的卡片。"));
		} else if (!graph.reached_two_hops && !graph.gap_recorded) {
			missing.push("graph_gap_not_recorded");
			nextActions.push(action("graph_note", "记录图中未形成有效两跳路径的结构缺口。"));
		}
	}

	const latestSubstantive = steps.filter((step) => !NON_SUBSTANTIVE_OPERATORS.has(step.action?.operator)
		|| (step.action?.operator === "update_cognitive_workspace" && ["hypotheses", "scope", "extension"].some((field) => step.observation?.data?.fields?.includes(field))))
		.at(-1)?.step ?? -1;
	const latestSufficiency = steps.filter((step) => step.action?.operator === "inspect_cognitive_sufficiency").at(-1);
	if (require_sufficiency_observation && (!latestSufficiency
		|| latestSufficiency.observation?.data?.ready !== true
		|| Number(latestSufficiency.step ?? -1) <= Number(latestSubstantive))) {
		missing.push("fresh_sufficiency_check");
		nextActions.push(action("inspect_cognitive_sufficiency", "在最后一次知识观察后重新检查信息是否足够。"));
	}

	return {
		ready: missing.length === 0,
		applicable: true,
		missing: [...new Set(missing)],
		next_actions: [...new Map([
			...(missing.length && exploration.applicable && exploration.gaps.length && exploration.discovery_calls_available > 0 && exploration.frontier.length
				? [action(exploration.frontier[0].next_action, "信息仍不足：按 working_memory.exploration_budget.frontier 先补读桥接候选，确认相关后从它继续有限多跳；不是重复从原点扩大范围。")]
				: []), ...nextActions
		].map((item) => [item.action, item])).values()].slice(0, 4),
		evidence_anchors: anchors,
		working_memory: memoryReadiness?.working_memory ?? buildWorkingMemory(state),
		progress: {
			complexity_level: complexity,
			budget: state.workspace.budget,
			graph, evidence, exploration,
			distinct_read_targets: readTargets.size,
			minimum_read_targets: minimumReadTargets,
			observed_nodes: state.workspace.observed_nodes?.length ?? 0,
			...(deepProgress ? { deep_thinking: deepProgress } : {})
		}
	};
}
