import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STRUCTURE_REVIEW_STATUSES = Object.freeze([
	"linked", "duplicate_candidate", "reclassification_candidate", "membership_candidate",
	"intentionally_standalone", "evidence_gap"
]);

export const UNCONNECTED_REVIEW_SCOPES = Object.freeze([
	"fully_isolated", "without_relations", "without_ready_relations", "without_domain"
]);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** Fingerprint all semantic Card fields so any meaningful change reopens its review. */
export function cardFingerprint(card) {
	if (!card) return null;
	return createHash("sha256")
		.update(JSON.stringify(canonical({ meta: card.meta ?? {}, body: card.body ?? "" })))
		.digest("hex");
}

function reviewFile(root) {
	return join(root, ".nexogenesis", "graph", "structure-reviews.jsonl");
}

export function readStructureReviews(root) {
	if (!root) return [];
	const file = reviewFile(root);
	if (!existsSync(file)) return [];
	const records = [];
	for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-3000)) {
		try {
			const record = JSON.parse(line);
			if (!STRUCTURE_REVIEW_STATUSES.includes(record?.status)) continue;
			if (!record.card_id || !record.card_fingerprint || !record.issue_kind) continue;
			records.push(record);
		} catch { /* 单条运行记录损坏不应阻断知识图谱观察。 */ }
	}
	return records;
}

/** Latest current-fingerprint review per card and issue kind. */
export function currentStructureReviews(root, cards, { issue_kind } = {}) {
	const latest = new Map();
	for (const record of readStructureReviews(root)) {
		if (issue_kind && record.issue_kind !== issue_kind) continue;
		const card = cards.get(record.card_id);
		if (!card || cardFingerprint(card) !== record.card_fingerprint) continue;
		if (record.candidate_fingerprints && Object.entries(record.candidate_fingerprints)
			.some(([id, fingerprint]) => cardFingerprint(cards.get(id)) !== fingerprint)) continue;
		latest.set(`${record.issue_kind}\u0000${record.card_id}`, record);
	}
	return latest;
}

export function recordStructureReview(root, cards, input) {
	const cardId = String(input?.card_id ?? "").trim();
	const issueKind = String(input?.issue_kind ?? "").trim();
	const status = String(input?.status ?? "").trim();
	const reason = String(input?.reason ?? "").trim();
	const candidateIds = [...new Set((Array.isArray(input?.candidate_ids) ? input.candidate_ids : [])
		.map((id) => String(id).trim()).filter(Boolean))];
	const card = cards.get(cardId);
	if (!card) throw new Error(`卡片不存在：${cardId}`);
	if (!UNCONNECTED_REVIEW_SCOPES.includes(issueKind)) throw new Error(`不支持的结构审阅范围：${issueKind}`);
	if (!STRUCTURE_REVIEW_STATUSES.includes(status)) throw new Error(`不支持的结构审阅结论：${status}`);
	if (reason.length < 12) throw new Error("结构审阅结论必须说明比较依据、排除理由或仍缺少的证据。");
	for (const id of candidateIds) if (!cards.has(id)) throw new Error(`候选卡不存在：${id}`);
	if (status === "duplicate_candidate" && candidateIds.length === 0) {
		throw new Error("近重复候选结论必须至少指出一张已比较的候选卡。");
	}
	const record = {
		review_version: "1.0",
		card_id: cardId,
		card_fingerprint: cardFingerprint(card),
		issue_kind: issueKind,
		status,
		candidate_ids: candidateIds,
		candidate_fingerprints: Object.fromEntries(candidateIds.map((id) => [id, cardFingerprint(cards.get(id))])),
		reason,
		...(input.follow_up?.trim() ? { follow_up: input.follow_up.trim().slice(0, 800) } : {}),
		reviewed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
	};
	const file = reviewFile(root);
	mkdirSync(join(file, ".."), { recursive: true });
	appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}
