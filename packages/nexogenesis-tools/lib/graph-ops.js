/**
 * GraphOps —— 图谱操作闭集（移植上游 nexogenesis/graph/ops.py + traverse.py
 * + retrieve.py 的 v2.2 GraphOps 语义；当前契约见
 * docs/history/pre-uno/2026-08-30-TM-Skill-OPS与知识流程统一实施SPEC.md）。
 *
 * 设计原则：
 *  1. 论证边与隶属分开：walk 只走论证边（supports/based-on/extends/example-of/
 *     conflicts-with/involves/part-of + applies-to 仅当目标非 domain）；
 *     domains[] 隶属只能经 members 列出，绝不当推理跳。
 *  2. walk 支持受控的 1–3 跳：逐层去重、逐层限额，并返回实际路径；
 *     1 跳查直接论证，2 跳查中介机制，3 跳只用于桥接与结构探索。
 *  3. 每次返回附带观察学分（channel/n/hub_ratio/on_topic_new/truncated），
 *     供 Harness 下一轮偏置（先记录，后偏置）。
 *  4. 结构债 note_debt → .nexogenesis/graph/debts.jsonl（可删可重建，非语义权威）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { cardSnapshotVersion, scanCards, splitSections } from "./cards.js";
import {
	allowedSignature, RELATION_TYPES, relationPlane, relationReadiness, validateRelationSemantics
} from "./harness/relation-semantics.js";
import { cardFingerprint, currentStructureReviews } from "./cognition/structure-reviews.js";

function asList(value) {
	if (Array.isArray(value)) return value.map((item) => String(item));
	return value === void 0 || value === null || value === "" ? [] : [String(value)];
}

function containsEntityAlias(text, alias) {
	const haystack = String(text ?? "").toLowerCase();
	const needle = String(alias ?? "").trim().toLowerCase();
	if (!needle) return false;
	if (/[一-鿿]/u.test(needle)) return haystack.includes(needle);
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystack);
}

function cardMetadata(card) {
	const meta = card?.meta ?? {};
	return {
		maturity: String(meta.maturity ?? ""),
		origin: String(meta.origin ?? "user"),
		theory_status: String(meta.theory_status ?? ""),
		school: asList(meta.school),
		applicable_scope: asList(meta.applicable_scope),
		entity_kind: String(meta.entity_kind ?? ""),
		aliases: asList(meta.aliases),
		source_summary: {
			count: asList(meta.sources).length,
			references: asList(meta.sources).slice(0, 3)
		}
	};
}

function matchesMetadata(card, filters) {
	for (const [key, rawValues] of Object.entries(filters)) {
		const values = asList(rawValues);
		if (!values.length) continue;
		const expected = new Set(values);
		const actual = key === "school" || key === "applicable_scope"
			? asList(card.meta[key])
			: [String(card.meta[key] ?? "")];
		if (!actual.some((value) => expected.has(value))) return false;
	}
	return true;
}

// ---- 关系语义（移植 relation_semantics.py）----

const WALK_DEFAULT_RELATIONS = new Set([
	"supports", "extends", "based-on", "example-of",
	"conflicts-with", "involves", "part-of"
]);
const WALK_EXCLUDED_RELATIONS = new Set(["influences", "precedes"]);
const WALK_CONTEXT_RELATIONS = new Set(["influences", "precedes"]);
const WALK_REFERENCE_RELATIONS = new Set(["characterizes", "attributed-to"]);

const PART_OF_NOTE_RE = /组成部分|部分[–—\-−]?整体|是其部分|环节之一|组成环节|组成要素|子环节|构件|机制的环节|(?:^|是|的|为)环节/;
const TEMPORAL_NOTE_RE = /时间上|时间先后|时序上|先于|早于|之后发生|此前发生|先发生|随后发生/;

export const DEBT_KINDS = [
	"missing_entity", "uncovered_conflict", "membership_as_applies_to", "domain_overload", "relation_evidence_gap"
];
const ON_TOPIC_TYPES = new Set(["model", "claim", "conflict", "entity"]);
const ANALOGIZE_TYPES = new Set(["model", "claim", "method"]);
const COMPARISON_DIMENSIONS = {
	mechanism: ["机制", "传导", "作用链", "因果", "关键组件", "结构关系"],
	vulnerability: ["脆弱", "风险", "约束", "暴露"],
	buffer: ["缓冲", "稳定因素", "保护因素", "有利条件"],
	time_horizon: ["时间", "时滞", "周期", "阶段"],
	policy_response: ["政策", "应对", "治理", "干预"],
	counterevidence: ["反证", "反例", "边界", "限制", "失效"]
};
const RETRIEVAL_ROLE_ORDER = ["core_claim", "mechanism", "evidence", "counter", "boundary", "context", "related"];

const STRUCTURE_ISSUE_PRIORITY = Object.freeze({
	ghost_domain: "P0", ghost_relation_target: "P0", missing_relation_target: "P0",
	invalid_relation_signature: "P0", unknown_relation_type: "P0", unknown_card_type: "P0",
	self_relation: "P0", duplicate_relation: "P0", duplicate_id: "P0",
	conflict_non_involves_outgoing: "P0", relation_targets_domain: "P0", sample_card: "P0",
	membership_as_applies_to: "P0",
	missing_relation_note: "P1", vague_relation_note: "P1", temporal_anchor_missing: "P1",
	relation_source_missing: "P1", relation_evidence_gap: "P1",
	single_neighbor_concentration: "P1",
	missing_entity: "P2",
	uncovered_conflict: "P3", domain_overload: "P3"
});
const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

function relationAtField(card, field) {
	const match = String(field ?? "").match(/^relations\[(\d+)\]/u);
	return match ? card?.meta?.relations?.[Number(match[1])] : null;
}

function issueFingerprint(issue) {
	const material = [
		issue.kind, issue.card_id, issue.target_id, issue.relation_type,
		issue.source === "graph_debt" ? issue.detail : ""
	].map((value) => String(value ?? "")).join("\u0000");
	return createHash("sha256").update(material).digest("hex");
}

function semanticSlotSummary(card) {
	const parts = splitSections(card?.body ?? "");
	const preferred = /主张|机制|推理|条件|边界|限制|反例|证据|依据|组成|定义|解释|含义/u;
	const selected = parts.filter((part) => part.heading && preferred.test(part.heading)).slice(0, 8);
	const fallback = selected.length ? selected : parts.filter((part) => String(part.content ?? "").trim()).slice(0, 3);
	return fallback.map((part) => ({
		heading: part.heading || "正文",
		excerpt: String(part.content ?? "").replace(/<!--\s*unit:[^>]+-->/gu, "").replace(/\s+/gu, " ").trim().slice(0, 420)
	}));
}

function looksLikePartOf(note) {
	return PART_OF_NOTE_RE.test(String(note ?? ""));
}
function looksLikePrecedes(note) {
	return TEMPORAL_NOTE_RE.test(String(note ?? ""));
}

function constructRelationAllowed(type, sourceType, targetType) {
	return allowedSignature(type, sourceType, targetType) && targetType !== "conflict";
}

function readGraphDebts(root) {
	const file = join(root, ".nexogenesis", "graph", "debts.jsonl");
	if (!existsSync(file)) return [];
	const records = [];
	const seen = new Set();
	for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-500)) {
		try {
			const record = JSON.parse(line);
			if (!DEBT_KINDS.includes(record?.kind)) continue;
			const cards = asList(record.cards).filter(Boolean);
			const reason = String(record.reason ?? "").trim();
			const signature = `${record.kind}\u0000${cards.join("\u0000")}\u0000${reason}`;
			if (seen.has(signature)) continue;
			seen.add(signature);
			records.push({ kind: record.kind, cards, reason, at: String(record.at ?? "") });
		} catch { /* 单条运行态债务损坏不应阻断确定性图谱观察。 */ }
	}
	return records;
}

/** 存量脏边还原：based-on+组成 note → part-of；influences+时序 note → precedes。 */
export function effectiveRelationType(declared, note = "") {
	if (declared === "based-on" && looksLikePartOf(note)) return "part-of";
	if (declared === "influences" && looksLikePrecedes(note)) return "precedes";
	return declared;
}

function relationNote(cards, fromId, toId, declared) {
	const card = cards.get(fromId);
	if (!card) return "";
	for (const rel of card.meta.relations ?? []) {
		if (rel?.target === toId && rel?.type === declared) return String(rel?.note ?? "");
	}
	return "";
}

function walkRelationType(cards, fromId, edge) {
	if (edge.kind !== "relation" || !edge.relation_type) return edge.relation_type;
	const note = relationNote(cards, fromId, edge.to, edge.relation_type);
	return effectiveRelationType(edge.relation_type, note);
}

function edgeReadiness(cards, edge) {
	const type = walkRelationType(cards, edge.from, edge);
	const note = relationNote(cards, edge.from, edge.to, edge.relation_type) || String(edge.note ?? "");
	return relationReadiness(cards.get(edge.from), { target: edge.to, type, note }, cards.get(edge.to));
}

/** 默认可走的论证/组成边。不走隶属、wikilink、时间先后。 */
export function isArgumentEdge(cards, edge, { includeInfluences = false, includeAppliesTo = false } = {}) {
	if (edge.kind !== "relation" || !edge.relation_type) return false;
	const effective = walkRelationType(cards, edge.from, edge);
	if (!effective) return false;
	if (WALK_EXCLUDED_RELATIONS.has(effective)) {
		return includeInfluences && effective === "influences";
	}
	if (effective === "applies-to") {
		const target = cards.get(edge.to);
		return includeAppliesTo && Boolean(target && target.meta.type !== "domain");
	}
	return WALK_DEFAULT_RELATIONS.has(effective);
}

export function isContextEdge(cards, edge) {
	if (edge.kind !== "relation" || !edge.relation_type) return false;
	return WALK_CONTEXT_RELATIONS.has(walkRelationType(cards, edge.from, edge));
}

export function isReferenceEdge(cards, edge) {
	if (edge.kind !== "relation" || !edge.relation_type) return false;
	return WALK_REFERENCE_RELATIONS.has(walkRelationType(cards, edge.from, edge));
}

// ---- 检索辅助（移植 retrieve.py）----

const QUERY_STOP = new Set([
	"的", "了", "是", "在", "和", "与", "对", "为", "中", "及", "这", "那", "不",
	"也", "都", "就", "而", "并", "或", "但", "被", "把", "上", "下", "从", "到",
	"向", "往", "于", "之", "以", "其", "等", "个", "种", "类", "问题", "什么",
	"如何", "为何", "为什么", "是否", "哪些", "怎样", "怎么", "分析", "探讨",
	"讨论", "比较", "理解", "解释", "关系", "相关", "关于", "对于", "以及", "一个"
]);
const CJK_RUN_RE = /[\u4e00-\u9fff]{4,}/g;
const QUERY_INSTRUCTION_RE = /(?:我希望|请问|请|帮我|深入|深度|如何|怎么|怎样|为何|为什么|判断|分析|研究|检验|验证|比较|寻找|说明|当前|处于|是否|什么样|时候|问题)/gu;
const QUERY_CLAUSE_CONNECTOR_RE = /(?:看起来|的时候|转向|通过|影响|以及|从|到|与|和|及|时|年)/gu;
const QUERY_SEGMENT_STOP = new Set([
	...QUERY_STOP, "我", "希望", "帮", "请", "问", "请问", "看起来", "深入", "深度", "判断", "分析",
	"研究", "检验", "验证", "寻找", "说明", "当前", "处于", "样", "时候", "转向", "通过", "影响", "时", "年"
]);
const QUERY_WORD_SEGMENTER = typeof Intl?.Segmenter === "function"
	? new Intl.Segmenter("zh-CN", { granularity: "word" })
	: null;

/** query 侧 token：过滤宽词；长段中文补 2–4 字 n-gram。 */
export function queryTokens(text) {
	const toks = new Set();
	const words = String(text ?? "").toLowerCase().split(/[\s，。、；：！？,.!?;:()（）"'“”‘’\-_/\\|]+/);
	for (const w of words) {
		const t = w.trim();
		if (t.length > 1 && !QUERY_STOP.has(t)) toks.add(t);
	}
	const semanticText = String(text ?? "").replace(QUERY_INSTRUCTION_RE, " ");
	for (const run of semanticText.match(CJK_RUN_RE) ?? []) {
		for (const n of [2, 3, 4]) {
			for (let i = 0; i <= run.length - n; i++) {
				const gram = run.slice(i, i + n);
				if (!QUERY_STOP.has(gram)) toks.add(gram);
			}
		}
	}
	return toks;
}

/**
 * 问题侧 token：先按提问套语和连接词切开语义分句，再产生有限词片。
 * 卡片侧仍保留宽 token；这样避免把“美元从”“信用和”“折与”等跨分句片段当成查询意图。
 */
export function retrievalQueryTokens(text) {
	const tokens = new Set();
	const clauses = [];
	let clause = [];
	const flush = () => {
		if (clause.length) clauses.push(clause.join(""));
		clause = [];
	};
	if (QUERY_WORD_SEGMENTER) {
		for (const part of QUERY_WORD_SEGMENTER.segment(String(text ?? "").toLowerCase())) {
			const segment = part.segment.trim();
			if (!segment || !part.isWordLike) {
				flush();
				continue;
			}
			if (QUERY_SEGMENT_STOP.has(segment)) {
				flush();
				continue;
			}
			clause.push(segment);
		}
		flush();
	} else {
		clauses.push(...String(text ?? "").replace(QUERY_INSTRUCTION_RE, " ")
			.split(QUERY_CLAUSE_CONNECTOR_RE).map((segment) => segment.trim()).filter(Boolean));
	}
	for (const semanticClause of clauses) {
		for (const token of queryTokens(semanticClause)) {
			if (/^[\u4e00-\u9fff]+$/u.test(token) && token.length <= 4) tokens.add(token);
			else if (/^[a-z0-9]{2,12}$/iu.test(token)) tokens.add(token);
		}
	}
	return tokens;
}

function semanticTokens(card) {
	const title = String(card?.meta?.title ?? "");
	const body = String(card?.body ?? "")
		.replace(/<!--\s*unit:[^>]+-->/g, "")
		.replace(/^#{1,6}\s+.+$/gm, "")
		.slice(0, 2200);
	return queryTokens(`${title} ${body}`);
}

const DISCOVERY_GENERIC_ANCHORS = new Set([
	"作者", "观点", "内容", "材料", "问题", "分析", "机制", "条件", "边界", "证据", "模型", "关系",
	"影响", "可能", "需要", "通过", "导致", "说明", "形成", "作用", "核心", "基础", "理论", "结果"
]);
const DISCOVERY_BREAK_WORDS = new Set(["的", "了", "在", "与", "和", "及", "或", "但", "而", "为", "是", "将", "从", "对", "并", "会", "把", "被", "于", "其", "该", "此", "这", "各", "本", "某", "下"]);
const DISCOVERY_EDGE_CHAR_RE = /^(?:的|了|在|与|和|及|或|但|而|为|是|将|从|对)|(?:的|了|在|与|和|及|或|但|而|为|是|将|从|对)$/u;

/**
 * 发现层只使用正文中的中文内容锚点：不读取来源、Markdown 模板、英文引文或通用段落标题。
 * 这是一道高精度候选闸门，宁可漏掉弱桥梁，也不让格式和转录残渣制造“语义联系”。
 */
function discoveryAnchors(card) {
	const clean = (value) => String(value ?? "")
		.replace(/<!--\s*unit:[^>]+-->/gu, " ")
		.replace(/[\[\]{}()（）*_`>#|]/gu, " ")
		.replace(/\b[a-z][a-z0-9_-]{1,}\b/giu, " ")
		.replace(/\d+/gu, " ");
	const text = clean(`${card?.meta?.title ?? ""}\n${semanticSlotSummary(card).map((slot) => slot.excerpt).join("\n")}`);
	const anchors = new Set();
	const add = (token) => {
		const value = String(token ?? "").trim();
		if (!/^[\u4e00-\u9fff]{2,8}$/u.test(value) || DISCOVERY_GENERIC_ANCHORS.has(value) || DISCOVERY_EDGE_CHAR_RE.test(value)) return;
		anchors.add(value);
	};
	const addWordPhrases = (words) => {
		for (let start = 0; start < words.length; start++) for (let width = 1; width <= 4 && start + width <= words.length; width++) {
			add(words.slice(start, start + width).join(""));
		}
	};
	if (QUERY_WORD_SEGMENTER) {
		let words = [];
		for (const part of QUERY_WORD_SEGMENTER.segment(text)) {
			const word = String(part.segment ?? "").trim();
			if (!part.isWordLike || !/^[\u4e00-\u9fff]+$/u.test(word) || DISCOVERY_BREAK_WORDS.has(word)) {
				addWordPhrases(words);
				words = [];
				continue;
			}
			words.push(word);
		}
		addWordPhrases(words);
	}
	return anchors;
}

function overlapScore(left, right) {
	if (!left.size || !right.size) return { score: 0, shared: [] };
	const shared = [...left].filter((token) => right.has(token));
	return {
		score: shared.length / Math.max(1, Math.min(left.size, right.size)),
		shared: shared.sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-CN")).slice(0, 8)
	};
}

function boundedNumber(value, fallback, minimum, maximum) {
	const number = Number(value);
	return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? Math.trunc(number) : fallback));
}

function boundedIntentTerms(value, maximum = 3) {
	return asList(value).map((term) => String(term).replace(/\s+/gu, " ").trim())
		.filter((term) => term.length >= 2 && term.length <= 80).slice(0, maximum);
}

/**
 * The model may turn a complex user question into a small, inspectable retrieval brief.
 * It is request-local and advisory: no inferred term changes the knowledge body or excludes evidence outright.
 */
function normalizeRetrievalIntent(query, intent) {
	const focus = boundedIntentTerms(intent?.focus);
	const mechanisms = boundedIntentTerms(intent?.mechanisms);
	const context = boundedIntentTerms(intent?.context);
	const contrasts = boundedIntentTerms(intent?.contrasts);
	const exclusions = boundedIntentTerms(intent?.exclusions);
	const primaryTerms = [...focus, ...mechanisms];
	const primaryText = primaryTerms.join(" ") || String(query ?? "");
	const rawQueryTerms = [...retrievalQueryTokens(query)];
	const primaryQueryTerms = [...retrievalQueryTokens(primaryText)];
	return {
		focus, mechanisms, context, contrasts, exclusions,
		primary_terms: primaryTerms,
		query_terms: primaryQueryTerms,
		raw_query_terms: rawQueryTerms,
		context_terms: [...retrievalQueryTokens(context.join(" "))],
		contrast_terms: [...retrievalQueryTokens(contrasts.join(" "))],
		exclusion_terms: [...retrievalQueryTokens(exclusions.join(" "))],
		intent_effects: {
			primary_term_count: primaryQueryTerms.length,
			raw_tail_term_count: primaryTerms.length
				? rawQueryTerms.filter((term) => !primaryQueryTerms.includes(term)).length : 0,
			context_term_count: retrievalQueryTokens(context.join(" ")).size,
			contrast_term_count: retrievalQueryTokens(contrasts.join(" ")).size,
			exclusion_term_count: retrievalQueryTokens(exclusions.join(" ")).size
		},
		source: primaryTerms.length || context.length || contrasts.length || exclusions.length ? "model_brief" : "raw_query"
	};
}

function encodeQueueCursor(item) {
	return Buffer.from(JSON.stringify([item.priority, item.card_id]), "utf8").toString("base64url");
}

function queueStart(items, cursor) {
	if (cursor === void 0 || cursor === null || cursor === "") return 0;
	if (typeof cursor === "number" || /^\d+$/.test(String(cursor))) return Math.max(0, Math.trunc(Number(cursor) || 0));
	try {
		const [priority, cardId] = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
		return items.findIndex((item) => item.priority < Number(priority)
			|| (item.priority === Number(priority) && item.card_id.localeCompare(String(cardId), "zh-CN") > 0));
	} catch {
		return 0;
	}
}

function mentionsCard(card, otherId, otherCard) {
	const text = `${card?.meta?.title ?? ""}\n${card?.body ?? ""}`;
	return [otherId, otherCard?.meta?.title].filter((value) => String(value ?? "").trim().length >= 2)
		.filter((value) => text.includes(String(value)));
}

/** 领域枢纽降权，不删除。成员越多，越不该当论证种子。 */
export function hubPenalty(cards, byDomain, cardId) {
	const card = cards.get(cardId);
	if (!card || card.meta.type !== "domain") return 0;
	const members = (byDomain.get(cardId) ?? []).filter((id) => id !== cardId);
	const n = members.length;
	if (n >= 50) return 12;
	if (n >= 20) return 6;
	if (n >= 8) return 3;
	return 1;
}

// ---- GraphOps ----

const GRAPH_SNAPSHOT_LIMIT = 4;
const graphSnapshots = new Map();

function graphSnapshotKey(root) {
	return resolve(root).toLocaleLowerCase();
}

function cacheGraphSnapshot(root, value) {
	const key = graphSnapshotKey(root);
	graphSnapshots.delete(key);
	graphSnapshots.set(key, value);
	while (graphSnapshots.size > GRAPH_SNAPSHOT_LIMIT) graphSnapshots.delete(graphSnapshots.keys().next().value);
}

/**
 * @param root - knowledge-body root.
 * @param seenIds - 可选：本轮已见卡 id（用于 on_topic_new 学分）。
 */
export function loadGraphOps(root, seenIds) {
	const scanned = scanCards(root);
	const version = cardSnapshotVersion(root);
	const cacheKey = graphSnapshotKey(root);
	const cached = graphSnapshots.get(cacheKey);
	if (cached?.version === version) {
		graphSnapshots.delete(cacheKey);
		graphSnapshots.set(cacheKey, cached);
		return new GraphOps(
			cached.cards, cached.byDomain, cached.adjOut, cached.adjIn,
			cached.conflictsInvolving, root, seenIds, cached.diagnostics, cached.sourceIndex, cached.derived
		);
	}
	const cards = scanned.cards;
	// 隶属索引：domain id → 成员卡 id。
	const byDomain = new Map();
	for (const [cid, card] of cards) {
		for (const domain of card.meta.domains ?? []) {
			if (!byDomain.has(domain)) byDomain.set(domain, []);
			byDomain.get(domain).push(cid);
		}
	}
	// 论证邻接（out/in）。
	const adjOut = new Map();
	const adjIn = new Map();
	for (const [cid, card] of cards) {
		for (const rel of card.meta.relations ?? []) {
			if (!rel || typeof rel.target !== "string") continue;
			const edge = { from: cid, to: rel.target, kind: "relation", relation_type: String(rel.type ?? "relation"), note: rel.note ?? "" };
			if (!adjOut.has(cid)) adjOut.set(cid, []);
			adjOut.get(cid).push(edge);
			if (!adjIn.has(rel.target)) adjIn.set(rel.target, []);
			adjIn.get(rel.target).push(edge);
		}
	}
	// conflict 覆盖索引：party id → [conflict 卡 id]。
	const conflictsInvolving = new Map();
	for (const [cid, card] of cards) {
		if (card.meta.type !== "conflict") continue;
		for (const rel of card.meta.relations ?? []) {
			if (rel?.type === "involves" && typeof rel.target === "string") {
				if (!conflictsInvolving.has(rel.target)) conflictsInvolving.set(rel.target, []);
				conflictsInvolving.get(rel.target).push(cid);
			}
		}
	}
	const sourceIndex = new Map();
	for (const [cardId, card] of cards) for (const source of asList(card.meta.sources)) {
		if (!sourceIndex.has(source)) sourceIndex.set(source, []);
		sourceIndex.get(source).push(cardId);
	}
	const derived = {};
	const snapshot = { version, cards, byDomain, adjOut, adjIn, conflictsInvolving, diagnostics: scanned.diagnostics, sourceIndex, derived };
	cacheGraphSnapshot(root, snapshot);
	return new GraphOps(cards, byDomain, adjOut, adjIn, conflictsInvolving, root, seenIds, scanned.diagnostics, sourceIndex, derived);
}

export class GraphOps {
	constructor(cards, byDomain, adjOut, adjIn, conflictsInvolving, root, seenIds, diagnostics = {}, sourceIndex = null, derived = {}) {
		this.cards = cards;
		this.byDomain = byDomain;
		this.adjOut = adjOut;
		this.adjIn = adjIn;
		this.conflictsInvolving = conflictsInvolving;
		this.root = root;
		this.seenIds = new Set(seenIds ?? []);
		this.diagnostics = diagnostics ?? {};
		// Content-only indexes share the Card snapshot lifetime; attention stays per call.
		this.derived = derived;
		this.semanticTokenCache = derived.semanticTokenCache ??= new Map();
		this.discoveryAnchorCache = derived.discoveryAnchorCache ??= new Map();
		this.sourceIndex = sourceIndex ?? new Map();
		if (sourceIndex === null) for (const [cardId, card] of cards) for (const source of asList(card.meta.sources)) {
			if (!this.sourceIndex.has(source)) this.sourceIndex.set(source, []);
			this.sourceIndex.get(source).push(cardId);
		}
	}

	get semanticTokenIndex() { return this.derived.semanticTokenIndex; }
	set semanticTokenIndex(value) { this.derived.semanticTokenIndex = value; }
	get discoveryAnchorIndex() { return this.derived.discoveryAnchorIndex; }
	set discoveryAnchorIndex(value) { this.derived.discoveryAnchorIndex = value; }

	/**
	 * Deterministic metadata audit. It produces a pageable issue queue so the
	 * model can inspect one local cluster at a time instead of pretending that a
	 * lexical query has scanned the whole graph.
	 */
	structureIssues({ kinds, cardIds, cursor = 0, limit = 12 } = {}) {
		const requestedKinds = new Set(asList(kinds));
		const requestedCardIds = new Set(asList(cardIds));
		const issueMap = new Map();
		const push = (issue) => {
			if (requestedKinds.size && !requestedKinds.has(issue.kind)) return;
			if (requestedCardIds.size && !requestedCardIds.has(issue.card_id) && !requestedCardIds.has(issue.target_id)
				&& !issue.member_ids?.some((id) => requestedCardIds.has(id))) return;
			const priority = STRUCTURE_ISSUE_PRIORITY[issue.kind] ?? "P2";
			const normalized = { ...issue, priority, priority_rank: PRIORITY_RANK[priority] };
			normalized.fingerprint = issueFingerprint(normalized);
			if (!issueMap.has(normalized.fingerprint)) issueMap.set(normalized.fingerprint, normalized);
		};

		for (const item of this.diagnostics.excluded_examples ?? []) {
			push({ kind: "sample_card", severity: "warning", card_id: item.id, file: item.file,
				detail: "样例卡已从正式检索图中隔离；请从实例知识体移出或明确转为正式知识。" });
		}
		for (const item of this.diagnostics.duplicate_ids ?? []) {
			push({ kind: "duplicate_id", severity: "error", card_id: item.id, files: item.files,
				detail: "多个文件声明同一卡片 id；运行时只采用按路径排序后的第一份。" });
		}

		const semanticCards = new Map([...this.cards].map(([id, card]) => [id, card.meta]));
		for (const [cardId, card] of this.cards) {
			for (const domainId of asList(card.meta.domains)) {
				const domain = this.cards.get(domainId);
				if (!domain || domain.meta.type !== "domain") push({
					kind: "ghost_domain", severity: "error", card_id: cardId, target_id: domainId,
					detail: "domains 引用了不存在或并非 domain 类型的卡片。"
				});
			}
			const signatures = new Set();
			for (const relation of card.meta.relations ?? []) {
				const targetId = String(relation?.target ?? "");
				const type = String(relation?.type ?? "");
				const signature = `${type}\u0000${targetId}`;
				if (signatures.has(signature)) push({
					kind: "duplicate_relation", severity: "warning", card_id: cardId, target_id: targetId,
					relation_type: type, detail: "同一来源卡重复声明了相同关系。"
				});
				signatures.add(signature);
				if (this.cards.get(targetId)?.meta.type === "domain") push({
					kind: "relation_targets_domain", severity: "warning", card_id: cardId, target_id: targetId,
					relation_type: type, detail: "论证关系指向领域容器；应核对它是否其实只是 domains 归属。"
				});
				if (card.meta.type === "conflict" && type !== "involves") push({
					kind: "conflict_non_involves_outgoing", severity: "warning", card_id: cardId,
					target_id: targetId, relation_type: type,
					detail: "conflict 是争议档案；这条非 involves 出边应核对是否应迁回具体立场卡。"
				});
				const readiness = relationReadiness(card, relation, this.cards.get(targetId));
				if (readiness.level === "legacy_candidate") push({
					kind: readiness.reason_codes[0] ?? "relation_not_ready", severity: "warning",
					card_id: cardId, target_id: targetId, relation_type: type,
					plane: readiness.plane, readiness: readiness.level, detail: readiness.summary
				});
			}
			for (const violation of validateRelationSemantics(card.meta, semanticCards)) {
				const relation = relationAtField(card, violation.field);
				push({
					kind: violation.code === "missing_relation_target" ? "ghost_relation_target" : violation.code,
					severity: "error", card_id: cardId, field: violation.field,
					target_id: relation?.target, relation_type: relation?.type, detail: violation.detail
				});
			}
		}

		// Count distinct live neighbours, never domains membership or parallel edge declarations.
		const live = (id) => this.cards.has(id) && this.cards.get(id).meta.type !== "domain"
			&& !["archived", "superseded"].includes(this.cards.get(id).meta.lifecycle);
		const leavesByCenter = new Map();
		for (const [id] of this.cards) {
			if (!live(id)) continue;
			const incident = [...(this.adjOut.get(id) ?? []), ...(this.adjIn.get(id) ?? [])];
			const neighbours = new Set(incident.map((e) => e.from === id ? e.to : e.from).filter((n) => n !== id && live(n)));
			if (neighbours.size !== 1) continue;
			const center = [...neighbours][0];
			if (!leavesByCenter.has(center)) leavesByCenter.set(center, []);
			leavesByCenter.get(center).push(id);
		}
		for (const [center, leaves] of leavesByCenter) {
			if (leaves.length <= 50) continue;
			const outgoing = (id) => (this.adjOut.get(id) ?? []).filter((e) => live(e.to) && e.to !== id
				&& edgeReadiness(this.cards, e).ready && edgeReadiness(this.cards, e).plane === "argument");
			const centerTargets = new Set(outgoing(center).map((e) => e.to));
			const readyLeaves = leaves.filter((id) => outgoing(id).some((e) => e.to === center));
			const twoHopLeaves = readyLeaves.filter((id) => [...centerTargets].some((target) => target !== id));
			push({ kind: "single_neighbor_concentration", severity: "warning", card_id: center,
				member_ids: leaves.sort(), leaf_count: leaves.length,
				inward_leaf_count: leaves.filter((id) => (this.adjOut.get(id) ?? []).some((e) => e.to === center)).length,
				ready_inward_leaf_count: readyLeaves.length, argument_out_two_hop_leaf_count: twoHopLeaves.length,
				argument_out_dead_end_leaf_count: readyLeaves.length - twoHopLeaves.length,
				detail: `${leaves.length} 张卡仅有同一个非领域邻居；其中 ${readyLeaves.length} 张可沿论证出边到达中心，${twoHopLeaves.length} 张能继续到第二跳。须比较中介机制、互补与反例，不能仅为增加跳数补边。` });
		}

		for (const debt of readGraphDebts(this.root)) {
			const [cardId, ...candidateIds] = debt.cards;
			if (debt.kind === "relation_evidence_gap" && cardId && this.cards.has(cardId)) {
				const ready = [...(this.adjOut.get(cardId) ?? []), ...(this.adjIn.get(cardId) ?? [])]
					.some((edge) => edgeReadiness(this.cards, edge).ready);
				if (ready) continue;
			}
			push({
				kind: debt.kind,
				severity: "warning",
				source: "graph_debt",
				card_id: cardId,
				target_id: candidateIds[0],
				candidate_ids: candidateIds,
				recorded_at: debt.at,
				detail: debt.reason || "此前流程记录了尚待复核的结构问题。"
			});
		}

		const issues = [...issueMap.values()];
		issues.sort((a, b) => a.priority_rank - b.priority_rank
			|| `${a.kind}|${a.card_id ?? ""}|${a.target_id ?? ""}`
				.localeCompare(`${b.kind}|${b.card_id ?? ""}|${b.target_id ?? ""}`, "zh-CN"));
		const start = Math.max(0, Math.trunc(Number(cursor) || 0));
		const cap = Math.min(30, Math.max(1, Math.trunc(Number(limit) || 12)));
		const page = issues.slice(start, start + cap);
		const totals = {};
		for (const issue of issues) totals[issue.kind] = (totals[issue.kind] ?? 0) + 1;
		const totalsByPriority = { P0: 0, P1: 0, P2: 0, P3: 0 };
		for (const issue of issues) totalsByPriority[issue.priority]++;
		const nodeIds = [...new Set(page.flatMap((issue) => [issue.card_id, issue.target_id]).filter((id) => this.cards.has(id)))];
		const nodes = nodeIds.map((id) => this._cardRef(id));
		const nextCursor = start + page.length < issues.length ? start + page.length : null;
		const checkedCardIds = [...requestedCardIds].filter((id) => this.cards.has(id));
		const unresolvedCardIds = new Set(issues.flatMap((issue) => [issue.card_id, issue.target_id, ...(issue.member_ids ?? [])]));
		const observed = this._observe("structure-audit", nodes, {
			truncated: nextCursor !== null,
			reason: nextCursor !== null ? "issue_page_limit" : undefined,
			extra: {
				issues: page, issue_total: issues.length, totals, totals_by_priority: totalsByPriority,
				checked_kinds: [...requestedKinds],
				unresolved_fingerprints: issues.map((issue) => issue.fingerprint),
				priority_order: ["P0", "P1", "P2", "P3"], cursor: start, next_cursor: nextCursor ?? undefined,
				checked_card_ids: checkedCardIds,
				resolved_card_ids: checkedCardIds.filter((id) => !unresolvedCardIds.has(id))
			}
		});
		this._remember(nodes);
		return observed;
	}

	/** 字面/标题/正文召回（channel: lexical；超度枢纽降权）。 */
	search(query, { types, domains, maturity, origin, theory_status, school, applicable_scope, limit = 8 } = {}) {
		const tokens = retrievalQueryTokens(query ?? "");
		const typeSet = new Set(types ?? []);
		const domainSet = new Set(domains ?? []);
		const metadataFilters = { maturity, origin, theory_status, school, applicable_scope };
		const scored = [];
		for (const [cid, card] of this.cards) {
			if (card.meta.lifecycle === "archived") continue;
			if (typeSet.size && !typeSet.has(card.meta.type)) continue;
			if (domainSet.size && !(domainSet.size && card.meta.domains?.some((d) => domainSet.has(d)))) continue;
			if (!matchesMetadata(card, metadataFilters)) continue;
			const hay = `${cid} ${card.meta.title ?? ""} ${String(card.body ?? "").slice(0, 600)}`;
			let rel = 0;
			for (const tok of tokens) if (hay.includes(tok)) rel += 3;
			if (rel <= 0) continue;
			scored.push([rel - hubPenalty(this.cards, this.byDomain, cid), cid]);
		}
		scored.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? -1 : 1));
		const cap = Math.max(0, limit);
		const hits = scored.slice(0, cap).map(([, cid]) => this._cardRef(cid));
		const structuralFrontier = hits
			.map((node) => this._structuralFrontier(node.id))
			.filter(Boolean)
			.sort((a, b) => b.two_hop_reachable - a.two_hop_reachable
				|| b.ready_relation_count - a.ready_relation_count
				|| a.card_id.localeCompare(b.card_id, "zh-CN"));
		const suggestedFrontier = structuralFrontier.find((item) => item.ready_relation_count > 0);
		const observed = this._observe("lexical", hits, {
			truncated: scored.length > cap,
			reason: scored.length > cap ? "result_limit" : undefined,
			extra: {
				query: String(query ?? ""),
				filters: Object.fromEntries(Object.entries(metadataFilters).filter(([, value]) => asList(value).length)),
				structural_frontier: structuralFrontier.slice(0, 4),
				...(suggestedFrontier ? {
					suggested_operator: "graph_walk",
					suggested_args: {
						card_id: suggestedFrontier.card_id,
						plane: suggestedFrontier.recommended_plane,
						direction: "both",
						hops: 2
					}
				} : hits.length ? {
					graph_gap: {
						reason_code: "search_hits_have_no_ready_relations",
						card_ids: hits.filter((node) => node.type !== "domain").map((node) => node.id)
					}
				} : {})
			}
		});
		this._remember(hits);
		return observed;
	}

	/**
	 * 统一的首轮检索：较宽词面召回后沿 ready argument/context 边扩展，
	 * 再按当前问题、关系说明、论证角色和内容冗余产生可解释阅读计划。
	 */
	retrieveContext(query, {
		types, domains, maturity, origin, theory_status, school, applicable_scope,
		limit = 10, graphHops = 2, planes = ["argument", "context"], intent
	} = {}) {
		const cap = boundedNumber(limit, 10, 4, 16);
		const hops = boundedNumber(graphHops, 2, 0, 2);
		const retrievalIntent = normalizeRetrievalIntent(query, intent);
		const querySet = new Set([...retrievalIntent.query_terms, ...retrievalIntent.raw_query_terms]);
		const queryFacets = this._queryFacets(new Set(retrievalIntent.query_terms.length
			? retrievalIntent.query_terms : retrievalIntent.raw_query_terms));
		const typeSet = new Set(types ?? []);
		const domainSet = new Set(domains ?? []);
		const planeSet = new Set(asList(planes).filter((plane) => ["argument", "context"].includes(plane)));
		const metadataFilters = { maturity, origin, theory_status, school, applicable_scope };
		const direct = [];
		for (const [cardId, card] of this.cards) {
			if (card.meta.lifecycle === "archived") continue;
			if (typeSet.size && !typeSet.has(card.meta.type)) continue;
			if (domainSet.size && !card.meta.domains?.some((domain) => domainSet.has(domain))) continue;
			if (!matchesMetadata(card, metadataFilters)) continue;
			const relevance = this._queryRelevance(cardId, querySet, query, retrievalIntent);
			if (relevance.score <= 0) continue;
			direct.push({ card_id: cardId, ...relevance });
		}
		direct.sort((left, right) => right.score - left.score || left.card_id.localeCompare(right.card_id, "zh-CN"));
		const directThreshold = Math.max(0.8, (direct[0]?.score ?? 0) * 0.16);
		const directPoolLimit = Math.max(12, cap * 2);
		const primaryPool = direct.filter((item) => item.score >= directThreshold);
		const primaryPoolIds = new Set(primaryPool.map((item) => item.card_id));
		// 结构化意图应聚焦，而不是把原问题的第二机制删掉。只保留少量强尾部命中，且不把它们当发现种子。
		const rawTailPool = retrievalIntent.source === "model_brief"
			? direct.filter((item) => !primaryPoolIds.has(item.card_id) && item.raw_tail_score >= 6).sort((left, right) => right.raw_tail_score - left.raw_tail_score || left.card_id.localeCompare(right.card_id, "zh-CN")).slice(0, 4)
			: [];
		const directPool = [...new Map([
			...primaryPool.slice(0, Math.max(1, directPoolLimit - rawTailPool.length)), ...rawTailPool
		].map((item) => [item.card_id, item])).values()]
			.sort((left, right) => right.score - left.score || left.card_id.localeCompare(right.card_id, "zh-CN"));
		const rawTailIds = new Set(rawTailPool.map((item) => item.card_id));
		const seeds = directPool.filter((item) => !rawTailIds.has(item.card_id) && this.cards.get(item.card_id)?.meta.type !== "domain").slice(0, Math.min(6, cap));
		const candidates = new Map();
		for (const item of directPool) candidates.set(item.card_id, {
			card_id: item.card_id, hop: 0, score: item.score,
			retrieval_source: "direct",
			score_breakdown: { query_relevance: item.score, raw_tail_relevance: item.raw_tail_score, graph_affinity: 0, relation_note_relevance: 0, distance_cost: 0 },
			matched_tokens: item.matched_tokens, path: [item.card_id], path_edges: []
		});

		// 正式关系图只负责已核验的推理路径；候选关联场只帮助发现值得比较的陌生桥梁。
		// 它不生成关系、不继续扩散，也不会把候选当作证据。
		for (const seed of seeds.slice(0, 4)) for (const association of this._discoveryAssociations(seed.card_id, {
			limit: Math.min(4, cap), exclude: new Set(directPool.map((item) => item.card_id))
		})) {
			const existing = candidates.get(association.card_id);
			if (existing?.retrieval_source === "direct") continue;
			const relevance = this._queryRelevance(association.card_id, querySet, query, retrievalIntent);
			const score = Math.round((relevance.score + association.score) * 1000) / 1000;
			if (!existing || existing.score < score) candidates.set(association.card_id, {
				card_id: association.card_id, hop: 0, score, retrieval_source: "discovery",
				score_breakdown: {
					query_relevance: relevance.score, graph_affinity: 0,
					raw_tail_relevance: relevance.raw_tail_score,
					relation_note_relevance: 0, distance_cost: 0,
					discovery_affinity: association.score
				},
				matched_tokens: relevance.matched_tokens, discovery: association,
				path: [seed.card_id, association.card_id], path_edges: []
			});
		}

		const queue = seeds.map((item) => ({ card_id: item.card_id, seed_score: item.score, hop: 0, path: [item.card_id], path_edges: [] }));
		const expandedAt = new Map(queue.map((item) => [item.card_id, 0]));
		while (queue.length) {
			const current = queue.shift();
			if (current.hop >= hops) continue;
			const incident = [
				...(this.adjOut.get(current.card_id) ?? []).map((edge) => ({ edge, other: edge.to, direction: "out" })),
				...(this.adjIn.get(current.card_id) ?? []).map((edge) => ({ edge, other: edge.from, direction: "in" }))
			];
			for (const { edge, other, direction } of incident) {
				const card = this.cards.get(other);
				if (!card || card.meta.type === "domain" || card.meta.lifecycle === "archived") continue;
				const plane = isArgumentEdge(this.cards, edge) ? "argument" : isContextEdge(this.cards, edge) ? "context" : null;
				if (!plane || !planeSet.has(plane) || !edgeReadiness(this.cards, edge).ready) continue;
				const nextHop = current.hop + 1;
				const relationType = walkRelationType(this.cards, edge.from, edge);
				const noteOverlap = overlapScore(querySet, queryTokens(edge.note ?? ""));
				const relevance = this._queryRelevance(other, querySet, query, retrievalIntent);
				const graphAffinity = (nextHop === 1 ? 3 : 1) + Math.min(2, current.seed_score * 0.08)
					+ (["conflicts-with", "supports", "based-on", "example-of"].includes(relationType) ? 1 : 0);
				const noteRelevance = Math.round(noteOverlap.score * 800) / 100;
				const distanceCost = nextHop * 3;
				const score = Math.round((relevance.score + graphAffinity + noteRelevance - distanceCost) * 1000) / 1000;
				const pathEdge = { from: edge.from, to: edge.to, relation_type: relationType, plane, direction, note: String(edge.note ?? "") };
				const candidate = {
					card_id: other, hop: nextHop, score, retrieval_source: "graph",
					score_breakdown: {
						query_relevance: relevance.score, graph_affinity: Math.round(graphAffinity * 1000) / 1000,
						raw_tail_relevance: relevance.raw_tail_score,
						relation_note_relevance: noteRelevance, distance_cost: distanceCost
					},
					matched_tokens: relevance.matched_tokens,
					via: current.card_id, path: [...current.path, other], path_edges: [...current.path_edges, pathEdge]
				};
				const existing = candidates.get(other);
				if (existing?.retrieval_source === "direct") existing.role_edges = [...(existing.role_edges ?? []), pathEdge];
				// 已核验图关系永远比候选关联优先：同一节点一旦有 ready 路径，不能继续作为 discovery 返回。
				else if (existing?.retrieval_source === "discovery" || !existing || existing.score < score) candidates.set(other, candidate);
				if (nextHop < hops && (!expandedAt.has(other) || expandedAt.get(other) > nextHop)) {
					expandedAt.set(other, nextHop);
					queue.push({ card_id: other, seed_score: current.seed_score, hop: nextHop, path: candidate.path, path_edges: candidate.path_edges });
				}
			}
		}

		const ranked = [...candidates.values()].map((item) => {
			const roles = this._retrievalRoles(item.card_id, [...(item.path_edges ?? []), ...(item.role_edges ?? [])]);
			return { ...item, roles, primary_role: RETRIEVAL_ROLE_ORDER.find((role) => roles.includes(role)) ?? "related" };
		}).sort((left, right) => right.score - left.score || left.hop - right.hop || left.card_id.localeCompare(right.card_id, "zh-CN"));
		const selection = this._selectRetrievalContext(ranked, cap, queryFacets);
		const nodes = selection.selected.map((item) => ({
			...this._cardRef(item.card_id), hop: item.hop, retrieval_role: item.primary_role, retrieval_roles: item.roles,
			score: item.score, score_breakdown: item.score_breakdown, matched_tokens: item.matched_tokens,
			retrieval_source: item.retrieval_source ?? "direct",
			...(item.discovery ? { discovery: item.discovery } : {}),
			...(item.via ? { via: item.via, path: item.path, path_edges: item.path_edges } : {}),
			reasons: this._retrievalReasons(item), read_slots: this._retrievalReadSlots(item.roles),
			source_trace_required: this._sourceTraceRequired(item.card_id, item.roles)
		}));
		const selectedIds = new Set(nodes.map((node) => node.id));
		const frontier = nodes.filter((node) => node.hop === 0 && node.retrieval_source !== "discovery")
			.map((node) => this._structuralFrontier(node.id)).filter(Boolean)
			.sort((left, right) => right.two_hop_reachable - left.two_hop_reachable
				|| right.ready_relation_count - left.ready_relation_count
				|| left.card_id.localeCompare(right.card_id, "zh-CN"));
		const suggested = frontier.find((item) => item.ready_relation_count > 0);
		const coverage = Object.fromEntries(RETRIEVAL_ROLE_ORDER.slice(0, -1).map((role) => [role, nodes.some((node) => node.retrieval_roles.includes(role))]));
		const facetCoverage = Object.fromEntries(queryFacets.map((facet) => [facet, nodes.some((node) => node.matched_tokens.includes(facet))]));
		const gaps = [
			...Object.entries(coverage).filter(([, present]) => !present).map(([role]) => `当前候选尚未覆盖 ${role}`),
			...Object.entries(facetCoverage).filter(([, present]) => !present).map(([facet]) => `当前候选尚未覆盖查询侧面：${facet}`)
		];
		const observed = this._observe("context-retrieval", nodes, {
			truncated: ranked.some((item) => !selectedIds.has(item.card_id)),
			reason: ranked.length > nodes.length ? "context_budget" : undefined,
			extra: {
				query: String(query ?? ""), retrieval_intent: retrievalIntent, candidate_total: ranked.length,
				direct_candidate_total: directPool.length, raw_tail_candidate_total: rawTailPool.length,
				graph_candidate_total: ranked.filter((item) => item.hop > 0).length,
				discovery_candidate_total: ranked.filter((item) => item.retrieval_source === "discovery").length,
				context_plan: {
					selected: nodes.map((node) => ({
						card_id: node.id, role: node.retrieval_role, roles: node.retrieval_roles,
						reasons: node.reasons, read_slots: node.read_slots, source_trace_required: node.source_trace_required,
						hop: node.hop, path: node.path ?? [node.id], retrieval_source: node.retrieval_source,
						...(node.discovery ? {
							candidate_status: "unverified_association",
							required_next_step: "先精读并比较候选卡；不得把候选关联作为关系或证据使用。"
						} : {})
					})),
					excluded: selection.excluded.slice(0, 8), coverage, query_facets: queryFacets,
					query_facet_coverage: facetCoverage, gaps
				},
				structural_frontier: frontier.slice(0, 4),
				discovery_frontier: nodes.filter((node) => node.retrieval_source === "discovery").map((node) => ({
					seed_id: node.discovery.seed_id, candidate_id: node.id,
					required_next_step: "精读并比较种子卡与候选卡；不要沿候选关联作图遍历。"
				})),
				...(suggested ? { suggested_operator: "graph_walk", suggested_args: {
					card_id: suggested.card_id, plane: suggested.recommended_plane, direction: "both", hops: 2
				} } : nodes.length ? { graph_gap: { reason_code: "selected_seeds_have_no_ready_relations", card_ids: nodes.filter((node) => node.hop === 0).map((node) => node.id) } } : {})
			}
		});
		this._remember(nodes);
		return observed;
	}

	/** 领域成员列表（channel: membership；不是 BFS）。 */
	members(domainId, { types, limit = 12, query } = {}) {
		const domain = this.cards.get(domainId);
		if (!domain) {
			return this._observe("membership", [], { extra: { domain_id: domainId, error: `卡片不存在：${domainId}` } });
		}
		if (domain.meta.type !== "domain") {
			return this._observe("membership", [], {
				extra: {
					domain_id: domainId,
					misuse: "graph_members 只接受 domain 卡；论证邻居请用 graph_walk",
					misuse_code: "member_lookup_requires_domain",
					suggested_operator: "graph_walk",
					suggested_args: { card_id: domainId, hops: 1 }
				}
			});
		}
		const typeSet = new Set(types ?? []);
		const tokens = retrievalQueryTokens(query ?? "");
		const scored = [];
		for (const cid of this.byDomain.get(domainId) ?? []) {
			if (cid === domainId) continue;
			const card = this.cards.get(cid);
			if (!card || card.meta.lifecycle === "archived") continue;
			if (typeSet.size && !typeSet.has(card.meta.type)) continue;
			const hay = `${cid} ${card.meta.title ?? ""} ${String(card.body ?? "").slice(0, 400)}`;
			const rel = tokens.size ? [...tokens].reduce((acc, tok) => acc + (hay.includes(tok) ? 3 : 0), 0) : 1;
			if (tokens.size && rel <= 0) continue;
			scored.push([rel, cid]);
		}
		scored.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? -1 : 1));
		const cap = Math.max(0, limit);
		const hits = scored.slice(0, cap).map(([, cid]) => this._cardRef(cid));
		const truncated = scored.length > cap;
		const observed = this._observe("membership", hits, {
			truncated,
			reason: truncated ? "member_limit" : undefined,
			extra: { domain_id: domainId, member_total: scored.length }
		});
		this._remember(hits);
		return observed;
	}

	/**
	 * 全库元数据审视：定位没有可见结构归属的卡，而不靠关键词碰运气。
	 * `fully_isolated` 与 without_relations 均指无卡间入出关系；领域归属不算关系。
	 */
	unconnected({ scope = "fully_isolated", cursor, limit = 12, excludeReviewed = true, cardIds } = {}) {
		const groups = { fully_isolated: [], without_relations: [], without_ready_relations: [], without_domain: [] };
		const requestedIds = new Set(asList(cardIds));
		for (const [cid, card] of this.cards) {
			if (requestedIds.size && !requestedIds.has(cid)) continue;
			if (["archived", "superseded"].includes(card.meta.lifecycle) || card.meta.type === "domain") continue;
			const domains = Array.isArray(card.meta.domains) ? card.meta.domains : [];
			const incident = [...(this.adjOut.get(cid) ?? []), ...(this.adjIn.get(cid) ?? [])];
			const relationCount = incident.length;
			const readyRelationCount = incident.filter((edge) => edgeReadiness(this.cards, edge).ready).length;
			if (relationCount === 0) groups.without_relations.push(cid);
			if (readyRelationCount === 0) groups.without_ready_relations.push(cid);
			if (domains.length === 0) groups.without_domain.push(cid);
			if (relationCount === 0) groups.fully_isolated.push(cid);
		}
		if (!(scope in groups)) {
			return this._observe("structure", [], { extra: { scope, error: `未知的孤立范围：${scope}` } });
		}
		const reviews = currentStructureReviews(this.root, this.cards, { issue_kind: scope });
		const prioritized = groups[scope].map((cid) => {
			const review = reviews.get(`${scope}\u0000${cid}`);
			// A linked disposition cannot hide a card when the same detector says it is disconnected again.
			return this._unconnectedPriority(cid, scope, review?.status === "linked" ? null : review);
		})
			.sort((a, b) => (b.priority - a.priority) || a.card_id.localeCompare(b.card_id, "zh-CN"));
		const reviewedExcluded = excludeReviewed ? prioritized.filter((item) => item.review).length : 0;
		const visible = prioritized.filter((item) => !excludeReviewed || !item.review);
		const candidates = requestedIds.size ? visible.filter((item) => requestedIds.has(item.card_id)) : visible;
		const resolvedStart = queueStart(candidates, cursor);
		const start = requestedIds.size ? 0 : resolvedStart < 0 ? candidates.length : resolvedStart;
		const cap = Math.min(Math.max(1, Math.trunc(Number(limit) || 12)), 24);
		const page = candidates.slice(start, start + cap);
		const nodes = page.map((item) => ({
			...this._cardRef(item.card_id),
			issue_id: `unconnected:${scope}:${item.card_id}`,
			priority: item.priority,
			priority_reasons: item.priority_reasons,
			incident_summary: item.incident_summary,
			...(item.review ? { review: item.review } : {})
		}));
		const nextCursor = start + page.length < candidates.length && page.length ? encodeQueueCursor(page.at(-1)) : null;
		const checkedCardIds = requestedIds.size ? [...requestedIds].filter((id) => this.cards.has(id)) : [];
		const unresolved = new Set(candidates.map((node) => node.card_id));
		const observed = this._observe("structure", nodes, {
			truncated: nextCursor !== null,
			reason: nextCursor !== null ? "candidate_page_limit" : undefined,
				extra: {
					scope,
					counts_scope: requestedIds.size ? "requested_cards" : "knowledge_body",
					candidate_total: candidates.length,
					raw_candidate_total: prioritized.length,
					reviewed_excluded_total: reviewedExcluded,
					cursor: cursor ?? null,
					page_offset: start,
					next_cursor: nextCursor ?? undefined,
					checked_card_ids: checkedCardIds,
					resolved_card_ids: checkedCardIds.filter((id) => !unresolved.has(id)),
					fully_isolated_total: groups.fully_isolated.length,
					without_relations_total: groups.without_relations.length,
					without_ready_relations_total: groups.without_ready_relations.length,
					without_domain_total: groups.without_domain.length
			}
		});
		this._remember(nodes);
		return observed;
	}

	/** Deterministic all-card endpoint recall for one Card; it never chooses a relation type. */
	integrationCandidates(cardId, { limit = 6, issueScope = "without_relations" } = {}) {
		const focus = this.cards.get(cardId);
		if (!focus) return this._observe("integration-candidates", [], { extra: { focus_card_id: cardId, error: `卡片不存在：${cardId}` } });
		if (focus.meta.type === "domain") return this._observe("integration-candidates", [], { extra: {
			focus_card_id: cardId, misuse: "领域卡是成员容器，不进入结构接入候选分析。", misuse_code: "integration_requires_non_domain_card"
		} });
		const candidates = [];
		const pool = this._integrationCandidatePool(cardId, { includeExplicit: true });
		for (const candidateId of pool.keys()) {
			const candidate = this.cards.get(candidateId);
			if (!candidate || candidateId === cardId || candidate.meta.type === "domain" || candidate.meta.lifecycle === "archived") continue;
			const signals = this._integrationSignals(cardId, candidateId);
			const meaningful = signals.signals.shared_sources.length
				|| signals.signals.explicit_mentions.length
				|| ["high", "medium"].includes(signals.signals.semantic_overlap);
			if (!meaningful || signals.score <= 0) continue;
			candidates.push({ candidate_id: candidateId, ...signals });
		}
		candidates.sort((a, b) => (b.score - a.score) || a.candidate_id.localeCompare(b.candidate_id, "zh-CN"));
		const cap = Math.min(12, Math.max(1, Math.trunc(Number(limit) || 6)));
		const page = candidates.slice(0, cap);
		const nodes = page.map((item) => ({
			...this._cardRef(item.candidate_id), score: item.score, signals: item.signals, why: item.why
		}));
		const observed = this._observe("integration-candidates", nodes, {
			truncated: candidates.length > cap,
			reason: candidates.length > cap ? "candidate_limit" : undefined,
			extra: {
				focus_card_id: cardId,
				focus_fingerprint: cardFingerprint(focus),
				issue_scope: issueScope,
				candidate_total: candidates.length
			}
		});
		this._remember([this._cardRef(cardId), ...nodes]);
		return observed;
	}

	/** Assemble the bounded context needed to adjudicate one relation; never decides or writes it. */
	relationCase(sourceId, targetId, { relationType } = {}) {
		const source = this.cards.get(sourceId);
		const target = this.cards.get(targetId);
		if (!source || !target) return this._observe("relation-case", [], { extra: {
			source_id: sourceId, target_id: targetId,
			error: !source ? `卡片不存在：${sourceId}` : `卡片不存在：${targetId}`
		} });
		if (source.meta.type === "domain" || target.meta.type === "domain") return this._observe("relation-case", [], { extra: {
			source_id: sourceId, target_id: targetId,
			misuse: "领域归属不是知识关系；请改用领域成员观察与归属操作。",
			misuse_code: "relation_case_requires_non_domain_cards"
		} });
		const directRelations = [];
		for (const relation of source.meta.relations ?? []) {
			if (relation.target !== targetId || (relationType && relation.type !== relationType)) continue;
			const readiness = relationReadiness(source, relation, target);
			directRelations.push({
				from: sourceId, to: targetId, type: relation.type, note: String(relation.note ?? ""),
				direction: "forward", plane: readiness.plane, readiness: readiness.level,
				ready: readiness.ready, warnings: readiness.reason_codes
			});
		}
		for (const relation of target.meta.relations ?? []) {
			if (relation.target !== sourceId || (relationType && relation.type !== relationType)) continue;
			const readiness = relationReadiness(target, relation, source);
			directRelations.push({
				from: targetId, to: sourceId, type: relation.type, note: String(relation.note ?? ""),
				direction: "reverse", plane: readiness.plane, readiness: readiness.level,
				ready: readiness.ready, warnings: readiness.reason_codes
			});
		}
		const sourceSources = new Set(asList(source.meta.sources));
		const sharedSources = asList(target.meta.sources).filter((item) => sourceSources.has(item));
		const sourceMentions = mentionsCard(source, targetId, target);
		const targetMentions = mentionsCard(target, sourceId, source);
		const overlap = overlapScore(this._semanticTokens(sourceId), this._semanticTokens(targetId));
		const sharedDomains = asList(source.meta.domains).filter((item) => asList(target.meta.domains).includes(item));
		const sourceDegree = (this.adjIn.get(sourceId) ?? []).length + (this.adjOut.get(sourceId) ?? []).length;
		const targetDegree = (this.adjIn.get(targetId) ?? []).length + (this.adjOut.get(targetId) ?? []).length;
		const pathView = this.path(sourceId, targetId, { maxHops: 3, maxPaths: 4, plane: "argument" });
		const validRelations = [];
		for (const type of RELATION_TYPES) {
			if (constructRelationAllowed(type, source.meta.type, target.meta.type)) validRelations.push({ type, direction: "forward" });
			if (constructRelationAllowed(type, target.meta.type, source.meta.type)) validRelations.push({ type, direction: "reverse" });
		}
		const highestTier = directRelations.some((item) => item.ready) || sourceMentions.length || targetMentions.length ? "E3"
			: sharedSources.length || overlap.score >= 0.16 ? "E2" : "E1";
		const nodes = [this._cardRef(sourceId), this._cardRef(targetId)];
		const observed = this._observe("relation-case", nodes, { extra: {
			source_id: sourceId, target_id: targetId, requested_relation_type: relationType,
			case_fingerprint: createHash("sha256").update(`${cardFingerprint(source)}\u0000${cardFingerprint(target)}`).digest("hex"),
			endpoints: {
				source: { ...this._cardRef(sourceId), fingerprint: cardFingerprint(source), semantic_slots: semanticSlotSummary(source) },
				target: { ...this._cardRef(targetId), fingerprint: cardFingerprint(target), semantic_slots: semanticSlotSummary(target) }
			},
			current_relations: directRelations,
			explicit_references: { source_to_target: sourceMentions, target_to_source: targetMentions },
			shared_sources: sharedSources,
			existing_paths: pathView.paths ?? [],
			neighborhood: {
				source: { inbound: (this.adjIn.get(sourceId) ?? []).length, outbound: (this.adjOut.get(sourceId) ?? []).length, degree: sourceDegree },
				target: { inbound: (this.adjIn.get(targetId) ?? []).length, outbound: (this.adjOut.get(targetId) ?? []).length, degree: targetDegree },
				mirror_present: directRelations.some((item) => item.direction === "forward") && directRelations.some((item) => item.direction === "reverse")
			},
			valid_relation_options: validRelations,
			removal_impact: directRelations.map((item) => ({
				from: item.from, to: item.to, type: item.type,
				would_isolate_source: sourceDegree - 1 <= 0,
				would_isolate_target: targetDegree - 1 <= 0
			})),
			flags: {
				conflict_involved: source.meta.type === "conflict" || target.meta.type === "conflict",
				cross_domain: sharedDomains.length === 0,
				hub_involved: sourceDegree >= 12 || targetDegree >= 12
			},
			candidate_signals: {
				highest_observed_tier: highestTier,
				E1_recall_only: { shared_domains: sharedDomains, semantic_overlap: overlap.score, shared_tokens: overlap.shared },
				E2_compare_only: { shared_sources: sharedSources, strong_semantic_slot_overlap: overlap.score >= 0.16 },
				E3_write_candidate: { explicit_references: sourceMentions.length + targetMentions.length, existing_ready_relation: directRelations.some((item) => item.ready) },
				E4_preflight: { reached: false, reason: "仍需结构化证据、反证、方向理由和适用边界。" }
			}
		} });
		this._remember(nodes);
		return observed;
	}

	/** Simulate and critically classify one relation adjudication without mutating Markdown. */
	simulateRelationPatch({
		decision, sourceId, targetId, oldRelationType, proposedSourceId, proposedTargetId,
		proposedRelationType, note, evidence = [], counterevidence = [], directionReason, scopeOrBoundary,
		issueFingerprint: relatedIssueFingerprint, criticalReview
	} = {}) {
		const source = this.cards.get(sourceId);
		const target = this.cards.get(targetId);
		if (!source || !target) return this._observe("relation-simulation", [], { extra: {
			decision, source_id: sourceId, target_id: targetId,
			error: !source ? `卡片不存在：${sourceId}` : `卡片不存在：${targetId}`
		} });
		const oldRelation = (source.meta.relations ?? []).find((item) => item.target === targetId
			&& (!oldRelationType || item.type === oldRelationType));
		const newSourceId = proposedSourceId || sourceId;
		const newTargetId = proposedTargetId || targetId;
		const newSource = this.cards.get(newSourceId);
		const newTarget = this.cards.get(newTargetId);
		const proposedRelation = ["keep", "change"].includes(decision) ? {
			from: decision === "keep" ? sourceId : newSourceId,
			to: decision === "keep" ? targetId : newTargetId,
			type: decision === "keep" ? (oldRelationType || oldRelation?.type) : proposedRelationType,
			note: String(note ?? (decision === "keep" ? oldRelation?.note ?? "" : ""))
		} : null;
		const excludedSignature = oldRelation
			? `${sourceId}\u0000${oldRelation.type}\u0000${targetId}` : null;
		const duplicate = proposedRelation ? (this.cards.get(proposedRelation.from)?.meta.relations ?? []).some((item) =>
			item.target === proposedRelation.to && item.type === proposedRelation.type
			&& `${proposedRelation.from}\u0000${item.type}\u0000${item.target}` !== excludedSignature) : false;
		const mirror = proposedRelation ? (this.cards.get(proposedRelation.to)?.meta.relations ?? []).some((item) =>
			item.target === proposedRelation.from && item.type === proposedRelation.type) : false;
		const proposedReadiness = proposedRelation && newSource && newTarget
			? relationReadiness(newSource, { target: proposedRelation.to, type: proposedRelation.type, note: proposedRelation.note }, newTarget)
			: null;
		const conflictRoleViolation = Boolean(proposedRelation && newSource && newTarget && (
			(newSource.meta.type === "conflict" && proposedRelation.type !== "involves")
			|| newTarget.meta.type === "conflict"
		));
		const alternatePath = this._hasReadyPath(sourceId, targetId, 3, excludedSignature ? new Set([excludedSignature]) : new Set());
		const sourceDegree = (this.adjIn.get(sourceId) ?? []).length + (this.adjOut.get(sourceId) ?? []).length;
		const targetDegree = (this.adjIn.get(targetId) ?? []).length + (this.adjOut.get(targetId) ?? []).length;
		const sharedDomains = asList(source.meta.domains).filter((item) => asList(target.meta.domains).includes(item));
		const contractErrors = [];
		if (!["keep", "change", "remove", "defer"].includes(decision)) contractErrors.push("decision_not_supported");
		if (["keep", "remove"].includes(decision) && !oldRelation) contractErrors.push("old_relation_not_found");
		if (["keep", "change", "remove"].includes(decision) && !asList(evidence).length) contractErrors.push("evidence_required");
		if (["keep", "change"].includes(decision) && !String(directionReason ?? "").trim()) contractErrors.push("direction_reason_required");
		if (!String(scopeOrBoundary ?? "").trim()) contractErrors.push("scope_or_boundary_required");
		if (decision === "change" && (!proposedRelationType || !newSource || !newTarget)) contractErrors.push("proposed_relation_incomplete");
		if (decision === "defer" && !asList(counterevidence).length && !String(scopeOrBoundary ?? "").trim()) contractErrors.push("defer_reason_required");
		const deterministicBlockers = [];
		if (proposedRelation && proposedRelation.from === proposedRelation.to) deterministicBlockers.push("self_relation");
		if (duplicate) deterministicBlockers.push("duplicate_relation");
		if (conflictRoleViolation) deterministicBlockers.push("conflict_role_violation");
		if (proposedReadiness?.level === "invalid") deterministicBlockers.push(...proposedReadiness.reason_codes);
		if (proposedReadiness && !proposedReadiness.ready && proposedReadiness.level !== "invalid") deterministicBlockers.push(...proposedReadiness.reason_codes);
		const criticalReasons = [];
		// This flag asks for review; it is not a semantic classifier or proof of correctness.
		if (proposedRelation?.type === "supports" && /平行现象|方向.{0,6}(?:争议|不明)|共同.{0,12}(?:结果|支撑)|parallel|co[- ]?cause/iu.test(asList(counterevidence).join(" "))) criticalReasons.push("support_semantics_disputed");
		if (source.meta.type === "conflict" || target.meta.type === "conflict") criticalReasons.push("conflict_role");
		if (sourceDegree >= 12 || targetDegree >= 12) criticalReasons.push("hub_relation");
		if (sharedDomains.length === 0) criticalReasons.push("cross_domain_relation");
		if (decision === "remove" && !alternatePath) criticalReasons.push("path_cut_or_bridge_removal");
		const riskLevel = criticalReasons.length ? "high"
			: mirror || alternatePath || deterministicBlockers.length ? "medium" : "low";
		const criticalReviewCompleted = riskLevel !== "high" || String(criticalReview ?? "").trim().length >= 12;
		const e4Reached = Boolean(proposedReadiness?.ready && asList(evidence).length
			&& asList(counterevidence).length && String(directionReason ?? "").trim() && String(scopeOrBoundary ?? "").trim());
		const nodes = [this._cardRef(sourceId), this._cardRef(targetId)];
		const observed = this._observe("relation-simulation", nodes, { extra: {
			case_fingerprint: createHash("sha256").update(`${cardFingerprint(source)}\u0000${cardFingerprint(target)}`).digest("hex"),
			adjudication: {
				decision,
				issue_fingerprint: String(relatedIssueFingerprint ?? ""),
				old_relation: oldRelation ? { from: sourceId, to: targetId, type: oldRelation.type, note: String(oldRelation.note ?? "") } : null,
				proposed_relation: proposedRelation,
				evidence: asList(evidence), counterevidence: asList(counterevidence),
				direction_reason: String(directionReason ?? ""), scope_or_boundary: String(scopeOrBoundary ?? ""),
				risk_level: riskLevel,
				critical_review: String(criticalReview ?? "")
			},
			checks: {
				self_relation: Boolean(proposedRelation && proposedRelation.from === proposedRelation.to),
				duplicate_relation: duplicate,
				mirror_relation: mirror,
				equivalent_ready_path: alternatePath,
				conflict_role_violation: conflictRoleViolation,
				removal_would_isolate_source: decision === "remove" && sourceDegree - 1 <= 0,
				removal_would_isolate_target: decision === "remove" && targetDegree - 1 <= 0,
				hub_involved: sourceDegree >= 12 || targetDegree >= 12,
				cross_domain: sharedDomains.length === 0,
				proposed_readiness: proposedReadiness?.level ?? null
			},
			contract_valid: contractErrors.length === 0,
			contract_errors: contractErrors,
			deterministic_blockers: [...new Set(deterministicBlockers)],
			E4_preflight: { reached: e4Reached, reason: e4Reached ? "证据、反证、方向、边界与就绪关系均已具备。" : "尚未同时具备证据、反证、方向、边界与就绪关系。" },
			requires_critical_review: riskLevel === "high",
			critical_review_completed: criticalReviewCompleted,
			critical_review_reasons: criticalReasons,
			preflight_passed: decision === "defer"
				? contractErrors.length === 0
				: contractErrors.length === 0 && deterministicBlockers.length === 0
					&& criticalReviewCompleted && (decision === "remove" || e4Reached)
		} });
		this._remember(nodes);
		return observed;
	}

	/** 沿论证、情境或对象引用平面做受控 BFS（含入边），最多 3 跳且总返回量不超过 24。 */
	walk(cardId, { direction = "both", hops = 1, limit, plane = "argument", relationTypes, focusQuery = "" } = {}) {
		const start = this.cards.get(cardId);
		if (!start) {
			return this._observe(plane, [], { extra: { start: cardId, plane, error: `卡片不存在：${cardId}` } });
		}
		if (start.meta.type === "domain") {
			return this._observe(plane, [], {
				extra: {
					start: cardId, plane,
					misuse: "领域卡不能当论证跳的起点；列出成员请用 graph_members",
					misuse_code: "domain_start_requires_members",
					suggested_operator: "graph_members",
					suggested_args: { domain_id: cardId }
				}
			});
		}
		if (!new Set(["argument", "context", "reference"]).has(plane)) {
			return this._observe("argument", [], { extra: {
				start: cardId, plane, error: `未知关系平面：${plane}`,
				misuse_code: "unknown_relation_plane"
			} });
		}
		const requestedHops = Number.isFinite(Number(hops)) ? Math.trunc(Number(hops)) : 1;
		const maxHops = Math.min(3, Math.max(1, requestedHops));
		const defaultLimits = { 1: 12, 2: 18, 3: 24 };
		const totalLimit = Math.min(24, Math.max(1, Number.isFinite(Number(limit))
			? Math.trunc(Number(limit))
			: defaultLimits[maxHops]));
		const relationTypeSet = new Set(relationTypes ?? []);
		const includeAppliesTo = relationTypeSet.has("applies-to");
		const seen = new Set([cardId]);
		const hits = [];
		const layers = [];
		const deferred = [];
		const focus = String(focusQuery).slice(0, 600);
		const focusTokens = retrievalQueryTokens(focus);
		const relevance = new Map();
		let frontier = [{ id: cardId, path: [cardId], pathEdges: [] }];
		let truncated = false;

		for (let depth = 1; depth <= maxHops && frontier.length && hits.length < totalLimit; depth++) {
			const candidates = new Map();
			for (const parent of [...frontier].sort((a, b) => a.id.localeCompare(b.id, "zh-CN"))) {
				const pending = [];
				if (direction !== "in") {
					for (const edge of this.adjOut.get(parent.id) ?? []) pending.push([edge.to, edge, "out"]);
				}
				if (direction !== "out") {
					for (const edge of this.adjIn.get(parent.id) ?? []) pending.push([edge.from, edge, "in"]);
				}
				pending.sort((a, b) => `${a[0]}|${a[1].from}|${a[1].to}|${a[2]}`.localeCompare(`${b[0]}|${b[1].from}|${b[1].to}|${b[2]}`, "zh-CN"));
				for (const [other, edge, dir] of pending) {
					if (!this.cards.has(other) || seen.has(other)) continue;
					const target = this.cards.get(other);
					if (target.meta.lifecycle === "archived") continue;
					const traversable = plane === "context"
						? isContextEdge(this.cards, edge)
						: plane === "reference"
							? isReferenceEdge(this.cards, edge)
							: isArgumentEdge(this.cards, edge, { includeAppliesTo });
					if (!traversable) continue;
					const effective = walkRelationType(this.cards, edge.from, edge);
					if (relationTypeSet.size && !relationTypeSet.has(effective)) continue;
					const readiness = edgeReadiness(this.cards, edge);
					if (readiness.level === "invalid") continue;
					if (depth > 1 && !readiness.ready) continue;
					const edgeRef = {
						from: edge.from,
						to: edge.to,
						type: effective,
						declared_type: edge.relation_type,
						note: String(edge.note ?? ""),
						plane: readiness.plane,
						readiness: readiness.level,
						ready: readiness.ready,
						warnings: readiness.reason_codes
					};
					const ref = this._cardRef(other);
					ref.hop = depth;
					ref.via = dir === "in"
						? `relation:${effective}←${edge.from}`
						: `relation:${effective}→${edge.to}`;
					ref.direction = dir;
					ref.relation_readiness = readiness.level;
					ref.edge = edgeRef;
					ref.path = [...parent.path, other];
					ref.path_edges = [...parent.pathEdges, edgeRef];
					if (focus) {
						if (!relevance.has(other)) relevance.set(other, overlapScore(focusTokens, queryTokens(`${target.meta.title ?? other} ${String(target.body ?? "").slice(0, 4000)}`)).score);
						ref.discovery_score = relevance.get(other);
						ref.new_to_context = !this.seenIds.has(other);
					}
					const existingCandidate = candidates.get(other);
					if (!existingCandidate || (!existingCandidate.ref.edge?.ready && ref.edge?.ready)) {
						candidates.set(other, { ref, parent: parent.id });
					}
				}
			}

			const ordered = [...candidates.values()].sort((a, b) =>
				Number(b.ref.edge?.ready) - Number(a.ref.edge?.ready)
				|| Number(b.ref.discovery_score ?? 0) - Number(a.ref.discovery_score ?? 0)
				|| Number(b.ref.new_to_context ?? false) - Number(a.ref.new_to_context ?? false)
				|| a.ref.id.localeCompare(b.ref.id, "zh-CN"));
			const remaining = totalLimit - hits.length;
			const remainingLayers = maxHops - depth + 1;
			const layerLimit = Math.ceil(remaining / remainingLayers);
			const selected = ordered.slice(0, layerLimit);
			// One residual slot can discover a different branch instead of amplifying one dense parent.
			if (focus && selected.length >= 3) {
				const parents = new Set(selected.slice(0, -1).map((item) => item.parent));
				const alternate = ordered.slice(selected.length).find((item) => item.ref.edge?.ready && item.ref.new_to_context && !parents.has(item.parent));
				if (alternate) selected[selected.length - 1] = alternate;
			}
			const selectedIds = new Set(selected.map((item) => item.ref.id));
			for (const item of ordered.filter((item) => item.ref.edge?.ready && !selectedIds.has(item.ref.id)).slice(0, 4)) {
				deferred.push({ card_id: item.ref.id, parent_id: item.parent, depth, path: item.ref.path,
					discovery_score: item.ref.discovery_score ?? 0, reason: "layer_budget", read_required: true });
			}
			const layerTruncated = ordered.length > selected.length;
			truncated ||= layerTruncated;
			if (!selected.length) break;

			for (const item of selected) seen.add(item.ref.id);
			const layerNodes = selected.map((item) => item.ref);
			hits.push(...layerNodes);
			layers.push({
				depth,
				source_ids: [...new Set(selected.map((item) => item.parent))],
				node_ids: layerNodes.map((node) => node.id),
				edges: layerNodes.map((node) => node.edge),
				returned: layerNodes.length,
				ready_count: layerNodes.filter((node) => node.edge?.ready).length,
				legacy_count: layerNodes.filter((node) => !node.edge?.ready).length,
				candidate_total: ordered.length,
				truncated: layerTruncated
			});
			frontier = selected.filter((item) => item.ref.edge?.ready).map((item) => ({
				id: item.ref.id,
				path: item.ref.path,
				pathEdges: item.ref.path_edges
			}));
		}

		const extra = {
			start: cardId,
			plane,
			direction,
			hops: maxHops,
			requested_hops: requestedHops,
			reached_hops: layers.at(-1)?.depth ?? 0,
			total_limit: totalLimit,
			focus_query: focus,
			deferred_frontier: deferred.filter((item) => !seen.has(item.card_id)).slice(0, 8),
			continuation_note: "层预算省略的 ready 分支可定向补读；到达边界且仍缺信息时，先精读桥接卡，再从该卡继续有限多跳。候选不是证据。",
			layers,
			...(relationTypeSet.size ? { relation_types: [...relationTypeSet] } : {})
		};
		if (requestedHops !== maxHops) extra.note = `hops 已限制为 ${maxHops}（允许 1–3）`;
		const observed = this._observe(plane, hits, {
			truncated,
			reason: truncated ? "hop_budget" : undefined,
			extra
		});
		this._remember(hits);
		this.seenIds.add(cardId);
		return observed;
	}

	/**
	 * 从一个核心判断沿 ready supports 入边回溯其支持脊柱，并在每一层寻找
	 * ready conflicts-with 或覆盖该节点的 conflict 档案。它只返回真实边；
	 * 找不到张力时以明确 stop_reason 收束，不以词面相反伪造冲突。
	 */
	traceSupportToTension(cardId, { maxDepth = 5, branchWidth = 3, limit = 18, maxTensions = 3 } = {}) {
		const start = this.cards.get(cardId);
		if (!start) return this._observe("insight-tension", [], { extra: {
			start: cardId, error: `卡片不存在：${cardId}`
		} });
		if (start.meta.type === "domain") return this._observe("insight-tension", [], { extra: {
			start: cardId, misuse: "领域卡没有可回溯的支持脊柱；请先选择一个具体主张、模型或方法。",
			misuse_code: "support_trace_requires_non_domain_card"
		} });

		const depthLimit = boundedNumber(maxDepth, 5, 1, 6);
		const width = boundedNumber(branchWidth, 3, 1, 4);
		const nodeLimit = boundedNumber(limit, 18, 4, 24);
		const tensionLimit = boundedNumber(maxTensions, 3, 1, 4);
		const seen = new Set([cardId]);
		const paths = new Map([[cardId, { node_ids: [cardId], edges: [] }]]);
		const supportLayers = [];
		const supportRefs = [];
		let frontier = [cardId];
		let truncated = false;
		let reachedDepth = 0;

		const edgeRef = (edge) => {
			const readiness = edgeReadiness(this.cards, edge);
			return {
				from: edge.from, to: edge.to,
				type: walkRelationType(this.cards, edge.from, edge),
				declared_type: edge.relation_type,
				note: String(edge.note ?? ""), plane: readiness.plane,
				readiness: readiness.level, ready: readiness.ready,
				warnings: readiness.reason_codes
			};
		};

		const tensionsAt = (anchorIds, depth) => {
			const cases = [];
			const signatures = new Set();
			const push = (value) => {
				const signature = `${value.anchor_id}\u0000${value.opponent_id}\u0000${value.conflict_card_id ?? ""}`;
				if (signatures.has(signature) || cases.length >= tensionLimit) return;
				signatures.add(signature);
				cases.push(value);
			};
			for (const anchorId of [...anchorIds].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
				const pending = [
					...(this.adjOut.get(anchorId) ?? []).map((edge) => ({ other: edge.to, edge })),
					...(this.adjIn.get(anchorId) ?? []).map((edge) => ({ other: edge.from, edge }))
				].filter(({ other, edge }) => other !== anchorId && this.cards.has(other)
					&& walkRelationType(this.cards, edge.from, edge) === "conflicts-with");
				pending.sort((a, b) => a.other.localeCompare(b.other, "zh-CN"));
				for (const { other, edge } of pending) {
					const ref = edgeRef(edge);
					if (!ref.ready) continue;
					push({
						anchor_id: anchorId, opponent_id: other, conflict_card_id: null,
						depth, node_ids: [other], edges: [ref],
						support_path: paths.get(anchorId) ?? { node_ids: [cardId, anchorId], edges: [] }
					});
				}
				for (const conflictId of [...(this.conflictsInvolving.get(anchorId) ?? [])].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
					const conflict = this.cards.get(conflictId);
					if (!conflict) continue;
					const involving = (conflict.meta.relations ?? []).filter((relation) => relation?.type === "involves" && this.cards.has(relation.target));
					const anchorRelation = involving.find((relation) => relation.target === anchorId);
					const anchorEdge = anchorRelation ? edgeRef({
						from: conflictId, to: anchorId, kind: "relation", relation_type: "involves", note: anchorRelation.note ?? ""
					}) : null;
					if (!anchorEdge?.ready) continue;
					for (const relation of involving) {
						if (relation.target === anchorId) continue;
						const conflictEdge = { from: conflictId, to: relation.target, kind: "relation", relation_type: "involves", note: relation.note ?? "" };
						const ref = edgeRef(conflictEdge);
						if (!ref.ready) continue;
						push({
							anchor_id: anchorId, opponent_id: relation.target, conflict_card_id: conflictId,
							depth, node_ids: [conflictId, relation.target], edges: [anchorEdge, ref],
							support_path: paths.get(anchorId) ?? { node_ids: [cardId, anchorId], edges: [] }
						});
					}
				}
				if (cases.length >= tensionLimit) break;
			}
			return cases;
		};

		let tensionCases = tensionsAt([cardId], 0);
		for (let depth = 1; !tensionCases.length && depth <= depthLimit && frontier.length && supportRefs.length < nodeLimit; depth++) {
			const selected = [];
			let layerTruncated = false;
			for (const parentId of [...frontier].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
				const candidates = (this.adjIn.get(parentId) ?? []).filter((edge) =>
					edge.to === parentId && edge.relation_type === "supports" && this.cards.has(edge.from)
					&& !seen.has(edge.from) && this.cards.get(edge.from)?.meta.lifecycle !== "archived"
				).map((edge) => ({ id: edge.from, edge, ref: edgeRef(edge), parent: parentId }))
					.filter((item) => item.ref.ready)
					.sort((a, b) => a.id.localeCompare(b.id, "zh-CN"));
				if (candidates.length > width) { truncated = true; layerTruncated = true; }
				for (const candidate of candidates.slice(0, width)) {
					if (selected.length + supportRefs.length >= nodeLimit) { truncated = true; layerTruncated = true; break; }
					if (selected.some((item) => item.id === candidate.id)) continue;
					selected.push(candidate);
				}
			}
			if (!selected.length) { frontier = []; break; }
			for (const item of selected) {
				seen.add(item.id);
				const parentPath = paths.get(item.parent) ?? { node_ids: [cardId, item.parent], edges: [] };
				paths.set(item.id, { node_ids: [...parentPath.node_ids, item.id], edges: [...parentPath.edges, item.ref] });
				const ref = this._cardRef(item.id);
				ref.hop = depth;
				ref.edge = item.ref;
				ref.path = paths.get(item.id).node_ids;
				ref.path_edges = paths.get(item.id).edges;
				supportRefs.push(ref);
			}
			reachedDepth = depth;
			supportLayers.push({
				depth,
				source_ids: [...new Set(selected.map((item) => item.parent))],
				node_ids: selected.map((item) => item.id),
				edges: selected.map((item) => item.ref),
				returned: selected.length,
				truncated: layerTruncated
			});
			frontier = selected.map((item) => item.id);
			tensionCases = tensionsAt(frontier, depth);
		}

		const tensionNodeIds = [...new Set(tensionCases.flatMap((item) => item.node_ids))];
		const allRefs = [...supportRefs, ...tensionNodeIds.filter((id) => !seen.has(id)).map((id) => this._cardRef(id))];
		const stopReason = tensionCases.length ? "tension_found"
			: !frontier.length || !supportLayers.length ? "support_exhausted"
				: reachedDepth >= depthLimit ? "depth_limit" : "node_budget";
		const observed = this._observe("insight-tension", allRefs, {
			truncated,
			reason: truncated ? "insight_budget" : undefined,
			extra: {
				start: cardId, requested_depth: depthLimit, reached_depth: reachedDepth,
				branch_width: width, node_limit: nodeLimit, support_layers: supportLayers,
				tension: {
					found: tensionCases.length > 0,
					depth: tensionCases[0]?.depth ?? null,
					anchor_ids: [...new Set(tensionCases.map((item) => item.anchor_id))],
					opponent_ids: [...new Set(tensionCases.map((item) => item.opponent_id))],
					conflict_card_ids: [...new Set(tensionCases.map((item) => item.conflict_card_id).filter(Boolean))],
					node_ids: tensionNodeIds,
					edges: tensionCases.flatMap((item) => item.edges),
					cases: tensionCases
				},
				stop_reason: stopReason,
				write_evidence_eligible: false
			}
		});
		this._remember(allRefs);
		this.seenIds.add(cardId);
		return observed;
	}

	/**
	 * 对模型显式提出的关键假设做一次反转探针。语义反转由模型负责；工具只核对
	 * 原假设能否在焦点卡中定位，并用反转后的查询召回真实候选与既有路径。
	 */
	probeAssumptionInversion(cardId, { assumption, invertedAssumption, limit = 6 } = {}) {
		const start = this.cards.get(cardId);
		if (!start) return this._observe("assumption-inversion", [], { extra: {
			start: cardId, error: `卡片不存在：${cardId}`
		} });
		const original = String(assumption ?? "").replace(/\s+/gu, " ").trim();
		const inverted = String(invertedAssumption ?? "").replace(/\s+/gu, " ").trim();
		if (original.length < 4 || inverted.length < 4 || original === inverted) {
			return this._observe("assumption-inversion", [], { extra: {
				start: cardId,
				misuse: "必须分别给出可辨认且不相同的原假设与反转假设。",
				misuse_code: "assumption_inversion_requires_distinct_statements"
			} });
		}
		const cap = boundedNumber(limit, 6, 4, 16);
		const assumptionTokens = queryTokens(original);
		const sourceSections = semanticSlotSummary(start);
		const sourceExcerpt = sourceSections.find((section) =>
			[...assumptionTokens].some((token) => `${section.heading} ${section.excerpt}`.includes(token))
		) ?? null;
		const plan = this.retrieveContext(inverted, {
			limit: Math.max(4, cap), graphHops: 1,
			intent: { focus: [inverted], contrasts: [original] }
		});
		const candidates = (plan.nodes ?? []).filter((node) => node.id !== cardId && node.type !== "domain").slice(0, cap)
			.map((node) => ({
				...node,
				hypothesis_status: "unverified_inversion_candidate",
				write_evidence_eligible: false
			}));
		const relatedEdges = candidates.flatMap((node) => node.path_edges ?? []).filter((edge) => edge?.ready !== false);
		const observed = this._observe("assumption-inversion", candidates, { extra: {
			start: cardId,
			assumption: original,
			inverted_assumption: inverted,
			...(sourceExcerpt ? { source_excerpt: sourceExcerpt } : {}),
			assumption_located: Boolean(sourceExcerpt),
			candidate_ids: candidates.map((node) => node.id),
			related_edges: relatedEdges,
			stop_reason: candidates.length ? "candidates_found" : "no_candidates",
			hypothesis_status: "unverified_probe",
			write_evidence_eligible: false
		} });
		this._remember(candidates);
		this.seenIds.add(cardId);
		return observed;
	}

	/**
	 * 核对模型已识别出的实体名称是否值得成为稳定枢纽。候选名称由材料读取
	 * 或对话语义给出；这里不做全库正则 NER，避免把普通名词批量变成百科卡。
	 */
	entityCandidates(candidates, { limit = 12 } = {}) {
		const requested = (Array.isArray(candidates) ? candidates : []).slice(0, 12);
		const results = [];
		for (const raw of requested) {
			const name = String(raw?.name ?? "").trim();
			if (!name) continue;
			const aliases = [...new Set([name, ...asList(raw?.aliases)].map((value) => value.trim()).filter(Boolean))];
			const existing_entities = [];
			const mentioned_cards = [];
			const sources = new Set();
			const domains = new Map();
			for (const [cardId, card] of this.cards) {
				const metaAliases = asList(card.meta.aliases);
				const identityText = [cardId, card.meta.title, ...metaAliases].map((value) => String(value ?? "").toLowerCase());
				if (card.meta.type === "entity" && aliases.some((alias) => identityText.some((value) => value === alias.toLowerCase()))) {
					existing_entities.push(cardId);
				}
				const haystack = `${cardId}\n${card.meta.title ?? ""}\n${String(card.body ?? "")}`.toLowerCase();
				if (!aliases.some((alias) => containsEntityAlias(haystack, alias))) continue;
				mentioned_cards.push(cardId);
				for (const source of asList(card.meta.sources)) sources.add(source);
				for (const domain of asList(card.meta.domains)) domains.set(domain, (domains.get(domain) ?? 0) + 1);
			}
			const mentionCount = mentioned_cards.length;
			const status = existing_entities.length ? "existing"
				: mentionCount >= 5 || sources.size >= 3 ? "strong_candidate"
					: mentionCount >= 3 ? "candidate" : "weak";
			results.push({
				name,
				aliases: aliases.slice(1),
				entity_kind: String(raw?.entity_kind ?? raw?.kind ?? ""),
				status,
				existing_entity_ids: existing_entities,
				mention_card_count: mentionCount,
				source_count: sources.size,
				representative_card_ids: mentioned_cards.slice(0, 8),
				top_domains: [...domains].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")).slice(0, 5)
					.map(([id, count]) => ({ id, count }))
			});
		}
		return this._observe("entity-candidates", [], {
			extra: {
				candidates: results.slice(0, Math.max(0, Math.min(12, Number(limit) || 12))),
				candidate_total: results.length,
				decision_rule: "多卡重复出现、多来源支持或能承接多条对象引用时才考虑实体卡；单次出现默认留在原卡正文。"
			}
		});
	}

	/** conflict：involves 两造；或 conflicts-with 对端 + covering conflict 卡。 */
	conflicts(cardId) {
		const card = this.cards.get(cardId);
		if (!card) {
			return this._observe("argument", [], { extra: { start: cardId, error: `卡片不存在：${cardId}` } });
		}
		const parties = [];
		const covering = [];
		const partyEdges = [];
		if (card.meta.type === "conflict") {
			for (const rel of card.meta.relations ?? []) {
				if (rel?.type !== "involves" || !this.cards.has(rel.target)) continue;
				parties.push(rel.target);
				const readiness = relationReadiness(card, rel, this.cards.get(rel.target));
				partyEdges.push({
					from: cardId, to: rel.target, type: "involves", note: String(rel.note ?? ""),
					plane: readiness.plane, readiness: readiness.level, ready: readiness.ready,
					warnings: readiness.reason_codes
				});
			}
			covering.push(cardId);
		} else {
			for (const rel of card.meta.relations ?? []) {
				if (rel?.type !== "conflicts-with" || !this.cards.has(rel.target)) continue;
				parties.push(rel.target);
				const readiness = relationReadiness(card, rel, this.cards.get(rel.target));
				partyEdges.push({
					from: cardId, to: rel.target, type: "conflicts-with", note: String(rel.note ?? ""),
					plane: readiness.plane, readiness: readiness.level, ready: readiness.ready,
					warnings: readiness.reason_codes
				});
			}
			for (const edge of this.adjIn.get(cardId) ?? []) {
				if (edge.relation_type !== "conflicts-with" || !this.cards.has(edge.from)) continue;
				parties.push(edge.from);
				const readiness = edgeReadiness(this.cards, edge);
				partyEdges.push({
					from: edge.from, to: cardId, type: "conflicts-with", note: String(edge.note ?? ""),
					plane: readiness.plane, readiness: readiness.level, ready: readiness.ready,
					warnings: readiness.reason_codes
				});
			}
			for (const pid of parties) {
				for (const confId of this.conflictsInvolving.get(pid) ?? []) {
					const conf = this.cards.get(confId);
					if (!conf) continue;
					const involved = new Set();
					for (const rel of conf.meta.relations ?? []) {
						if (rel?.type === "involves") involved.add(rel.target);
					}
					if (involved.has(cardId) && involved.has(pid) && !covering.includes(confId)) covering.push(confId);
				}
			}
		}
		const unique = [];
		const seen = new Set();
		for (const cid of [...parties, ...covering]) {
			if (!this.cards.has(cid) || seen.has(cid)) continue;
			seen.add(cid);
			unique.push(this._cardRef(cid));
		}
		const uniqueParties = [...new Set(parties)];
		const extra = {
			start: cardId, parties: uniqueParties, party_edges: partyEdges,
			covering_conflicts: covering,
			legacy_relation_count: partyEdges.filter((edge) => !edge.ready).length
		};
		if (uniqueParties.length && covering.length === 0) {
			extra.debt = { kind: "uncovered_conflict", reason: "有 conflicts-with 但对端尚未被 conflict 卡 involves 覆盖" };
		}
		const observed = this._observe("argument", unique, { extra });
		this._remember(unique);
		return observed;
	}

	/** 受限对照：比较显式字段、关系与用户指定的正文语义维度，不替模型生成结论。 */
	compare(cardIds, { dimensions = [] } = {}) {
		const ids = [...new Set(asList(cardIds))].slice(0, 4);
		if (ids.length < 2) {
			return this._observe("comparison", [], { extra: { error: "compare_cards 至少需要两张卡" } });
		}
		const missing = ids.filter((id) => !this.cards.has(id));
		if (missing.length) {
			return this._observe("comparison", [], { extra: { error: `卡片不存在：${missing.join("、")}`, requested: ids } });
		}
		const nodes = ids.map((id) => this._cardRef(id));
		const sharedDomains = [...new Set(nodes.flatMap((node) => node.domains))]
			.filter((domain) => nodes.every((node) => node.domains.includes(domain)));
		const relationEdges = [];
		for (const id of ids) {
			for (const edge of this.adjOut.get(id) ?? []) {
				if (!ids.includes(edge.to)) continue;
				const readiness = edgeReadiness(this.cards, edge);
				relationEdges.push({
					from: edge.from,
					to: edge.to,
					type: walkRelationType(this.cards, edge.from, edge),
					declared_type: edge.relation_type,
					note: String(edge.note ?? ""),
					plane: readiness.plane,
					readiness: readiness.level,
					ready: readiness.ready,
					warnings: readiness.reason_codes
				});
			}
		}
		const requestedDimensions = [...new Set(asList(dimensions))].filter((dimension) => COMPARISON_DIMENSIONS[dimension]);
		const semanticMatrix = {};
		const missingDimensions = {};
		for (const id of ids) {
			const sections = splitSections(this.cards.get(id)?.body ?? "");
			semanticMatrix[id] = {};
			missingDimensions[id] = [];
			for (const dimension of requestedDimensions) {
				const aliases = COMPARISON_DIMENSIONS[dimension];
				const headingMatches = sections.filter((section) => aliases.some((alias) => section.heading.includes(alias)));
				const bodyMatches = sections.flatMap((section) => section.content.split(/\r?\n|(?<=[。！？])/u)
					.filter((line) => aliases.some((alias) => line.includes(alias)))
					.map((line) => ({ heading: section.heading, content: line })));
				const matched = headingMatches.length ? headingMatches : bodyMatches;
				if (!matched.length) {
					semanticMatrix[id][dimension] = [];
					missingDimensions[id].push(dimension);
					continue;
				}
				semanticMatrix[id][dimension] = matched.slice(0, 3).map((section) => ({
					heading: section.heading || "正文",
					match_basis: headingMatches.length ? "section_heading" : "body_candidate_requires_review",
					excerpt: section.content.replace(/<!--\s*unit:[^>]+-->/g, "").replace(/\s+/g, " ").trim().slice(0, 520)
				}));
			}
		}
		const observed = this._observe("comparison", nodes, {
			extra: {
				compared: ids,
				shared_domains: sharedDomains,
				direct_relations: relationEdges,
				requested_dimensions: requestedDimensions,
				semantic_matrix: semanticMatrix,
				missing_dimensions: missingDimensions,
				comparison_note: "矩阵是原文片段定位，不是完成的语义比较。正文关键词补召回须人工确认；空格应定向补读或明确不可比较。",
				differences: Object.fromEntries(nodes.map((node) => [node.id, {
					type: node.type,
					maturity: node.maturity,
					origin: node.origin,
					theory_status: node.theory_status,
					school: node.school,
					applicable_scope: node.applicable_scope
				}]))
			}
		});
		this._remember(nodes);
		return observed;
	}

	/** 结构类比（channel: analogical）：同型、跨领域、关系签名相似。 */
	analogize(cardId, { limit = 6, mechanismQuery = "" } = {}) {
		const start = this.cards.get(cardId);
		if (!start) {
			return this._observe("analogical", [], { extra: { start: cardId, error: `卡片不存在：${cardId}` } });
		}
		if (!ANALOGIZE_TYPES.has(start.meta.type)) {
			return this._observe("analogical", [], {
				extra: { start: cardId, misuse: "类比默认从 model/claim/method 出发" }
			});
		}
		const startSig = this._relationSignature(start);
		const startDomains = new Set(start.meta.domains ?? []);
		const query = String(mechanismQuery).trim().slice(0, 300);
		const terms = [...queryTokens(query)].filter((term) => term.length >= 2);
		const sourceText = `${start.meta.title ?? ""} ${start.body ?? ""}`.toLowerCase();
		const sourceTerms = terms.filter((term) => sourceText.includes(term));
		if (query && !sourceTerms.length) return this._observe("analogical", [], { extra: {
			start: cardId, misuse: "机制查询未在焦点正文定位；先精读焦点并用其具体作用环节描述待比较结构。", misuse_code: "analogy_query_not_grounded"
		} });
		const scored = [];
		for (const [cid, card] of this.cards) {
			if (cid === cardId || (query ? !ANALOGIZE_TYPES.has(card.meta.type) : card.meta.type !== start.meta.type)) continue;
			if (["archived", "superseded"].includes(card.meta.lifecycle)) continue;
			const sharedDomain = startDomains.size && (card.meta.domains ?? []).some((d) => startDomains.has(d));
			if (!query && sharedDomain) continue;
			const otherSig = this._relationSignature(card);
			const shared = [...startSig].filter((t) => otherSig.has(t)).sort();
			const body = `${card.meta.title ?? ""} ${card.body ?? ""}`.toLowerCase();
			const clues = sourceTerms.filter((term) => body.includes(term));
			if (query ? clues.length < Math.min(2, sourceTerms.length) : !shared.length) continue;
			const union = new Set([...startSig, ...otherSig]);
			const structureScore = shared.length / Math.max(1, union.size);
			scored.push([query ? 0.8 * clues.length / Math.max(1, sourceTerms.length) + 0.15 * structureScore + (sharedDomain ? 0 : 0.05) : structureScore, cid, shared, clues]);
		}
		scored.sort((a, b) => (b[0] - a[0]) || (a[1] < b[1] ? -1 : 1));
		const hits = [];
		for (const [score, cid, shared, clues] of scored.slice(0, boundedNumber(limit, 6, 1, 12))) {
			const ref = this._cardRef(cid);
			ref.why = query ? `正文机制线索：${clues.join("、")}；仍需比较角色、方向、条件与断裂点` : `共用关系类型：${shared.join(", ")}`;
			ref.candidate_status = "unverified_analogy";
			ref.matching_clues = clues;
			ref.write_evidence_eligible = false;
			ref.score = Math.round(score * 1000) / 1000;
			hits.push(ref);
		}
		const observed = this._observe("analogical", hits, { extra: { start: cardId, mechanism_query: query,
			candidate_basis: query ? "body_clues_and_relation_signature" : "relation_signature",
			boundary: "候选排序是词面和关系线索，不证明机制同构；无边候选不构成图路径。" } });
		this._remember(hits);
		return observed;
	}

	/** 在两个已知对象之间查找受控的 1–3 跳 ready 路径。 */
	path(fromId, toId, { maxHops = 3, maxPaths = 4, plane = "argument", relationTypes, direction = "both" } = {}) {
		if (!new Set(["argument", "context", "reference"]).has(plane)) return this._observe("argument-path", [], { extra: {
			from: fromId, to: toId, plane, error: `未知关系平面：${plane}`, misuse_code: "unknown_relation_plane"
		} });
		if (!this.cards.has(fromId) || !this.cards.has(toId)) {
			return this._observe(`${plane}-path`, [], { extra: {
				from: fromId, to: toId, plane,
				error: !this.cards.has(fromId) ? `卡片不存在：${fromId}` : `卡片不存在：${toId}`
			} });
		}
		if (this.cards.get(fromId).meta.type === "domain" || this.cards.get(toId).meta.type === "domain") {
			return this._observe(`${plane}-path`, [], { extra: {
				from: fromId, to: toId, plane,
				misuse: "graph_path 不使用领域卡制造推理捷径；请先用 graph_members 选择具体成员。",
				misuse_code: "path_requires_non_domain_cards"
			} });
		}
		const hops = Math.min(3, Math.max(1, Math.trunc(Number(maxHops) || 3)));
		const cap = Math.min(4, Math.max(1, Math.trunc(Number(maxPaths) || 4)));
		const relationTypeSet = new Set(relationTypes ?? []);
		const includeAppliesTo = relationTypeSet.has("applies-to");
		const queue = [{ id: fromId, nodes: [fromId], edges: [] }];
		const paths = [];
		let expanded = 0;
		let truncated = false;
		while (queue.length && paths.length < cap && expanded < 80) {
			const current = queue.shift();
			if (current.edges.length >= hops) continue;
			const pending = [];
			if (direction !== "in") for (const edge of this.adjOut.get(current.id) ?? []) pending.push([edge.to, edge]);
			if (direction !== "out") for (const edge of this.adjIn.get(current.id) ?? []) pending.push([edge.from, edge]);
			pending.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-CN"));
			const eligible = [];
			for (const [other, edge] of pending) {
				if (!this.cards.has(other) || current.nodes.includes(other)) continue;
				const traversable = plane === "context"
					? isContextEdge(this.cards, edge)
					: plane === "reference"
						? isReferenceEdge(this.cards, edge)
						: isArgumentEdge(this.cards, edge, { includeAppliesTo });
				if (!traversable) continue;
				const type = walkRelationType(this.cards, edge.from, edge);
				if (relationTypeSet.size && !relationTypeSet.has(type)) continue;
				const readiness = edgeReadiness(this.cards, edge);
				if (!readiness.ready) continue;
				eligible.push([other, {
					from: edge.from, to: edge.to, type, declared_type: edge.relation_type,
					note: String(edge.note ?? ""), plane: readiness.plane,
					readiness: readiness.level, ready: true, warnings: []
				}]);
			}
			if (eligible.length > 16) truncated = true;
			for (const [other, edgeRef] of eligible.slice(0, 16)) {
				expanded++;
				const next = { id: other, nodes: [...current.nodes, other], edges: [...current.edges, edgeRef] };
				if (other === toId) paths.push({ node_ids: next.nodes, edges: next.edges, hops: next.edges.length });
				else queue.push(next);
				if (paths.length >= cap || expanded >= 80) break;
			}
		}
		truncated ||= queue.length > 0;
		const nodeIds = [...new Set(paths.flatMap((path) => path.node_ids))];
		const nodes = nodeIds.map((id) => this._cardRef(id));
		const observed = this._observe(`${plane}-path`, nodes, {
			truncated,
			reason: truncated ? "path_budget" : undefined,
			extra: { from: fromId, to: toId, plane, max_hops: hops, max_paths: cap, paths, expanded }
		});
		this._remember(nodes);
		return observed;
	}

	/** 形成一张卡的有界论证视图，不替模型裁决。 */
	argument(cardId) {
		const card = this.cards.get(cardId);
		if (!card) return this._observe("argument-view", [], { extra: { start: cardId, error: `卡片不存在：${cardId}` } });
		if (card.meta.type === "domain") return this._observe("argument-view", [], { extra: {
			start: cardId, misuse: "领域卡没有论证视图；请用 graph_members 查看成员。",
			misuse_code: "argument_requires_non_domain_card"
		} });
		const selected = [];
		for (const edge of this.adjIn.get(cardId) ?? []) if (walkRelationType(this.cards, edge.from, edge) === "supports") selected.push(edge);
		for (const edge of this.adjOut.get(cardId) ?? []) if (["based-on", "conflicts-with"].includes(walkRelationType(this.cards, edge.from, edge))) selected.push(edge);
		for (const edge of this.adjIn.get(cardId) ?? []) if (walkRelationType(this.cards, edge.from, edge) === "conflicts-with") selected.push(edge);
		const edges = selected.map((edge) => {
			const readiness = edgeReadiness(this.cards, edge);
			return {
				from: edge.from, to: edge.to, type: walkRelationType(this.cards, edge.from, edge),
				declared_type: edge.relation_type, note: String(edge.note ?? ""), plane: readiness.plane,
				readiness: readiness.level, ready: readiness.ready, warnings: readiness.reason_codes
			};
		});
		const nodeIds = [...new Set([cardId, ...edges.flatMap((edge) => [edge.from, edge.to])])];
		const nodes = nodeIds.map((id) => this._cardRef(id));
		const boundaries = slotExcerpt(card.body ?? "", ["适用条件", "已知限制", "失效边界", "反例与失效条件"]);
		const observed = this._observe("argument-view", nodes, { extra: {
			start: cardId,
			edges,
			supports: edges.filter((edge) => edge.type === "supports" && edge.to === cardId),
			based_on: edges.filter((edge) => edge.type === "based-on" && edge.from === cardId),
			conflicts: edges.filter((edge) => edge.type === "conflicts-with"),
			boundaries,
			source_summary: cardMetadata(card).source_summary,
			ready_relation_count: edges.filter((edge) => edge.ready).length,
			legacy_relation_count: edges.filter((edge) => !edge.ready).length
		} });
		this._remember(nodes);
		return observed;
	}

	/** 精读（可指定语义槽，只摘对应章节）。 */
	read(cardId, { slots } = {}) {
		const card = this.cards.get(cardId);
		if (!card) return { channel: "read", error: `卡片不存在：${cardId}` };
		let body = card.body ?? "";
		if (Array.isArray(slots) && slots.length) body = slotExcerpt(body, slots);
		this.seenIds.add(cardId);
		return {
			channel: "read",
			id: cardId,
			title: String(card.meta.title ?? cardId),
			type: String(card.meta.type ?? "unknown"),
			maturity: String(card.meta.maturity ?? ""),
			lifecycle: String(card.meta.lifecycle ?? "active"),
			domains: Array.isArray(card.meta.domains) ? card.meta.domains : [],
			origin: String(card.meta.origin ?? "user"),
			sources: Array.isArray(card.meta.sources) ? card.meta.sources : [],
			relations: Array.isArray(card.meta.relations) ? card.meta.relations : [],
			created: String(card.meta.created ?? ""),
			updated: String(card.meta.updated ?? ""),
			...cardMetadata(card),
			body
		};
	}

	/** 记录结构债（.nexogenesis/graph/debts.jsonl，可删可重建）。 */
	noteDebt(kind, cards, reason) {
		if (!DEBT_KINDS.includes(kind)) {
			return { ok: false, error: `未知债类型：${kind}（闭集：${DEBT_KINDS.join("/")}）` };
		}
		const normalizedCards = (cards ?? []).filter(Boolean);
		const normalizedReason = String(reason ?? "");
		const existingRecord = this.root ? readGraphDebts(this.root).find((item) =>
			item.kind === kind
			&& JSON.stringify(item.cards) === JSON.stringify(normalizedCards)
			&& item.reason === normalizedReason) : null;
		if (existingRecord) return { ok: true, channel: "debt", ...existingRecord, deduplicated: true };
		const record = {
			kind,
			cards: normalizedCards,
			reason: normalizedReason,
			at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
		};
		if (this.root) {
			try {
				const path = join(this.root, ".nexogenesis", "graph", "debts.jsonl");
				mkdirSync(join(path, ".."), { recursive: true });
				const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
				writeFileSync(path, existing + JSON.stringify(record) + "\n", "utf8");
			} catch { /* 债记录 best-effort */ }
		}
		return { ok: true, channel: "debt", ...record, deduplicated: false };
	}

	// ---- 内部 ----

	_unconnectedPriority(cardId, scope, review) {
		const card = this.cards.get(cardId);
		const incident = [...(this.adjOut.get(cardId) ?? []), ...(this.adjIn.get(cardId) ?? [])];
		const ready = incident.filter((edge) => edgeReadiness(this.cards, edge).ready);
		const reasons = [];
		let priority = 10;
		if (card?.meta?.type === "conflict" && !(this.adjOut.get(cardId) ?? []).some((edge) => edge.relation_type === "involves")) {
			priority += 100;
			reasons.push("conflict_missing_involves");
		}
		const pool = this._integrationCandidatePool(cardId);
		let bestCandidate;
		for (const [candidateId, poolSignal] of [...pool].sort((a, b) => b[1].semantic_hits - a[1].semantic_hits).slice(0, 16)) {
			const signals = this._integrationSignals(cardId, candidateId, { includePath: false });
			if (!bestCandidate || signals.score > bestCandidate.score) bestCandidate = { candidate_id: candidateId, ...signals, poolSignal };
		}
		if ((bestCandidate?.signals.shared_sources?.length ?? 0) > 0) {
			priority += 40;
			reasons.push("shared_source_candidate");
		}
		if ((bestCandidate?.signals.explicit_mentions?.length ?? 0) > 0) {
			priority += 30;
			reasons.push("explicit_mention_candidate");
		}
		if (bestCandidate?.signals.semantic_overlap === "high") {
			priority += 20;
			reasons.push("high_semantic_overlap");
		}
		if (card?.meta?.type === "entity") {
			priority += 8;
			reasons.push("isolated_entity_requires_inbound_review");
		}
		if (scope === "without_domain") reasons.push("membership_only_issue");
		return {
			card_id: cardId,
			priority,
			priority_reasons: reasons.length ? reasons : ["ordinary_unconnected_card"],
			incident_summary: {
				inbound: (this.adjIn.get(cardId) ?? []).length,
				outbound: (this.adjOut.get(cardId) ?? []).length,
				ready: ready.length,
				legacy_or_invalid: incident.length - ready.length
			},
			review: review ? {
				status: review.status,
				candidate_ids: review.candidate_ids ?? [],
				reason: review.reason,
				reviewed_at: review.reviewed_at
			} : null
		};
	}

	_integrationSignals(cardId, candidateId, { includePath = true } = {}) {
		const focus = this.cards.get(cardId);
		const candidate = this.cards.get(candidateId);
		const focusSources = new Set(asList(focus?.meta?.sources));
		const sharedSources = asList(candidate?.meta?.sources).filter((source) => focusSources.has(source));
		const focusDomains = new Set(asList(focus?.meta?.domains));
		const sameDomains = asList(candidate?.meta?.domains).filter((domain) => focusDomains.has(domain));
		const explicitMentions = [
			...mentionsCard(focus, candidateId, candidate).map((value) => ({ from: cardId, matched: value })),
			...mentionsCard(candidate, cardId, focus).map((value) => ({ from: candidateId, matched: value }))
		];
		const overlap = overlapScore(this._semanticTokens(cardId), this._semanticTokens(candidateId));
		const association = this._discoveryAssociation(cardId, candidateId);
		const semanticOverlap = overlap.score >= 0.16 ? "high"
			: overlap.score >= 0.07 ? "medium"
				: overlap.score > 0 ? "low" : "none";
		const compatibleTypes = [...RELATION_TYPES].filter((type) =>
			constructRelationAllowed(type, focus?.meta?.type, candidate?.meta?.type)
			|| constructRelationAllowed(type, candidate?.meta?.type, focus?.meta?.type));
		const existingPath = includePath ? this._hasReadyPath(cardId, candidateId, 3) : false;
		let score = Math.min(48, sharedSources.length * 24)
			+ Math.min(4, sameDomains.length * 2)
			+ Math.min(36, explicitMentions.length * 18)
			+ Math.min(8, Math.round(overlap.score * 24))
			+ Math.min(6, association.score)
			+ (compatibleTypes.length ? 1 : 0)
			- (existingPath ? 8 : 0);
		score = Math.max(0, score);
		const evidenceTier = explicitMentions.length ? "E3"
			: sharedSources.length || semanticOverlap === "high" || association.qualified ? "E2" : "E1";
		const why = [];
		if (sharedSources.length) why.push(`共享 ${sharedSources.length} 个来源`);
		if (sameDomains.length) why.push(`同属 ${sameDomains.length} 个领域`);
		if (explicitMentions.length) why.push(`存在 ${explicitMentions.length} 处显式互指`);
		if (semanticOverlap !== "none") why.push(`语义单元重合为 ${semanticOverlap}`);
		if (association.qualified) why.push(`候选关联场发现：${association.reason}`);
		if (existingPath) why.push("已有 ready 间接路径，需避免重复补边");
		return {
			score,
			signals: {
				shared_sources: sharedSources,
				same_domains: sameDomains,
				explicit_mentions: explicitMentions,
				semantic_overlap: semanticOverlap,
				shared_semantic_units: overlap.shared,
				type_pair: `${focus?.meta?.type ?? "unknown"} → ${candidate?.meta?.type ?? "unknown"}`,
				compatible_relation_types: compatibleTypes,
				candidate_association: association,
				existing_path: existingPath,
				evidence_tier: evidenceTier,
				tier_meaning: evidenceTier === "E3"
					? "正文存在显式互指，可进入关系案件比较；仍需方向、边界与反证。"
					: evidenceTier === "E2"
						? "共享来源、较强语义槽重合或候选关联场信号，只允许进入比较。"
						: "共同领域或有限词面信号，只用于召回。",
				write_evidence_eligible: false
			},
			why: why.join("；") || "仅有较弱的有限词面信号"
		};
	}

	_integrationCandidatePool(cardId, { includeExplicit = false } = {}) {
		const focus = this.cards.get(cardId);
		const pool = new Map();
		const add = (candidateId, kind) => {
			if (candidateId === cardId || !this.cards.has(candidateId)) return;
			const state = pool.get(candidateId) ?? { semantic_hits: 0, source_hits: 0, domain_hits: 0, explicit_hits: 0 };
			state[kind]++;
			pool.set(candidateId, state);
		};
		for (const source of asList(focus?.meta?.sources)) for (const candidateId of this.sourceIndex.get(source) ?? []) add(candidateId, "source_hits");
		for (const domain of asList(focus?.meta?.domains)) for (const candidateId of this.byDomain.get(domain) ?? []) add(candidateId, "domain_hits");
		this._ensureSemanticIndex();
		const maxPosting = Math.max(24, Math.ceil(this.cards.size * 0.06));
		for (const token of this._semanticTokens(cardId)) {
			const posting = this.semanticTokenIndex.get(token) ?? [];
			if (posting.length > maxPosting) continue;
			for (const candidateId of posting) add(candidateId, "semantic_hits");
		}
		if (includeExplicit) for (const [candidateId, candidate] of this.cards) {
			if (candidateId === cardId || candidate.meta.type === "domain") continue;
			const hits = mentionsCard(focus, candidateId, candidate).length + mentionsCard(candidate, cardId, focus).length;
			for (let index = 0; index < hits; index++) add(candidateId, "explicit_hits");
		}
		return pool;
	}

	_hasReadyPath(fromId, toId, maxHops, excludedSignatures = new Set()) {
		const queue = [{ id: fromId, depth: 0 }];
		const seen = new Set([fromId]);
		while (queue.length) {
			const current = queue.shift();
			if (current.depth >= maxHops) continue;
			const edges = [...(this.adjOut.get(current.id) ?? []), ...(this.adjIn.get(current.id) ?? [])];
			for (const edge of edges) {
				const signature = `${edge.from}\u0000${edge.relation_type}\u0000${edge.to}`;
				if (excludedSignatures.has(signature)) continue;
				if (!isArgumentEdge(this.cards, edge, { includeAppliesTo: true })) continue;
				if (!edgeReadiness(this.cards, edge).ready) continue;
				const other = edge.from === current.id ? edge.to : edge.from;
				if (other === toId) return true;
				if (!this.cards.has(other) || seen.has(other)) continue;
				seen.add(other);
				queue.push({ id: other, depth: current.depth + 1 });
			}
		}
		return false;
	}

	_semanticTokens(cardId) {
		if (!this.semanticTokenCache.has(cardId)) this.semanticTokenCache.set(cardId, semanticTokens(this.cards.get(cardId)));
		return this.semanticTokenCache.get(cardId);
	}

	_tokenWeight(token) {
		this._ensureSemanticIndex();
		const documentFrequency = this.semanticTokenIndex.get(token)?.length ?? 0;
		const inverseFrequency = 1 + Math.log((this.cards.size + 1) / (documentFrequency + 1));
		const lengthWeight = Math.min(2, Math.max(1, String(token).length / 2));
		return inverseFrequency * lengthWeight;
	}

	_weightedQueryOverlap(querySet, candidateSet) {
		if (!querySet.size || !candidateSet.size) return { score: 0, shared: [] };
		let totalWeight = 0;
		let sharedWeight = 0;
		const shared = [];
		for (const token of querySet) {
			const weight = this._tokenWeight(token);
			totalWeight += weight;
			if (!candidateSet.has(token)) continue;
			sharedWeight += weight;
			shared.push(token);
		}
		return {
			score: totalWeight ? sharedWeight / totalWeight : 0,
			shared: shared.sort((left, right) => this._tokenWeight(right) - this._tokenWeight(left)
				|| right.length - left.length || left.localeCompare(right, "zh-CN")).slice(0, 10)
		};
	}

	_queryFacets(querySet) {
		this._ensureSemanticIndex();
		const candidates = [...querySet].filter((token) => {
			const frequency = this.semanticTokenIndex.get(token)?.length ?? 0;
			const titleHit = [...this.cards].some(([cardId, card]) => `${cardId} ${card.meta.title ?? ""}`.includes(token));
			return frequency > 0 && (frequency >= 2 || titleHit)
				&& frequency <= Math.max(24, Math.ceil(this.cards.size * 0.25))
				&& (/^[\u4e00-\u9fff]{2,4}$/u.test(token) || /^[a-z0-9]{3,12}$/iu.test(token));
		}).sort((left, right) => this._tokenWeight(right) - this._tokenWeight(left)
			|| right.length - left.length || left.localeCompare(right, "zh-CN"));
		const facets = [];
		for (const token of candidates) {
			if (facets.some((chosen) => chosen.includes(token) || token.includes(chosen))) continue;
			facets.push(token);
			if (facets.length >= 6) break;
		}
		return facets;
	}

	_queryRelevance(cardId, querySet, rawQuery, retrievalIntent = {}) {
		const card = this.cards.get(cardId);
		if (!card || !querySet.size) return { score: 0, matched_tokens: [] };
		const titleTokens = queryTokens(`${cardId} ${card.meta.title ?? ""} ${asList(card.meta.aliases).join(" ")}`);
		const metadataTokens = queryTokens(`${asList(card.meta.school).join(" ")} ${asList(card.meta.applicable_scope).join(" ")} ${asList(card.meta.domains).join(" ")}`);
		const primaryTerms = new Set(retrievalIntent.query_terms?.length ? retrievalIntent.query_terms : querySet);
		const rawTailTerms = new Set((retrievalIntent.raw_query_terms ?? []).filter((term) => !primaryTerms.has(term)));
		const title = this._weightedQueryOverlap(primaryTerms, titleTokens);
		const body = this._weightedQueryOverlap(primaryTerms, this._semanticTokens(cardId));
		const metadata = this._weightedQueryOverlap(primaryTerms, metadataTokens);
		const rawTailTitle = this._weightedQueryOverlap(rawTailTerms, titleTokens);
		const rawTailBody = this._weightedQueryOverlap(rawTailTerms, this._semanticTokens(cardId));
		const rawTailMetadata = this._weightedQueryOverlap(rawTailTerms, metadataTokens);
		const context = this._weightedQueryOverlap(new Set(retrievalIntent.context_terms ?? []), this._semanticTokens(cardId));
		const contrast = this._weightedQueryOverlap(new Set(retrievalIntent.contrast_terms ?? []), this._semanticTokens(cardId));
		const exclusion = this._weightedQueryOverlap(new Set(retrievalIntent.exclusion_terms ?? []), titleTokens);
		const normalizedQuery = String(rawQuery ?? "").replace(/\s+/gu, "").toLowerCase();
		const normalizedTitle = `${cardId}${card.meta.title ?? ""}`.replace(/\s+/gu, "").toLowerCase();
		const phraseBonus = normalizedQuery.length >= 3 && normalizedTitle.includes(normalizedQuery) ? 15 : 0;
		const score = Math.max(0, Math.round((title.score * 60 + body.score * 32 + metadata.score * 12
			+ rawTailTitle.score * 18 + rawTailBody.score * 10 + rawTailMetadata.score * 4
			+ context.score * 8 + contrast.score * 6 + phraseBonus
			- exclusion.score * 12
			- hubPenalty(this.cards, this.byDomain, cardId)) * 1000) / 1000);
		return {
			score,
			raw_tail_score: Math.round((rawTailTitle.score * 60 + rawTailBody.score * 32 + rawTailMetadata.score * 12) * 1000) / 1000,
			matched_tokens: [...new Set([
				...title.shared, ...body.shared, ...metadata.shared,
				...rawTailTitle.shared, ...rawTailBody.shared, ...rawTailMetadata.shared,
				...context.shared, ...contrast.shared
			])].slice(0, 10)
		};
	}

	_retrievalRoles(cardId, pathEdges = []) {
		const card = this.cards.get(cardId);
		const roles = new Set();
		const type = card?.meta?.type;
		if (type === "claim") roles.add("core_claim");
		if (["model", "method"].includes(type)) roles.add("mechanism");
		if (type === "evidence") roles.add("evidence");
		if (type === "conflict") roles.add("counter");
		if (["phenomenon", "entity", "domain"].includes(type)) roles.add("context");
		const body = String(card?.body ?? "");
		if (/^#{1,6}\s+.*(?:边界|限制|失效|反例)/mu.test(body)) roles.add("boundary");
		for (const edge of pathEdges) {
			if (edge.relation_type === "conflicts-with") roles.add("counter");
			if (["supports", "example-of"].includes(edge.relation_type)) roles.add("evidence");
			if (["based-on", "part-of", "extends"].includes(edge.relation_type)) roles.add("mechanism");
			if (edge.plane === "context") roles.add("context");
		}
		if (!roles.size) roles.add("related");
		return [...roles];
	}

	_selectRetrievalContext(ranked, limit, queryFacets = []) {
		const selected = [];
		const excluded = [];
		const deferredReliable = [];
		const selectedIds = new Set();
		const reliable = ranked.filter((item) => item.retrieval_source !== "discovery");
		const discovery = ranked.filter((item) => item.retrieval_source === "discovery" && item.discovery?.qualified);
		const add = (item, reason) => {
			if (!item || selectedIds.has(item.card_id) || selected.length >= limit) return;
			selectedIds.add(item.card_id);
			selected.push(item);
			if (reason) item.selection_reason = reason;
		};
		for (const facet of queryFacets) {
			add(reliable.find((item) => item.matched_tokens.includes(facet)), `覆盖查询侧面：${facet}`);
		}
		const roleThreshold = Math.max(1.5, (reliable[0]?.score ?? 0) * 0.12);
		for (const role of RETRIEVAL_ROLE_ORDER.slice(0, -1)) {
			const candidate = reliable.find((item) => item.roles.includes(role)
				&& item.score >= roleThreshold);
			add(candidate, `补足 ${role} 角色`);
		}
		for (const item of reliable) {
			if (selected.length >= limit) break;
			if (selectedIds.has(item.card_id)) continue;
			const itemTokens = this._semanticTokens(item.card_id);
			const duplicate = selected.find((chosen) => overlapScore(itemTokens, this._semanticTokens(chosen.card_id)).score >= 0.88
				&& item.roles.every((role) => chosen.roles.includes(role)));
			if (duplicate) {
				deferredReliable.push({ item, duplicate });
				continue;
			}
			add(item, "按问题相关性与图关系综合入选");
		}
		// 图关系仍是可用证据。若去重让预算未填满，先回补这些可靠候选，再谈发现层。
		for (const { item, duplicate } of deferredReliable) {
			if (selected.length >= limit) break;
			add(item, `保留已核验路径：虽与 ${duplicate.card_id} 内容相近，但提供独立关系证据`);
		}
		// Discovery has an explicit residual budget. It can enrich a sufficiently covered plan, never replace its direct or ready-graph evidence.
		if (limit >= 6 && selected.length < limit) add(discovery[0], "在可靠候选之后保留一个未证实关联，用于发现与比较");
		for (const item of ranked) if (!selectedIds.has(item.card_id) && !excluded.some((entry) => entry.card_id === item.card_id)) {
			excluded.push({ card_id: item.card_id, retrieval_source: item.retrieval_source, reason: "超出本轮上下文预算或相关性低于已选候选" });
		}
		selected.sort((left, right) => right.score - left.score || left.hop - right.hop || left.card_id.localeCompare(right.card_id, "zh-CN"));
		return { selected, excluded };
	}

	_retrievalReasons(item) {
		const reasons = [];
		if (item.retrieval_source === "discovery" && item.discovery) {
			reasons.push(`候选关联场：${item.discovery.reason}`);
			reasons.push(`从 ${item.discovery.seed_id} 的机制/条件语义锚点发现`);
			reasons.push("未证实关联；必须精读并比较后才能用于判断");
			return reasons.slice(0, 4);
		}
		if (item.matched_tokens?.length) reasons.push(`与问题共享：${item.matched_tokens.slice(0, 5).join("、")}`);
		if (item.hop === 0) reasons.push("直接词面或语义槽命中");
		else reasons.push(`经 ready 关系 ${item.hop} 跳到达`);
		const lastEdge = item.path_edges?.at(-1);
		if (lastEdge?.relation_type) reasons.push(`末条关系为 ${lastEdge.relation_type}${lastEdge.note ? `：${lastEdge.note.slice(0, 80)}` : ""}`);
		if (item.selection_reason) reasons.push(item.selection_reason);
		return reasons.slice(0, 4);
	}

	_retrievalReadSlots(roles) {
		const slots = new Set(["核心表达"]);
		if (roles.includes("core_claim")) slots.add("主张");
		if (roles.includes("mechanism")) slots.add("机制");
		if (roles.includes("evidence")) slots.add("依据");
		if (roles.includes("counter")) slots.add("反例");
		if (roles.includes("boundary")) slots.add("边界");
		return [...slots].slice(0, 4);
	}

	_sourceTraceRequired(cardId, roles) {
		const card = this.cards.get(cardId);
		return roles.includes("evidence") || /\d/u.test(String(card?.body ?? "")) || asList(card?.meta?.sources).length > 1;
	}

	/**
	 * 候选关联场：从一张已命中卡的语义锚点出发，寻找尚无正式关系但值得比较的对象。
	 * 这是可重建的检索索引，不产生、修改或暗示正式关系；没有向量模型时只使用
	 * 稀有共享表达与最小结构相似性，并把不足明确暴露给上层。
	 */
	_discoveryAssociations(seedId, { limit = 8, exclude = new Set() } = {}) {
		const seed = this.cards.get(seedId);
		if (!seed || seed.meta.type === "domain") return [];
		const results = [];
		for (const [candidateId, candidate] of this.cards) {
			if (candidateId === seedId || exclude.has(candidateId) || candidate.meta.type === "domain" || candidate.meta.lifecycle === "archived") continue;
			const association = this._discoveryAssociation(seedId, candidateId);
			if (association.qualified) results.push(association);
		}
		return results.sort((left, right) => right.score - left.score || left.card_id.localeCompare(right.card_id, "zh-CN"))
			.slice(0, Math.max(1, Math.min(16, Math.trunc(Number(limit) || 8))));
	}

	_discoveryAssociation(seedId, candidateId) {
		const seed = this.cards.get(seedId);
		const candidate = this.cards.get(candidateId);
		if (!seed || !candidate) return {
			card_id: candidateId, seed_id: seedId, score: 0, qualified: false,
			kind: "semantic_anchor_bridge", signals: { rare_shared_anchors: [], shared_relation_roles: [], cross_domain: false },
			reason: "种子或候选卡不存在", status: "unverified_association", write_evidence_eligible: false
		};
		this._ensureDiscoveryAnchorIndex();
		const overlap = overlapScore(this._discoveryAnchors(seedId), this._discoveryAnchors(candidateId));
		const rareShared = overlap.shared.filter((token) => {
			const frequency = this.discoveryAnchorIndex?.get(token)?.length ?? 0;
			return frequency > 0 && frequency <= Math.max(3, Math.min(16, Math.ceil(this.cards.size * 0.01)));
		});
		// 同一概念会产生嵌套短语（如“铸币法案”与“币法案”）；不能把它们伪装成两条独立线索。
		const independentRare = [];
		for (const token of [...rareShared].sort((left, right) => right.length - left.length || left.localeCompare(right, "zh-CN"))) {
			if (token.length < 3 || independentRare.some((chosen) => chosen.includes(token))) continue;
			independentRare.push(token);
		}
		const seedRelations = this._relationSignature(seed);
		const candidateRelations = this._relationSignature(candidate);
		const sharedRelationRoles = [...seedRelations].filter((type) => candidateRelations.has(type));
		const sameDomains = asList(seed.meta.domains).filter((domain) => asList(candidate.meta.domains).includes(domain));
		const crossDomain = !sameDomains.length && asList(seed.meta.domains).length && asList(candidate.meta.domains).length;
		const hasSemanticBridge = independentRare.length >= 3;
		const hasStructuralBridge = independentRare.length >= 3 && sharedRelationRoles.length >= 2;
		// 已有 ready 路径的对象属于正式图的职责；发现层只保留图上尚未表达的比较对象。
		const existingReadyPath = this._hasReadyPath(seedId, candidateId, 2);
		const qualified = !existingReadyPath && (hasSemanticBridge || hasStructuralBridge);
		const score = Math.round((
			Math.min(5, independentRare.length * 1.5)
			+ Math.min(2, sharedRelationRoles.length * 0.75)
			+ (crossDomain ? 0.6 : 0)
		) * 1000) / 1000;
		const signals = [];
		if (independentRare.length) signals.push(`共享独立稀有语义锚点：${independentRare.slice(0, 4).join("、")}`);
		if (sharedRelationRoles.length >= 2) signals.push(`相近关系结构：${sharedRelationRoles.slice(0, 3).join("、")}`);
		if (crossDomain) signals.push("跨领域候选");
		if (existingReadyPath) signals.push("已有 ready 图路径，应通过正式关系读取");
		return {
			card_id: candidateId, seed_id: seedId, score, qualified,
			kind: hasStructuralBridge ? "semantic_structural_bridge" : "semantic_anchor_bridge",
			signals: { rare_shared_anchors: independentRare, shared_relation_roles: sharedRelationRoles, cross_domain: crossDomain },
			reason: signals.join("；") || "候选关联信号不足",
			status: "unverified_association",
			write_evidence_eligible: false
		};
	}

	_ensureSemanticIndex() {
		if (this.semanticTokenIndex) return;
		this.semanticTokenIndex = new Map();
		for (const cardId of this.cards.keys()) for (const token of this._semanticTokens(cardId)) {
			if (!this.semanticTokenIndex.has(token)) this.semanticTokenIndex.set(token, []);
			this.semanticTokenIndex.get(token).push(cardId);
		}
	}

	_discoveryAnchors(cardId) {
		if (!this.discoveryAnchorCache.has(cardId)) this.discoveryAnchorCache.set(cardId, discoveryAnchors(this.cards.get(cardId)));
		return this.discoveryAnchorCache.get(cardId);
	}

	_ensureDiscoveryAnchorIndex() {
		if (this.discoveryAnchorIndex) return;
		this.discoveryAnchorIndex = new Map();
		for (const cardId of this.cards.keys()) for (const token of this._discoveryAnchors(cardId)) {
			if (!this.discoveryAnchorIndex.has(token)) this.discoveryAnchorIndex.set(token, []);
			this.discoveryAnchorIndex.get(token).push(cardId);
		}
	}

	_cardRef(cardId) {
		const card = this.cards.get(cardId);
		return {
			id: cardId,
			title: String(card?.meta.title ?? cardId),
			type: String(card?.meta.type ?? "unknown"),
			domains: Array.isArray(card?.meta.domains) ? card.meta.domains : [],
			...cardMetadata(card)
		};
	}

	_relationSignature(card) {
		const types = new Set();
		for (const rel of card.meta.relations ?? []) {
			if (rel?.type === "applies-to") continue;
			const readiness = relationReadiness(card, rel, this.cards.get(rel?.target));
			if (readiness.ready && rel?.type) types.add(rel.type);
		}
		return types;
	}

	_edgeDirection(start, other) {
		let outHit = false;
		for (const edge of this.adjOut.get(start) ?? []) {
			if (isArgumentEdge(this.cards, edge) && edge.to === other) outHit = true;
		}
		let inHit = false;
		for (const edge of this.adjIn.get(start) ?? []) {
			if (isArgumentEdge(this.cards, edge) && edge.from === other) inHit = true;
		}
		if (outHit && inHit) return "both";
		if (inHit) return "in";
		return "out";
	}

	_remember(nodes) {
		for (const node of nodes) {
			if (node?.id) this.seenIds.add(node.id);
		}
	}

	_structuralFrontier(cardId) {
		const card = this.cards.get(cardId);
		if (!card || card.meta.type === "domain") return null;
		const incident = [
			...(this.adjOut.get(cardId) ?? []).map((edge) => [edge.to, edge]),
			...(this.adjIn.get(cardId) ?? []).map((edge) => [edge.from, edge])
		];
		const planeChecks = {
			argument: (edge) => isArgumentEdge(this.cards, edge),
			context: (edge) => isContextEdge(this.cards, edge),
			reference: (edge) => isReferenceEdge(this.cards, edge)
		};
		const planes = {};
		for (const [plane, accepts] of Object.entries(planeChecks)) {
			const direct = incident.filter(([, edge]) => accepts(edge) && edgeReadiness(this.cards, edge).ready);
			const secondHop = new Set();
			for (const [middle] of direct) {
				const nextIncident = [
					...(this.adjOut.get(middle) ?? []).map((edge) => [edge.to, edge]),
					...(this.adjIn.get(middle) ?? []).map((edge) => [edge.from, edge])
				];
				for (const [other, edge] of nextIncident) {
					if (other !== cardId && accepts(edge) && edgeReadiness(this.cards, edge).ready) secondHop.add(other);
				}
			}
			planes[plane] = { ready_relation_count: direct.length, two_hop_reachable: secondHop.size };
		}
		const [recommendedPlane, score] = Object.entries(planes)
			.sort((a, b) => b[1].two_hop_reachable - a[1].two_hop_reachable
				|| b[1].ready_relation_count - a[1].ready_relation_count
				|| ["argument", "context", "reference"].indexOf(a[0]) - ["argument", "context", "reference"].indexOf(b[0]))[0];
		return {
			card_id: cardId,
			recommended_plane: recommendedPlane,
			ready_relation_count: score.ready_relation_count,
			two_hop_reachable: score.two_hop_reachable,
			planes
		};
	}

	_observe(channel, nodes, { truncated = false, reason, extra } = {}) {
		let hubN = 0;
		for (const node of nodes) {
			if (this._isHub(node?.id ?? "")) hubN++;
		}
		let onTopicNew = 0;
		for (const node of nodes) {
			const cid = node?.id ?? "";
			const card = this.cards.get(cid);
			if (card && ON_TOPIC_TYPES.has(card.meta.type) && !this.seenIds.has(cid)) onTopicNew++;
		}
		const out = {
			channel,
			n: nodes.length,
			nodes,
			hub_ratio: nodes.length ? Math.round((hubN / nodes.length) * 1000) / 1000 : 0,
			on_topic_new: onTopicNew,
			truncated
		};
		if (reason) out.truncated_reason = reason;
		if (extra) Object.assign(out, extra);
		if (channel === "lexical" && nodes.length) {
			const domainN = nodes.filter((node) => this.cards.get(node?.id ?? "")?.meta.type === "domain").length;
			if (domainN / nodes.length >= 0.5 || out.hub_ratio >= 0.5) {
				out.note = "像领域星，请改 walk/analogize，不要把成员列表当成论证邻居";
			}
		}
		return out;
	}

	_isHub(cardId) {
		const card = this.cards.get(cardId);
		if (!card) return false;
		if (card.meta.type === "domain") return true;
		return hubPenalty(this.cards, this.byDomain, cardId) >= 6;
	}
}

/** 只摘命中的语义槽章节（复用卡片分节）。 */
export function slotExcerpt(body, slots) {
	const wanted = new Set((slots ?? []).map((s) => String(s).trim()).filter(Boolean));
	if (!wanted.size) return body;
	const chunks = [];
	for (const part of splitSections(body)) {
		if (part.heading && [...wanted].some((name) => part.heading.includes(name) || name.includes(part.heading))) {
			chunks.push(`## ${part.heading}\n\n${String(part.content).trimEnd()}\n`);
		}
	}
	return chunks.join("\n").trimEnd() + (chunks.length ? "\n" : "");
}
