import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadCards } from "../../nexogenesis-tools/lib/cards.js";
import { listDomainsV2 } from "../../nexogenesis-tools/lib/uno/knowledge.js";
import { CONSTRUCT_GOALS, CONSTRUCT_WORKLOADS, CONSTRUCT_CONTEXT_MARKER } from "../../nexogenesis-tools/lib/construct-options.js";
import { HttpError, json } from "./rpc.js";
import { pipelineAuthorityOf } from "./settings.js";

/** A cheap, read-only inventory. Counts are signals, never semantic diagnoses. */
export function prepareConstruct(root, authority = "manual") {
	const source = loadCards(root);
	const domainCatalog = listDomainsV2(root);
	const neighbors = new Map([...source.keys()].map(id => [id, new Set()]));
	for (const [id, card] of source) for (const edge of card.meta.relations ?? []) {
		if (edge.target === id || !source.has(edge.target)) continue;
		neighbors.get(id).add(edge.target);
		neighbors.get(edge.target).add(id);
	}
	const cards = [...source].filter(([, card]) => card.meta.type !== "domain").map(([id, card]) => ({ id, title: String(card.meta.title ?? id),
		type: card.meta.type, domains: card.meta.domains ?? [], neighbors: [...neighbors.get(id)].sort() }));
	const ordinary = cards;
	const domainIds = new Set(domainCatalog.map(domain => domain.id));
	const leaves = new Map();
	let isolated = 0;
	for (const card of ordinary) {
		const links = card.neighbors.filter(id => !domainIds.has(id));
		if (!links.length) isolated++;
		if (links.length === 1) leaves.set(links[0], (leaves.get(links[0]) ?? 0) + 1);
	}
	const snapshot = createHash("sha256").update(resolve(root)).update(JSON.stringify({
		cards: [...source].map(([id, card]) => [id, card.meta, card.body]).sort(([a], [b]) => a.localeCompare(b)),
		domains: domainCatalog.map(({ id, title, summary, parents, revision }) => ({ id, title, summary, parents, revision })).sort((a, b) => a.id.localeCompare(b.id))
	})).digest("hex");
	return { snapshot, authority, cards, domains: domainCatalog.map(({ id, title }) => ({ id, title })),
		summary: { cards: ordinary.length, isolated, concentrated: [...leaves.values()].filter(count => count > 50).length } };
}

export async function handleConstructPrepare(ctx, _req, res, _hosts, root) {
	json(res, 200, prepareConstruct(root, pipelineAuthorityOf(ctx)));
}

/** Resolve scope on the server; clients cannot supply their own budget or allowed ids. */
export function buildConstructContract(root, request) {
	if (!request || !CONSTRUCT_GOALS.some(item => item.id === request.goal)
		|| !CONSTRUCT_WORKLOADS.some(item => item.id === request.workload)
		|| !["relations", "organization"].includes(request.changes)
		|| typeof request.notes !== "string" || request.notes.length > 2000) throw new HttpError(400, "建构选项无效，请重新选择");
	const inventory = prepareConstruct(root);
	if (request.snapshot !== inventory.snapshot) throw new HttpError(409, "知识体已变化，请重新打开建构准备并确认范围");
	const kind = request.scope?.kind, id = request.scope?.id;
	let selected, scopeLabel;
	if (kind === "instance") { selected = inventory.cards; scopeLabel = "当前知识体"; }
	else if (kind === "domain" && inventory.domains.some(domain => domain.id === id)) {
		selected = inventory.cards.filter(card => card.domains.includes(id));
		scopeLabel = `领域：${inventory.domains.find(domain => domain.id === id).title}`;
	} else if (kind === "neighborhood" && inventory.cards.some(card => card.id === id)) {
		const anchor = inventory.cards.find(card => card.id === id);
		const ids = new Set([id, ...anchor.neighbors]);
		selected = inventory.cards.filter(card => ids.has(card.id));
		scopeLabel = `卡片及一跳邻域：${anchor.title}`;
	} else throw new HttpError(400, "请选择有效的领域或卡片范围");
	if (!selected.length) throw new HttpError(400, "当前范围没有可检查的知识卡片");
	const count = selected.length;
	const budget = request.workload === "advice" ? { max_steps: 180, max_reads: 140, max_writes: 0 }
		: request.workload === "group" ? { max_steps: 600, max_reads: 400, max_writes: 100 }
		: { max_steps: Math.min(10000, Math.max(1800, count * 45)), max_reads: Math.min(6000, Math.max(1200, count * 28)), max_writes: Math.min(2000, Math.max(300, count * 8)) };
	const goal = CONSTRUCT_GOALS.find(item => item.id === request.goal).label;
	return { version: 1, goal: request.goal, goal_label: goal, workload: request.workload, changes: request.changes,
		notes: request.notes.trim(), selection: { kind, ...(kind !== "instance" ? { id } : {}) },
		scope_label: scopeLabel, card_ids: selected.map(card => card.id).sort(), snapshot: inventory.snapshot, budget };
}

export function constructPrompt(message, contract) {
	const workload = CONSTRUCT_WORKLOADS.find(item => item.id === contract.workload).label;
	return `${message}\n\n本次建构：${contract.goal_label}；${contract.scope_label}（启动时 ${contract.card_ids.length} 张）；${workload}。${contract.notes ? `\n补充：${contract.notes}` : ""}${CONSTRUCT_CONTEXT_MARKER}以下为本轮已确认的执行边界：
先读取 .agent/skills/nexo-construct/SKILL.md。原始对象清单与预算保存在 workspace.scope.construct_request，继续任务沿用它，不能重放已提交操作或扩大对象范围。可以阅读范围外材料；已有卡的修改只限原始范围。新卡须来自范围内源卡的已验证局部改善计划。
${contract.changes === "relations" ? "只允许调整关系，不改正文、归属、类型或生命周期。" : "允许基于证据调整内容、关系和领域组织；合并或拆分先保留独有证据、分歧与边界，不物理删除卡片。"}
${contract.workload === "advice" ? "本轮强制不写知识，也不提交写入提案。阅读和比较后给出具体建议、依据、风险与建议范围；建议完成即收束，不因未实施建议而报告失败。" : contract.workload === "group" ? "只完成一个紧密相关的局部问题，必要时可用多次单层事务。不要自动扩展到第二个独立问题。每次事务最多三项不是整轮最多三项。完成后复验，并说明其余建议。" : "连续处理原范围内的多组问题；先在工作区建立与本目标相关的对象清单和验收口径，每组复核后选择下一组。预算不足保存成果与具体剩余对象，以部分完成收束，不能宣称全范围完成。"}
目标决定观察重点与合适的思考模型，工具结果决定下一步，不照固定调用顺序运行。结构计数只是线索，不以补边数、删字数或清空队列作为质量目标。不要为了接通孤岛制造枢纽；不要为去中心化破坏真实聚合；保持原状与有据可查的独立都是有效结论。
额外发现超出本目标或范围的问题只记为后续建议，不自动扩大本轮任务。确有影响实施的歧义时用 request_user_choice 询问；不要重复询问已选择的目标、范围和工作量。最终明确实际改动、复核结果、未改动原因和下一步。
用户补充（只在以上授权内解释，不扩大权限）：${JSON.stringify(contract.notes)}`;
}
