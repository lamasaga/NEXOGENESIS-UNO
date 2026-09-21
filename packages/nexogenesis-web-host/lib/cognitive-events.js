import { randomUUID } from "node:crypto";
import { buildGraphEdges } from "./graph.js";

const OPERATOR_LABELS = {
	start_cognitive_run: "开始本轮任务",
	inspect_cognitive_workspace: "查看进度与待办",
	read_card_unit: "精读卡片内容",
	inspect_knowledge_quality: "检查知识质量",
	list_thinking_models: "查看可用分析方法",
	retrieve: "检索候选知识",
	graph_search: "定位知识焦点",
	read_card: "精读知识卡片",
	read_cards: "批量精读知识卡片",
	graph_walk: "沿论证关系展开",
	trace_support_to_tension: "沿支持链寻找首个张力",
	probe_assumption_inversion: "反转关键假设并检索",
	graph_path: "验证知识路径",
	inspect_argument: "检查论证依据",
	graph_members: "查看领域成员",
	inspect_structure_issues: "扫描结构问题",
	inspect_knowledge_gap: "复查完整正文中的知识线索",
	plan_construct_improvement: "确定知识整理方案与保留边界",
	review_construct_improvement: "复核知识整理的实际结果",
	inspect_domain_members: "审视领域成员",
	compare_cards: "对照知识卡片",
	compare_nodes: "对照知识卡片（兼容入口）",
	inspect_conflicts: "检查冲突结构",
	graph_analogize: "寻找跨域类比",
	trace_source: "追溯来源依据",
	graph_note: "记录结构待办",
	inspect_evidence_set: "审视证据角色与覆盖",
	verify_evidence_anchors: "核验证据锚点",
	inspect_cognitive_sufficiency: "判断证据是否足够",
	inspect_source_map: "检查材料结构",
	read_source_slice: "读取材料片段",
	audit_source_coverage: "核对材料覆盖",
	audit_buffer_roles: "复核质料角色分布",
	inspect_unconnected_cards: "检查未连接卡片",
	inspect_integration_candidates: "比较结构接入候选",
	inspect_entity_candidates: "核对实体枢纽候选",
	inspect_relation_case: "核对一组知识联系",
	simulate_relation_patch: "预演关系调整影响",
	record_structure_review: "保存结构审阅结论",
	simulate_split_domain: "模拟领域拆分",
	reassign_members: "调整领域成员",
	assign_domain_members: "归入领域成员",
	propose_domain_retirement: "提出领域退役",
	propose_semantic_patch: "整合知识贡献",
	record_card_integration_decision: "确认新卡结构边界",
	update_cognitive_workspace: "整理思维工作区",
	select_thinking_model: "选择思考模型",
	finish_cognitive_run: "收束本轮思考",
	propose_write: "提出知识变更",
	propose_relation_patch: "提出关系调整",
	propose_card_reclassification: "校准知识对象类型",
	user_write_decision: "完成结构化写入",
	write_buffer: "沉淀编译质料"
};

/** Presentation only. Structured observations retain exact identifiers for diagnostics. */
export function userFacingProgress(value) {
	const terms = { ...OPERATOR_LABELS, candidate_actions: "后续安排", deferred_items: "待办事项",
		observed_nodes: "已检查的知识", open_questions: "待解问题", counter_evidence: "反对证据",
		issue_ledger: "结构问题记录", recovery_review: "上次未完成事项", stop_reason: "停止原因",
		working_memory: "本轮发现", fully_isolated: "无卡间关系", without_relations: "无卡间关系",
		without_ready_relations: "无可推理关系", without_domain: "无领域归属",
		completed: "已完成", blocked: "尚未完成", failed: "执行失败", cancelled: "已停止",
		pending: "待处理", ready: "可用", extension: "补充记录", hypotheses: "待验证判断",
		budget: "可用额度", evidence: "证据", scope: "处理范围", goal: "目标", conflicts: "分歧",
		Workspace: "本轮工作记录", Harness: "写入校验", GraphOps: "知识关系检查", TM: "分析方法", OPS: "知识操作",
		Card: "知识卡片", Buffer: "待消化材料", Inbox: "待处理材料", body: "正文", turn: "执行回合" };
	return String(value ?? "").replace(/\b[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z_]+)*\b/g, (word) => terms[word]
		?? (/^(?:run|CognitiveRun)$/i.test(word) ? "任务" : /^(?:Workspace|Harness|GraphOps|OPS|TM|body)$/i.test(word) ? "内部处理"
			: word.includes("_") ? "处理项" : word));
}

function asId(value) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cardIdFromAnchor(value) {
	const anchor = asId(value);
	return anchor ? anchor.split("#", 1)[0] : null;
}

function uniqueIds(values) {
	return [...new Set(values.map(asId).filter(Boolean))];
}

function idsFromEvidence(observation) {
	return (observation?.evidence ?? []).map((item) => asId(item?.card_id)).filter(Boolean);
}

function edgeIdsFor(projectRoot, descriptors = [], graphEdges = null) {
	if (!Array.isArray(descriptors) || descriptors.length === 0) return [];
	const edges = graphEdges ?? buildGraphEdges(projectRoot);
	return edges.filter((edge) => descriptors.some((descriptor) =>
		edge.from === descriptor?.from
		&& edge.to === descriptor?.to
		&& (descriptor?.declared_type
			? edge.relation_type === descriptor.declared_type
			: (!descriptor?.type || edge.relation_type === descriptor.type || edge.kind === descriptor.type))
	)).map((edge) => edge.id);
}

function targetsFrom(observation, args, projectRoot) {
	// 兼容早期 trusted 写入把 Harness receipt 嵌在 data.receipt 的运行记录。
	const data = observation?.data?.receipt?.data ?? observation?.data ?? {};
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	const evidenceResults = Array.isArray(data.results) ? data.results.filter((item) => item && typeof item === "object") : [];
	const evidenceRoles = Object.fromEntries(["support", "counter", "boundary", "background", "inference"].map((role) => [
		role,
		uniqueIds(evidenceResults.filter((item) => item.role === role && item.exists !== false).map((item) => item.card_id))
	]));
	const sufficiencyIds = uniqueIds((Array.isArray(data.evidence_anchors) ? data.evidence_anchors : [])
		.map((item) => cardIdFromAnchor(typeof item === "string" ? item : item?.anchor)));
	const nodeIds = new Set([
		...nodes.map((node) => asId(node?.id)),
		...idsFromEvidence(observation),
		asId(data.start), asId(args?.card_id), asId(args?.id),
		asId(data.focus_card_id), asId(data.card_id),
		asId(data.source_id), asId(data.target_id),
		asId(args?.source_id), asId(args?.target_id),
		...(Array.isArray(data.checked_card_ids) ? data.checked_card_ids.map(asId) : []),
		...(Array.isArray(data.resolved_card_ids) ? data.resolved_card_ids.map(asId) : []),
		...(Array.isArray(data.candidate_ids) ? data.candidate_ids.map(asId) : []),
		...(Array.isArray(data.tension?.node_ids) ? data.tension.node_ids.map(asId) : []),
		...(Array.isArray(data.tension?.opponent_ids) ? data.tension.opponent_ids.map(asId) : []),
		...(Array.isArray(data.tension?.conflict_card_ids) ? data.tension.conflict_card_ids.map(asId) : []),
		// read_cards 的正式结果在 data.results 中；保留它可使老运行记录即使缺少 evidence
		// 也能把每张确实读到的卡片投影给前端。
		...(Array.isArray(data.results) ? data.results.map((item) => asId(item?.card_id)) : []),
		...sufficiencyIds,
		...(Array.isArray(args?.candidate_ids) ? args.candidate_ids.map(asId) : []),
		...(Array.isArray(data.parties) ? data.parties.map(asId) : []),
		...(Array.isArray(data.covering_conflicts) ? data.covering_conflicts.map(asId) : []),
		...(Array.isArray(data.compared) ? data.compared.map(asId) : []),
		asId(data.from), asId(data.to),
		...(Array.isArray(data.paths) ? data.paths.flatMap((path) => path?.node_ids ?? []).map(asId) : []),
		...(Array.isArray(data.existing_paths) ? data.existing_paths.flatMap((path) => path?.node_ids ?? []).map(asId) : [])
	].filter(Boolean));
	for (const id of [...(data.created ?? []), ...(data.enriched ?? [])]) {
		if (asId(id)) nodeIds.add(asId(id));
	}
	const descriptors = [
		...nodes.map((node) => node?.edge).filter(Boolean),
		...(Array.isArray(data.direct_relations) ? data.direct_relations : []),
		...(Array.isArray(data.edges) ? data.edges : []),
		...(Array.isArray(data.party_edges) ? data.party_edges : []),
		...(Array.isArray(data.supports) ? data.supports : []),
		...(Array.isArray(data.based_on) ? data.based_on : []),
		...(Array.isArray(data.conflicts) ? data.conflicts : []),
		...(Array.isArray(data.related_edges) ? data.related_edges : []),
		...(Array.isArray(data.tension?.edges) ? data.tension.edges : []),
		...(Array.isArray(data.support_layers) ? data.support_layers.flatMap((layer) => layer?.edges ?? []) : []),
		...(Array.isArray(data.paths) ? data.paths.flatMap((path) => path?.edges ?? []) : []),
		...(asId(args?.source_id) && asId(args?.target_id) && asId(args?.relation_type)
			? [{ from: asId(args.source_id), to: asId(args.target_id), type: asId(args.relation_type) }]
			: [])
	];
	const pathLayers = [];
	for (const path of Array.isArray(data.paths) ? data.paths : []) {
		const pathNodes = Array.isArray(path?.node_ids) ? path.node_ids : [];
		const pathEdges = Array.isArray(path?.edges) ? path.edges : [];
		for (let index = 0; index < pathEdges.length; index++) {
			const depth = index + 1;
			let layer = pathLayers.find((candidate) => candidate.depth === depth);
			if (!layer) {
				layer = { depth, node_ids: [], source_ids: [], edges: [], truncated: false };
				pathLayers.push(layer);
			}
			layer.node_ids.push(pathNodes[index + 1]);
			layer.source_ids.push(pathNodes[index]);
			layer.edges.push(pathEdges[index]);
		}
	}
	const supportTrace = Array.isArray(data.support_layers);
	const rawWalkLayers = supportTrace ? data.support_layers
		: Array.isArray(data.layers) && data.layers.length ? data.layers : pathLayers;
	const graphEdges = descriptors.length || rawWalkLayers.length ? buildGraphEdges(projectRoot) : [];
	const walkLayers = rawWalkLayers.map((layer) => {
		const layerEdges = Array.isArray(layer?.edges) ? layer.edges : [];
		const readyEdges = layerEdges.filter((edge) => edge?.ready !== false && edge?.readiness !== "legacy_candidate");
		const legacyEdges = layerEdges.filter((edge) => edge?.ready === false || edge?.readiness === "legacy_candidate");
		return {
			depth: Math.min(supportTrace ? 6 : 3, Math.max(1, Number(layer?.depth ?? 1))),
			node_ids: (Array.isArray(layer?.node_ids) ? layer.node_ids : []).map(asId).filter(Boolean).slice(0, 24),
			edge_ids: edgeIdsFor(projectRoot, layerEdges, graphEdges).slice(0, 24),
			ready_edge_ids: edgeIdsFor(projectRoot, readyEdges, graphEdges).slice(0, 24),
			legacy_edge_ids: edgeIdsFor(projectRoot, legacyEdges, graphEdges).slice(0, 24),
			source_ids: (Array.isArray(layer?.source_ids) ? layer.source_ids : []).map(asId).filter(Boolean).slice(0, 24),
			truncated: Boolean(layer?.truncated)
		};
	}).filter((layer) => layer.node_ids.length || layer.edge_ids.length);
	return {
		node_ids: [...nodeIds].slice(0, 24),
		edge_ids: edgeIdsFor(projectRoot, descriptors, graphEdges).slice(0, 24),
		source_ids: uniqueIds([asId(data.start), asId(data.from), asId(data.source_id), asId(args?.from_id), asId(args?.source_id), asId(args?.card_id), asId(args?.id)]),
		domain_ids: [asId(data.domain_id), ...(Array.isArray(data.shared_domains) ? data.shared_domains.map(asId) : [])].filter(Boolean),
		created: (Array.isArray(data.created) ? data.created : []).map(asId).filter(Boolean),
		enriched: (Array.isArray(data.enriched) ? data.enriched : []).map(asId).filter(Boolean),
		...(walkLayers.length || supportTrace ? {
			walk_layers: walkLayers,
			walk_requested_depth: Math.min(supportTrace ? 6 : 3, Math.max(1, Number(data.hops ?? data.max_hops ?? data.requested_hops ?? data.requested_depth ?? walkLayers.length))),
			walk_reached_depth: Math.min(supportTrace ? 6 : 3, Math.max(0, Number(data.reached_hops ?? data.reached_depth ?? walkLayers.at(-1)?.depth ?? 0)))
		} : {}),
		graph_plane: data.plane ?? (String(data.channel ?? "").startsWith("context") ? "context" : undefined),
		insight_tension_node_ids: (Array.isArray(data.tension?.node_ids) ? data.tension.node_ids : []).map(asId).filter(Boolean),
		insight_tension_edge_ids: edgeIdsFor(projectRoot, Array.isArray(data.tension?.edges) ? data.tension.edges : [], graphEdges),
		insight_anchor_ids: (Array.isArray(data.tension?.anchor_ids) ? data.tension.anchor_ids : []).map(asId).filter(Boolean),
		insight_candidate_ids: (Array.isArray(data.candidate_ids) ? data.candidate_ids : []).map(asId).filter(Boolean),
		insight_stop_reason: asId(data.stop_reason),
		evidence_role_node_ids: evidenceRoles,
		evidence_valid_node_ids: uniqueIds(evidenceResults.filter((item) => item.usable === true).map((item) => item.card_id)),
		evidence_invalid_node_ids: uniqueIds(evidenceResults.filter((item) => item.usable !== true && item.exists !== false).map((item) => item.card_id)),
		evidence_claim_count: Array.isArray(data.claims) ? data.claims.length : 0,
		evidence_all_valid: data.all_deterministic_checks_passed === true,
		sufficiency_node_ids: sufficiencyIds,
		sufficiency_ready: data.ready === true,
		sufficiency_missing: Array.isArray(data.missing) ? data.missing.map(String).slice(0, 12) : [],
		relation_decision: asId(data.adjudication?.decision ?? args?.decision ?? args?.action),
		relation_source_id: asId(data.adjudication?.proposed_relation?.from ?? data.adjudication?.old_relation?.from ?? data.source_id ?? args?.proposed_source_id ?? args?.source_id),
		relation_target_id: asId(data.adjudication?.proposed_relation?.to ?? data.adjudication?.old_relation?.to ?? data.target_id ?? args?.proposed_target_id ?? args?.target_id),
		relation_type: asId(data.adjudication?.proposed_relation?.type ?? data.adjudication?.old_relation?.type ?? data.requested_relation_type ?? args?.proposed_relation_type ?? args?.relation_type),
		relation_preflight_passed: data.preflight_passed === true
	};
}

function toneOf(observation, operator) {
	if (["rejected", "error", "cancelled"].includes(observation?.status)) return "warning";
	if (operator === "finish_cognitive_run" && observation?.data?.review_ref) return "evidence";
	if (operator === "finish_cognitive_run" && observation?.data?.status !== "completed") return "warning";
	if (observation?.reason_code === "committed" || observation?.data?.receipt?.reason_code === "committed") return "success";
	if (operator === "inspect_conflicts" || (operator === "trace_support_to_tension" && observation?.data?.tension?.found)) return "conflict";
	if (["trace_source", "read_card", "read_cards", "inspect_argument"].includes(operator)) return "evidence";
	if (["finish_cognitive_run", "write_buffer"].includes(operator)) return "success";
	return "active";
}

function eventKindOf(phase, operator, observation) {
	if (phase === "started") return "op.started";
	if (operator === "select_thinking_model" && observation?.status === "ok") return "tm.selected";
	if (operator === "update_cognitive_workspace" && observation?.status === "ok") return "workspace.updated";
	if (operator === "finish_cognitive_run" && observation?.status === "ok") {
		if (observation?.data?.status === "completed") return "run.completed";
		if (observation?.data?.status === "cancelled") return "run.cancelled";
		if (observation?.data?.status === "failed") return "run.failed";
		return "op.observed";
	}
	if (operator === "user_write_decision" && observation?.status === "ok") return "write.applied";
	const receiptData = observation?.data?.receipt?.data ?? observation?.data ?? {};
	const committed = observation?.reason_code === "committed"
		|| observation?.data?.receipt?.reason_code === "committed"
		|| (observation?.status === "ok" && (Array.isArray(receiptData.created) || Array.isArray(receiptData.enriched)));
	if (committed && ["propose_write", "propose_relation_patch", "propose_card_reclassification", "propose_semantic_patch", "reassign_members", "assign_domain_members", "propose_domain_retirement"].includes(operator)) {
		return "write.applied";
	}
	if (["propose_write", "propose_relation_patch", "propose_card_reclassification", "propose_semantic_patch"].includes(operator) && observation?.status !== "rejected") return "proposal.created";
	return "op.observed";
}

/**
 * Convert one real tool lifecycle edge plus its persisted Episode step into a
 * compact Web event. It is a projection, never a second source of truth.
 */
export function projectCognitiveEvent({ sessionId, state, operator, args = {}, toolCallId, phase = "observed", projectRoot }) {
	const steps = state?.episode?.steps ?? [];
	const latestStep = phase === "started" ? null : steps.at(-1) ?? null;
	const exactStep = phase === "started" ? null : [...steps].reverse().find((item) => item?.action?.operator === operator) ?? null;
	// 某些 GraphOps 会把可判定的误用纠正为真实操作（如领域卡 walk → members）。
	// 结果阶段以 Episode 最新实际步骤为准，避免动画继续展示模型最初选错的工具。
	const autoCorrected = latestStep?.observation?.data?.auto_corrected_from?.operator === operator;
	const step = autoCorrected ? latestStep : exactStep ?? latestStep;
	const effectiveOperator = step?.action?.operator ?? operator;
	const observation = step?.observation ?? null;
	const targets = targetsFrom(observation, args, projectRoot);
	const label = OPERATOR_LABELS[effectiveOperator] ?? "处理知识任务";
	const kind = eventKindOf(phase, effectiveOperator, observation);
	const governance = state?.workspace && state?.episode ? {
		usage: {
			steps: state.episode.steps?.length ?? 0,
			reads: state.episode.steps?.filter((item) => item.action?.mode === "read").length ?? 0,
			writes: state.episode.steps?.filter((item) => ["write", "proposal"].includes(item.action?.mode)).length ?? 0
		},
		limits: {
			steps: Number(state.workspace.budget?.max_steps ?? 24),
			reads: Number(state.workspace.budget?.max_reads ?? 12),
			writes: Number(state.workspace.budget?.max_writes ?? 3)
		}
	} : null;
	return {
		schema_version: "1.0",
		event_id: randomUUID(),
		session_id: sessionId,
		run_id: state?.run?.run_id ?? null,
		episode_id: state?.episode?.episode_id ?? null,
		at: new Date().toISOString(),
		kind,
		tool_call_id: toolCallId ?? null,
		operator: { name: effectiveOperator ?? "tool", mode: step?.action?.mode ?? null },
		targets,
		...(observation ? {
			observation: {
				status: observation.status,
				channel: observation.data?.channel ?? null,
				summary: observation.summary,
				reason_code: observation.reason_code ?? null,
				on_topic_new: observation.data?.on_topic_new ?? null,
				truncated: Boolean(observation.truncated)
			}
		} : {}),
		...(step?.workspace_delta ? { workspace_delta: step.workspace_delta } : {}),
		...(governance ? { governance } : {}),
		presentation: {
			title: phase === "started" ? `正在${label}` : label,
			detail: phase === "started" ? "操作已发出，等待真实观察结果" : userFacingProgress(observation?.summary ?? "操作已完成"),
			tone: toneOf(observation, effectiveOperator)
		}
	};
}

export function toolCallIdOf(data, fallback) {
	return asId(data?.tool_call_id) ?? asId(data?.toolCallId) ?? asId(data?.call_id) ?? asId(data?.id) ?? fallback;
}
