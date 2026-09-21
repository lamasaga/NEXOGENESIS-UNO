import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { loadCards, parseCardFile } from "../cards.js";
import { cardFingerprint } from "./structure-reviews.js";
import { readingEntries } from "./reading-coverage.js";
import { relationReadiness } from "../harness/relation-semantics.js";
import { normalizeJsonValue } from "../json-value.js";

const list = (v) => Array.isArray(v) ? v : [];
const unique = (v) => [...new Set(list(v).filter((x) => typeof x === "string" && x.trim()))];
const compact = (s) => String(s ?? "").replace(/\s+/gu, "").toLowerCase();
const written = (s) => s.observation?.reason_code === "committed" && s.observation?.status === "ok";
export const IMPROVEMENT_KINDS = ["relation", "merge", "split", "refine", "membership", "synthesis"];

// The normal retrieval snapshot intentionally excludes retired cards. A plan must still verify their files.
function planCards(root, plan) {
	const cards = new Map(loadCards(root));
	for (const [id, file] of Object.entries(plan.files ?? {})) {
		if (existsSync(file)) cards.set(id, { ...parseCardFile(file), file });
		else cards.delete(id);
	}
	return cards;
}

/** Full-body fallback: absence from a bounded candidate list is never absence from the corpus. */
export function inspectKnowledgeGap(root, { queries, limit = 8, match_mode = "any" } = {}) {
	const terms = unique(queries);
	if (!terms.length || terms.length > 4 || terms.some((q) => q.length > 120)) throw new Error("提供 1–4 个具体概念、别名或机制短语，每项最多 120 字；不是一段完整问题。");
	if (!["any", "all", "phrase"].includes(match_mode)) throw new Error("match_mode 使用 any（任一关键词）、all（同卡全部关键词）或 phrase（连续短语）。");
	const cards = loadCards(root), cap = Math.max(1, Math.min(12, Number(limit) || 8));
	const searches = terms.map((query) => {
		const needles = match_mode === "phrase" ? [compact(query)] : unique(query.trim().split(/\s+/u)).map(compact), hits = [];
		for (const [id, card] of cards) {
			if (["archived", "superseded"].includes(card.meta.lifecycle)) continue;
			const title = compact(`${id} ${card.meta.title} ${list(card.meta.aliases).join(" ")}`);
			const full = `${title}\n${compact(card.body)}`;
			const matched = needles.filter((needle) => full.includes(needle));
			if (match_mode === "all" ? matched.length !== needles.length : !matched.length) continue;
			const titleHit = needles.some((needle) => title.includes(needle));
			const paragraphs = String(card.body ?? "").split(/\r?\n/);
			const line = paragraphs.findIndex((p) => needles.some((needle) => compact(p).includes(needle)));
			hits.push({ id, title: card.meta.title ?? id, title_hit: titleHit, body_line: line < 0 ? null : line + 1,
				matched_terms: matched, excerpt: line < 0 ? "" : paragraphs[line].trim().slice(0, 260), fingerprint: cardFingerprint(card) });
		}
		hits.sort((a, b) => Number(b.title_hit) - Number(a.title_hit) || a.id.localeCompare(b.id));
		return { query, match_mode, terms: needles, total: hits.length, hits: hits.slice(0, cap), truncated: hits.length > cap };
	});
	return { searches, nodes: [...new Map(searches.flatMap((s) => s.hits).map((h) => [h.id, h])).values()],
		conclusion: searches.some((s) => s.total) ? "candidates_found" : "not_located",
		boundary: "全正文词面定位，不是语义穷尽检索；候选须精读。未找到只能记为尚未定位，不能宣称知识体没有或尚未编译。" };
}

function probesAt(root, probes) {
	return probes.map((p) => {
		const search = inspectKnowledgeGap(root, { queries: [p.query], limit: 12, match_mode: "phrase" }).searches[0];
		const ids = search.hits.map((h) => h.id);
		return { query: p.query, hits: ids, total: search.total, truncated: search.truncated,
			found_expected: p.expected_ids.filter((id) => ids.includes(id)),
			missing_expected: p.expected_ids.filter((id) => !ids.includes(id)) };
	});
}

export function planConstructImprovement(root, state, args) {
	if (!IMPROVEMENT_KINDS.includes(args.kind) || !String(args.problem ?? "").trim() || !String(args.benefit ?? "").trim()) throw new Error("说明 kind、当前知识使用问题 problem 与预期改善 benefit。");
	const cards = loadCards(root), cardIds = unique(args.card_ids), targets = unique(args.target_ids);
	if (!cardIds.length || cardIds.length > 6 || !targets.length || targets.length > 6) throw new Error("一个局部计划选择 1–6 张已有卡和 1–6 个结果对象；更大问题分成可恢复的局部调整。");
	for (const id of cardIds) if (!cards.has(id)) throw new Error(`卡片不存在：${id}`);
	if (targets.some((id) => cards.has(id) && !cardIds.includes(id))) throw new Error("已有结果卡也必须列入完整阅读与内容保留范围。");
	if (args.kind === "merge" && (cardIds.length < 2 || targets.length !== 1)) throw new Error("合并至少两张源卡并明确一个保留对象。");
	if (args.kind === "split" && (cardIds.length !== 1 || targets.length < 2)) throw new Error("拆分选择一张源卡和至少两个结果对象；可以保留原卡作为有解释力的入口。");
	const previous = state.workspace.extension?.improvement_plan;
	if (previous && !["verified", "deferred", "kept"].includes(previous.status)) throw new Error("先复核或明确延期当前改善计划，再切换问题；不得覆盖未完成调整。");
	const reads = state.episode.steps.filter((s) => ["ok", "partial"].includes(s.observation?.status)).flatMap(readingEntries);
	for (const id of cardIds) {
		const hash = createHash("sha256").update(cards.get(id).body).digest("hex");
		if (!reads.some((r) => r.card_id === id && r.reading?.coverage === "full" && r.reading?.fingerprint === hash)) throw new Error(`计划前须完整精读当前版本：${id}`);
	}
	const alternatives = unique(args.alternatives);
	if (!alternatives.length || alternatives.length > 4) throw new Error("简述 1–4 个未选方案及理由，包括保留现状是否更合适。");
	if (["merge", "synthesis"].includes(args.kind) && cardIds.length > 1) {
		const comparisons = state.episode.steps.filter((s) => s.action?.operator === "compare_cards" && s.observation?.status === "ok");
		if (cardIds.some((id) => !comparisons.some((s) => s.observation.data?.compared?.includes(id) && s.observation.data.compared.filter((other) => cardIds.includes(other)).length > 1))) throw new Error("合并或聚合前须实际比较这些源卡的知识功能、独有信息和边界。");
	}
	const preservation = list(args.preservation);
	if (!preservation.length || preservation.length > 16) throw new Error("指定 1–16 处不可丢失的关键原文锚点及去向；不是把整卡复制进计划。");
	for (const item of preservation) {
		if (!cardIds.includes(item.from) || !unique(item.to).length || item.to.some((id) => !targets.includes(id))
			|| compact(item.excerpt).length < 8 || String(item.excerpt).length > 500 || !compact(cards.get(item.from).body).includes(compact(item.excerpt))) throw new Error("保留映射必须引用已读源卡中的 8–500 字原文及计划内结果对象。");
	}
	if (cardIds.some((id) => !preservation.some((p) => p.from === id))) throw new Error("每张源卡都需说明关键证据、独有信息或边界的去向。");
	const probes = list(args.probes).map((p) => ({ query: String(p.query ?? "").trim(), expected_ids: unique(p.expected_ids) }));
	if (!probes.length || probes.length > 3 || probes.some((p) => !p.query || !p.expected_ids.length || p.expected_ids.some((id) => !targets.includes(id)))) throw new Error("提供 1–3 个发现性验证短语与预期结果卡；语义收益还须人工判断。");
	const retireIds = unique(args.retire_ids);
	if (retireIds.some((id) => !cardIds.includes(id) || targets.includes(id))) throw new Error("退役对象只能是源卡中不再承担结果职责的对象。");
	if (["merge", "split"].includes(args.kind) && cardIds.some((id) => !targets.includes(id) && !retireIds.includes(id))) throw new Error("合并或拆分须交代每个原对象：保留为结果或在迁移后退役。");
	const inbound = [...cards].flatMap(([id, card]) => list(card.meta.relations).filter((r) => cardIds.includes(r.target)).map((r) => ({ from: id, ...r })));
	return { id: randomUUID(), status: "planned", kind: args.kind, problem: args.problem.slice(0, 600), benefit: args.benefit.slice(0, 600),
		card_ids: cardIds, target_ids: targets, retire_ids: retireIds, alternatives, preservation, probes,
		baseline: probesAt(root, probes), inbound, sources: Object.fromEntries(cardIds.map((id) => [id, list(cards.get(id).meta.sources)])),
		files: Object.fromEntries([...new Set([...cardIds, ...targets, ...inbound.map((r) => r.from)])].filter((id) => cards.has(id)).map((id) => [id, cards.get(id).file])),
		fingerprints: Object.fromEntries([...new Set([...cardIds, ...targets, ...inbound.map((r) => r.from)])].map((id) => [id, cardFingerprint(cards.get(id))])),
		planned_at_step: state.episode.steps.length + 1,
		boundary: "计划不是写入授权或语义验收；沿用单层 Gateway。原文锚点保留是确定性下限，未列出内容仍须语义审查。" };
}

export function improvementChecks(root, plan, replacements = []) {
	const cards = planCards(root, plan);
	for (const card of replacements) cards.set(card.id, { meta: card, body: card.body });
	const errors = [];
	for (const id of plan.target_ids) if (!cards.has(id) || ["superseded", "archived"].includes(cards.get(id).meta.lifecycle)) errors.push(`结果对象不存在或已退役：${id}`);
	for (const item of plan.preservation) {
		if (!item.to.some((id) => compact(cards.get(id)?.body).includes(compact(item.excerpt)))) errors.push(`关键锚点未保留：${item.from} → ${item.to.join("、")}`);
		const sources = new Set(item.to.flatMap((id) => list(cards.get(id)?.meta.sources)));
		if (plan.sources[item.from].some((source) => !sources.has(source))) errors.push(`来源未完整承接：${item.from}`);
	}
	for (const [id, card] of cards) {
		if (["superseded", "archived"].includes(card.meta.lifecycle)) continue;
		for (const r of list(card.meta.relations)) {
			if (plan.retire_ids.includes(r.target)) errors.push(`活跃卡仍指向待退役卡：${id} → ${r.target}`);
			if (plan.target_ids.includes(id) || plan.target_ids.includes(r.target)) {
				if (relationReadiness(card, r, cards.get(r.target)).level === "invalid") errors.push(`结果邻域存在非法关系：${id} → ${r.target}`);
			}
		}
	}
	return [...new Set(errors)];
}

export function constructPlanWriteReadiness(root, state, { layer, operations = [] } = {}) {
	if (state.run.mode !== "construct") return { ready: true };
	const plan = state.workspace.extension?.improvement_plan;
	if (!plan) return state.run.thinking_model?.id === "knowledge-organization"
		? { ready: false, reason_code: "construct_plan_required", summary: "先记录当前问题、方案、保留去向与检索验证，再调整知识体。" } : { ready: true };
	const reject = (summary) => ({ ready: false, reason_code: "construct_plan_mismatch", summary });
	if (plan.status !== "planned") return reject("当前计划已收束；继续修改需基于最新对象重新计划。");
	const allowed = new Set(Object.keys(plan.fingerprints));
	if (operations.some((op) => !allowed.has(op.id))) return reject("本次写入超出局部改善对象及已观察入边范围；应拆分或修订计划。");
	const cards = planCards(root, plan);
	if (["content", "reclassification"].includes(layer)) {
		const proposed = new Map(operations.map((op) => [op.id, op]));
		for (const item of plan.preservation) {
			if (!proposed.has(item.from)) continue;
			const next = proposed.get(item.from);
			if (next.body !== undefined && !compact(next.body).includes(compact(item.excerpt))
				&& !item.to.some((id) => compact(proposed.get(id)?.body ?? cards.get(id)?.body).includes(compact(item.excerpt)))) return reject(`精简前先承接关键锚点：${item.from}`);
		}
	}
	for (const id of allowed) {
		const lastWrite = state.episode.steps.filter((s) => s.step > plan.planned_at_step && written(s) && s.observation?.scope?.card_ids?.includes(id)).at(-1);
		if (!lastWrite && cardFingerprint(cards.get(id)) !== plan.fingerprints[id]) return reject(`计划期间对象版本已变化：${id}；延期并重新阅读、计划。`);
		if (lastWrite?.observation?.revision?.[id]) {
			const current = cards.get(id);
			const hash = current?.file ? createHash("sha256").update(readFileSync(current.file)).digest("hex") : null;
			if (hash !== lastWrite.observation.revision[id]) return reject(`写入后对象被其他操作改动：${id}；重新阅读、计划。`);
		}
	}
	if (layer === "lifecycle" && operations.some((op) => ["superseded", "archived"].includes(op.lifecycle))) {
		if (operations.some((op) => !plan.retire_ids.includes(op.id))) return reject("未列入退役计划的对象不能退役。");
		const errors = improvementChecks(root, plan, operations);
		if (errors.length) return reject(errors.slice(0, 3).join("；"));
	}
	return { ready: true };
}

export function reviewConstructImprovement(root, state, { outcome, reason } = {}) {
	const plan = state.workspace.extension?.improvement_plan;
	if (!plan || plan.status !== "planned") throw new Error("没有待复核的改善计划。");
	if (!["verify", "defer", "keep"].includes(outcome) || !String(reason ?? "").trim()) throw new Error("明确 verify/defer/keep 和语义审阅理由；不是只报告连边或字数变化。");
	const writes = state.episode.steps.filter((s) => s.step > plan.planned_at_step && written(s));
	if (outcome === "keep" && writes.length) throw new Error("已经发生写入，不能报告保持原状；应复核或如实延期。");
	const after = probesAt(root, plan.probes), errors = outcome === "verify" ? improvementChecks(root, plan) : [];
	if (outcome === "verify") {
		for (const probe of after) if (probe.missing_expected.length) errors.push(`发现性验证未命中预期对象：${probe.query}`);
		const cards = planCards(root, plan);
		const reads = state.episode.steps.filter((s) => s.step > plan.planned_at_step && ["ok", "partial"].includes(s.observation?.status)).flatMap(readingEntries);
		for (const id of plan.target_ids) {
			const hash = cards.get(id) ? createHash("sha256").update(cards.get(id).body).digest("hex") : null;
			if (!reads.some((r) => r.card_id === id && r.reading?.coverage === "full" && r.reading?.fingerprint === hash)) errors.push(`写后尚未完整复读结果对象：${id}`);
		}
		for (const id of plan.retire_ids) if (!["superseded", "archived"].includes(cards.get(id)?.meta.lifecycle)) errors.push(`计划中的退役尚未执行：${id}`);
		if (!writes.length) errors.push("没有实际调整；如判断原状更合适，请使用 keep。");
	}
	const currentCards = planCards(root, plan);
	return { ...plan, files: { ...plan.files, ...Object.fromEntries(plan.target_ids.filter((id) => currentCards.has(id)).map((id) => [id, currentCards.get(id).file])) },
		status: errors.length ? "planned" : outcome === "verify" ? "verified" : outcome === "defer" ? "deferred" : "kept",
		review: { outcome, reason: String(reason).slice(0, 1600), errors, after, committed_transactions: writes.length,
			semantic_quality: "model_assessed_not_independently_verified" },
		verified_fingerprints: Object.fromEntries([...new Set([...plan.card_ids, ...plan.target_ids, ...plan.inbound.map((r) => r.from)])].map((id) => [id, cardFingerprint(currentCards.get(id))])) };
}

export function constructImprovementCompletion(root, state) {
	const plan = state.workspace.extension?.improvement_plan;
	if (!plan) return { ready: true };
	if (plan.status === "planned") return { ready: false, reason_code: "construct_improvement_review_required", summary: "当前改善计划尚未复核；按原问题验收或明确延期，不能只凭写入成功完成。" };
	if (root && plan.status === "verified") {
		const cards = planCards(root, plan);
		if (Object.entries(plan.verified_fingerprints).some(([id, fp]) => cardFingerprint(cards.get(id)) !== fp)) return { ready: false, reason_code: "construct_improvement_review_stale", summary: "验收后对象已变化，需重新计划和复核。" };
	}
	return { ready: true };
}

export function constructWorkingMemory(state, maxCharacters = 10000) {
	const ext = state.workspace.extension ?? {}, steps = state.episode.steps, plan = ext.improvement_plan;
	const memory = structuredClone({ version: "construct-1", goal: String(state.workspace.goal).slice(0, 500),
		recovery_review: ext.recovery_review ?? null,
		problem: plan ? { id: plan.id, kind: plan.kind, status: plan.status, problem: plan.problem, benefit: plan.benefit,
			card_ids: plan.card_ids, target_ids: plan.target_ids, alternatives: plan.alternatives, preservation: plan.preservation, probes: plan.probes, baseline: plan.baseline, review: plan.review } : ext.focus_issue ?? ext.focus,
		hypotheses: list(state.workspace.hypotheses).slice(-4),
		readings: steps.flatMap(readingEntries).slice(-8).map((r) => ({ card_id: r.card_id, coverage: r.reading?.coverage, units: r.reading?.unit_addresses })),
		recent_observations: steps.filter((s) => ["read", "simulate"].includes(s.action?.mode)).slice(-6).map((s) => ({ step: s.step, operator: s.action.operator, summary: s.observation.summary })),
		issues: list(ext.issue_ledger).slice(-8), deferred: list(state.workspace.deferred_items).slice(-4),
		budget: { ...state.workspace.budget, steps_used: steps.length, writes_used: steps.filter(written).length },
		guidance: ["围绕同一知识使用问题选择下一步，不逐张追求连边率。", "候选不足可换措辞、查全文、多跳或类比；预留阅读和验收预算，重复空结果则延期。", "尚未定位不等于不存在。类比检查机制映射和失效处；反例区分矛盾、条件与术语差异。", "写入成功与语义改善分开报告；不得丢弃独有证据、分歧和边界。"], truncated: false });
	const cap = Math.max(1500, maxCharacters);
	while (JSON.stringify(memory).length > cap) {
		memory.truncated = true;
		if (memory.recent_observations.length) memory.recent_observations.shift();
		else if (memory.readings.length) memory.readings.shift();
		else if (memory.issues.length) memory.issues.shift();
		else if (memory.problem?.preservation?.length) memory.problem.preservation.pop();
		else { memory.problem = { id: plan?.id, status: plan?.status, problem: String(plan?.problem ?? "").slice(0, 400) }; memory.hypotheses = []; memory.deferred = []; memory.recovery_review = ext.recovery_review ? { prior_run_id: ext.recovery_review.prior_run_id, boundary: "有上轮未闭合收据；通过 inspect_cognitive_workspace 查看，不能重复写入。" } : null; break; }
	}
	return normalizeJsonValue(memory);
}
