import { CARD_TYPES as CURRENT_CARD_TYPES } from '../uno/card-classification.js';
export const CARD_TYPES = new Set(["domain", ...CURRENT_CARD_TYPES]);
export const RELATION_TYPES = new Set([
	"supports", "extends", "based-on", "example-of", "conflicts-with", "involves", "part-of",
	"applies-to", "influences", "precedes", "characterizes", "attributed-to"
]);
export const RELATION_PLANES = Object.freeze({
	argument: Object.freeze([
		"supports", "extends", "based-on", "example-of", "conflicts-with", "involves", "part-of", "applies-to"
	]),
	context: Object.freeze(["influences", "precedes"]),
	reference: Object.freeze(["characterizes", "attributed-to"])
});
const ARGUMENT_TYPES = new Set(["claim", "mechanism", "model", "method"]);
const GENERIC_NOTE_RE = /^(?:相关|有关|关联|支持|扩展|基于|冲突|涉及|影响|类似|例子|组成部分|时间先后|参见|同上)[。.!！]?$/u;
const TEMPORAL_NOTE_RE = /时间|先于|早于|晚于|随后|此前|之后|阶段|年代|年份|年|月|日/u;

function asList(value) {
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim());
	return typeof value === "string" && value.trim() ? [value] : [];
}

function metaOf(card) {
	return card?.meta && typeof card.meta === "object" ? card.meta : card ?? {};
}

function compactNote(note) {
	return String(note ?? "").replace(/[\s`*_#：:，。；;、（）()《》〈〉“”"'\-]/gu, "");
}

export function relationPlane(type) {
	return RELATION_PLANES.context.includes(type) ? "context"
		: RELATION_PLANES.reference.includes(type) ? "reference"
			: RELATION_PLANES.argument.includes(type) ? "argument" : "invalid";
}

export function allowedSignature(type, sourceType, targetType) {
	// Card 类型描述知识对象的功能，不等于它只能扮演一种论证角色。
	// 例如现象可为模型提供证据，两个现象也可构成范围扩展。旧规则把
	// 这些正常表达误报为签名错误，反而迫使 Agent 规避真实关系。
	// 两条刚性边界是：domain 不进入关系；conflict 只是争议档案，
	// 只能用 involves 列出参与方，不能代替具体立场承担论证或情境出边。
	if (sourceType === "conflict") {
		return type === "involves" && (ARGUMENT_TYPES.has(targetType) || targetType === "entity");
	}
	const nonDomainPair = sourceType !== "domain" && targetType !== "domain";
	if (type === "supports") return nonDomainPair;
	if (type === "extends") return nonDomainPair;
	if (type === "based-on") return nonDomainPair;
	if (type === "example-of") return sourceType !== "domain" && targetType !== "domain";
	if (type === "conflicts-with") return ARGUMENT_TYPES.has(sourceType) && ARGUMENT_TYPES.has(targetType);
	if (type === "involves") return false;
	if (type === "part-of") return nonDomainPair;
	if (type === "applies-to") return nonDomainPair;
	if (type === "influences" || type === "precedes") return sourceType !== "domain" && targetType !== "domain";
	if (type === "characterizes") return ["concept", "claim", "mechanism", "model", "method", "phenomenon", "case"].includes(sourceType) && targetType === "entity";
	if (type === "attributed-to") return ["claim", "mechanism", "model", "method"].includes(sourceType) && targetType === "entity";
	return false;
}

/**
 * Compute whether one stored edge is safe for model reasoning.
 * This is deliberately derived at runtime: old Markdown keeps round-tripping
 * unchanged while GraphOps can keep weak legacy edges out of multi-hop paths.
 */
export function relationReadiness(sourceCard, relation, targetCard) {
	const source = metaOf(sourceCard);
	const target = metaOf(targetCard);
	const type = String(relation?.type ?? "");
	const targetId = String(relation?.target ?? "");
	const note = String(relation?.note ?? "").trim();
	const plane = relationPlane(type);
	const reason_codes = [];
	if (!RELATION_TYPES.has(type)) reason_codes.push("unknown_relation_type");
	if (String(source.id ?? "") && targetId === String(source.id)) reason_codes.push("self_relation");
	if (!targetCard) reason_codes.push("missing_relation_target");
	else if (!allowedSignature(type, source.type, target.type)) reason_codes.push("invalid_relation_signature");
	if (reason_codes.length) return {
		level: "invalid", ready: false, plane, reason_codes,
		summary: "关系类型、目标或方向不符合当前契约。"
	};

	const compact = compactNote(note);
	if (!note) reason_codes.push("missing_relation_note");
	else if (compact.length < 6 || GENERIC_NOTE_RE.test(note.trim())) reason_codes.push("vague_relation_note");
	if (type === "precedes" && note && !TEMPORAL_NOTE_RE.test(note)) reason_codes.push("temporal_anchor_missing");
	const origin = String(source.origin ?? "user");
	if (["document", "external"].includes(origin) && asList(source.sources).length === 0) {
		reason_codes.push("relation_source_missing");
	}
	if (reason_codes.length) return {
		level: "legacy_candidate", ready: false, plane, reason_codes,
		summary: reason_codes.includes("missing_relation_note")
			? "这条旧关系缺少成立理由，只能作为待核验线索。"
			: "这条关系的说明或来源不足，暂不能支撑多跳推理。"
	};
	return {
		level: plane === "context" ? "context_ready" : plane === "reference" ? "reference_ready" : "argument_ready",
		ready: true, plane, reason_codes: [], summary: "关系已满足当前推理就绪条件。"
	};
}

/** Strict checks for newly added or explicitly modified relations. */
export function validateRelationReadiness(card, cardsById, relations = card?.relations ?? []) {
	const violations = [];
	for (const [index, relation] of relations.entries()) {
		const target = cardsById.get(String(relation?.target ?? ""));
		const readiness = relationReadiness(card, relation, target);
		if (readiness.level === "invalid") continue; // semantic validator returns the precise hard error.
		if (readiness.ready) continue;
		const code = readiness.reason_codes[0] ?? "relation_not_ready";
		const details = {
			missing_relation_note: "新增或修改的关系必须用 note 说明为什么成立、方向和必要条件。",
			vague_relation_note: "关系 note 过于空泛；请说明具体证据、机制、差异或适用条件。",
			temporal_anchor_missing: "precedes 必须在 note 中给出可核对的时间或阶段依据。",
			relation_source_missing: "文档或外部来源卡缺少来源锚点，不能新增可推理关系。"
		};
		violations.push({
			code, field: `relations[${index}].note`,
			detail: details[code] ?? readiness.summary
		});
	}
	return violations;
}

/** Validate relation type, target existence and source/target type signature. */
export function validateRelationSemantics(card, cardsById) {
	const violations = [];
	const sourceId = String(card.id ?? card.meta?.id ?? "");
	const seen = new Set();
	if (!CARD_TYPES.has(card.type)) violations.push({ code: "unknown_card_type", field: "type", detail: card.type });
	for (const [index, relation] of (card.relations ?? []).entries()) {
		const type = String(relation?.type ?? "");
		const target = String(relation?.target ?? "");
		const signature = `${type}\u0000${target}`;
		if (!RELATION_TYPES.has(type)) {
			violations.push({ code: "unknown_relation_type", field: `relations[${index}].type`, detail: type });
			continue;
		}
		if (sourceId && target === sourceId) {
			violations.push({ code: "self_relation", field: `relations[${index}].target`, detail: target });
			continue;
		}
		if (seen.has(signature)) {
			violations.push({ code: "duplicate_relation", field: `relations[${index}]`, detail: `${type}: ${target}` });
			continue;
		}
		seen.add(signature);
		const targetCard = cardsById.get(target);
		if (!targetCard) {
			violations.push({ code: "missing_relation_target", field: `relations[${index}].target`, detail: target });
			continue;
		}
		const targetType = targetCard.type ?? targetCard.meta?.type;
		if (!allowedSignature(type, card.type, targetType)) {
			violations.push({
				code: "invalid_relation_signature",
				field: `relations[${index}]`,
				detail: `${type}: ${card.type} -> ${targetType}`
			});
		}
	}
	return violations;
}

export function relationAlternatives(violation) {
	if (["missing_relation_note", "vague_relation_note", "temporal_anchor_missing"].includes(violation?.code)) {
		return [
			{ action: "explain_relation", description: "补充这条关系的具体证据、机制、方向和必要条件" },
			{ action: "defer_relation", description: "证据不足时先不连边，把候选留给后续建构核验" }
		];
	}
	if (violation?.code === "relation_source_missing") {
		return [
			{ action: "trace_or_repair_source", description: "补回可核验的 Buffer、原文或页码锚点后再连边" },
			{ action: "defer_relation", description: "保留卡片内容，暂不把这条联系用于推理" }
		];
	}
	if (violation?.code === "invalid_relation_signature") {
		return [
			{ action: "remove_relation", description: "保留节点改写，但从本次提案中移除不合法关系" },
			{ action: "use_specialized_operator", description: "改用领域归属、冲突或生命周期专用工具" }
		];
	}
	if (violation?.code === "missing_relation_target") {
		return [
			{ action: "read_or_search_target", description: "重新检索并使用真实存在的目标卡 id" },
			{ action: "defer_relation", description: "先提交无该关系的单层变更，把关系候选记入待办" }
		];
	}
	if (violation?.code === "self_relation") {
		return [
			{ action: "remove_relation", description: "移除指向卡片自身的关系；自我说明应写入正文而不是图边" },
			{ action: "search_target", description: "重新检索真正要连接的外部知识对象" }
		];
	}
	if (violation?.code === "duplicate_relation") {
		return [
			{ action: "deduplicate_relation", description: "合并同类型同目标关系，只保留一条具体说明" },
			{ action: "differentiate_relation", description: "若表达不同机制，改用不同且真实成立的关系类型" }
		];
	}
	return [
		{ action: "shrink_proposal", description: "缩小到一个结构层面后重新提案" },
		{ action: "inspect_contract", description: "读取当前可执行字段与关系契约后改选动作" }
	];
}
