import { createHash } from "node:crypto";
import { parseCardUnits } from "../card-units.js";
import { splitSections } from "../cards.js";

/** Coverage describes delivered text, not the tool's name or the model's understanding. */
export function describeReading(cardId, original, delivered) {
	const full = original === delivered;
	const deliveredUnits = new Map(parseCardUnits(cardId, delivered).map((unit) => [unit.id, unit.text]));
	const units = parseCardUnits(cardId, original).filter((unit) => unit.text && deliveredUnits.get(unit.id) === unit.text);
	const sections = splitSections(delivered).filter((part) => part.content.trim());
	return {
		coverage: full ? "full" : "excerpt",
		original_characters: original.length, delivered_characters: delivered.length,
		fingerprint: createHash("sha256").update(original).digest("hex"),
		unit_addresses: units.map((unit) => unit.address),
		sections: sections.map((part) => part.heading || "正文"),
		excerpt_only: true,
		omitted_sections: Math.max(0, sections.length - 6),
		excerpts: (sections.length > 6 ? [...sections.slice(0, 4), ...sections.slice(-2)] : sections).map((part) => ({
			section: part.heading || "正文",
			text: part.content.replace(/<!--\s*unit:[^>]+-->/g, "").trim().slice(0, 160)
		})),
		note: full ? "完整正文已返回；语义充分性仍需判断。" : "仅返回部分正文；未读章节不能作为证据。补读完整正文或具体 unit。"
	};
}

export function readingEntries(step) {
	const data = step?.observation?.data ?? {};
	if (step.action?.operator === "read_cards") return data.results ?? [];
	if (step.action?.operator === "read_card") return [{ card_id: data.id ?? step.observation?.evidence?.[0]?.card_id, reading: data.reading }];
	if (step.action?.operator === "read_card_unit" && data.address && data.reading) return [{
		card_id: data.parent_card ?? data.address.split("#")[0],
		reading: data.reading
	}];
	return [];
}

export function hasCompleteReading(step) {
	return readingEntries(step).some((entry) => entry.reading?.coverage === "full" || entry.reading?.unit_addresses?.length > 0);
}
