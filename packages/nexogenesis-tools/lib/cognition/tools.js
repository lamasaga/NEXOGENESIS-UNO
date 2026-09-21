import { defineTool } from "@deepseek-ai/dsh-tools";
import { loadCards, readCard } from "../cards.js";
import { createHash } from "node:crypto";
import { loadGraphOps } from "../graph-ops.js";
import { HarnessGateway, HarnessRejected } from "../harness/gateway.js";
import { storeProposal } from "../pending.js";
import { makeHarnessReceipt, makeObservation, observationSchema } from "./observations.js";
import { operatorRegistry } from "./operator-registry.js";
import { getCognitiveRuntime, sessionIdOf, summarizeWorkspace, WorkspaceContractError, workspaceContract } from "./run-store.js";
import { modelRequirementStatus, ThinkingModelRegistry } from "./thinking-models.js";
import { constructCompletionReadiness, constructRunAudit, constructWriteReadiness } from "./construct-governance.js";
import { inspectEvidenceSet, verifyEvidenceAnchors } from "./evidence-inspection.js";
import { generalAnalysisReadiness, isAnalyticalRun } from "./general-analysis.js";
import { buildWorkingMemory } from "./working-memory.js";
import { isConversationAnalysis, reviewConversationDelivery } from "./conversation-analysis.js";
import { registerConstructTools } from "./construct-tools.js";
import { constructBacklog } from "./construct-backlog.js";
import { readingEntries } from "./reading-coverage.js";
import {
	recordStructureReview, STRUCTURE_REVIEW_STATUSES, UNCONNECTED_REVIEW_SCOPES
} from "./structure-reviews.js";
import { normalizeJsonValue } from "../json-value.js";
import { renderModelOutput } from "./model-output.js";
import { subscribeActiveInstance } from "../instances/registry.js";

function render(args, value) {
	const visible = structuredClone(value);
	if (visible?.data?.proposal?.operations) {
		visible.data.proposal.operations = visible.data.proposal.operations.map((operation) => ({ id: operation.id, type: operation.type }));
	}
	return renderModelOutput(args, visible);
}

function registerDescriptor(entry) {
	if (!operatorRegistry.get(entry.name)) operatorRegistry.register(entry);
}

const INTERNAL_USER_COPY = /`|\b(?:CognitiveRun|GraphOps|Harness|run|body|applies-to|extends|part-of|based-on|supports|conflicts-with)\b|债边|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|(?:→|->)\s*(?:领域|domain|Card)/i;

function assertPlainUserCopy(value, field) {
	if (INTERNAL_USER_COPY.test(String(value ?? ""))) {
		throw new Error(`${field} 含有内部术语。请改成用户能直接判断的自然语言：说明发现了什么、准备怎样处理、各选项会带来什么结果；不要写工具名、关系代码、卡片 id 或“债边”。`);
	}
}

function observe(runtime, exec, operator, data, summary, defaults, extra = {}) {
	const observation = makeObservation({ operator, summary, data, ...extra });
	const state = runtime.ensure(exec, defaults);
	runtime.record(state.run.run_id, { action: { operator, mode: operatorRegistry.get(operator)?.mode }, observation });
	return observation;
}

export function registerCognitionTools(ctx, root, seenSetFor, modelRoot = root) {
	let runtime = getCognitiveRuntime(root);
	let models = new ThinkingModelRegistry(modelRoot).load();
	const followActiveInstance = () => subscribeActiveInstance((instance) => {
		root = instance.root;
		runtime = getCognitiveRuntime(root);
		models = new ThinkingModelRegistry(modelRoot).load();
	});
	if (typeof ctx.effect === "function") ctx.effect(followActiveInstance);
	else followActiveInstance();
	for (const entry of [
		{ name: "inspect_cognitive_workspace", version: "1.1.0", capabilities: ["read-cognitive-workspace"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_cognitive_sufficiency", version: "1.0.0", capabilities: ["inspect-analysis-sufficiency"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_checkpoint_state", version: "1.0.0", capabilities: ["inspect-checkpoint-update"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_evidence_set", version: "1.0.0", capabilities: ["inspect-evidence-set"], mode: "read", risk: "low", cost: "low" },
		{ name: "verify_evidence_anchors", version: "1.0.0", capabilities: ["verify-evidence-anchors"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_domain_members", version: "1.0.0", capabilities: ["inspect-domain-members"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_entity_candidates", version: "1.0.0", capabilities: ["inspect-entity-candidates"], mode: "read", risk: "low", cost: "low" },
		{ name: "inspect_unconnected_cards", version: "1.1.0", capabilities: ["inspect-unconnected-cards"], mode: "read", risk: "low", cost: "low" },
		{ name: "record_structure_review", version: "1.0.0", capabilities: ["record-structure-review"], mode: "runtime-write", risk: "low", cost: "low" },
		{ name: "simulate_split_domain", version: "1.0.0", capabilities: ["simulate-domain-split"], mode: "simulate", risk: "low", cost: "medium" },
		{ name: "reassign_members", version: "1.0.0", capabilities: ["reassign-domain-members"], mode: "proposal", risk: "medium", cost: "medium" },
		{ name: "assign_domain_members", version: "1.0.0", capabilities: ["assign-domain-members"], mode: "proposal", risk: "medium", cost: "medium" },
		{ name: "propose_domain_retirement", version: "1.0.0", capabilities: ["retire-domain"], mode: "proposal", risk: "high", cost: "medium" },
	]) registerDescriptor(entry);
	registerConstructTools(ctx, () => root);
	const selectModel = (id, exec) => {
			const model = models.get(id);
			if (!model) throw new Error(`Thinking Model 不存在: ${id}`);
			const state = runtime.ensure(exec);
			const allowedModels = state.workspace.scope?.allowed_thinking_models;
			if (Array.isArray(allowedModels) && !allowedModels.includes(model.id)) {
				return makeObservation({
					operator: "select_thinking_model", status: "rejected",
					summary: `当前受控任务不允许选择 ${model.id}。`,
					reason_code: "thinking_model_not_allowed_in_scope",
					data: { model_id: model.id, allowed_thinking_models: allowedModels }
				});
			}
			const explicitlyAllowed = state.workspace.scope?.allow_experimental_models === true
				|| (state.workspace.scope?.allowed_thinking_models ?? []).includes(model.id);
			if (model.experimental === true && !explicitlyAllowed) {
				return makeObservation({
					operator: "select_thinking_model", status: "rejected",
					summary: `${model.id} 仍是受控候选，只能在显式允许它的评测或实验任务中启用。`,
					reason_code: "experimental_thinking_model_not_enabled",
					data: { model_id: model.id }
				});
			}
			if ((model.applicable_modes ?? []).length && !model.applicable_modes.includes(state.run.mode)) {
				return makeObservation({
					operator: "select_thinking_model", status: "rejected",
					summary: "所选分析方法不适用于当前任务，请选择其它方法。",
					reason_code: "thinking_model_mode_incompatible",
					data: { model_id: model.id, current_mode: state.run.mode, applicable_modes: model.applicable_modes }
				});
			}
			const coverage = models.capabilityCoverage(model, operatorRegistry);
			if (!coverage.available) {
				return makeObservation({
					operator: "select_thinking_model", status: "rejected",
					summary: `该 Thinking Model 所需能力尚未接入：${coverage.missing.join("、")}。`,
					reason_code: "thinking_model_capability_unavailable",
					next_actions: [{ action: "inspect_operator_contracts", description: "核对当前可用能力与缺口" }],
					data: { model_id: model.id, coverage }
				});
			}
			const selected = runtime.selectThinkingModel(state.run.run_id, model, coverage);
			runtime.record(state.run.run_id, {
				action: { operator: "select_thinking_model", mode: "runtime-write" },
				observation: makeObservation({ operator: "select_thinking_model", summary: "已选择适用的分析方法；接下来依据实际材料检查问题。", data: { model_id: model.id, coverage } })
			});
			return { selected, model, coverage };
	};

	ctx.tools.register(defineTool({
		name: "start_cognitive_run",
		description: "开始一个显式知识任务并建立可恢复 Workspace。general 的 nexo-talk 或 complexity_level 请求自动启用分析，不必重复填 analysis_depth；本题尚未提案的只读侦察可原地升级并保留检索/阅读。复杂问答用 complexity_level 选择 light、standard 或 deep；Runtime 会分配并限制预算，深度档允许 40–60 步、20–32 次读取。简单问答不必调用。改换目标先结束当前 run；不能覆盖待确认项。",
		parameters: {
			mode: { type: "string", required: true, enum: ["construct", "assess", "report", "general"] },
			skill: { type: "string", required: true },
			goal: { type: "string", required: true },
			thinking_model: { type: "string", description: "已知道适用 TM 时在启动内选择，省去单独调用；仍执行同一模式、受控范围与能力校验。" },
			complexity_level: { type: "string", enum: ["light", "standard", "deep"], description: "适用于 analytical general、assess、report；省略时 standard，交付形式不决定分析深度" },
			scope: { type: "object", additionalProperties: true },
			budget: { type: "object", additionalProperties: true }
		},
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args, exec) => {
			const session_id = sessionIdOf(exec) ?? `process-${process.pid}`;
			const current = runtime.current(session_id);
			if (["compile","theme_compile","digest"].includes(args.mode)||["compile","theme_compile","digest"].includes(current?.run.mode)) throw new Error("旧编译已退役，历史任务只读；请使用新版图书编译入口。");
			const scope = args.complexity_level
				? { ...(args.scope ?? {}), complexity_level: args.complexity_level }
				: { ...(args.scope ?? {}) };
			// Explicit analytical intent must not depend on an easily omitted nested flag.
			if (args.mode === "general" && (args.complexity_level || scope.complexity_level
				|| ["nexo-talk", "nexo-deep-think"].includes(args.skill))) scope.analysis_depth = "iterative";
			if (current?.run?.status === "waiting_user" || (current?.run?.status === "running" && current.run.mode !== args.mode)) {
				return makeObservation({ operator: "start_cognitive_run", status: "rejected", reason_code: "active_run_requires_finish",
					summary: "当前仍有活动任务或待确认项；先处理或结束它，不能通过启动新任务覆盖状态。" });
			}
			const startView = (selection) => {
				const active = runtime.current(session_id);
				// 保留原账本不等于重发全部工具正文；综合时可显式读取 memory。
				return normalizeJsonValue({ run: active.run, workspace: summarizeWorkspace(active.workspace),
					working_memory: buildWorkingMemory(active), ...(active.run.mode === "construct" ? { backlog: constructBacklog(root, { limit: 3 }) } : {}), ...(selection ? { selection } : {}) });
			};
			// Web 在启动知识流程时已冻结运行权限与预算。模型重复调用本工具时
			// 复用该 run，不能把受控设置悄悄覆盖掉。
			if (current?.run?.status === "running" && current.run.mode === args.mode) {
				const upgradesImplicitGeneral = args.mode === "general"
					&& scope.analysis_depth === "iterative"
					&& current.workspace?.scope?.analysis_depth !== "iterative";
				if (!upgradesImplicitGeneral) {
					const selection = args.thinking_model ? selectModel(args.thinking_model, exec) : undefined;
					return startView(selection);
				}
				try {
					runtime.promoteAnalysis(current.run.run_id, { skill: args.skill, goal: args.goal, scope, budget: args.budget });
				} catch (error) {
					return makeObservation({ operator: "start_cognitive_run", status: "rejected", reason_code: "analysis_upgrade_requires_readonly", summary: error.message });
				}
				const selection = args.thinking_model ? selectModel(args.thinking_model, exec) : undefined;
				return startView(selection);
			}
			const created = runtime.start({ session_id, ...args, scope });
			if (!args.thinking_model) return created;
			const selection = selectModel(args.thinking_model, exec);
			return startView(selection);
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_cognitive_workspace",
		description: "只读查看当前任务的显式认知状态、预算与最近行动。没有活动任务时返回 no_active_run 和最后一次运行摘要，不会隐式创建新任务；它不是知识卡检索。",
		parameters: { view: { type: "string", enum: ["brief", "memory", "full", "backlog"], description: "brief 看进度；memory 看工作记忆；full 查看完整本任务；backlog 分页查当前实例历次建构待办，历史发现须重验。" }, cursor: { type: "number" }, limit: { type: "number" } },
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args, exec) => {
			const session_id = sessionIdOf(exec) ?? `process-${process.pid}`;
			const state = runtime.current(session_id);
			if (args.view === "backlog") return normalizeJsonValue(constructBacklog(root, args));
			if (!state) return {
				active: false,
				status: "no_active_run",
				summary: "当前会话没有认知任务；如需显式循环，请先开始新的任务。"
			};
			const active = ["running", "waiting_user"].includes(state.run.status);
			if (args.view === "memory") return normalizeJsonValue({ active, run: state.run, working_memory: buildWorkingMemory(state) });
			return normalizeJsonValue({
				active,
				status: active ? "active" : "no_active_run",
				run: state.run,
				workspace: args.view !== "full" && state.run.mode === "construct" ? summarizeWorkspace(state.workspace) : state.workspace,
				...(state.run.mode === "construct" ? { backlog: constructBacklog(root, { limit: 3 }) } : {}),
				working_memory: buildWorkingMemory(state),
				recent_steps: state.episode.steps.slice(-5).map((step) => state.run.mode === "construct" ? { step: step.step, action: step.action, observation: { status: step.observation?.status, summary: step.observation?.summary, scope: step.observation?.scope } } : step),
				contract: workspaceContract(state.run.mode),
				governance: runtime.governance(state.run.run_id)
			});
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_cognitive_sufficiency",
		description: "检查当前复杂问答是否已经满足 Thinking Model、结构观察、证据角色、证据锚点和停止条件。若未满足，返回下一项最小行动；新增知识观察后必须重新检查。它不替模型裁决结论。",
		parameters: {},
		output: { schema: observationSchema(), render },
		execute: async (_args, exec) => {
			const state = runtime.ensure(exec);
			if (!isAnalyticalRun(state)) return observe(runtime, exec, "inspect_cognitive_sufficiency",
				{ ready: false, applicable: false, missing: ["analysis_run"] },
				"当前不是分析任务，尚未执行证据验收；这不是通过结果。复杂分析先显式启动，轻量回答无需此检查。", {},
				{ status: "rejected", reason_code: "analysis_run_required", next_actions: [{ action: "start_cognitive_run", description: "本题需要分析时使用 nexo-talk 和 complexity_level 启动，并选择适用 TM。" }] });
			const decision = runtime.canOperate(state.run.run_id, { mode: "read", operator: "inspect_cognitive_sufficiency" });
			if (!decision.allowed) return makeObservation({ operator: "inspect_cognitive_sufficiency", status: "rejected", summary: decision.reason, reason_code: decision.reason_code });
			if (isConversationAnalysis(state)) return observe(runtime, exec, "inspect_cognitive_sufficiency", {
				can_deliver: true, semantic_verification: "not_certified", process_obligations: "advisory",
				note: "新版不以方法或探索配额决定能否交流。准备回答时提交最终引用和原问题未完成项；未核验内容不得声称已核验。"
			}, "可按现有成果回答；证据限制与请求覆盖需要如实说明。", {}, { status: "ok" });
			const data = generalAnalysisReadiness(state, operatorRegistry);
			return observe(runtime, exec, "inspect_cognitive_sufficiency", data,
				data.ready ? "当前复杂问答的观察与证据已经达到完成门。" : `当前还缺少 ${data.missing.length} 项完成条件。`,
				{ mode: state.run.mode, skill: state.run.skill, goal: state.workspace.goal },
				{ status: "ok", next_actions: data.next_actions });
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_checkpoint_state",
		description: "读取评测或序贯分析在启动时冻结的当前时点、上一时点和上一轮输出。只返回当前 Workspace scope 中显式提供的内容，不读取未来材料，也不修改历史判断。",
		parameters: {},
		output: { schema: observationSchema(), render },
		execute: async (_args, exec) => {
			const state = runtime.ensure(exec);
			const decision = runtime.canOperate(state.run.run_id, { mode: "read", operator: "inspect_checkpoint_state" });
			if (!decision.allowed) return makeObservation({ operator: "inspect_checkpoint_state", status: "rejected", summary: decision.reason, reason_code: decision.reason_code });
			const scope = state.workspace.scope ?? {};
			const previous = scope.previous_output ?? null;
			const data = {
				current_checkpoint: scope.current_checkpoint ?? scope.checkpoint ?? null,
				previous_checkpoint: scope.previous_checkpoint ?? null,
				as_of: scope.as_of ?? null,
				previous_output: previous,
				previous_output_frozen: previous !== null
			};
			return observe(runtime, exec, "inspect_checkpoint_state", data,
				previous === null ? "当前时点没有上一轮冻结输出。" : "已读取上一时点冻结输出；本轮只能说明变化，不能改写历史结果。",
				{ mode: state.run.mode, skill: state.run.skill, goal: state.workspace.goal },
				{ status: "ok", scope: { current_checkpoint: data.current_checkpoint, previous_checkpoint: data.previous_checkpoint, as_of: data.as_of } });
		}
	}));

	const evidenceItemSchema = {
		type: "object", additionalProperties: false, properties: {
			anchor: { type: "string", required: true, description: "已精读的 card_id 或 card_id#unit-id" },
			role: { type: "string", required: true, enum: ["support", "counter", "boundary", "background", "inference"] },
			claim_id: { type: "string", required: true, description: "该证据所挂接的当前结论标识" },
			explanation: { type: "string", description: "说明原文怎样支持、反驳或限定该判断；counter 明确所否定的环节，不把不同机制或未知项当反例" }
		}
	};

	ctx.tools.register(defineTool({
		name: "verify_evidence_anchors",
		description: "核验一组证据锚点是否真实存在、已在本轮精读、角色合法并挂接到明确结论。只接受 Card 或 Card unit 地址；语义上是否足以支撑结论仍由模型或人工复核。",
		parameters: { items: { type: "array", required: true, items: evidenceItemSchema } },
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const state = runtime.ensure(exec);
			const decision = runtime.canOperate(state.run.run_id, { mode: "read", operator: "verify_evidence_anchors" });
			if (!decision.allowed) return makeObservation({ operator: "verify_evidence_anchors", status: "rejected", summary: decision.reason, reason_code: decision.reason_code });
			const data = verifyEvidenceAnchors(root, state, args.items);
			return observe(runtime, exec, "verify_evidence_anchors", data,
				data.all_deterministic_checks_passed ? `已核验 ${data.valid_count} 个可回查证据锚点。` : `证据锚点核验未通过：${data.valid_count}/${data.anchor_count} 可用。`,
				{ mode: state.run.mode, skill: state.run.skill, goal: state.workspace.goal },
				{ status: data.all_deterministic_checks_passed ? "ok" : "partial", reason_code: data.all_deterministic_checks_passed ? undefined : "evidence_anchor_invalid", evidence: data.results.filter((item) => item.exists).map((item) => ({ card_id: item.card_id, address: item.anchor })) });
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_evidence_set",
		description: "审视已精读证据集合的支持、反证、边界、来源独立性、重复转述、单点支撑和对象覆盖。它检查证据结构，不自动裁决结论真假。",
		parameters: { items: { type: "array", required: true, items: evidenceItemSchema } },
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const state = runtime.ensure(exec);
			const decision = runtime.canOperate(state.run.run_id, { mode: "read", operator: "inspect_evidence_set" });
			if (!decision.allowed) return makeObservation({ operator: "inspect_evidence_set", status: "rejected", summary: decision.reason, reason_code: decision.reason_code });
			const data = inspectEvidenceSet(root, state, args.items);
			return observe(runtime, exec, "inspect_evidence_set", data,
				`已审视 ${data.claims.length} 个结论的证据集合；${data.single_point_claims.length} 个仍为单点或同源支撑，${data.role_review_needed.length} 项反证尚需解释。`,
				{ mode: state.run.mode, skill: state.run.skill, goal: state.workspace.goal },
				{ status: data.valid_count ? "ok" : "partial", reason_code: data.valid_count ? undefined : "evidence_set_empty", evidence: data.results.filter((item) => item.exists).map((item) => ({ card_id: item.card_id, address: item.anchor })) });
		}
	}));

	ctx.tools.register(defineTool({
		name: "update_cognitive_workspace",
		description: "更新分析或建构的显式判断、证据、疑点、候选动作和延后项；模式状态放 extension。实际操作和授权范围由宿主维护，不保存隐藏思维链。",
		parameters: {
			patch: {
				type: "object", required: true, additionalProperties: false,
				properties: {
					goal: { type: "string" }, scope: { type: "object", additionalProperties: true },
					user_directives: { type: "array" }, hypotheses: { type: "array", description: "深度分析保留 1–8 个显式判断：id、statement、status(supported/inference/unresolved/rejected)、scope(地域/时期/样本/方法)、uncertainty、anchors(已读地址数组)。只记录结论和证据边界，不记录隐藏思维链。" }, evidence: { type: "array" },
					counter_evidence: { type: "array" }, open_questions: { type: "array" }, conflicts: { type: "array" },
					candidate_actions: { type: "array" }, observed_nodes: { type: "array" }, deferred_items: { type: "array" },
					budget: { type: "object", additionalProperties: true }, stop_reason: { type: "string" },
					read_revisions: { type: "object", additionalProperties: true },
					extension: {
						type: "object", additionalProperties: false,
						properties: {
							challenge_reviews: { type: "array", description: "定向挑战未找到真实反例时登记；不代表命题被证实", items: { type: "object", additionalProperties: false, properties: {
								claim_id: { type: "string", required: true }, operation_step: { type: "number", required: true },
								outcome: { type: "string", required: true, enum: ["not_found"] },
								finding: { type: "string", required: true }, limitation: { type: "string", required: true }
							} } },
							insight_reviews: { type: "array", items: { type: "object", additionalProperties: false, properties: {
								operation_step: { type: "number", description: "真实特殊 OPS 或类比在 Episode 中的 step；不适用时省略" },
								focus_card: { type: "string" },
								claim_id: { type: "string", description: "声称判断改变时，必须指向 hypotheses 中实际受影响的 id" },
								outcome: { type: "string", required: true, enum: ["revised", "narrowed", "alternative", "unchanged", "inconclusive", "empty", "not_applicable"] },
								finding: { type: "string", required: true, description: "发现使哪项判断改变/缩窄/保持，或为何本题不宜探索" },
								anchors: { type: "array", items: { type: "string" }, description: "实际补读的候选证据地址" },
								next_check: { type: "string", required: true, description: "实际挑战结果或尚缺的检验；不得把未验证假说写为事实" },
								challenge_step: { type: "number", description: "revised/narrowed/alternative 必须指向探索后真实的定向检索、论证、比较、冲突或来源检查 step；尚未检验用 inconclusive" },
								mapping: { type: "string", description: "类比双方对应的机制结构" },
								break_point: { type: "string", description: "类比不成立的差异和断裂点" }
							} } },
							checkpoint: { type: "object", additionalProperties: true },
							excluded_candidates: { type: "array" },
							write_proposals: { type: "array" }, focus: { type: "object", additionalProperties: true },
							simulations: { type: "array" }, structural_debts: { type: "array" }, affected_scope: { type: "object", additionalProperties: true },
							issue_ledger: { type: "array" }, relation_cases: { type: "array" }, relation_adjudications: { type: "array" },
							post_write_checks: { type: "array" }, result: { type: "object", additionalProperties: true }
						}
					}
				}
			}
		},
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args, exec) => {
			const state = runtime.ensure(exec);
			try {
				if (isAnalyticalRun(state) && args.patch?.goal && args.patch.goal !== state.workspace.goal) {
					throw new WorkspaceContractError("goal", { hint: "当前问题的目标不可改写；结束本轮后为新问题建立独立 Run" });
				}
				if (state.run.mode === "construct") {
					const protectedFields = ["issue_ledger", "post_write_checks", "review_records", "relation_cases", "relation_adjudications", "improvement_plan", "improvement_history", "recovery_review", "result"];
					const field = protectedFields.find((key) => key in (args.patch?.extension ?? {}));
					if (field) throw new WorkspaceContractError(`extension.${field}`, { hint: "使用专用观察、计划、复核或结束工具；运行事实不能手填" });
				}
				const fields = Object.keys(args.patch ?? {});
				const receipt = makeObservation({
					operator: "update_cognitive_workspace",
					summary: fields.length ? "已保存本轮发现与后续安排。" : "本轮发现与后续安排没有变化。",
					data: { fields }
				});
				const updated = runtime.updateWorkspaceWithDiff(state.run.run_id, args.patch, {
					action: { operator: "update_cognitive_workspace", mode: "runtime-write" },
					observation: receipt
				});
				return {
					run_id: state.run.run_id,
					workspace: updated.workspace,
					working_memory: buildWorkingMemory(runtime.get(state.run.run_id)),
					delta: updated.delta,
					observation: receipt,
					contract: workspaceContract(state.run.mode)
				};
			} catch (error) {
				if (!(error instanceof WorkspaceContractError)) throw error;
				const receipt = makeHarnessReceipt({
					operator: "update_cognitive_workspace", accepted: false,
					summary: error.message,
					reason_code: "workspace_contract_violation",
					alternatives: error.hint ? [
						{ action: "move_field", description: `把 ${error.field} 写入 ${error.hint}` },
						{ action: "inspect_contract", description: "调用 inspect_cognitive_workspace 查看当前 mode 的字段契约" }
					] : [
						{ action: "inspect_contract", description: "查看当前 mode 的 core_fields 与 extension_fields" },
						{ action: "use_deferred_item", description: "无法归类时先写入 deferred_items 并说明原因" }
					],
					data: { field: error.field, hint: error.hint, contract: workspaceContract(state.run.mode) }
				});
				runtime.record(state.run.run_id, { action: { operator: "update_cognitive_workspace" }, observation: receipt });
				return receipt;
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "list_thinking_models",
		description: "列出当前可用的程序性思考模型及其适用状态和能力要求。它们提供审视方式，不规定固定工具顺序。",
		parameters: {}, output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async () => ({ models: models.list().map((model) => ({ ...model, capability_coverage: models.capabilityCoverage(model, operatorRegistry) })) })
	}));

	ctx.tools.register(defineTool({
		name: "request_user_choice",
		description: "当下一步确实取决于用户的价值判断、范围授权或处理方向时，向界面提出一个可操作的选择题。提供 2–4 个互斥选项；界面会显示选项和“其他想法”，用户回答会回到同一会话。调用后立刻结束本轮：不要继续调用任何工具，不要在普通回复中复述选项，也不要假定用户已经选择。",
		parameters: {
			request_id: { type: "string", required: true },
			question: { type: "string", required: true },
			options: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
				id: { type: "string", required: true }, label: { type: "string", required: true }, description: { type: "string", required: true }
			} } }
		},
		output: {
			schema: { type: "object", additionalProperties: true }, render,
			presentationMeta: (_args, value) => ({ choice_request: value })
		},
		execute: async (args, exec) => {
			const options = Array.isArray(args.options) ? args.options.map((option) => ({
				id: String(option?.id ?? "").trim(), label: String(option?.label ?? "").trim(),
				description: String(option?.description ?? "").trim()
			})) : [];
			if (options.length < 2 || options.length > 4 || options.some((option) => !option.id || !option.label || !option.description)) {
				throw new Error("request_user_choice 需要 2–4 个带 id、label、description 的选项");
			}
			if (new Set(options.map((option) => option.id)).size !== options.length) throw new Error("request_user_choice 的选项 id 不能重复");
			const state = runtime.ensure(exec);
			const request_key = String(args.request_id).trim();
			const question = String(args.question).trim();
			if (!request_key || !question) throw new Error("request_id 和 question 不能为空");
			assertPlainUserCopy(question, "选择题问题");
			for (const option of options) {
				assertPlainUserCopy(option.label, "选项标题");
				assertPlainUserCopy(option.description, "选项说明");
			}
			const interaction = runtime.requestInteraction(state.run.run_id, { type: "choice", request_key, question, options });
			const open_questions = [...state.workspace.open_questions.filter((item) => item?.interaction_id !== interaction.interaction_id), {
				interaction_id: interaction.interaction_id, request_key, question, status: "waiting_user"
			}].slice(-12);
			runtime.updateWorkspace(state.run.run_id, { open_questions });
			return interaction;
		}
	}));

	ctx.tools.register(defineTool({
		name: "select_thinking_model",
		description: "为当前 run 选择一个 Thinking Model。应根据 Workspace 与最新 Observation 选择，可在新证据出现后换向。",
		parameters: { id: { type: "string", required: true } },
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args, exec) => selectModel(args.id, exec)
	}));

	ctx.tools.register(defineTool({
		name: "inspect_operator_contracts",
		description: "查看本次可执行 Operator 的真实契约摘要。字段、能力、风险和模式来自注册表；提示示例不得超出这里的契约。",
		parameters: { capability: { type: "string" } },
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args) => ({ operators: args.capability ? operatorRegistry.resolve(args.capability, { allowWrite: true, maxRisk: "high" }) : operatorRegistry.list() })
	}));













	ctx.tools.register(defineTool({
		name: "inspect_domain_members",
		description: "审视一个领域的成员构成与类型分布。它返回摘要和有限成员列表，不做任何领域迁移。",
		parameters: { domain_id: { type: "string", required: true }, query: { type: "string" }, limit: { type: "number" } },
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const data = loadGraphOps(root, seenSetFor(exec)).members(args.domain_id, { query: args.query, limit: Math.min(args.limit ?? 16, 24) });
			const counts = {};
			for (const node of data.nodes ?? []) counts[node.type] = (counts[node.type] ?? 0) + 1;
			return observe(runtime, exec, "inspect_domain_members", { ...data, type_counts: counts }, `领域共有 ${data.member_total ?? data.n} 个匹配成员，本次观察 ${data.n} 个。`, { mode: "construct", skill: "nexo-construct", goal: `审视领域 ${args.domain_id}`, scope: { domain_id: args.domain_id } }, { scope: { domain_id: args.domain_id }, truncated: data.truncated });
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_entity_candidates",
		description: "核对材料或对话中已识别出的关键人物、机构、学派、制度工具等对象，判断库内是否已有实体枢纽、在多少张卡和多少来源中重复出现，以及最集中的领域。它不做全库人名正则识别，也不写卡；只有多卡、多来源或高连接价值候选才应进入实体建卡判断。",
		parameters: {
			candidates: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
				name: { type: "string", required: true }, aliases: { type: "array", items: { type: "string" } },
				entity_kind: { type: "string", enum: ["person", "organization", "institution", "school", "legal-instrument", "collective", "artifact", "other"] }
			} } },
			limit: { type: "number", description: "最多返回 12 个候选" }
		},
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const data = loadGraphOps(root, seenSetFor(exec)).entityCandidates(args.candidates, { limit: args.limit });
			const strong = (data.candidates ?? []).filter((item) => item.status === "strong_candidate").length;
			const existing = (data.candidates ?? []).filter((item) => item.status === "existing").length;
			return observe(runtime, exec, "inspect_entity_candidates", data,
				`核对 ${data.candidate_total ?? 0} 个对象：${existing} 个已有实体枢纽，${strong} 个达到高置信候选门槛。`,
				{ mode: "construct", skill: "nexo-construct", goal: "核对缺失实体枢纽" },
				{ status: strong ? "partial" : "ok", next_actions: strong ? [
					{ action: "read_representative_cards", description: "精读候选的代表卡，确认对象身份、别名和适用边界" },
					{ action: "compare_existing_entities", description: "排除已有近义实体或不应独立成卡的普通名词" }
				] : [] });
		}
	}));

	ctx.tools.register(defineTool({
		name: "inspect_unconnected_cards",
		description: "分页扫描全体 Card 的领域与入出关系元数据，按结构紧迫性、共享来源、显式互指和有限语义信号排列未接入候选。fully_isolated=无任何卡间入/出关系，领域归属不算关系；without_relations=同一口径的兼容名称；without_ready_relations=可能存在旧边，但没有可用于多跳推理的 ready 关系；without_domain=没有领域。默认跳过内容指纹仍有效的已审项；卡片变化后会自动重新进入队列。写后可用 card_ids 精确重跑同一检测器。",
		parameters: {
			scope: { type: "string", enum: ["fully_isolated", "without_relations", "without_ready_relations", "without_domain"], description: "默认 fully_isolated" },
			cursor: { type: "string", description: "上一页返回的不透明 next_cursor；不要自行拼接或按数量计算" },
			limit: { type: "number", description: "候选返回上限，默认 12，最多 24" },
			exclude_reviewed: { type: "boolean", description: "是否跳过当前指纹下已形成处置结论的卡，默认 true" },
			card_ids: { type: "array", items: { type: "string" }, description: "写后复验时精确检查受影响卡；此时忽略游标" }
		},
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const scope = args.scope ?? "fully_isolated";
			const data = loadGraphOps(root, seenSetFor(exec)).unconnected({
				scope, cursor: args.cursor, limit: args.limit ?? 12,
				excludeReviewed: args.exclude_reviewed !== false, cardIds: args.card_ids
			});
			const total = data.candidate_total ?? 0;
			const scopeLabel = scope === "fully_isolated" ? "完全孤立"
				: scope === "without_relations" ? "没有关系"
					: scope === "without_ready_relations" ? "没有可用于多跳推理的就绪关系" : "没有领域";
			return observe(runtime, exec, "inspect_unconnected_cards", data,
				total ? `当前队列有 ${total} 张${scopeLabel}的待审卡；本页按结构信号优先级排列。` : data.reviewed_excluded_total ? `该范围的未接入卡均已有仍有效的审阅结论，本次跳过 ${data.reviewed_excluded_total} 张。` : "该范围内没有未接入的活跃非领域卡。",
				{ mode: "construct", skill: "nexo-construct", goal: "检查未接入知识卡", scope: { structural_scope: scope } },
				{ status: total ? "partial" : "ok", scope: { structural_scope: scope }, truncated: data.truncated,
					next_actions: total ? [
						{ action: "inspect_integration_candidates", description: "为一张待审卡生成有解释的候选端点" },
						{ action: scope === "without_domain" ? "list_domains" : "read_card", description: scope === "without_domain" ? "只比较领域归属，不把缺领域误当成缺关系" : "精读焦点卡和少量候选，核对知识功能与边界" }
					] : [] });
		}
	}));

	ctx.tools.register(defineTool({
		name: "record_structure_review",
		description: "记录一张未接入卡的最终结构处置，保存于可重建运行记录并绑定当前 Card 指纹。可记录已连接、近重复候选、待重分类、待调整领域、经比较后暂时独立或证据缺口；它不写知识卡。卡片内容或元数据变化后旧结论自动失效。结束孤立卡审阅前必须调用。",
		parameters: {
			card_id: { type: "string", required: true },
			issue_kind: { type: "string", required: true, enum: UNCONNECTED_REVIEW_SCOPES },
			status: { type: "string", required: true, enum: STRUCTURE_REVIEW_STATUSES },
			candidate_ids: { type: "array", items: { type: "string" }, description: "实际比较或待后续处理的候选卡" },
			reason: { type: "string", required: true, description: "比较依据、排除理由或具体证据缺口；零命中不能证明主题尚未编译" },
			follow_up: { type: "string", description: "本次发现但未处理的具体问题与下一步，例如领域归属不当；会持久化为待办，不能只在 reason 中顺带提及" }
		},
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const state = runtime.ensure(exec, { mode: "construct", skill: "nexo-construct", goal: "记录结构审阅结论" });
			if (state.run.mode !== "construct") return makeObservation({
				operator: "record_structure_review", status: "rejected", reason_code: "construct_run_required",
				summary: "结构审阅记录只属于建构任务。"
			});
			const decision = runtime.canOperate(state.run.run_id, { mode: "runtime-write", operator: "record_structure_review" });
			if (!decision.allowed) return makeObservation({
				operator: "record_structure_review", status: "rejected", reason_code: decision.reason_code,
				summary: decision.reason
			});
			try {
				const cards = loadCards(root);
				if (args.status === "intentionally_standalone") {
					const ids = [args.card_id, ...(args.candidate_ids ?? [])];
					const reads = state.episode.steps.filter((s) => ["ok", "partial"].includes(s.observation?.status)).flatMap(readingEntries);
					const compared = state.episode.steps.filter((s) => s.action?.operator === "compare_cards" && s.observation?.status === "ok");
					if (ids.length < 2 || ids.some((id) => !reads.some((r) => r.card_id === id && r.reading?.coverage === "full"
						&& r.reading.fingerprint === createHash("sha256").update(cards.get(id)?.body ?? "").digest("hex")))
						|| ids.slice(1).some((id) => !compared.some((s) => [args.card_id, id].every((v) => s.observation.data?.compared?.includes(v))))) {
						throw new Error("合理独立须完整阅读焦点与列出的候选并实际比较；只看到候选摘要或检索零命中，请记录 evidence_gap 与下一步。");
					}
				}
				if (args.status === "linked") {
					const unresolved = loadGraphOps(root, seenSetFor(exec)).unconnected({
						scope: "without_ready_relations", cardIds: [args.card_id], excludeReviewed: false, limit: 1
					});
					if ((unresolved.nodes ?? []).some((node) => node.id === args.card_id)) {
						throw new Error("“已接入”只用于已经具有 ready 入边或出边的卡；旧边、空泛说明或幽灵目标不能算完成。");
					}
				}
				const record = recordStructureReview(root, cards, args);
				if (args.follow_up?.trim()) runtime.updateWorkspace(state.run.run_id, { deferred_items: [...state.workspace.deferred_items, { card_id: args.card_id, reason: args.follow_up.trim().slice(0, 800), source: "structure_review" }] });
				return observe(runtime, exec, "record_structure_review", record,
					"已保存当前卡片指纹下的结构审阅结论；卡片变化后会自动重新进入待审队列。",
					{ mode: "construct" }, { status: "ok", scope: { card_ids: [args.card_id], issue_kind: args.issue_kind } });
			} catch (error) {
				const receipt = makeObservation({
					operator: "record_structure_review", status: "rejected", reason_code: "structure_review_invalid",
					summary: error.message
				});
				runtime.record(state.run.run_id, { action: { operator: "record_structure_review", mode: "runtime-write" }, observation: receipt });
				return receipt;
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "simulate_split_domain",
		description: "模拟一次领域拆分，不写知识体。groups 必须明确给出每组成员 id；工具检查重复、遗漏、越界和组间已有关系，供 Agent 决定保持、改分组或提出单层迁移。",
		parameters: {
			domain_id: { type: "string", required: true },
			groups: { type: "array", required: true, items: { type: "object", additionalProperties: true } }
		},
		output: { schema: observationSchema(), render },
		execute: async (args, exec) => {
			const all = loadGraphOps(root, seenSetFor(exec)).members(args.domain_id, { limit: 10000 });
			const allowed = new Set((all.nodes ?? []).map((node) => node.id));
			const assigned = new Map();
			const duplicates = [];
			const unknown = [];
			for (const group of args.groups ?? []) for (const id of group.member_ids ?? []) {
				if (!allowed.has(id)) unknown.push(id);
				if (assigned.has(id)) duplicates.push(id);
				assigned.set(id, group.label ?? "未命名组");
			}
			const unassigned = [...allowed].filter((id) => !assigned.has(id));
			const data = { domain_id: args.domain_id, groups: args.groups, duplicates, unknown, unassigned, valid: !duplicates.length && !unknown.length && !unassigned.length };
			return observe(runtime, exec, "simulate_split_domain", data, data.valid ? "拆分模拟覆盖全部成员且没有重复。" : `拆分模拟仍有 ${duplicates.length} 个重复、${unknown.length} 个越界、${unassigned.length} 个遗漏。`, { mode: "construct", skill: "nexo-construct", goal: `模拟拆分领域 ${args.domain_id}` }, { status: data.valid ? "ok" : "partial", scope: { domain_id: args.domain_id }, next_actions: data.valid ? [{ action: "inspect_cross_group_evidence", description: "抽查跨组桥梁后再决定是否迁移" }] : [{ action: "revise_groups", description: "修复重复、越界和遗漏后重新模拟" }] });
		}
	}));

	const fullRecord = (id) => {
		const card = readCard(root, id);
		if (!card) throw new Error(`卡片不存在: ${id}`);
		return { ...card, updated: new Date().toISOString().slice(0, 10) };
	};

	const domainProposal = (exec, { summary, layer, operations, operator }) => {
		const proposalOperator = operator ?? (layer === "membership" ? "reassign_members" : "propose_domain_retirement");
		const state = runtime.ensure(exec, { mode: "construct", skill: "nexo-construct", goal: summary });
		const readiness = constructWriteReadiness(state, { layer, root, operations });
		if (!readiness.ready) {
			const receipt = makeObservation({
				operator: proposalOperator, status: "rejected", summary: readiness.summary,
				reason_code: readiness.reason_code, next_actions: readiness.next_actions,
				data: { thinking_model: state.run.thinking_model?.id ?? null }
			});
			runtime.record(state.run.run_id, {
				action: { operator: "construct_write_guard", mode: "runtime-write" }, observation: receipt
			});
			return receipt;
		}
		if (runtime.currentInteraction(state.run.session_id)) {
			return observe(runtime, exec, proposalOperator, {}, "当前已有一个等待用户选择的问题，本轮不会提出新的写入确认。", { mode: "construct" }, { status: "partial", next_actions: [{ action: "await_user_decision", description: "等待用户先完成当前选择" }] });
		}
		try {
			const checked = new HarnessGateway(root).preflight({ operations, layer });
			if (state.run.write_authority === "trusted") {
				const receipt = new HarnessGateway(root).commit({
					proposal_id: `trusted-${state.run.run_id}`,
					operations: checked.cards,
					layer: checked.layer,
					revisions: checked.revisions
				});
				return observe(runtime, exec, proposalOperator, receipt.data, "领域操作已通过校验并写入知识体。", { mode: "construct" }, {
					status: "ok", reason_code: receipt.reason_code, scope: receipt.scope, revision: receipt.revision
				});
			}
			const proposal = storeProposal({
				root, summary, operations: checked.cards, session_id: state.run.session_id, run_id: state.run.run_id,
				layer, revisions: checked.revisions
			});
			runtime.setStatus(state.run.run_id, "waiting_user");
			return observe(runtime, exec, proposalOperator, { proposal }, "领域操作已通过预检，正在等待用户确认。", { mode: "construct" }, { status: "partial", scope: { layer }, next_actions: [{ action: "await_user_decision", description: "等待用户确认；结果会返回本 loop" }] });
		} catch (error) {
			if (error instanceof HarnessRejected) {
				runtime.record(state.run.run_id, { action: { operator: proposalOperator, layer }, observation: error.receipt });
				return error.receipt;
			}
			throw error;
		}
	};

	ctx.tools.register(defineTool({
		name: "reassign_members",
		description: "提出一次领域成员迁移，不伪装成正文改写。一次只迁移 1–3 张卡，从 source_domain 移到 target_domain；write_authority=manual 时通过预检后等待用户确认，trusted 的建构任务则直接原子写入。",
		parameters: {
			source_domain: { type: "string", required: true }, target_domain: { type: "string", required: true },
			member_ids: { type: "array", required: true, items: { type: "string" } },
			reason: { type: "string", required: true }
		},
		output: { schema: observationSchema(), render, presentationMeta: (_args, value) => value.data?.proposal ? { proposal: value.data.proposal } : {} },
		execute: async (args, exec) => {
			if (args.source_domain === args.target_domain) throw new Error("源领域与目标领域不能相同");
			if (!Array.isArray(args.member_ids) || args.member_ids.length < 1 || args.member_ids.length > 3) throw new Error("一次只能迁移 1–3 个成员");
			const operations = args.member_ids.map((id) => {
				const record = fullRecord(id);
				if (!record.domains.includes(args.source_domain)) throw new Error(`${id} 不属于源领域 ${args.source_domain}`);
				record.domains = [...new Set(record.domains.filter((domain) => domain !== args.source_domain).concat(args.target_domain))];
				return record;
			});
			return domainProposal(exec, { summary: args.reason, layer: "membership", operations });
		}
	}));

	ctx.tools.register(defineTool({
		name: "assign_domain_members",
		description: "提出把尚未归入任何领域的 1–3 张卡加入一个已有领域。它只修改 domains，不建立关系，也不改正文；候选必须已由 inspect_unconnected_cards 或 read_card 核对，目标领域必须已由 list_domains 确认。write_authority=manual 时等待确认，trusted 的建构任务则直接原子写入。已有领域归属的卡请改用 reassign_members。",
		parameters: {
			target_domain: { type: "string", required: true }, member_ids: { type: "array", required: true, items: { type: "string" } },
			reason: { type: "string", required: true }
		},
		output: { schema: observationSchema(), render, presentationMeta: (_args, value) => value.data?.proposal ? { proposal: value.data.proposal } : {} },
		execute: async (args, exec) => {
			if (!Array.isArray(args.member_ids) || args.member_ids.length < 1 || args.member_ids.length > 3) throw new Error("一次只能归入 1–3 张卡");
			const target = fullRecord(args.target_domain);
			if (target.type !== "domain") throw new Error("target_domain 必须是已有 domain 卡");
			const operations = args.member_ids.map((id) => {
				const record = fullRecord(id);
				if (record.type === "domain") throw new Error("领域卡不能作为待归入成员");
				if (record.domains.length) throw new Error(`${id} 已有领域归属；请使用 reassign_members`);
				record.domains = [args.target_domain];
				return record;
			});
			return domainProposal(exec, { summary: args.reason, layer: "membership", operations, operator: "assign_domain_members" });
		}
	}));

	ctx.tools.register(defineTool({
		name: "propose_domain_retirement",
		description: "在领域已无活跃成员后提出退役提案。它只改变 lifecycle，不迁移成员、不改正文或关系；有成员时返回合法替代动作。",
		parameters: { domain_id: { type: "string", required: true }, reason: { type: "string", required: true } },
		output: { schema: observationSchema(), render, presentationMeta: (_args, value) => value.data?.proposal ? { proposal: value.data.proposal } : {} },
		execute: async (args, exec) => {
			const members = loadGraphOps(root, seenSetFor(exec)).members(args.domain_id, { limit: 4 });
			if ((members.member_total ?? 0) > 0) {
				return observe(runtime, exec, "propose_domain_retirement", { domain_id: args.domain_id, member_total: members.member_total }, `领域仍有 ${members.member_total} 个成员，不能直接退役。`, { mode: "construct", skill: "nexo-construct", goal: `评估退役领域 ${args.domain_id}` }, { status: "rejected", reason_code: "domain_has_members", next_actions: [{ action: "reassign_members", description: "先分批迁移有证据支持的成员" }, { action: "keep_domain", description: "保留领域并记录边界问题" }] });
			}
			const record = fullRecord(args.domain_id);
			if (record.type !== "domain") throw new Error("propose_domain_retirement 只接受 domain 卡");
			record.lifecycle = "superseded";
			return domainProposal(exec, { summary: args.reason, layer: "lifecycle", operations: [record] });
		}
	}));



	ctx.tools.register(defineTool({
		name: "finish_cognitive_run",
		description: "收束当前任务。宿主标记 conversation-v2 的分析用 status=completed、coverage 和最终 evidence_anchors 准备交付：返回引用核验与具体缺口，不强制补齐方法配额；随后直接回答，宿主确认实际消息后登记交付。无效锚点不能宣称已核验，pending 保留原请求未完成项。固定测试与建构仍执行相应验收，不允许切换策略豁免。旧编译已退役。",
		parameters: {
			status: { type: "string", required: true, enum: ["completed", "blocked", "cancelled", "failed"] },
			coverage: { type: "string", enum: ["answered", "partial", "unanswered", "unknown"], description: "新版分析对原请求的覆盖声明，不是证据正确性认证；重要验证未完成用 partial 并填 pending。" },
			relation_findings: { type: "array", description: "可选的公开关系推理结果，最多8项；不是完成义务或隐藏思维链。", items: { type: "object", additionalProperties: false, properties: {
				claim_id: { type: "string", required: true }, path: { type: "array", required: true, items: { type: "string" } },
				anchors: { type: "array", required: true, items: { type: "string" } }, finding: { type: "string", required: true },
				conditions: { type: "string", required: true }, outcome: { type: "string", required: true, enum: ["narrowed", "alternative", "composed", "unchanged", "rejected", "inconclusive"] }
			} } },
			stop_reason: { type: "string", required: true },
			changed: { type: "array", items: { type: "string" }, required: true },
			unchanged: { type: "array", items: { type: "string" }, required: true },
			pending: { type: "array", items: { type: "string" }, required: true },
			previous_checkpoint: { type: "string", description: "序贯任务中必须与启动时冻结的上一时点一致；首轮可省略" },
			evidence_anchors: { type: "array", items: evidenceItemSchema, description: "最终同一组证据地址、角色和判断；audit_evidence=true 时在本次调用内核验，否则必须已经核验" },
			audit_evidence: { type: "boolean", description: "分析任务 completed 时可合并三项确定性审计；逐项留下真实 Observation，仍受相同完成门和审计预算约束。" }
		},
		output: { schema: { type: "object", additionalProperties: true }, render },
		execute: async (args, exec) => {
			const session_id = sessionIdOf(exec) ?? `process-${process.pid}`;
			let state = runtime.current(session_id);
			if (["compile","theme_compile","digest"].includes(state?.run.mode)) throw new Error("旧编译已退役，历史任务只读。");
			if (!isConversationAnalysis(state)) for (const item of [...args.changed, ...args.unchanged, ...args.pending]) assertPlainUserCopy(item, "建构结果");
			if (!state) return makeObservation({
				operator: "finish_cognitive_run", status: "rejected",
				summary: "当前会话没有可结束的认知任务。",
				reason_code: "no_active_run",
				next_actions: [{ action: "start_cognitive_run", description: "需要显式循环时先开始一个新任务。" }]
			});
			if (!["running", "waiting_user"].includes(state.run.status)) {
				if (state.run.status === args.status) {
					const priorStep = [...state.episode.steps].reverse().find((step) => step.action?.operator === "finish_cognitive_run");
					const result = state.workspace.extension?.result ?? {
						changed: args.changed, unchanged: args.unchanged, pending: args.pending
					};
					const observation = priorStep?.observation ?? makeObservation({
						operator: "finish_cognitive_run", status: "ok", summary: state.workspace.stop_reason ?? args.stop_reason,
						data: { status: state.run.status, ...result }
					});
					return normalizeJsonValue({ run: state.run, result, observation, working_memory: buildWorkingMemory(state), idempotent_replay: true });
				}
				return makeObservation({
					operator: "finish_cognitive_run", status: "rejected",
					summary: `当前任务已经以 ${state.run.status} 结束，不能改写为 ${args.status}。`,
					reason_code: "run_already_closed",
					data: { run_id: state.run.run_id, current_status: state.run.status, requested_status: args.status }
				});
			}
			if (args.status === "completed" && isConversationAnalysis(state)) {
				if (state.run.status !== "running" || runtime.currentInteraction(session_id)) return makeObservation({ operator: "finish_cognitive_run", status: "rejected", reason_code: "pending_user_decision", summary: "请先处理实际待答问题，不能以准备交付覆盖它。" });
				const review = reviewConversationDelivery(root, state, args);
				let run;
				// Save declared pending items before preparing, so the host snapshot cannot be invalidated by its own result projection.
				if (JSON.stringify(args.pending) !== JSON.stringify(state.workspace.extension?.result?.pending)) runtime.updateWorkspace(state.run.run_id, { extension: { result: { changed: args.changed, unchanged: args.unchanged, pending: args.pending } } });
				try { run = runtime.prepareDelivery(state.run.run_id, review, args); }
				catch (error) { return makeObservation({ operator: "finish_cognitive_run", status: "partial", reason_code: "delivery_review_exhausted", summary: error.message }); }
				if (!run.idempotent_replay) {
					runtime.updateWorkspace(state.run.run_id, { extension: { result: { changed: args.changed, unchanged: args.unchanged, pending: args.pending } } });
					runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: makeObservation({ operator: "finish_cognitive_run", status: "ok", summary: "已准备本轮回答；保留证据限制，等待实际交付。", data: { review_ref: review.fingerprint, coverage: review.coverage, limitations: review.limitations } }) });
				}
				return normalizeJsonValue({ run: runtime.get(state.run.run_id).run, review, working_memory: buildWorkingMemory(runtime.get(state.run.run_id)), idempotent_replay: run.idempotent_replay === true });
			}
			if (args.status === "completed") {
				if (args.audit_evidence === true && !isAnalyticalRun(state)) {
					const receipt = makeObservation({ operator: "finish_cognitive_run", status: "rejected", reason_code: "analysis_run_required",
						summary: "请求了分析证据审计，但当前任务不是分析模式；审计未执行，不能以已验收完成。",
						data: { audited: false, applicable: false }, next_actions: [{ action: "start_cognitive_run", description: "确需分析时先升级本题并选择 TM；非分析任务按其真实完成条件收束。" }] });
					runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
					return receipt;
				}
				if (args.audit_evidence === true && isAnalyticalRun(state)) {
					for (const operator of ["inspect_evidence_set", "verify_evidence_anchors", "inspect_cognitive_sufficiency"]) {
						const permission = runtime.canOperate(state.run.run_id, { mode: "read", operator });
						if (!permission.allowed) {
							const receipt = makeObservation({ operator: "finish_cognitive_run", status: "rejected",
							reason_code: permission.reason_code ?? "audit_not_allowed", summary: permission.reason,
							next_actions: [{ action: "finish_cognitive_run", description: "以 blocked 如实记录未闭合条件，不能绕过范围或预算。" }] });
							runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
							return receipt;
						}
						state = runtime.get(state.run.run_id);
						const data = operator === "inspect_evidence_set" ? inspectEvidenceSet(root, state, args.evidence_anchors)
							: operator === "verify_evidence_anchors" ? verifyEvidenceAnchors(root, state, args.evidence_anchors)
								: generalAnalysisReadiness(state, operatorRegistry);
						const observation = makeObservation({ operator, data,
							status: data.results && !data.valid_count ? "partial" : "ok",
							summary: operator === "inspect_cognitive_sufficiency" ? (data.ready ? "合并审计已达到完成门。" : "合并审计仍有未闭合条件。") : `合并审计：已检查 ${data.anchor_count} 个证据地址。`,
							evidence: (data.results ?? []).filter((item) => item.exists).map((item) => ({ card_id: item.card_id, address: item.anchor })) });
						runtime.record(state.run.run_id, { action: { operator, mode: "read", invoked_by: "finish_cognitive_run" }, observation });
					}
					state = runtime.get(state.run.run_id);
				}
				const readiness = constructCompletionReadiness(state, root, { pending: args.pending });
				if (!readiness.ready) {
					const receipt = makeObservation({
						operator: "finish_cognitive_run", status: "rejected",
						summary: readiness.summary, reason_code: readiness.reason_code,
						next_actions: readiness.next_actions,
						data: { mode: state.run.mode, thinking_model: state.run.thinking_model?.id ?? null }
					});
					runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
					return receipt;
				}
				const generalReadiness = generalAnalysisReadiness(state, operatorRegistry, { require_sufficiency_observation: true });
				if (!generalReadiness.ready) {
					const receipt = makeObservation({
						operator: "finish_cognitive_run", status: "rejected",
						summary: "复杂问答的思考状态、证据验收或迭代停止条件尚未闭合。",
						reason_code: "general_analysis_incomplete",
						next_actions: generalReadiness.next_actions,
						data: { mode: state.run.mode, missing: generalReadiness.missing, progress: generalReadiness.progress }
					});
					runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
					return receipt;
				}
				if (isAnalyticalRun(state)) {
					const currentEvidence = verifyEvidenceAnchors(root, state, args.evidence_anchors);
					if (!currentEvidence.all_deterministic_checks_passed) {
						const receipt = makeObservation({ operator: "finish_cognitive_run", status: "rejected", reason_code: "final_evidence_changed",
							summary: "最终证据不可用或卡片正文已改变；补读当前版本后重新验收，不能使用旧通过结果。",
							next_actions: [{ action: "verify_evidence_anchors", description: "核对当前版本并补读失效证据。" }],
							data: { results: currentEvidence.results.filter((item) => !item.usable) } });
						runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
						return receipt;
					}
				}
			}
			const requirements = args.status === "completed" ? modelRequirementStatus(state, operatorRegistry, args) : {
				missing_capabilities: [], unmet_observation_obligations: [], missing_output_obligations: []
			};
			if (requirements.missing_capabilities.length || requirements.unmet_observation_obligations.length || requirements.missing_output_obligations.length) {
				const receipt = makeObservation({
					operator: "finish_cognitive_run", status: "rejected",
					summary: "当前 Thinking Model 的能力、观察或输出义务尚未闭合，不能把任务标记为完成。",
					reason_code: "thinking_model_requirements_incomplete",
					next_actions: [
						...requirements.missing_capabilities.slice(0, 2).map((capability) => ({ action: "inspect_operator_contracts", description: `为 ${capability} 选择一个已注册 Operator 并执行。` })),
						...(requirements.missing_output_obligations.includes("evidence_anchors") ? [{ action: "verify_evidence_anchors", description: "提交的证据与最新核验不一致：先确定最终同一组 anchor/role/claim_id，再检查集合、核验与充分性；不要沿用旧角色。" }] : [])
					],
					data: { thinking_model: state.run.thinking_model?.id, ...requirements }
				});
				runtime.record(state.run.run_id, { action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: receipt });
				return receipt;
			}
			const changed=args.changed,unchanged=args.unchanged,freshState=runtime.get(state.run.run_id);
			const pending = state.run.mode === "construct"
				? [...new Set([
					...state.workspace.deferred_items.filter((item) => !["resolved", "excluded"].includes(item?.status)).map((item) => typeof item === "string" ? item : item?.description ?? item?.reason).filter(Boolean),
					...(state.workspace.extension?.improvement_plan?.status === "deferred" ? [`局部改善尚未全部完成：${state.workspace.extension.improvement_plan.review.reason}`] : []),
					...args.pending
				])]
				: [...new Set(args.pending)];
			const audit = state.run.mode === "construct" ? constructRunAudit(state) : undefined;
			const deferred_items = state.run.mode === "construct" ? [...freshState.workspace.deferred_items, ...pending.filter((description) => !freshState.workspace.deferred_items.some((item) => (typeof item === "string" ? item : item?.description ?? item?.reason) === description)).map((description) => ({
				description, status: "deferred", source: "finish_cognitive_run"
			}))] : freshState.workspace.deferred_items;
			const result = normalizeJsonValue({ changed, unchanged, pending, audit });
			runtime.updateWorkspace(state.run.run_id, {
				deferred_items,
				extension: {
					...freshState.workspace.extension,
					result
				}
			});
			const completion = makeObservation({
				operator: "finish_cognitive_run", status: "ok",
				summary: args.stop_reason,
				data: { status: args.status, ...result, previous_checkpoint: args.previous_checkpoint ?? null, evidence_anchors: args.evidence_anchors ?? [] }
			});
			runtime.record(state.run.run_id, {
				action: { operator: "finish_cognitive_run", mode: "runtime-write" }, observation: completion
			});
			const run = runtime.setStatus(state.run.run_id, args.status, args.stop_reason);
			return normalizeJsonValue({ run, result, observation: completion, working_memory: buildWorkingMemory(runtime.get(state.run.run_id)), idempotent_replay: false });
		}
	}));
}
