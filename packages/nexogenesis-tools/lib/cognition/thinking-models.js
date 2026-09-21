import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasCompleteReading, readingEntries } from "./reading-coverage.js";

export class ThinkingModelRegistry {
	constructor(root) {
		this.root = root;
		this.models = new Map();
	}

	load() {
		this.models.clear();
		const dirs = [
			join(this.root, "schemes", "default", "thinking-models"),
			join(this.root, ".nexogenesis", "cognition", "thinking-models")
		];
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir).filter((name) => /\.(json|ya?ml)$/i.test(name)).sort()) {
				try {
					// Baseline .yaml files intentionally use the JSON-compatible YAML subset.
					const model = JSON.parse(readFileSync(join(dir, file), "utf8"));
					this._validate(model);
					this.models.set(model.id, model);
				} catch (error) {
					throw new Error(`Thinking Model 无法加载 ${file}: ${error.message}`);
				}
			}
		}
		return this;
	}

	_validate(model) {
		for (const key of ["id", "version", "purpose", "required_capabilities", "stop_conditions"]) {
			if (model?.[key] === void 0) throw new Error(`缺少 ${key}`);
		}
		if (!Array.isArray(model.required_capabilities) || !Array.isArray(model.stop_conditions)) {
			throw new Error("required_capabilities 与 stop_conditions 必须为数组");
		}
		for (const key of ["applicable_modes", "observation_obligations", "evidence_roles", "output_obligations"]) {
			if (model[key] !== void 0 && !Array.isArray(model[key])) throw new Error(`${key} 必须为数组`);
		}
		for (const [index, obligation] of (model.observation_obligations ?? []).entries()) {
			if (!obligation || typeof obligation !== "object" || !String(obligation.role ?? "").trim()) {
				throw new Error(`observation_obligations[${index}] 缺少 role`);
			}
			if (!Array.isArray(obligation.accepted_capabilities) || obligation.accepted_capabilities.length === 0) {
				throw new Error(`observation_obligations[${index}].accepted_capabilities 必须为非空数组`);
			}
			if (obligation.minimum_distinct_targets !== void 0
				&& (!Number.isInteger(obligation.minimum_distinct_targets) || obligation.minimum_distinct_targets < 0)) {
				throw new Error(`observation_obligations[${index}].minimum_distinct_targets 必须为非负整数`);
			}
			if (obligation.required_evidence_roles !== void 0 && !Array.isArray(obligation.required_evidence_roles)) {
				throw new Error(`observation_obligations[${index}].required_evidence_roles 必须为数组`);
			}
		}
	}

	get(id) { return this.models.get(id); }
	list() { return [...this.models.values()]; }

	/** 返回模型所需能力在当前实际 Operator 集中的可用性，而不是只相信提示词。 */
	capabilityCoverage(model, registry) {
		const operators = {};
		const missing = [];
		for (const capability of model.required_capabilities) {
			const names = registry.resolve(capability, { allowWrite: true, maxRisk: "high" }).map((entry) => entry.name);
			operators[capability] = names;
			if (!names.length) missing.push(capability);
		}
		return { available: missing.length === 0, missing, operators };
	}
}

/**
 * Thinking Model 的能力只能由真实、可用的 Observation 满足。
 * 空结果可以是有效观察；拒绝、失败、取消以及工具误用不可以。
 */
export function observationSatisfiesCapability(observation) {
	if (!observation || !["ok", "partial", "empty"].includes(observation.status)) return false;
	const data = observation.data ?? {};
	if (data.error || data.misuse) return false;
	if (observation.status === "partial") {
		return !observation.reason_code
			&& (observation.data !== void 0 || (observation.evidence?.length ?? 0) > 0);
	}
	return true;
}

export function missingModelCapabilities(state, registry) {
	const required = state?.run?.thinking_model?.required_capabilities ?? [];
	if (!required.length) return [];
	const observed = new Set();
	const selectedAtStep = Number(state?.run?.thinking_model?.selected_at_step ?? -1);
	for (const step of state?.episode?.steps ?? []) {
		if (!observationSatisfiesCapability(step.observation)) continue;
		for (const capability of registry.get(step.action?.operator)?.capabilities ?? []) {
			if (Number(step?.step ?? -1) > selectedAtStep
				|| (reusesQuestionEvidence(state) && capability === "read-evidence-slice" && hasCompleteReading(step))
				|| (reusesQuestionRetrieval(state) && capability === "retrieve-candidates")) observed.add(capability);
		}
	}
	return required.filter((capability) => !observed.has(capability));
}

function reusesQuestionEvidence(state) {
	return ["assess", "report", "general"].includes(state?.run?.mode) && state?.workspace?.scope?.analysis_depth === "iterative";
}

function reusesQuestionRetrieval(state) {
	// 普通分析的方法选择不使本题候选失效；固定执行评测仍保留阶段顺序。
	return reusesQuestionEvidence(state) && state.run.skill !== "nexo-deep-think"
		&& state.workspace.scope.execution_profile !== "deep-think-v1"
		&& state.run.thinking_model?.id !== "deep-inquiry";
}

function observationTargets(observation) {
	const data = observation?.data ?? {};
	return [...new Set([
		...(observation?.evidence ?? []).flatMap((item) => [item?.card_id, item?.address, item?.source]),
		...(data.nodes ?? []).map((item) => item?.id),
		...(data.compared ?? []),
		...(data.parties ?? []),
		data.card_id, data.id, data.address, data.start, data.from, data.to
	].filter(Boolean).map(String))];
}

/**
 * 分析任务可复用同一问题内的精读；方法专属观察仍须在本次选择后执行。
 * 原始 Episode 不删除，最终锚点另行核对当前正文版本。
 */
export function unmetModelObservationObligations(state, registry) {
	const model = state?.run?.thinking_model;
	const obligations = model?.observation_obligations ?? [];
	const selectedAtStep = Number(model?.selected_at_step ?? -1);
	const steps = (state?.episode?.steps ?? []).filter((step) => observationSatisfiesCapability(step.observation));
	const unmet = [];
	for (const obligation of obligations) {
		const accepted = new Set(obligation.accepted_capabilities ?? []);
		const matching = steps.filter((step) => {
			if (Number(step?.step ?? -1) <= selectedAtStep && !(reusesQuestionEvidence(state)
				&& obligation.require_full_read === true && accepted.has("read-evidence-slice") && hasCompleteReading(step))) return false;
			const capabilities = registry.get(step.action?.operator)?.capabilities ?? [];
			if (!capabilities.some((capability) => accepted.has(capability))) return false;
			if (obligation.require_full_read === true && !hasCompleteReading(step)) return false;
			return true;
		});
		const targets = new Set(matching.flatMap((step) => obligation.require_full_read
			? readingEntries(step).filter((entry) => entry.reading?.coverage === "full" || entry.reading?.unit_addresses?.length).map((entry) => entry.card_id)
			: observationTargets(step.observation)));
		const roles = new Set(matching.flatMap((step) => step.observation?.data?.roles_present ?? []));
		const minimumObservations = Math.max(1, Number(obligation.minimum_observations ?? 1));
		const minimumTargets = Math.max(0, Number(obligation.minimum_distinct_targets ?? 0));
		const missingRoles = (obligation.required_evidence_roles ?? []).filter((role) => !roles.has(role));
		if (matching.length < minimumObservations || targets.size < minimumTargets || missingRoles.length) {
			unmet.push({
				role: obligation.role,
				minimum_observations: minimumObservations,
				observed: matching.length,
				minimum_distinct_targets: minimumTargets,
				distinct_targets: targets.size,
				missing_evidence_roles: missingRoles,
				accepted_capabilities: [...accepted]
			});
		}
	}
	return unmet;
}

export function missingModelOutputObligations(state, completion = {}) {
	const required = state?.run?.thinking_model?.output_obligations ?? [];
	const missing = [];
	for (const key of required) {
		if (key === "changed" || key === "unchanged" || key === "pending") {
			if (!Array.isArray(completion[key])) missing.push(key);
			continue;
		}
		if (key === "evidence_anchors") {
			const anchors = Array.isArray(completion.evidence_anchors) ? completion.evidence_anchors : [];
			const selectedAtStep = Number(state?.run?.thinking_model?.selected_at_step ?? -1);
			const verified = new Set((state?.episode?.steps ?? [])
				.filter((step) => Number(step?.step ?? -1) > selectedAtStep
					&& step.action?.operator === "verify_evidence_anchors"
					&& observationSatisfiesCapability(step.observation))
				.slice(-1)
				.flatMap((step) => step.observation?.data?.results ?? [])
				.filter((item) => item?.usable)
				.map((item) => `${item.anchor}|${item.role}|${item.claim_id ?? ""}`));
			const allVerified = anchors.length > 0 && anchors.every((item) => verified.has(`${item?.anchor}|${item?.role}|${item?.claim_id ?? ""}`));
			if (!allVerified) missing.push(key);
			continue;
		}
		if (key === "previous_checkpoint") {
			const expected = state?.workspace?.scope?.previous_checkpoint;
			if (expected !== void 0 && String(completion.previous_checkpoint ?? "") !== String(expected)) missing.push(key);
			continue;
		}
		if (completion[key] === void 0 || completion[key] === null || completion[key] === "") missing.push(key);
	}
	return missing;
}

export function modelRequirementStatus(state, registry, completion = {}) {
	return {
		missing_capabilities: missingModelCapabilities(state, registry),
		unmet_observation_obligations: unmetModelObservationObligations(state, registry),
		missing_output_obligations: missingModelOutputObligations(state, completion)
	};
}
