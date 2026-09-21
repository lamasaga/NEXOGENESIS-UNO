import { defineTool } from "@deepseek-ai/dsh-tools";
import { getCognitiveRuntime } from "./run-store.js";
import { operatorRegistry } from "./operator-registry.js";
import { makeObservation, observationSchema } from "./observations.js";
import { renderModelOutput } from "./model-output.js";
import { IMPROVEMENT_KINDS, inspectKnowledgeGap, planConstructImprovement, reviewConstructImprovement, constructWorkingMemory } from "./construct-improvement.js";

const strings = { type: "array", items: { type: "string" } };
export function registerConstructTools(ctx, getRoot) {
	const register = (name, mode, capability, description, parameters, execute, constructOnly = true) => {
		if (!operatorRegistry.get(name)) operatorRegistry.register({ name, version: "1.0.0", capabilities: [capability], mode, risk: "low", cost: "medium" });
		ctx.tools.register(defineTool({ name, description, parameters,
			output: { schema: observationSchema(), render: renderModelOutput },
			execute: async (args, exec) => {
				const root = getRoot(), runtime = getCognitiveRuntime(root), state = runtime.ensure(exec, constructOnly
					? { mode: "construct", skill: "nexo-construct", goal: "改善知识的组织与使用" }
					: { mode: "general", skill: "implicit", goal: "按具体概念定位既有知识" });
				const reject = (reason_code, summary) => {
					const observation = makeObservation({ operator: name, status: "rejected", reason_code, summary });
					runtime.record(state.run.run_id, { action: { operator: name, mode }, observation });
					return observation;
				};
				if (constructOnly && state.run.mode !== "construct") return reject("construct_run_required", "该工具只用于建构任务；没有执行检测，不能据此推断知识缺失。");
				const allowed = runtime.canOperate(state.run.run_id, { mode, operator: name });
				if (!allowed.allowed) return reject(allowed.reason_code, allowed.reason);
				let observation;
				try {
					const result = execute(root, state, args);
					if (result.plan) {
						const prior = state.workspace.extension?.improvement_plan;
						const history = state.workspace.extension?.improvement_history ?? [];
						runtime.updateWorkspace(state.run.run_id, { extension: { improvement_plan: result.plan,
							...(prior && prior.id !== result.plan.id ? { improvement_history: [...history, {
								id: prior.id, status: prior.status, kind: prior.kind, problem: prior.problem,
								card_ids: prior.card_ids, review: { reason: prior.review?.reason }
							}] } : {}) } });
					}
					observation = makeObservation({ operator: name, status: result.status ?? "ok", summary: result.summary, data: result.data });
				} catch (error) {
					observation = makeObservation({ operator: name, status: "rejected", reason_code: "construct_improvement_contract", summary: error.message });
				}
				runtime.record(state.run.run_id, { action: { operator: name, mode }, observation });
				return observation;
			}
		}));
	};
	register("inspect_knowledge_gap", "read", "inspect-knowledge-gap",
		"通用只读全文定位，不要求建构模式；仍受当前任务预算与 allowed_ops 限制。用 1–4 组概念或别名定位活跃卡完整正文。默认 match_mode=any，空格分隔关键词，命中任一即召回；all 要求同卡含全部词；phrase 要求连续短语。例如 queries:[复本位,自由铸银] 或 queries:[复本位 金银比价]。返回 matched_terms 和有限片段，须精读判断。零命中换词或拆词；拒绝不表示未命中，不得据此宣称知识不存在、主题尚未编译或确定合理独立。",
		{ queries: { ...strings, required: true }, limit: { type: "number" }, match_mode: { type: "string", enum: ["any", "all", "phrase"] } },
		(root, _state, args) => { const data = inspectKnowledgeGap(root, args); return { data, summary: data.conclusion === "candidates_found" ? "找到需要精读的既有材料；先区分内容缺失与组织缺口。" : "这些短语尚未定位到材料；可换措辞或从相邻节点探索，不据此宣布缺卡。" }; }, false);
	register("plan_construct_improvement", "runtime-write", "plan-knowledge-improvement",
		"记录一项局部知识改善计划：关系、合并、拆分、精修、领域归属或有解释力的聚合。必须完整阅读当前源卡；提供未选方案、不可丢失的关键原文锚点及结果去向、1–3 个检索验证短语。自动保存版本、入边影响和检索基线，不写卡。之后复用现有单层写入工具；关键锚点是保留原文的下限，其余内容可以准确改写。",
		{ kind: { type: "string", required: true, enum: IMPROVEMENT_KINDS }, problem: { type: "string", required: true }, benefit: { type: "string", required: true },
			card_ids: { ...strings, required: true }, target_ids: { ...strings, required: true }, retire_ids: strings, alternatives: { ...strings, required: true },
			preservation: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { from: { type: "string", required: true }, excerpt: { type: "string", required: true }, to: { ...strings, required: true } } } },
			probes: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { query: { type: "string", required: true }, expected_ids: { ...strings, required: true } } } } },
		(root, state, args) => { const plan = planConstructImprovement(root, state, args); return { plan, summary: "已保存局部改善目标、保留去向、入边影响和检索基线；尚未修改知识卡。", data: { plan_id: plan.id, inbound: plan.inbound, working_memory: constructWorkingMemory({ ...state, workspace: { ...state.workspace, extension: { ...state.workspace.extension, improvement_plan: plan } } }) } }; });
	register("review_construct_improvement", "simulate", "verify-knowledge-improvement",
		"按原计划重跑发现性验证，并检查结果对象、关键原文锚点、来源承接、退役入边与非法关系。verify 表示模型已审阅语义收益；程序通过不代表语义正确。defer 如实保留部分写入与下一步；keep 仅用于未写入且决定保持现状。",
		{ outcome: { type: "string", required: true, enum: ["verify", "defer", "keep"] }, reason: { type: "string", required: true, description: "说明表达、机制、差异、边界是否保留，以及检索/比较的实际收益；延期写明下一步。" } },
		(root, state, args) => { const plan = reviewConstructImprovement(root, state, args); return { plan, status: plan.review.errors.length ? "partial" : "ok", summary: plan.review.errors.length ? "改善验收仍有缺口，不能标记完成。" : "已记录改善复核；语义收益为模型判断，未冒充独立验证。", data: { plan_id: plan.id, status: plan.status, ...plan.review } }; });
}
