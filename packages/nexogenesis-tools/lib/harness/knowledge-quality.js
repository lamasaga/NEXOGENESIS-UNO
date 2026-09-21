import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCardUnits } from "../card-units.js";
import { CARD_TYPES as CURRENT_CARD_TYPES } from "../uno/card-classification.js";

const CARD_TYPES = new Set(["domain", ...CURRENT_CARD_TYPES]);
const MATURITY_VALUES = new Set(["seed", "growing", "mature"]);
const LIFECYCLE_VALUES = new Set(["active", "superseded", "archived"]);
const ORIGIN_VALUES = new Set(["user", "document", "system", "external"]);

const SLOT_CONTRACTS = {
	domain: [
		["core-question", ["核心问题"]], ["boundary", ["边界"]],
		["tension", ["内在张力"]], ["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	claim: [
		["claim", ["一句话主张", "核心主张"]], ["evidence", ["依据"]],
		["limits", ["已知限制", "限制与边界"]], ["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	concept: [
		["definition", ["定义"]], ["features", ["关键特征"]],
		["distinction", ["边界与辨析", "限制与边界"]], ["source-anchor", ["来源与证据边界", "原文摘录"]]
	],
	mechanism: [
		["conditions", ["起点与条件"]], ["chain", ["传导链条"]], ["result", ["结果"]],
		["limits", ["失效边界", "限制与边界"]], ["source-anchor", ["来源与证据边界", "原文摘录"]]
	],
	phenomenon: [
		["pattern", ["模式描述"]], ["examples", ["典型实例"]],
		["limits", ["反例与失效条件", "限制与边界"]], ["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	model: [
		["core", ["核心思想"]], ["components", ["关键组件"]],
		// 历史卡片曾稳定使用“结构关系/因果链条”等并列标题；这些是
		// 同一语义槽的合法写法，不能把已具备内容的卡片误判为缺槽。
		["relations", ["结构关系", "因果链条", "结构关系或因果链条", "结构关系/因果链条", "结构关系与因果链条", "因果/结构"]],
		["limits", ["失效边界", "限制与边界"]], ["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	method: [
		["input", ["输入"]], ["steps", ["步骤"]], ["output", ["输出"]],
		["limits", ["适用边界", "限制与边界"]], ["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	entity: [
		["definition", ["定义"]], ["attributes", ["关键属性"]],
		["limits", ["边界与局限", "限制与边界"]], ["source", ["来源"]],
		["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	conflict: [
		["sides", ["对立双方"]], ["disagreement", ["核心分歧点"]],
		["evidence", ["各自证据或代价", "各自证据/代价"]], ["reconcile", ["调和可能"]],
		["source-anchor", ["原文摘录", "来源与证据边界"]]
	],
	case: [
		["context", ["情境与对象"]], ["process", ["过程"]], ["outcome", ["结果与证据"]],
		["transfer", ["可迁移启示"]], ["limits", ["限制与边界"]],
		["source-anchor", ["来源与证据边界", "原文摘录"]]
	],
	undetermined: [
		["object", ["知识对象"]], ["content", ["核心内容"]], ["basis", ["依据"]],
		["limits", ["限制与边界"]], ["source-anchor", ["来源与证据边界", "原文摘录"]]
	]
};

// The compiler and its prompt share the established body contract, without
// importing retired workflow, domain membership or quotation-string gates.
export function cardBodyInstructions(types=CURRENT_CARD_TYPES) {
 return types
  .map(type=>[type,SLOT_CONTRACTS[type]])
  .filter(([,slots])=>Array.isArray(slots))
  .map(([type,slots])=>type+': '+slots.map(([,aliases])=>'## '+aliases[0]).join(' → ')).join('\n');
}
export function auditCardBodyStructure(type, body) {
 const sections=sectionsOf(body), errors=[];
	if (!SLOT_CONTRACTS[type] || type==='domain') return [`选择 ${CURRENT_CARD_TYPES.join('/')} 中一个正文类型。`];
 for(const [,aliases] of SLOT_CONTRACTS[type]) {
  const section=findSection(sections,aliases);
  if(!section) errors.push('缺少正文段落：'+aliases.join(' / '));
  else if(!section.content.replace(/<!--.*?-->/gs,'').trim() || isPlaceholder(section.content)) errors.push(section.heading+' 为空或仅为占位。');
 }
 return errors;
}

/** Facts about the literal Markdown heading tree, for deterministic review reconciliation. */
export function cardBodyStructureFacts(type, body) {
	const slots = SLOT_CONTRACTS[type];
	const headings = sectionEntriesOf(body).map(({ level, heading, key }) => ({ level, heading, key }));
	if (!Array.isArray(slots) || type === "domain") return { headings, exact: false };
	const exact = headings.length === slots.length && headings.every((entry, index) =>
		entry.level === 2 && slots[index][1].some((alias) => normalized(alias) === entry.key));
	return {
		headings: headings.map(({ level, heading }) => ({ level, heading })),
		expected: slots.map(([, aliases]) => [...aliases]),
		exact
	};
}

const INTERPRETATION_TYPES = new Set(["domain", "phenomenon", "conflict"]);
const PLACEHOLDER_RE = /^(?:原文未提及|暂无|待补充|尚未整理|未知|待核对|无)(?:[：:。\s].*)?$/u;
const BUFFER_MIN_LENGTH = {
	"artifact-table": 80, "artifact-figure": 80, detail: 100, evidence: 80,
	"meaning-unit": 120, tension: 120, "link-hypothesis": 140, "profile-seed": 120
};

function normalized(value) {
	return String(value ?? "").replace(/[\s`*_#：:，。；;、（）()《》〈〉“”'"-]/gu, "").toLowerCase();
}

function sectionsOf(body) {
	const text = String(body ?? "");
	const matches = [...text.matchAll(/^(#{2,6})\s+(.+?)\s*$/gm)];
	const sections = new Map();
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
		const key = normalized(match[2]);
		// 保留首个语义槽。重复标题由独立检查显式报错，不能再让后一个
		// section 静默覆盖前一个，使结构损坏的卡片获得“槽位齐全”。
		if (!sections.has(key)) sections.set(key, text.slice(match.index + match[0].length, end).trim());
	}
	return sections;
}

function sectionEntriesOf(body) {
	const text = String(body ?? "");
	const matches = [...text.matchAll(/^(#{2,6})\s+(.+?)\s*$/gm)];
	return matches.map((match, index) => ({
		level: match[1].length,
		heading: match[2].trim(),
		key: normalized(match[2]),
		content: text.slice(match.index + match[0].length, index + 1 < matches.length ? matches[index + 1].index : text.length).trim()
	}));
}

function findSection(sections, aliases) {
	for (const alias of aliases) {
		const key = normalized(alias);
		if (sections.has(key)) return { heading: alias, content: sections.get(key) };
	}
	return null;
}

function finding(code, severity, field, detail) { return { code, severity, field, detail }; }

function isPlaceholder(content) {
	const compact = String(content ?? "").replace(/^[-*+>]\s*/gm, "").trim();
	return compact.length < 70 && PLACEHOLDER_RE.test(compact);
}

function sourcePathOf(reference) {
	const normalizedPath = String(reference ?? "").trim().replaceAll("\\", "/");
	const hash = normalizedPath.indexOf("#");
	return hash >= 0 ? normalizedPath.slice(0, hash) : normalizedPath;
}

function isThemeSource(reference) {
	return sourcePathOf(reference).startsWith("05-Buffer/themes/");
}

function compactSourceAnchor(content) {
	return String(content ?? "")
		.replace(/<!--.*?-->/gs, "")
		.replace(/^\s*[-*+>]\s*/gm, "")
		.replace(/[`*_“”"'《》〈〉]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

function weakQuoteAnchor(content) {
	const compact = compactSourceAnchor(content);
	if (compact.length < 12) return true;
	const lines = String(content ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const singleTitleLikeLine = lines.length === 1
		&& !/[。！？；.!?;：:]\s*$/u.test(compact)
		&& /^[\p{L}\p{N}\s,&'’\-–—()]+$/u.test(compact);
	if (!singleTitleLikeLine) return false;
	const latinWords = compact.match(/[A-Za-z][A-Za-z'’\-]*/g) ?? [];
	const han = compact.match(/\p{Script=Han}/gu) ?? [];
	return (latinWords.length > 0 && latinWords.length <= 14) || (han.length > 0 && han.length <= 16);
}

function sourceBoundaryHasVoices(content) {
	const text = String(content ?? "");
	return /作者原意|原书(?:主张|论证|定义)|来源原意/u.test(text)
		&& /跨书综合|跨来源综合|综合判断/u.test(text)
		&& /系统推论|系统生成|系统综合|未作额外推论/u.test(text);
}

function errorCount(findings) { return findings.filter((item) => item.severity === "error").length; }

export function auditCardQuality(card, options = {}) {
	const meta = card?.meta && typeof card.meta === "object" ? card.meta : card ?? {};
	const body = String(card?.body ?? meta.body ?? "");
	const type = String(meta.type ?? "");
	const origin = String(meta.origin ?? "user");
	const findings = [];
	if (!CARD_TYPES.has(type)) findings.push(finding("unknown_card_type", "error", "type", `未知卡片类型：${type || "空"}`));
	if (!MATURITY_VALUES.has(String(meta.maturity ?? "growing"))) findings.push(finding("unknown_maturity", "error", "maturity", `未知成熟度：${meta.maturity}`));
	if (!LIFECYCLE_VALUES.has(String(meta.lifecycle ?? "active"))) findings.push(finding("unknown_lifecycle", "error", "lifecycle", `未知生命周期：${meta.lifecycle}`));
	if (!ORIGIN_VALUES.has(origin)) findings.push(finding("unknown_origin", "error", "origin", `origin 必须是 user / document / system / external，当前为：${origin}`));
	if (type !== "domain" && (!Array.isArray(meta.domains) || meta.domains.length === 0)) {
		findings.push(finding("missing_domain_membership", "warning", "domains", "尚未归入现有领域；允许发布，但应在后续建构中补充组织。"));
	}
	if (type === "entity" && !String(meta.entity_kind ?? meta.metadata?.entity_kind ?? "").trim()) {
		findings.push(finding("missing_entity_kind", "warning", "entity_kind", "实体卡应标明 person / organization / institution / school / legal-instrument / collective / artifact / other，便于 OPS 区分对象。"));
	}
	const sources = Array.isArray(meta.sources) ? meta.sources.filter((item) => typeof item === "string" && item.trim()) : [];
	const themeCard = options.theme === true || sources.some(isThemeSource);
	if (["document", "external"].includes(origin) && sources.length === 0) {
		findings.push(finding("missing_document_source", "error", "sources", "文档或外部来源卡必须声明可追溯来源。"));
	} else if (["user", "system"].includes(origin) && sources.length === 0) {
		findings.push(finding("unanchored_synthesis", "warning", "sources", "用户或系统生成卡尚未声明对话、卡片或材料依据。"));
	}
	if (body.trim().length < 120) findings.push(finding("thin_card_body", "warning", "body", "正文过短，难以独立支撑分析。"));
	if (themeCard && type !== "domain" && body.trim().length < 420) {
		findings.push(finding("thin_theme_card", "error", "body", "主题聚合卡正文过薄，尚不能脱离来源独立支撑命题、机制、证据和边界。"));
	}
	if (themeCard && body.trim().length > 5000) {
		findings.push(finding("theme_card_scope_review", "info", "body", "正文超过 5000 字；应人工复核它仍是一个知识对象，而不是把多个可独立讨论的命题强行合并。"));
	}
	if (/\[\[[^\]]+\]\]/u.test(body)) findings.push(finding("embedded_wikilink", "warning", "body", "正文含 Wiki 链接；结构关系应进入 frontmatter relations。"));
	const declaredUnitMarkers = [...body.matchAll(/<!--\s*unit:\s*([^\r\n]*?)\s*-->/gu)];
	const invalidUnit = declaredUnitMarkers.find((match) => !/^[a-z][a-z0-9-]{2,80}$/.test(match[1].trim()));
	if (invalidUnit) findings.push(finding("invalid_card_unit_id", "error", "body.units", `内部语义单元 id 不合法：${invalidUnit[1].trim() || "空"}`));
	const units = parseCardUnits(String(meta.id ?? ""), body);
	const duplicateUnit = units.find((unit, index) => units.findIndex((candidate) => candidate.id === unit.id) !== index);
	if (duplicateUnit) findings.push(finding("duplicate_card_unit_id", "error", "body.units", `内部语义单元 id 在卡内重复：${duplicateUnit.id}`));
	const emptyUnit = units.find((unit) => unit.text.length < 20);
	if (emptyUnit) findings.push(finding("empty_card_unit", "error", "body.units", `内部语义单元没有足够的可读取内容：${emptyUnit.id}`));
	const unitReviewLimit = type === "domain" ? 12 : 8;
	if (units.length > unitReviewLimit) findings.push(finding("card_unit_oversegmentation", "warning", "body.units", `本卡含 ${units.length} 个内部语义单元，建议核对是否把普通段落机械编号。`));
	if (themeCard && type !== "domain" && units.length < 2) {
		findings.push(finding("theme_units_insufficient", "error", "body.units", "主题聚合卡至少需要两个经过选择的内部语义单元，供 OPS 精确定位核心命题、机制、证据或边界。"));
	}

	const sections = sectionsOf(body);
	const sectionEntries = sectionEntriesOf(body).filter((item) => item.level === 2);
	const duplicateHeadings = [...new Set(sectionEntries.filter((item, index, entries) => entries.findIndex((candidate) => candidate.key === item.key) !== index).map((item) => item.heading))];
	for (const heading of duplicateHeadings) {
		findings.push(finding("duplicate_semantic_heading", "error", "body.headings", `二级语义标题重复：${heading}。应合并同槽内容或把不同对象改为准确标题。`));
	}
	for (const [slot, aliases] of SLOT_CONTRACTS[type] ?? []) {
		const section = findSection(sections, aliases);
		if (!section) {
			findings.push(finding("missing_required_slot", "error", `body.${slot}`, `缺少语义槽：${aliases.join(" / ")}`));
			continue;
		}
		if (isPlaceholder(section.content)) {
			findings.push(finding("placeholder_required_slot", "error", `body.${slot}`, `${section.heading} 只有占位说明，没有可用于推理的内容。`));
		}
	}
	if (INTERPRETATION_TYPES.has(type) && !findSection(sections, ["诠释", "导读"])) {
		findings.push(finding("missing_interpretation", "warning", "body.诠释", "建议用一段人话说明这个对象是什么以及为何重要。"));
	}
	const quoteSection = findSection(sections, ["原文摘录"]);
	const boundarySection = findSection(sections, ["来源与证据边界"]);
	if (quoteSection && weakQuoteAnchor(quoteSection.content)) {
		findings.push(finding("weak_source_excerpt", themeCard ? "error" : "warning", "body.source-anchor", "原文摘录只有章节名、短标题或过短片段，不能充当证据；应换成可核对短引文，或明确改写为来源与证据边界。"));
	}
	if (boundarySection && compactSourceAnchor(boundarySection.content).length < 60) {
		findings.push(finding("thin_source_boundary", themeCard ? "error" : "warning", "body.source-anchor", "来源与证据边界过薄，未说明材料支撑什么、不能推出什么。"));
	}
	if (themeCard && boundarySection && !sourceBoundaryHasVoices(boundarySection.content)) {
		findings.push(finding("theme_voice_boundary_missing", "error", "body.source-anchor", "主题聚合卡的来源边界必须区分作者原意、跨书综合与系统推论，不能把三者混写成一个无归属结论。"));
	}
	if (options.root) {
		for (const source of sources.filter((item) => /^(?:03-Archive|05-Buffer)\//u.test(sourcePathOf(item)))) {
			const relative = sourcePathOf(source);
			if (relative.split("/").includes("..") || !existsSync(join(options.root, ...relative.split("/")))) {
				findings.push(finding("missing_source_file", "error", "sources", `来源文件不存在或路径越界：${source}`));
			}
		}
	}
	const openingAliases = SLOT_CONTRACTS[type]?.[0]?.[1] ?? [];
	const opening = findSection(sections, openingAliases);
	if (opening && normalized(opening.content) === normalized(meta.title)) {
		findings.push(finding("title_echo", "warning", "body", "核心语义槽只是复述标题，没有形成独立判断。"));
	}
	if (type === "conflict") {
		const involves = (Array.isArray(meta.relations) ? meta.relations : []).filter((relation) => relation?.type === "involves");
		if (involves.length < 2) findings.push(finding("conflict_sides_unlinked", "warning", "relations", "冲突卡尚未用 involves 指向两方知识对象。"));
		if ((meta.relations ?? []).some((relation) => relation?.type && relation.type !== "involves")) {
			findings.push(finding("conflict_has_argument_outgoing", "warning", "relations", "冲突卡是争议档案；非 involves 出边应核对并迁回具体立场卡。"));
		}
	} else if (!new Set(["domain", "entity"]).has(type) && (!Array.isArray(meta.relations) || meta.relations.length === 0)) {
		findings.push(finding("structure_unexamined", "warning", "relations", "卡片尚无论证关系；应复核是否确实不存在可靠联系。"));
	}
	const weakRelationNotes = (Array.isArray(meta.relations) ? meta.relations : [])
		.filter((relation) => relation?.type && String(relation.note ?? "").trim().length < 8).length;
	if (weakRelationNotes) {
		findings.push(finding("relation_note_missing_or_thin", "warning", "relations", `${weakRelationNotes} 条关系缺少足以说明方向、机制或条件的 note；旧边可显示，但不能作为多跳推理中介。`));
	}
	const errors = errorCount(findings);
	const warnings = findings.filter((item) => item.severity === "warning").length;
	const score = Math.max(0, 100 - errors * 18 - warnings * 5);
	return {
		card_id: String(meta.id ?? ""), type, score,
		status: errors ? "blocked" : warnings ? "caution" : "ready",
		findings, metrics: { body_characters: body.trim().length, source_count: sources.length, relation_count: Array.isArray(meta.relations) ? meta.relations.length : 0, slot_count: sections.size, unit_count: units.length }
	};
}

export function auditBufferQuality({ role, title, source, body }) {
	const findings = [];
	const text = String(body ?? "").trim();
	const minimum = BUFFER_MIN_LENGTH[role] ?? 160;
	if (!String(source ?? "").trim()) findings.push(finding("missing_buffer_source", "error", "source", "Buffer 必须保留原材料路径、章节、页码或对话锚点。"));
	if (text.length < minimum) findings.push(finding("thin_buffer_body", "error", "body", `${role} 正文至少需要 ${minimum} 字的可复用质料，当前为 ${text.length} 字。`));
	if (isPlaceholder(text)) findings.push(finding("placeholder_buffer", "error", "body", "Buffer 不能只写缺失说明或待补充占位。"));
	if (/\[\[[^\]]+\]\]/u.test(text)) findings.push(finding("buffer_contains_wikilink", "error", "body", "Buffer 正文不得预写 Wiki 关系。"));
	if (normalized(text) === normalized(title)) findings.push(finding("buffer_title_echo", "error", "body", "Buffer 正文只是复述标题。"));
	if (!["detail", "evidence", "artifact-table", "artifact-figure"].includes(role) && !/^#{2,6}\s+/m.test(text)) {
		findings.push(finding("buffer_structure_implicit", "warning", "body", "长材料质料建议显式保留核心表达、依据细节、限制边界和原文摘录。"));
	}
	if (!["artifact-table", "artifact-figure"].includes(role) && !/[“”"']|原文摘录|来源锚点/u.test(text)) {
		findings.push(finding("buffer_quote_unmarked", "warning", "body", "尚未识别到原文短摘录或明确证据锚点。"));
	}
	const errors = errorCount(findings);
	return { status: errors ? "blocked" : findings.length ? "caution" : "ready", score: Math.max(0, 100 - errors * 22 - (findings.length - errors) * 5), findings };
}

export function newBlockingFindings(before, after) {
	const beforeKeys = new Set(before.findings.filter((item) => item.severity === "error").map((item) => `${item.code}:${item.field}`));
	return after.findings.filter((item) => item.severity === "error" && !beforeKeys.has(`${item.code}:${item.field}`));
}

export const KNOWLEDGE_QUALITY_ENUMS = {
	card_types: [...CARD_TYPES], maturity: [...MATURITY_VALUES], lifecycle: [...LIFECYCLE_VALUES], origin: [...ORIGIN_VALUES],
	entity_kinds: ["person", "organization", "institution", "school", "legal-instrument", "collective", "artifact", "other"]
};
