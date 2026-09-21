#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { relationReadiness } from "../packages/nexogenesis-tools/lib/harness/relation-semantics.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = ".nexogenesis/graph/legacy-relations-audit.json";
const CJK_WORD = /[\u4e00-\u9fff]{2,}/gu;
const LATIN_WORD = /[a-z][a-z0-9-]{2,}/giu;
const STOP_WORDS = new Set([
	"一个", "一种", "以及", "可以", "通过", "对于", "这一", "这种", "其中", "因为", "因此",
	"关系", "影响", "支持", "基于", "冲突", "涉及", "模型", "主张", "现象", "方法", "机制",
	"the", "and", "for", "with", "from", "that", "this"
]);

function argsOf(argv) {
	const args = { root: DEFAULT_ROOT, output: DEFAULT_OUTPUT, stdout: false };
	for (const item of argv) {
		if (item === "--stdout") args.stdout = true;
		else if (item.startsWith("--root=")) args.root = resolve(item.slice("--root=".length));
		else if (item.startsWith("--output=")) args.output = item.slice("--output=".length);
	}
	return args;
}

function asList(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function normalizeText(value) {
	return String(value ?? "").toLowerCase().replace(/\s+/gu, " ");
}

function aliasesOf(card) {
	const meta = card?.meta ?? {};
	return [...new Set([
		String(meta.id ?? "").trim(),
		String(meta.title ?? "").trim(),
		...asList(meta.aliases)
	].filter((item) => item.length >= 2))];
}

function mentions(card, target) {
	const body = normalizeText(card?.body);
	const hits = aliasesOf(target).filter((alias) => body.includes(normalizeText(alias)));
	return hits.slice(0, 4);
}

function sourceKey(reference) {
	return String(reference).split("#")[0].replaceAll("\\", "/").trim();
}

function sharedSources(left, right) {
	const leftSources = new Set(asList(left?.meta?.sources).map(sourceKey).filter(Boolean));
	return [...new Set(asList(right?.meta?.sources).map(sourceKey).filter((item) => leftSources.has(item)))];
}

function sharedDomains(left, right) {
	const domains = new Set(asList(left?.meta?.domains));
	return [...new Set(asList(right?.meta?.domains).filter((item) => domains.has(item)))];
}

function semanticTokens(card) {
	const text = normalizeText(`${card?.meta?.title ?? ""}\n${card?.body ?? ""}`)
		.replace(/<!--\s*unit:[^>]+-->/gu, " ")
		.replace(/^#{1,6}\s+.+$/gmu, " ");
	const tokens = new Set();
	for (const match of text.match(CJK_WORD) ?? []) {
		for (const n of [2, 3, 4]) {
			for (let index = 0; index <= match.length - n; index += 1) {
				const token = match.slice(index, index + n);
				if (!STOP_WORDS.has(token)) tokens.add(token);
			}
		}
	}
	for (const match of text.match(LATIN_WORD) ?? []) {
		const token = match.toLowerCase();
		if (!STOP_WORDS.has(token)) tokens.add(token);
	}
	return tokens;
}

function tokenOverlap(left, right) {
	if (!left.size || !right.size) return { score: 0, shared: [] };
	const shared = [...left].filter((token) => right.has(token));
	return {
		score: Number((shared.length / Math.max(1, Math.min(left.size, right.size))).toFixed(4)),
		shared: shared.sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-CN")).slice(0, 10)
	};
}

function classify({ source, target, relation, readiness, sourceMentionsTarget, targetMentionsSource, sources, domains, overlap }) {
	if (source.meta.type === "conflict" && relation.type !== "involves") {
		return {
			bucket: "conflict_role_migration",
			priority: 0,
			reason: "conflict 是争议档案；非 involves 出边必须迁回真实立场卡或移除。"
		};
	}
	if (relation.type === "involves" && source.meta.type === "conflict") {
		const directlyNamed = sourceMentionsTarget.length > 0 || targetMentionsSource.length > 0;
		return {
			bucket: directlyNamed ? "direct_evidence_review" : "semantic_review",
			priority: directlyNamed ? 1 : 2,
			reason: directlyNamed
				? "争议档案正文直接出现参与方，可优先核对并补充具体争议角色。"
				: "方向符合契约，但需核实目标是否确为争议参与方。"
		};
	}
	const directMention = sourceMentionsTarget.length > 0 || targetMentionsSource.length > 0;
	const commonSource = sources.length > 0;
	if (directMention && commonSource) return {
		bucket: "direct_evidence_review", priority: 1,
		reason: "端点正文互指且共享来源，适合优先精读后补证或改型。"
	};
	if (directMention || (commonSource && overlap.score >= 0.08)) return {
		bucket: "evidence_candidate", priority: 2,
		reason: directMention
			? "正文存在直接互指，但仍需核对关系方向与语义。"
			: "端点共享来源且语义重合较高，具备局部精读价值。"
	};
	if (readiness.reason_codes.includes("vague_relation_note")) return {
		bucket: "semantic_review", priority: 2,
		reason: "已有说明过于空泛，不能把旧 note 直接扩写为证据。"
	};
	if (domains.length > 0 || overlap.score >= 0.06) return {
		bucket: "semantic_review", priority: 3,
		reason: "只有领域或语义相近信号，必须精读，不能自动保留。"
	};
	return {
		bucket: "removal_review", priority: 4,
		reason: "未发现正文互指、共享来源或足够语义重合，应优先核查是否为主题相似误连。"
	};
}

function bump(record, key) {
	record[key] = (record[key] ?? 0) + 1;
}

function buildAudit(root) {
	const cards = loadCards(root);
	const tokenCache = new Map([...cards].map(([id, card]) => [id, semanticTokens(card)]));
	const items = [];
	const counts = { reasons: {}, relation_types: {}, buckets: {}, source_types: {}, signatures: {} };
	let totalRelations = 0;

	for (const [sourceId, source] of cards) {
		const relations = Array.isArray(source.meta.relations) ? source.meta.relations : [];
		for (const relation of relations) {
			totalRelations += 1;
			const targetId = String(relation?.target ?? "");
			const target = cards.get(targetId);
			const readiness = relationReadiness(source, relation, target);
			if (readiness.level !== "legacy_candidate") continue;
			const sourceMentionsTarget = target ? mentions(source, target) : [];
			const targetMentionsSource = target ? mentions(target, source) : [];
			const sources = target ? sharedSources(source, target) : [];
			const domains = target ? sharedDomains(source, target) : [];
			const overlap = target
				? tokenOverlap(tokenCache.get(sourceId), tokenCache.get(targetId))
				: { score: 0, shared: [] };
			const classification = classify({
				source, target, relation, readiness, sourceMentionsTarget, targetMentionsSource, sources, domains, overlap
			});
			for (const reason of readiness.reason_codes) bump(counts.reasons, reason);
			bump(counts.relation_types, relation.type);
			bump(counts.buckets, classification.bucket);
			bump(counts.source_types, source.meta.type);
			bump(counts.signatures, `${source.meta.type}->${relation.type}->${target?.meta?.type ?? "missing"}`);
			items.push({
				source_id: sourceId,
				source_title: String(source.meta.title ?? sourceId),
				source_type: String(source.meta.type ?? ""),
				target_id: targetId,
				target_title: String(target?.meta?.title ?? targetId),
				target_type: String(target?.meta?.type ?? ""),
				relation_type: String(relation?.type ?? ""),
				note: String(relation?.note ?? ""),
				readiness_reasons: readiness.reason_codes,
				bucket: classification.bucket,
				priority: classification.priority,
				classification_reason: classification.reason,
				evidence_signals: {
					source_mentions_target: sourceMentionsTarget,
					target_mentions_source: targetMentionsSource,
					shared_sources: sources,
					shared_domains: domains,
					semantic_overlap: overlap.score,
					shared_tokens: overlap.shared
				},
				source_file: source.file,
				target_file: target?.file ?? ""
			});
		}
	}

	items.sort((left, right) => (
		left.priority - right.priority
		|| right.evidence_signals.shared_sources.length - left.evidence_signals.shared_sources.length
		|| right.evidence_signals.semantic_overlap - left.evidence_signals.semantic_overlap
		|| left.source_id.localeCompare(right.source_id, "zh-CN")
		|| left.target_id.localeCompare(right.target_id, "zh-CN")
	));
	return {
		generated_at: new Date().toISOString(),
		root,
		active_cards: cards.size,
		total_relations: totalRelations,
		legacy_candidates: items.length,
		counts,
		classification_contract: {
			direct_evidence_review: "具备直接互指或争议参与方证据，优先精读；不自动写入。",
			evidence_candidate: "具备共享来源或较强文本证据，需核对关系方向。",
			conflict_role_migration: "conflict 非 involves 出边，迁回立场卡或移除。",
			semantic_review: "只能确认主题或语义接近，必须人工/模型精读。",
			removal_review: "缺乏可见证据信号，优先核查是否为误连。"
		},
		items
	};
}

const args = argsOf(process.argv.slice(2));
const audit = buildAudit(args.root);
const output = isAbsolute(args.output) ? args.output : join(args.root, args.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(audit, null, 2)}\n`, "utf8");

const summary = {
	output,
	active_cards: audit.active_cards,
	total_relations: audit.total_relations,
	legacy_candidates: audit.legacy_candidates,
	reasons: audit.counts.reasons,
	buckets: audit.counts.buckets,
	relation_types: audit.counts.relation_types
};
process.stdout.write(`${JSON.stringify(args.stdout ? audit : summary, null, 2)}\n`);
