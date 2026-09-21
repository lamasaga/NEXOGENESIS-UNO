import { loadCards, readCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { parseCardUnits } from "../packages/nexogenesis-tools/lib/card-units.js";
import { HarnessGateway } from "../packages/nexogenesis-tools/lib/harness/gateway.js";
import { auditCardQuality } from "../packages/nexogenesis-tools/lib/harness/knowledge-quality.js";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const gateway = new HarnessGateway(root);
const cards = loadCards(root);
const today = new Date().toISOString().slice(0, 10);

function themed(card) {
	return (card.meta.sources ?? []).some((source) => String(source).replaceAll("\\", "/").startsWith("05-Buffer/themes/"));
}

function recordOf(id, patch = {}) {
	const card = readCard(root, id);
	if (!card) throw new Error(`Card 不存在：${id}`);
	return { ...card, ...patch, updated: today };
}

function normalizedHeading(value) {
	return String(value ?? "").replace(/[\s`*_#：:，。；;、（）()《》〈〉“”'"-]/gu, "").toLowerCase();
}

function renameDuplicateHeadings(body) {
	const matches = [...String(body).matchAll(/^##\s+(.+?)\s*$/gm)];
	const groups = new Map();
	for (const match of matches) {
		const key = normalizedHeading(match[1]);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(match);
	}
	const replacements = [];
	for (const [key, occurrences] of groups) {
		if (occurrences.length < 2) continue;
		for (let index = 0; index < occurrences.length - 1; index += 1) {
			let heading;
			if (key === "失效边界") {
				heading = occurrences.length === 2 || index === 0 ? "成立条件与识别接口" : "应用与证据接口";
			} else if (key === "调和可能") heading = "比较条件与判别接口";
			else if (key === "输入") heading = "方法目标与研究对象";
			else if (key === "适用边界") heading = index === 0 ? "诊断与验证" : `诊断与验证补充${index + 1}`;
			else throw new Error(`没有为重复标题“${occurrences[index][1]}”定义语义修复`);
			replacements.push({ start: occurrences[index].index, length: occurrences[index][0].length, text: `## ${heading}` });
		}
	}
	let result = String(body);
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.start + replacement.length)}`;
	}
	return result;
}

function replaceH2Section(body, heading, nextHeading, content) {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^##\\s+${escaped}\\s*$[\\s\\S]*?(?=^##\\s+|(?![\\s\\S]))`, "m");
	if (!pattern.test(body)) throw new Error(`找不到章节：${heading}`);
	return body.replace(pattern, `## ${nextHeading}\n\n${content.trim()}\n\n`);
}

function sectionContent(body, heading) {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "m").exec(body)?.[1]?.trim() ?? "";
}

function voiceBoundary(id, type, existing = "") {
	const object = type === "domain" ? "领域导航与问题边界" : type === "method" ? "方法步骤、诊断与适用边界" : type === "conflict" ? "分歧结构与判别条件" : "核心命题、作用机制与成立边界";
	const synthesis = existing.replace(/^\s+/gm, "").trim();
	return [
		`  作者原意：所列章节分别为“${id}”提供定义、推导、证据接口或限制；具体论证仍以对应章节来源和定位信息为准。`,
		`  跨书综合：${synthesis || `本卡只把多个来源中能够共同讨论的${object}组织到同一知识对象中，不把章节之间的差异抹平。`}`,
		`  系统推论：本卡的结构化整理用于比较与检索，不代表任何具体样本已经满足识别条件，也不把教材中的条件性结论外推为普遍经验规律。`
	].join("\n\n");
}

function weakExcerptBoundary(id, type, excerpt) {
	const locator = excerpt.replace(/<!--.*?-->/gs, "").replace(/^\s*[-*+>]\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);
	const synthesisObject = type === "domain" ? "领域中的共同问题和边界" : type === "conflict" ? "相反机制与判别条件" : type === "method" ? "操作步骤和诊断条件" : "定价关系、作用机制和失效边界";
	return [
		`  作者原意：本卡的定义、公式与条件来自所列章节来源。原摘录栏中的“${locator}”只是章节或小节定位线索，不作为逐字引文或独立证据。`,
		`  跨书综合：正文围绕“${id}”归并${synthesisObject}；各项数字、样本和模型前提仍以对应章节来源为准。`,
		"  系统推论：未把校准关系、历史样本或教材例题外推为普遍经验规律；需要逐字引用或现实市场判断时，必须回到原书页码或补充带时点的数据。"
	].join("\n\n");
}

const UNIT_RULES = {
	claim: [["一句话主张", "核心主张"], ["依据"], ["适用条件"], ["已知限制", "限制与边界"]],
	model: [["核心思想"], ["关键组件"], ["结构关系", "因果链条", "结构关系或因果链条", "结构关系/因果链条", "结构关系与因果链条", "因果/结构"], ["失效边界", "限制与边界"]],
	method: [["输入"], ["步骤"], ["输出"], ["适用边界", "限制与边界"]],
	conflict: [["对立双方"], ["核心分歧点"], ["各自证据或代价", "各自证据/代价"], ["调和可能"]]
};
const UNIT_IDS = {
	claim: ["claim-core", "evidence-basis", "condition-scope", "boundary-primary"],
	model: ["claim-core", "mechanism-components", "mechanism-structure", "boundary-primary"],
	method: ["condition-input", "mechanism-procedure", "claim-output", "boundary-primary"],
	conflict: ["tension-sides", "tension-core", "evidence-sides", "boundary-reconciliation"]
};

function ensureTwoUnits(id, type, body) {
	if (parseCardUnits(id, body).length >= 2) return body;
	let result = String(body).replace(/(?:\r?\n)?<!--\s*unit:\s*[a-z][a-z0-9-]{2,80}\s*-->\r?\n?/g, "\n");
	const insertions = [];
	for (const [index, aliases] of (UNIT_RULES[type] ?? []).entries()) {
		const match = [...result.matchAll(/^##\s+(.+?)\s*$/gm)].find((item) => aliases.some((alias) => normalizedHeading(alias) === normalizedHeading(item[1])));
		if (!match) continue;
		const next = [...result.matchAll(/^##\s+(.+?)\s*$/gm)].find((item) => item.index > match.index);
		const text = result.slice(match.index + match[0].length, next?.index ?? result.length).trim();
		if (text.length < 20) continue;
		insertions.push({ offset: match.index + match[0].length, id: UNIT_IDS[type][index] });
	}
	if (insertions.length < 2) throw new Error(`Card ${id} 没有两个足够完整的语义槽可供标注`);
	for (const insertion of insertions.slice(0, 4).sort((left, right) => right.offset - left.offset)) {
		result = `${result.slice(0, insertion.offset)}\n\n<!-- unit: ${insertion.id} -->${result.slice(insertion.offset)}`;
	}
	return result;
}

const openingRewrites = new Map([
	["非正式保险只能分担可观察局部风险", "非正式保险依靠可观察冲击和可执行互惠，因而主要平滑社区内部的特质风险；共同冲击、长期高额损失或不可核实损失会同时削弱资源池与履约基础。"],
	["欧洲市场制度不是大分流的充分前因", "十八世纪欧亚核心区的土地、劳动和产品市场差异不足以单独解释工业革命分叉；要说明大分流，还必须加入能源、殖民地、生态约束或其他外生条件。"],
	["适应性效率不能还原为配置效率", "配置效率衡量既定规则下的静态资源利用，适应性效率衡量制度能否容纳试错、创新和纠错；前者良好不保证经济能跨期摆脱低效路径。"],
	["制度移植不等于激励移植", "复制成文规则不会自动复制原制度的激励效果，因为执行组织、非正式规范、信息结构与行动者预期共同决定规则如何落地。"]
]);

const deadSources = new Map([
	["比较优势与专业化贸易", ["05-Buffer/meaning-unit/2026-08-16-105544-01-比较优势可以被创造：对静态比较优势的批判.md"]],
	["财政账目作为观察政府行为的入口", ["05-Buffer/meaning-unit/2026-08-16-104620-01-财政账目是观察政见冲突与人事谋略的入口.md"]],
	["省直管县财政扁平化的浙江条件", ["05-Buffer/tension/2026-08-16-104654-01-省直管县在浙江成功，在外省却把大车劈成小车.md"]],
	["央地财政事权财权不匹配与基年政治", [
		"05-Buffer/tension/2026-08-16-103521-01-央地张力：统一不过950年，分裂占55%.md",
		"05-Buffer/tension/2026-08-16-104620-01-事权与财力匹配争议小，事权与财权匹配争议大，实际收支高度不匹配.md",
		"05-Buffer/tension/2026-08-16-104636-01-基年的政治：央地博弈藏在技术参数里，政策落地靠协商而非命令.md",
		"05-Buffer/meaning-unit/2026-08-16-103521-01-五级政府体系与‘以市管县’的演变.md",
		"05-Buffer/meaning-unit/2026-08-16-103521-01-官僚体系：意识形态、上级任命与异地轮换.md",
		"05-Buffer/meaning-unit/2026-08-16-104620-01-事权划分决定财权，且因其决定因素稳定而相对稳定.md",
		"05-Buffer/meaning-unit/2026-08-16-104636-01-财政包干制：地方积极性与“两个比重”下降的内在悖论.md",
		"05-Buffer/meaning-unit/2026-08-16-104654-01-分税制后财权上收、事权下压，基层财政陷入讨饭财政.md"
	]]
]);

const relationRepairs = [
	["包容性制度与攫取性制度", "适应性效率不能还原为配置效率", "supports", "包容性制度通过开放参与、约束攫取并保留创新与纠错空间，具体说明长期适应能力为何不能由静态配置效率替代。"],
	["财政账目作为观察政府行为的入口", "央地财政事权财权不匹配与基年政治", "applies-to", "财政收支、基数与返还口径把抽象央地权责落实为可观察记录，因此该方法可用于识别事权财权错配及协商结果。"],
	["发展政策边界由制度利益文化共同决定", "制度移植不等于激励移植", "supports", "政策效果受本地利益妥协、执行制度与文化规范约束，这直接支持复制法条不能复制真实激励的判断。"],
	["分工收益受协调成本约束", "比较优势与专业化贸易", "extends", "比较优势说明专业化收益，本卡进一步加入任务协调、知识传递与组织摩擦，限定分工深化并非无成本。"],
	["契约实证必须区分自选择与激励效应", "道德风险中的激励与保险权衡", "applies-to", "观察到契约与行为相关时，必须先分离主体自选择与合同激励，才能把证据用于检验道德风险中的激励—保险机制。"],
	["效率工资五渠道", "劳动市场摩擦使企业具有工资设定空间", "extends", "搜寻与买方势力解释企业为何能设定工资，效率工资进一步说明企业为何可能主动支付高于外部选项的工资以改善生产率与留任。"]
];

function contentOperations() {
	const operations = [];
	for (const card of cards.values()) {
		if (!themed(card)) continue;
		const audit = auditCardQuality({ ...card.meta, body: card.body }, { root });
		const codes = new Set(audit.findings.map((item) => item.code));
		let body = card.body;
		if (codes.has("duplicate_semantic_heading")) body = renameDuplicateHeadings(body);
		if (codes.has("weak_source_excerpt")) {
			const excerpt = sectionContent(body, "原文摘录");
			body = replaceH2Section(body, "原文摘录", "来源与证据边界", weakExcerptBoundary(card.meta.id, card.meta.type, excerpt));
		} else if (codes.has("theme_voice_boundary_missing") || codes.has("thin_source_boundary")) {
			const boundary = sectionContent(body, "来源与证据边界");
			try {
				body = replaceH2Section(body, "来源与证据边界", "来源与证据边界", voiceBoundary(card.meta.id, card.meta.type, boundary));
			} catch (error) {
				throw new Error(`Card ${card.meta.id} 修复来源边界失败：${error.message}`);
			}
		}
		if (codes.has("theme_units_insufficient")) body = ensureTwoUnits(card.meta.id, card.meta.type, body);
		if (openingRewrites.has(card.meta.id)) {
			const heading = /^##\s+(一句话主张|核心主张)\s*$/m.exec(body)?.[1];
			if (!heading) throw new Error(`Card ${card.meta.id} 缺少主张标题`);
			const current = sectionContent(body, heading);
			const markers = current.match(/^\s*<!--\s*unit:[^\n]+-->\s*/u)?.[0] ?? "";
			body = replaceH2Section(body, heading, heading, `${markers}${openingRewrites.get(card.meta.id)}`);
		}
		if (body !== card.body) operations.push(recordOf(card.meta.id, { body }));
	}
	return operations;
}

function sourceOperations() {
	return [...deadSources].map(([id, dead]) => {
		const current = readCard(root, id);
		const sources = current.sources.filter((source) => !dead.includes(source));
		if (sources.length === current.sources.length) throw new Error(`Card ${id} 没有预期的失踪来源`);
		return recordOf(id, { sources });
	});
}

function relationOperations() {
	return relationRepairs.map(([source, target, type, note]) => {
		const current = readCard(root, source);
		if (!readCard(root, target)) throw new Error(`关系目标不存在：${target}`);
		if (current.relations.some((relation) => relation.type === type && relation.target === target)) return null;
		return recordOf(source, { relations: [...current.relations, { target, type, note }] });
	}).filter(Boolean);
}

function processBatches(operations, layer, label) {
	const receipts = [];
	for (let index = 0; index < operations.length; index += 3) {
		const batch = operations.slice(index, index + 3);
		const checked = gateway.preflight({ operations: batch, layer });
		if (apply) receipts.push(gateway.commit({
			proposal_id: `codex-theme-repair-${layer}-${Math.floor(index / 3) + 1}`,
			operations: checked.cards, layer: checked.layer, revisions: checked.revisions
		}));
	}
	return { label, operations: operations.length, batches: Math.ceil(operations.length / 3), receipts: receipts.length };
}

const summary = [];
const content = contentOperations();
summary.push(processBatches(content, "content", "正文与语义单元"));
// 应用模式下前一层已经改变正文修订指纹；这里重新从磁盘组装完整记录，
// 避免 sources / relation 层把旧正文夹带回去。
const source = sourceOperations();
summary.push(processBatches(source, "sources", "失踪来源清理"));
const relation = relationOperations();
summary.push(processBatches(relation, "relation", "关系接入"));

console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", summary }, null, 2));
