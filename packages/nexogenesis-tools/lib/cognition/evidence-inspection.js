import { loadCards, parseCardFile } from "../cards.js";
import { resolve, sep } from "node:path";
import { readingEntries } from "./reading-coverage.js";
import { observationSatisfiesCapability } from "./thinking-models.js";
import { parseCardUnits } from "../card-units.js";
import { createHash } from "node:crypto";

export const EVIDENCE_ROLES = new Set(["support", "counter", "boundary", "background", "inference"]);

function normalizeItem(item) {
	if (typeof item === "string") return { anchor: item, role: "support", claim_id: "" };
	return {
		anchor: String(item?.anchor ?? "").trim(),
		role: String(item?.role ?? "support").trim(),
		claim_id: String(item?.claim_id ?? "").trim(),
		explanation: String(item?.explanation ?? "").trim().slice(0, 400)
	};
}

function splitAnchor(anchor) {
	const index = String(anchor).lastIndexOf("#");
	return index > 0
		? { card_id: anchor.slice(0, index), unit_id: anchor.slice(index + 1) }
		: { card_id: String(anchor), unit_id: "" };
}

function sourceFamily(reference, root, seen = new Set()) {
	const value = String(reference ?? "").trim();
	if (!value) return "";
	try {
		const url = new URL(value);
		return `${url.hostname}${url.pathname}`.replace(/\/$/, "");
	} catch {
		const path = value.split("#", 1)[0].replaceAll("\\", "/");
		// Resolve provenance, not chapter/slice count. Bound traversal and never leave the instance.
		if (root && seen.size < 4 && !seen.has(path) && /^(05-Buffer|03-Archive)\/.*\.md$/i.test(path)) {
			const base = resolve(root), target = resolve(root, path);
			if (target.startsWith(base + sep)) {
				try {
					const meta = parseCardFile(target).meta;
					const origin = meta.source ?? (meta.sources?.length === 1 ? meta.sources[0] : null);
					if (typeof origin === "string" && origin !== value) return sourceFamily(origin, root, new Set([...seen, path]));
				} catch { /* Unresolved lineage is explicitly not independent evidence. */ }
			}
		}
		const theme = path.match(/^(05-Buffer\/themes\/[^/]+\/sources\/[^/]+)\//);
		return theme?.[1] ?? path.replace(/\s*\/\s*(?:§|第|pp?\.?\s*\d|chapter\b|ch\.?\s*\d).*$/iu, "");
	}
}

function readEvidenceAnchors(state, currentCards) {
	const cards = new Set();
	const units = new Set();
	const full = new Set();
	for (const step of state?.episode?.steps ?? []) {
		if (!observationSatisfiesCapability(step?.observation)) continue;
		if (["read_card", "read_cards"].includes(step.action?.operator)) {
			for (const item of step.observation.evidence ?? []) if (item?.card_id) cards.add(String(item.card_id));
		}
		for (const entry of readingEntries(step)) {
			if (state.run?.analysis_policy_version === "conversation-v2" && !entry.reading?.fingerprint) continue;
			const current = currentCards.get(entry.card_id);
			if (entry.reading?.fingerprint && (!current || entry.reading.fingerprint !== createHash("sha256").update(current.body).digest("hex"))) continue;
			if (entry.reading?.coverage === "full") full.add(entry.card_id);
			for (const address of entry.reading?.unit_addresses ?? []) units.add(address);
		}
		if (step.action?.operator === "read_card_unit") {
			const address = step.observation.data?.address ?? step.observation.evidence?.[0]?.address;
			const fingerprint = step.observation.data?.reading?.unit_fingerprint;
			if (state.run?.analysis_policy_version === "conversation-v2" && !fingerprint) continue;
			const { card_id, unit_id } = splitAnchor(address ?? "");
			const currentUnit = parseCardUnits(card_id, currentCards.get(card_id)?.body ?? "").find((unit) => unit.id === unit_id);
			if (fingerprint && (!currentUnit || fingerprint !== createHash("sha256").update(currentUnit.text).digest("hex"))) { units.delete(address); continue; }
			if (address) {
				units.add(String(address));
				cards.add(splitAnchor(address).card_id);
			}
		}
	}
	return { cards, units, full };
}

export function verifyEvidenceAnchors(root, state, inputItems) {
	const items = (Array.isArray(inputItems) ? inputItems : []).map(normalizeItem);
	const cards = new Map(loadCards(root));
	// Recheck only the cited files, even inside the inventory cache's validation interval.
	// Index reuse must never make a just-edited or deleted source pass final verification.
	for (const id of new Set(items.map((item) => splitAnchor(item.anchor).card_id))) {
		const card = cards.get(id);
		if (!card?.file) continue;
		try {
			const current = parseCardFile(card.file);
			if (current.meta.id !== id || (current.meta.lifecycle && current.meta.lifecycle !== "active")) cards.delete(id);
			else cards.set(id, { ...current, file: card.file });
		} catch { cards.delete(id); }
	}
	const read = readEvidenceAnchors(state, cards);
	const results = items.map((item) => {
		const { card_id, unit_id } = splitAnchor(item.anchor);
		const card = cards.get(card_id);
		const unit = card && unit_id
			? parseCardUnits(card_id, card.body).find((candidate) => candidate.id === unit_id)
			: null;
		const exists = Boolean(card && (!unit_id || unit));
		const readInRun = unit_id ? read.units.has(item.anchor) || read.full.has(card_id) : read.cards.has(card_id);
		const families = card ? [...new Set((card.meta.sources ?? []).map((source) => sourceFamily(source, root)).filter(Boolean))] : [];
		const coverageSufficient = unit_id ? read.units.has(item.anchor) || read.full.has(card_id) : read.full.has(card_id);
		const roleValid = EVIDENCE_ROLES.has(item.role);
		return {
			anchor: item.anchor,
			role: item.role,
			claim_id: item.claim_id || null,
			explanation: item.explanation ?? "",
			card_id,
			unit_id: unit_id || null,
			exists,
			read_in_run: readInRun,
			reading_coverage: read.full.has(card_id) ? "full" : readInRun ? "excerpt" : "unread",
			coverage_sufficient: coverageSufficient,
			role_valid: roleValid,
			claim_linked: Boolean(item.claim_id),
			source_families: families,
			source_independence: "not_established",
			content_preview: unit ? unit.text.slice(0, 360) : card ? card.body.replace(/<!--\s*unit:[^>]+-->/g, "").trim().slice(0, 360) : "",
			content_fingerprint: card ? createHash("sha256").update(unit ? unit.text : card.body).digest("hex") : null,
			semantic_fit: exists && readInRun ? "model_review_required" : "unavailable",
			usable: exists && readInRun && coverageSufficient && roleValid && Boolean(item.claim_id)
		};
	});
	return {
		anchor_count: results.length,
		valid_count: results.filter((item) => item.usable).length,
		all_deterministic_checks_passed: results.length > 0 && results.every((item) => item.usable),
		roles_present: [...new Set(results.filter((item) => item.usable).map((item) => item.role))],
		results,
		note: "存在性、当轮精读、角色和结论挂接由工具核验；证据与结论的语义适配仍须模型或人工判断。"
	};
}

export function inspectEvidenceSet(root, state, inputItems) {
	const verified = verifyEvidenceAnchors(root, state, inputItems);
	const byClaim = new Map();
	const byFamily = new Map();
	for (const item of verified.results.filter((candidate) => candidate.usable)) {
		if (!byClaim.has(item.claim_id)) byClaim.set(item.claim_id, []);
		byClaim.get(item.claim_id).push(item);
		for (const family of item.source_families) {
			if (!byFamily.has(family)) byFamily.set(family, []);
			byFamily.get(family).push(item.anchor);
		}
	}
	const claims = [...byClaim].map(([claim_id, items]) => {
		const roles = [...new Set(items.map((item) => item.role))];
		const families = [...new Set(items.flatMap((item) => item.source_families))];
		return {
			claim_id,
			anchor_count: items.length,
			roles,
			source_families: families,
			source_family_count: families.length,
			independent_source_count: null,
			source_independence: "not_established",
			has_support: roles.includes("support"),
			has_counter_or_boundary: roles.includes("counter") || roles.includes("boundary"),
			single_point_support: items.filter((item) => item.role === "support").length <= 1 || families.length <= 1
		};
	});
	const declaredClaims = (state.workspace?.hypotheses ?? []).filter((claim) => ["supported", "inference"].includes(claim?.status));
	return {
		...verified,
		claims,
		duplicate_source_families: [...byFamily]
			.filter(([, anchors]) => new Set(anchors).size > 1)
			.map(([source_family, anchors]) => ({ source_family, anchors: [...new Set(anchors)] })),
		uncovered_claims: [...new Set([...claims.filter((claim) => !claim.has_support).map((claim) => claim.claim_id),
			...declaredClaims.filter((claim) => !claims.some((item) => item.claim_id === claim.id && item.has_support)).map((claim) => claim.id)])],
		role_review_needed: verified.results.filter((item) => item.usable && item.role === "counter" && !item.explanation)
			.map((item) => ({ claim_id: item.claim_id, anchor: item.anchor, reason: "说明该材料具体否定哪一环节；不同学派、背景事实或未知项不自动构成反例。" })),
		single_point_claims: claims.filter((claim) => claim.single_point_support).map((claim) => claim.claim_id)
	};
}
