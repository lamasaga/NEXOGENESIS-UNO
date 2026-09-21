import { observationSatisfiesCapability } from "./thinking-models.js";
import { readingEntries } from "./reading-coverage.js";
import { constructPlanWriteReadiness, constructImprovementCompletion } from "./construct-improvement.js";

function asArray(value) { return Array.isArray(value) ? value : []; }

function successfulWrite(step) {
	return ["write", "proposal"].includes(step?.action?.mode)
		&& step?.observation?.status === "ok"
		&& ["committed", "contributions_skipped"].includes(step?.observation?.reason_code);
}

const ISSUE_DETECTORS = new Set([
	"inspect_unconnected_cards", "inspect_structure_issues", "inspect_knowledge_quality", "inspect_domain_members"
]);

function successfulReview(step) {
	return step?.action?.operator === "record_structure_review"
		&& step?.observation?.status === "ok"
		&& step?.observation?.data?.card_id;
}

function isolatedFocusBefore(steps, index) {
	const step = [...steps.slice(0, index)].reverse().find((item) =>
		item?.action?.operator === "inspect_integration_candidates"
		&& observationSatisfiesCapability(item.observation)
		&& item.observation?.data?.focus_card_id);
	if (!step) return null;
	return {
		card_id: step.observation.data.focus_card_id,
		issue_kind: step.observation.data.issue_scope ?? "without_relations",
		step: step.step
	};
}

function reviewMatches(step, focus) {
	return successfulReview(step)
		&& step.observation.data.card_id === focus.card_id
		&& step.observation.data.issue_kind === focus.issue_kind;
}

/** Construct writes require an explicit lens, a real observation, and a stated local action. */
export function constructWriteReadiness(state, { layer, root, operations, relationRequest } = {}) {
	if (state?.run?.mode !== "construct") return { ready: true };
	const contract = state.workspace?.scope?.construct_request;
	if (contract) {
		if (contract.workload === "advice") return { ready: false, reason_code: "construct_advice_only", summary: "本轮只看建议，不允许修改知识或提交写入提案。" };
		if (layer && contract.changes === "relations" && layer !== "relation") return { ready: false, reason_code: "construct_layer_out_of_scope", summary: "本轮只授权调整关系；内容与组织调整需要另行授权。" };
		const allowed = new Set(contract.card_ids);
		const plans = [...asArray(state.workspace.extension?.improvement_history), state.workspace.extension?.improvement_plan].filter(Boolean);
		// New targets are allowed only when all source cards trace back to this scope.
		for (const plan of plans) if (plan.card_ids?.length && plan.card_ids.every(id => allowed.has(id))) {
			for (const id of plan.target_ids ?? []) if (plan.fingerprints?.[id] == null) allowed.add(id);
		}
		if (asArray(operations).some(op => !allowed.has(op.id)) || (relationRequest && !allowed.has(relationRequest.source_id))) return {
			ready: false, reason_code: "construct_card_out_of_scope", summary: "写入对象不在启动时确认的范围内。可以阅读范围外材料，但不能修改；请另开明确授权的任务。"
		};
	}
	if (root) {
		const planCheck = constructPlanWriteReadiness(root, state, { layer, operations });
		if (!planCheck.ready) return planCheck;
	}
	if (!state.run.thinking_model?.id) return {
		ready: false,
		reason_code: "construct_thinking_model_required",
		summary: "建构尚未选择思考模型；当前只能继续观察，不能修改知识结构。",
		next_actions: [
			{ action: "list_thinking_models", description: "查看与当前结构问题匹配的思考模型" },
			{ action: "select_thinking_model", description: "选择一个主要结构镜头后继续" }
		]
	};
	const validObservations = asArray(state.episode?.steps).filter((step) =>
		["read", "simulate"].includes(step?.action?.mode) && observationSatisfiesCapability(step.observation));
	if (!validObservations.length || !asArray(state.workspace?.observed_nodes).length || !asArray(state.workspace?.evidence).length) return {
		ready: false,
		reason_code: "construct_observation_required",
		summary: "建构尚未留下可审计的结构观察与证据；不能只凭关键词或标题修改关系。",
		next_actions: [
			{ action: "inspect_structure_issues", description: "先从确定性问题队列选择一个局部问题" },
			{ action: "graph_walk", description: "从非领域焦点卡观察真实论证邻域" }
		]
	};
	if (!asArray(state.workspace?.candidate_actions).length && !asArray(state.workspace?.hypotheses).length) return {
		ready: false,
		reason_code: "construct_local_intent_required",
		summary: "建构尚未记录本次局部结构假设或候选操作；请先说明准备修复什么以及依据是什么。",
		next_actions: [{ action: "update_cognitive_workspace", description: "把局部假设或候选操作写入思维工作区" }]
	};
	if (layer === "relation") {
		const steps = asArray(state.episode?.steps);
		const simulation = [...steps].reverse().find((step) => step?.action?.operator === "simulate_relation_patch"
			&& observationSatisfiesCapability(step.observation));
		if (!simulation) return {
			ready: false,
			reason_code: "relation_simulation_required",
			summary: "这项关系调整尚未完成结构化裁决与写前影响模拟。",
			next_actions: [
				{ action: "inspect_relation_case", description: "先读取双方语义、来源、路径与局部影响" },
				{ action: "simulate_relation_patch", description: "明确保留、改型、移除或延期，并检查反证与结构风险" }
			]
		};
		const relationCase = [...steps].reverse().find((step) => Number(step.step) < Number(simulation.step)
			&& step?.action?.operator === "inspect_relation_case" && observationSatisfiesCapability(step.observation)
			&& step.observation?.data?.case_fingerprint === simulation.observation?.data?.case_fingerprint);
		if (!relationCase) return {
			ready: false,
			reason_code: "relation_case_required",
			summary: "写前模拟没有对应的最新关系案件材料，无法确认端点内容在判断期间未变化。",
			next_actions: [{ action: "inspect_relation_case", description: "重新组装当前版本的关系案件后再模拟" }]
		};
		if (relationRequest) {
			const a = simulation.observation?.data?.adjudication, removing = relationRequest.action === "remove";
			const r = removing ? a?.old_relation : a?.proposed_relation;
			const from = r?.from ?? relationCase.observation.data.source_id;
			const to = r?.to ?? r?.target ?? relationCase.observation.data.target_id;
			if (!r || a.decision !== (removing ? "remove" : "change") || from !== relationRequest.source_id || to !== relationRequest.target_id
				|| r.type !== relationRequest.relation_type || (!removing && String(r.note ?? "") !== String(relationRequest.note ?? ""))) return {
				ready: false, reason_code: "construct_relation_simulation_mismatch", summary: "实际提交与通过模拟的关系不同；端点、类型、动作和说明必须对应，不能借用另一条关系的裁决。"
			};
		}
		// Compare the actual endpoints before this simulation, not unrelated cards at the end of the run.
		const pair = [relationCase.observation.data.source_id, relationCase.observation.data.target_id].filter(Boolean);
		if (pair.length === 2 && simulation.observation?.data?.adjudication?.decision === "change") {
			const prior = steps.filter((s) => s.step < simulation.step && observationSatisfiesCapability(s.observation));
			const compared = prior.some((s) => s.action?.operator === "compare_cards" && pair.every((id) => asArray(s.observation?.data?.compared).includes(id)));
			const read = prior.flatMap(readingEntries);
			if (!compared || !pair.every((id) => read.some((r) => r.card_id === id && (r.reading?.coverage === "full" || r.reading?.unit_addresses?.length)))) return {
				ready: false, reason_code: "construct_pair_comparison_required",
				summary: "当前模拟之前没有双方阅读与同题比较的完整记录；即使刚补做比较，旧模拟也不能复用。读齐双方并比较后，重新调用 simulate_relation_patch，再提交。",
				next_actions: [{ action: compared ? "read_card" : "compare_cards", description: "读齐双方并完成同题比较" }, { action: "simulate_relation_patch", description: "在比较之后重新模拟；不能直接重交旧提案" }]
			};
		}
		if (simulation.observation?.data?.adjudication?.decision === "defer") return {
			ready: false,
			reason_code: "relation_adjudication_deferred",
			summary: "本次裁决是延期；它是合法完成结果，但不能转换成关系写入。",
			next_actions: [{ action: "finish_cognitive_run", description: "保留延期理由与缺失证据，结束本次局部治理" }]
		};
		if (!simulation.observation?.data?.preflight_passed) return {
			ready: false,
			reason_code: simulation.observation?.data?.requires_critical_review
				&& !simulation.observation?.data?.critical_review_completed
				? "relation_critical_review_required" : "relation_preflight_incomplete",
			summary: simulation.observation?.data?.requires_critical_review
				&& !simulation.observation?.data?.critical_review_completed
				? "该关系涉及枢纽、跨领域、冲突角色或路径切断，需要再做一次反对性复核。"
				: "关系裁决仍有契约缺口或确定性阻断，不能进入写入预检。",
			next_actions: [{ action: "simulate_relation_patch", description: "补齐反证、方向、边界或高风险批判复核后重新模拟" }]
		};
	}
	return { ready: true };
}

export function constructRunAudit(state) {
	const steps = asArray(state?.episode?.steps);
	const writes = steps.filter(successfulWrite);
	const rejected = steps.filter((step) => ["write", "proposal"].includes(step?.action?.mode)
		&& ["rejected", "conflict", "error"].includes(step?.observation?.status));
	const affectedCards = [...new Set(writes.flatMap((step) => asArray(step.observation?.scope?.card_ids)))];
	const operationCount = writes.reduce((sum, step) => sum + Number(step.observation?.data?.operation_count ?? step.observation?.scope?.card_ids?.length ?? 0), 0);
	const graphObservations = steps.filter((step) => String(step?.action?.operator ?? "").startsWith("graph_")
		|| ["inspect_structure_issues", "inspect_unconnected_cards", "inspect_knowledge_quality", "inspect_domain_members", "inspect_relation_case", "simulate_relation_patch"].includes(step?.action?.operator));
	const issueLedger = asArray(state?.workspace?.extension?.issue_ledger);
	const closure = { discovered: issueLedger.length, fixed: 0, excluded: 0, deferred: 0, kept: 0, open: 0, reopened: 0, new_errors: 0 };
	for (const issue of issueLedger) {
		const status = String(issue?.status ?? "open");
		if (status in closure) closure[status]++;
		else closure.open++;
		if (issue?.reopened) closure.reopened++;
		if (issue?.new_after_write) closure.new_errors++;
	}
	return {
		step_count: steps.length,
		read_count: steps.filter((step) => step?.action?.mode === "read").length,
		graph_observation_count: graphObservations.length,
		committed_transactions: writes.length,
		atomic_operations: operationCount,
		affected_card_count: affectedCards.length,
		affected_cards: affectedCards,
		rejected_write_count: rejected.length,
		rejected_reason_codes: rejected.map((step) => step.observation?.reason_code).filter(Boolean),
		issue_closure: closure,
		improvement: state.workspace?.extension?.improvement_plan ? {
			kind: state.workspace.extension.improvement_plan.kind, status: state.workspace.extension.improvement_plan.status,
			semantic_quality: state.workspace.extension.improvement_plan.review?.semantic_quality ?? "not_reviewed"
		} : null,
		rejected_observation_count: steps.filter((s) => ["rejected", "error", "conflict"].includes(s.observation?.status)).length
	};
}

export function constructCompletionReadiness(state, root, { pending = [] } = {}) {
	if (state?.run?.mode !== "construct") return { ready: true };
	if (state.workspace?.scope?.construct_request?.workload === "advice") {
		const observed = asArray(state.episode?.steps).some(step => ["read", "simulate"].includes(step?.action?.mode) && observationSatisfiesCapability(step.observation));
		return state.run.thinking_model?.id && observed && asArray(state.workspace.evidence).length
			? { ready: true } : { ready: false, reason_code: "construct_observation_required", summary: "建议仍需基于实际阅读与证据，不能未诊断就结束。" };
	}
	const improvement = constructImprovementCompletion(root, state);
	if (!improvement.ready) return improvement;
	if (state.workspace.scope?.continuous_construct) {
		const originalIds = state.workspace.scope?.construct_request?.card_ids;
		const scopeIds = originalIds ? new Set(originalIds) : null;
		const inScope = item => {
			if (!scopeIds) return true;
			const ids = [item?.card_id, ...asArray(item?.card_ids), ...asArray(item?.member_ids)].filter(Boolean);
			return !ids.length || ids.some(id => scopeIds.has(id));
		};
		const unresolved = asArray(state.workspace.extension?.issue_ledger).filter((item) => inScope(item) && !["fixed", "excluded", "kept"].includes(item.status));
		const deferred = asArray(state.workspace.deferred_items).filter((item) => inScope(item) && !["resolved", "excluded"].includes(item?.status));
		const plan = state.workspace.extension?.improvement_plan;
		const historicalDeferred = asArray(state.workspace.extension?.improvement_history).some((item) => item.status === "deferred"
			&& !asArray(state.workspace.deferred_items).some((d) => d?.backlog_id === `plan:${item.id}` && ["resolved", "excluded"].includes(d.status) && d.reason));
		if (unresolved.length || deferred.length || pending.some(inScope) || historicalDeferred || plan?.status === "deferred" || state.workspace.extension?.checkpoint?.next_cursor != null) return {
			ready: false, reason_code: "construct_scope_remaining",
			summary: "局部改善不代表本轮建构全部完成；当前仍有未处理问题或待查页面。可继续选择下一项，确需停止则保留待办并报告部分完成。",
			next_actions: [{ action: "inspect_structure_issues", description: "按当前诊断选择下一项有价值的局部问题，已提交事项只复验。" },
				{ action: "finish_cognitive_run", description: "材料不足或预算边界时，以 blocked 保存实际成果、剩余对象和下一步，不宣称全部完成。" }]
		};
	}
	if (state.workspace.extension?.improvement_plan) return improvement;
	const steps = asArray(state.episode?.steps);
	if (!state.run.thinking_model?.id) return constructWriteReadiness(state);
	let lastWriteIndex = -1;
	for (let index = 0; index < steps.length; index++) if (successfulWrite(steps[index])) lastWriteIndex = index;
	if (lastWriteIndex < 0) {
		const observed = steps.some((step) => ["read", "simulate"].includes(step?.action?.mode)
			&& observationSatisfiesCapability(step.observation));
		const focus = isolatedFocusBefore(steps, steps.length);
		if (focus && !steps.some((step) => Number(step.step) > Number(focus.step) && reviewMatches(step, focus))) return {
			ready: false,
			reason_code: "construct_disposition_required",
			summary: "这张未接入卡虽已比较候选，但尚未形成可续接的处置结论，之后仍会被重复审查。",
			next_actions: [{ action: "record_structure_review", description: "记录暂时独立、近重复、待重分类、待调整领域或具体证据缺口" }]
		};
		const focusedIssue = state.workspace?.extension?.focus_issue;
		const focusedLedger = asArray(state.workspace?.extension?.issue_ledger)
			.find((item) => item.fingerprint === focusedIssue?.issue_id);
		if (focusedLedger && ["open", "pending_verification"].includes(focusedLedger.status)) return {
			ready: false,
			reason_code: "construct_issue_disposition_required",
			summary: "当前选中的结构问题尚未形成修复、排除、延期或保持独立的闭合结论。",
			next_actions: [
				{ action: "inspect_relation_case", description: "若问题涉及关系，先形成完整案件材料" },
				{ action: "simulate_relation_patch", description: "记录保留、改型、移除或延期裁决" }
			]
		};
		return observed && asArray(state.workspace?.evidence).length
			? { ready: true }
			: {
				ready: false,
				reason_code: "construct_observation_required",
				summary: "建构尚未形成任何可审计观察，不能直接标记为完成。",
				next_actions: [{ action: "inspect_structure_issues", description: "先执行一次确定性的结构审计" }]
			};
	}
	const writeReadiness = constructWriteReadiness(state, { layer: steps[lastWriteIndex]?.observation?.scope?.layer ?? steps[lastWriteIndex]?.action?.layer });
	if (!writeReadiness.ready) return writeReadiness;
	if (lastWriteIndex >= 0) {
		const writeStep = steps[lastWriteIndex];
		const affected = new Set(asArray(writeStep.observation?.scope?.card_ids));
		const focus = isolatedFocusBefore(steps, lastWriteIndex);
		const preDetector = [...steps.slice(0, lastWriteIndex)].reverse().find((step) =>
			ISSUE_DETECTORS.has(step?.action?.operator) && observationSatisfiesCapability(step.observation));
		const postSteps = steps.slice(lastWriteIndex + 1);
		let verified = false;
		if (focus) {
			verified = postSteps.some((step) => step?.action?.operator === "inspect_unconnected_cards"
				&& observationSatisfiesCapability(step.observation)
				&& step.observation?.data?.scope === focus.issue_kind
				&& asArray(step.observation?.data?.checked_card_ids).includes(focus.card_id));
			if (verified && !postSteps.some((step) => reviewMatches(step, focus))) return {
				ready: false,
				reason_code: "construct_disposition_required",
				summary: "原问题已经重新检查，但最终处置尚未绑定到当前卡片版本。",
				next_actions: [{ action: "record_structure_review", description: "记录已接入或其它明确处置，使后续任务能够续接" }]
			};
		} else if (preDetector) {
			verified = postSteps.some((step) => step?.action?.operator === preDetector.action.operator
				&& observationSatisfiesCapability(step.observation)
				&& (!affected.size || asArray(step.observation?.evidence).some((item) => affected.has(item?.card_id))
					|| asArray(step.observation?.data?.checked_card_ids).some((id) => affected.has(id))));
		} else {
			verified = postSteps.some((step) => ["read", "simulate"].includes(step?.action?.mode)
				&& observationSatisfiesCapability(step.observation)
				&& (!affected.size || asArray(step.observation?.evidence).some((item) => affected.has(item?.card_id))));
		}
		if (!verified) return {
			ready: false,
			reason_code: "construct_post_write_check_required",
			summary: "最后一次结构写入后尚未用发现该问题的检测方式复核同一对象，不能用无关观察代替验证。",
			next_actions: [
				{ action: focus?.card_id ? "inspect_unconnected_cards" : preDetector?.action?.operator ?? "read_card", description: "用原检测范围精确复核受影响卡，确认原问题已消失或转为明确处置" },
				{ action: "inspect_structure_issues", description: "同时确认没有新增重复边、幽灵目标或非法关系" }
			]
		};
		const pendingClosures = asArray(state.workspace?.extension?.issue_ledger)
			.filter((item) => item.status === "pending_verification" || (item.detector === "inspect_unconnected_cards" && !["fixed", "excluded", "kept", "deferred"].includes(item.status)));
		if (pendingClosures.length) return {
			ready: false,
			reason_code: "construct_issue_closure_required",
			summary: "写后虽发生过复核，但仍有关系裁决没有被原检测器确认闭合。",
			next_actions: [{ action: "inspect_structure_issues", description: "用问题指纹和受影响卡重新检查，确认问题消失或重新打开" }]
		};
	}
	return { ready: true };
}
