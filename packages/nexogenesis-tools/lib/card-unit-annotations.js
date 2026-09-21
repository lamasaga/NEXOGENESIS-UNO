import { parseCardUnits } from "./card-units.js";
import { relationReadiness } from "./harness/relation-semantics.js";

export const CARD_UNIT_SECTION_RULES = {
	model: [
		{ headings: ["核心思想"], unitId: "claim-core", minimum: 40 },
		{ headings: ["关键组件"], unitId: "mechanism-components", minimum: 45 },
		{ headings: ["结构关系", "因果链条", "结构关系或因果链条", "结构关系/因果链条", "结构关系与因果链条", "因果/结构"], unitId: "mechanism-structure", minimum: 45 },
		{ headings: ["失效边界", "限制与边界"], unitId: "boundary-primary", minimum: 50 }
	],
	method: [
		{ headings: ["输入"], unitId: "condition-input", minimum: 40 },
		{ headings: ["步骤"], unitId: "mechanism-procedure", minimum: 60 },
		{ headings: ["输出"], unitId: "claim-output", minimum: 40 },
		{ headings: ["适用边界", "限制与边界"], unitId: "boundary-primary", minimum: 50 }
	],
	claim: [
		{ headings: ["一句话主张", "核心主张"], unitId: "claim-core", minimum: 40 },
		{ headings: ["依据"], unitId: "evidence-basis", minimum: 60 },
		{ headings: ["适用条件"], unitId: "condition-scope", minimum: 40 },
		{ headings: ["已知限制", "限制与边界"], unitId: "boundary-primary", minimum: 50 }
	],
	conflict: [
		{ headings: ["对立双方"], unitId: "tension-sides", minimum: 60 },
		{ headings: ["核心分歧点"], unitId: "tension-core", minimum: 50 },
		{ headings: ["各自证据或代价", "各自证据/代价"], unitId: "evidence-sides", minimum: 60 },
		{ headings: ["调和可能"], unitId: "boundary-reconciliation", minimum: 50 }
	]
};

function normalizedHeading(value) {
	return String(value ?? "").replace(/[\s`*_#：:，。；;、（）()《》〈〉“”'"-]/gu, "").toLowerCase();
}

function sectionsOf(body) {
	const text = String(body ?? "");
	const matches = [...text.matchAll(/^(#{2,4})\s+(.+?)\s*$/gm)];
	return matches.map((match, index) => ({
		heading: match[2].trim(),
		headingEnd: (match.index ?? 0) + match[0].length,
		contentEnd: index + 1 < matches.length ? matches[index + 1].index : text.length,
		content: text.slice((match.index ?? 0) + match[0].length, index + 1 < matches.length ? matches[index + 1].index : text.length).trim()
	}));
}

function stripUnitMarkers(body) {
	return String(body ?? "").replace(/(?:\r?\n)?<!--\s*unit:\s*[a-z][a-z0-9-]{2,80}\s*-->\r?\n?/g, "");
}

export function annotateCardUnits(cardId, type, body) {
	const text = String(body ?? "");
	if (parseCardUnits(cardId, text).length > 0) return { body: text, added: [], reason: "curated_units_preserved" };
	const rules = CARD_UNIT_SECTION_RULES[type] ?? [];
	const sections = sectionsOf(text);
	const insertions = [];
	for (const rule of rules) {
		const names = new Set(rule.headings.map(normalizedHeading));
		const section = sections.find((item) => names.has(normalizedHeading(item.heading)));
		if (!section || section.content.length < rule.minimum || /<!--\s*unit:/u.test(section.content)) continue;
		insertions.push({ offset: section.headingEnd, unitId: rule.unitId, heading: section.heading });
	}
	if (insertions.length < 2) return { body: text, added: [], reason: "insufficient_addressable_sections" };
	let annotated = text;
	for (const insertion of [...insertions].sort((left, right) => right.offset - left.offset)) {
		annotated = `${annotated.slice(0, insertion.offset)}\n\n<!-- unit: ${insertion.unitId} -->${annotated.slice(insertion.offset)}`;
	}
	if (stripUnitMarkers(annotated) !== text) throw new Error(`Card ${cardId} 的语义单元标注改变了正文内容。`);
	return {
		body: annotated,
		added: insertions.map(({ unitId, heading }) => ({ unit_id: unitId, heading, address: `${cardId}#${unitId}` })),
		reason: "annotated"
	};
}

export function readyIncidentCounts(cards) {
	const counts = new Map([...cards.keys()].map((id) => [id, 0]));
	for (const [sourceId, source] of cards) {
		for (const relation of source.meta.relations ?? []) {
			const target = cards.get(relation.target);
			if (!target || !relationReadiness(source, relation, target).ready) continue;
			counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
			counts.set(relation.target, (counts.get(relation.target) ?? 0) + 1);
		}
	}
	return counts;
}

export function selectCardUnitMigrationCandidates(cards) {
	const incident = readyIncidentCounts(cards);
	const selected = [];
	for (const [id, card] of cards) {
		const type = String(card.meta.type ?? "");
		if (String(card.meta.lifecycle ?? "active") !== "active") continue;
		if (parseCardUnits(id, card.body).length > 0) continue;
		const priority = type === "model" || type === "method"
			|| (["claim", "conflict"].includes(type) && card.body.length >= 700 && (incident.get(id) ?? 0) >= 2);
		if (!priority) continue;
		const annotated = annotateCardUnits(id, type, card.body);
		if (annotated.added.length > 0) selected.push({ id, card, type, incident_count: incident.get(id) ?? 0, ...annotated });
	}
	return selected.sort((left, right) => left.id.localeCompare(right.id, "zh-CN"));
}
