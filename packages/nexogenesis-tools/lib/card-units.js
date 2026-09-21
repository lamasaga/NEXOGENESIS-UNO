import { loadCards } from "./cards.js";

const UNIT_RE = /<!--\s*unit:\s*([a-z][a-z0-9-]{2,80})\s*-->/g;

function sectionBefore(body, offset) {
	let section = "正文";
	for (const match of body.slice(0, offset).matchAll(/^#{2,4}\s+(.+)$/gm)) section = match[1].trim();
	return section;
}

export function parseCardUnits(cardId, body) {
	const matches = [...String(body ?? "").matchAll(UNIT_RE)];
	return matches.map((match, index) => {
		const start = (match.index ?? 0) + match[0].length;
		const nextMarker = matches[index + 1]?.index ?? body.length;
		const heading = /^#{2,4}\s+/m.exec(body.slice(start, nextMarker));
		const end = heading ? start + heading.index : nextMarker;
		const text = body.slice(start, end).trim();
		return {
			id: match[1], address: `${cardId}#${match[1]}`, parent_card: cardId,
			kind: match[1].split("-")[0], section: sectionBefore(body, match.index ?? 0), text
		};
	});
}

export function listCardUnits(root, cardId) {
	const card = loadCards(root).get(cardId);
	if (!card) return { card_id: cardId, units: [], error: "card_not_found" };
	return {
		card_id: cardId,
		units: parseCardUnits(cardId, card.body).map(({ text, ...unit }) => ({ ...unit, preview: text.slice(0, 260) }))
	};
}

export function readCardUnit(root, address) {
	const split = String(address ?? "").lastIndexOf("#");
	if (split < 1) return { address, error: "invalid_unit_address" };
	const cardId = address.slice(0, split);
	const unitId = address.slice(split + 1);
	const card = loadCards(root).get(cardId);
	if (!card) return { address, error: "card_not_found" };
	const unit = parseCardUnits(cardId, card.body).find((item) => item.id === unitId);
	return unit ?? { address, error: "unit_not_found" };
}

export function searchCardUnits(root, query, limit = 12) {
	const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return { query, units: [] };
	const units = [];
	for (const [cardId, card] of loadCards(root)) {
		for (const unit of parseCardUnits(cardId, card.body)) {
			const haystack = `${card.meta.title ?? ""} ${unit.section} ${unit.text}`.toLowerCase();
			const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
			if (score) units.push({ ...unit, card_title: card.meta.title ?? cardId, score, preview: unit.text.slice(0, 320) });
		}
	}
	units.sort((left, right) => right.score - left.score || left.address.localeCompare(right.address, "zh-CN"));
	return { query, units: units.slice(0, Math.min(Math.max(1, Number(limit) || 12), 30)) };
}
