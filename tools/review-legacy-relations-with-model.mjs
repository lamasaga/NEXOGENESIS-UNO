#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCards } from "../packages/nexogenesis-tools/lib/cards.js";
import { allowedSignature, RELATION_TYPES, relationReadiness } from "../packages/nexogenesis-tools/lib/harness/relation-semantics.js";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = ".nexogenesis/graph/model-relation-review.jsonl";
const API_KEY = process.env.DEEPSEEK_API_KEY;

function parseArgs(argv) {
	const args = {
		root: DEFAULT_ROOT,
		audit: ".nexogenesis/graph/legacy-relations-audit.json",
		output: DEFAULT_OUTPUT,
		model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
		baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
		limit: 1,
		resume: false,
		relationsPerBatch: 12,
		concurrency: 2
	};
	for (const item of argv) {
		if (item === "--resume") args.resume = true;
		else if (item.startsWith("--root=")) args.root = resolve(item.slice("--root=".length));
		else if (item.startsWith("--audit=")) args.audit = item.slice("--audit=".length);
		else if (item.startsWith("--output=")) args.output = item.slice("--output=".length);
		else if (item.startsWith("--model=")) args.model = item.slice("--model=".length);
		else if (item.startsWith("--base-url=")) args.baseUrl = item.slice("--base-url=".length);
		else if (item.startsWith("--limit=")) args.limit = Math.max(1, Number(item.slice("--limit=".length)) || 1);
		else if (item.startsWith("--relations-per-batch=")) args.relationsPerBatch = Math.max(1, Math.min(16, Number(item.slice("--relations-per-batch=".length)) || 12));
		else if (item.startsWith("--concurrency=")) args.concurrency = Math.max(1, Math.min(4, Number(item.slice("--concurrency=".length)) || 2));
	}
	args.audit = resolve(args.root, args.audit);
	args.output = resolve(args.root, args.output);
	return args;
}

function compactBody(body, limit = 1500) {
	return String(body ?? "")
		.replace(/<!--[^>]*-->/gu, " ")
		.replace(/^>.*$/gmu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, limit);
}

function cardPacket(card) {
	return {
		id: String(card?.meta?.id ?? ""),
		title: String(card?.meta?.title ?? card?.meta?.id ?? ""),
		type: String(card?.meta?.type ?? ""),
		domains: Array.isArray(card?.meta?.domains) ? card.meta.domains : [],
		sources: Array.isArray(card?.meta?.sources) ? card.meta.sources.slice(0, 8) : [],
		body: compactBody(card?.body)
	};
}

function relationKey(item) {
	return `${item.source_id}\u0000${item.relation_type}\u0000${item.target_id}`;
}

function reviewedKeys(path) {
	const keys = new Set();
	if (!existsSync(path)) return keys;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
		try {
			const record = JSON.parse(line);
			for (const review of record.reviews ?? []) keys.add(relationKey({
				source_id: review.source_id,
				relation_type: review.old_relation_type,
				target_id: review.target_id
			}));
		} catch { /* 损坏的单行不会阻断后续批次，可由最终汇总报告指出。 */ }
	}
	return keys;
}

function groupBySource(items) {
	const groups = new Map();
	for (const item of items) {
		const list = groups.get(item.source_id) ?? [];
		list.push(item);
		groups.set(item.source_id, list);
	}
	return [...groups.entries()]
		.map(([source_id, relations]) => ({ source_id, relations }))
		.sort((left, right) => right.relations.length - left.relations.length || left.source_id.localeCompare(right.source_id, "zh-CN"));
}

function packGroups(groups, relationLimit) {
	const batches = [];
	let current = [];
	let count = 0;
	for (const group of groups) {
		if (current.length > 0 && (count + group.relations.length > relationLimit || current.length >= 4)) {
			batches.push(current);
			current = [];
			count = 0;
		}
		current.push(group);
		count += group.relations.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function systemPrompt() {
	return `你是知识图谱历史关系审稿人。你的任务不是美化旧边，而是判断它能否用于多跳推理。

关系语义：supports=源对象给目标提供证据；based-on=源对象成立依赖目标；extends=源对象保留目标核心并扩展；example-of=源对象是目标实例；conflicts-with=两个立场直接冲突；part-of=源对象是目标结构组成；applies-to=源对象适用于目标；influences=源对象条件性改变目标概率、方向或强度；precedes=可核验的时序先于；characterizes=源知识描述目标实体；attributed-to=源思想明确归于目标实体。

硬规则：
1. domain 不参与关系。conflict 作为争议档案只能用 involves 发出参与方边。
2. 标题相似、同领域、共享关键词或共同来源本身都不足以证明关系。
3. 优先删除重复反向边、含义不清的 influences、仅表示“有关”的边。
4. influences 只用于源对象确实改变目标对象的概率、方向或强度；两个变量共同决定第三个结果、同处一条链或仅被一起讨论，不构成彼此 influences。
5. based-on 只用于源对象的成立依赖目标对象；来源更早、目标更宽、同属一个框架或教学章节相邻，不构成 based-on。若源是目标机制的组成环节，考虑 part-of；若目标才依赖源，应反转方向。
6. 冲突档案作为 target 时，若源其实是争议参与立场，应改成 conflict → involves → 源对象；不得用源 supports/applies-to conflict 表示参与。
7. keep 必须给出具体 note，说明端点、方向、机制/证据和必要边界；change 可改类型、反转方向，必须给出新端点与 note。
8. 证据不足时选择 remove 或 defer，不得编造正文没有的信息；方向无法从正文确认时不要 keep。
9. 不输出思维过程，只输出 JSON 对象：{"reviews":[...]}。

每项 review 字段固定为：source_id、target_id、old_relation_type、decision（keep/change/remove/defer）、new_source_id、new_target_id、new_relation_type（keep 时保持原端点与旧类型；remove/defer 可为空）、note（keep/change 必填）、confidence（high/medium/low）、evidence（用一两句话指出正文依据）、reason。change 反转方向时 new_source_id=原 target_id、new_target_id=原 source_id。`;
}

async function callModel(args, payload, attempt = 1) {
	const requestModel = attempt >= 3 && args.model === "deepseek-reasoner" ? "deepseek-chat" : args.model;
	const response = await fetch(`${args.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({
			model: requestModel,
			temperature: 0,
			max_tokens: 8192,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: systemPrompt() },
				{ role: "user", content: JSON.stringify(payload) }
			]
		})
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		if (attempt < 3 && [408, 429, 500, 502, 503, 504].includes(response.status)) {
			await new Promise((done) => setTimeout(done, 1200 * attempt));
			return callModel(args, payload, attempt + 1);
		}
		throw new Error(`模型请求失败 ${response.status}: ${detail}`);
	}
	const data = await response.json();
	const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
	try {
		if (!content) throw new Error("模型返回空 content");
		return JSON.parse(content);
	} catch (error) {
		if (attempt < 3) {
			await new Promise((done) => setTimeout(done, 1200 * attempt));
			return callModel(args, payload, attempt + 1);
		}
		throw new Error(`模型 JSON 无法解析：${error.message}`);
	}
}

function validateReview(groups, cards, response) {
	const relations = groups.flatMap((group) => group.relations);
	const expected = new Map(relations.map((item) => [relationKey(item), item]));
	const accepted = [];
	const rejected = [];
	for (const review of response?.reviews ?? []) {
		const key = relationKey({ source_id: review.source_id, relation_type: review.old_relation_type, target_id: review.target_id });
		const original = expected.get(key);
		if (!original) {
			rejected.push({ review, reason: "模型返回了批次之外的关系" });
			continue;
		}
		const decision = String(review.decision ?? "");
		if (!["keep", "change", "remove", "defer"].includes(decision)) {
			rejected.push({ review, reason: "decision 不在闭集" });
			continue;
		}
		if (["keep", "change"].includes(decision)) {
			const type = decision === "keep" ? original.relation_type : String(review.new_relation_type ?? "");
			const newSourceId = decision === "keep" ? original.source_id : String(review.new_source_id ?? original.source_id);
			const newTargetId = decision === "keep" ? original.target_id : String(review.new_target_id ?? original.target_id);
			if (!new Set([original.source_id, original.target_id]).has(newSourceId)
				|| !new Set([original.source_id, original.target_id]).has(newTargetId)
				|| newSourceId === newTargetId) {
				rejected.push({ review, reason: "change 只能在原有两个端点之间改型或反转" });
				continue;
			}
			const source = cards.get(newSourceId);
			const target = cards.get(newTargetId);
			if (!RELATION_TYPES.has(type) || !allowedSignature(type, source?.meta?.type, target?.meta?.type)) {
				rejected.push({ review, reason: "新关系类型或方向不合法" });
				continue;
			}
			const readiness = relationReadiness(source, { target: newTargetId, type, note: review.note }, target);
			if (!readiness.ready) {
				rejected.push({ review, reason: `note 未达到 ready：${readiness.reason_codes.join(",")}` });
				continue;
			}
			review.new_relation_type = type;
			review.new_source_id = newSourceId;
			review.new_target_id = newTargetId;
		}
		expected.delete(key);
		accepted.push(review);
	}
	for (const item of expected.values()) rejected.push({ item, reason: "模型漏答" });
	return { accepted, rejected };
}

const args = parseArgs(process.argv.slice(2));
if (!API_KEY) throw new Error("环境中没有 DEEPSEEK_API_KEY；本工具不会读取或打印密钥文件");
const audit = JSON.parse(readFileSync(args.audit, "utf8"));
const cards = loadCards(args.root);
const done = args.resume ? reviewedKeys(args.output) : new Set();
if (!args.resume) {
	mkdirSync(dirname(args.output), { recursive: true });
	writeFileSync(args.output, "", "utf8");
}
const remaining = audit.items.filter((item) => !done.has(relationKey(item)));
const batches = packGroups(groupBySource(remaining), args.relationsPerBatch).slice(0, args.limit);
let accepted = 0;
let rejected = 0;

async function reviewBatch(groups, index) {
	const payload = {
		groups: groups.map((group) => ({
			source: cardPacket(cards.get(group.source_id)),
			relations: group.relations.map((item) => ({
				old_relation: { type: item.relation_type, target: item.target_id, note: item.note },
				target: cardPacket(cards.get(item.target_id)),
				audit_signals: item.evidence_signals
			}))
		}))
	};
	const response = await callModel(args, payload);
	const checked = validateReview(groups, cards, response);
	const record = {
		at: new Date().toISOString(),
		source_ids: groups.map((group) => group.source_id),
		reviews: checked.accepted,
		rejected: checked.rejected
	};
	appendFileSync(args.output, `${JSON.stringify(record)}\n`, "utf8");
	accepted += checked.accepted.length;
	rejected += checked.rejected.length;
	process.stdout.write(`${JSON.stringify({ batch: index + 1, total: batches.length, source_ids: record.source_ids, accepted: checked.accepted.length, rejected: checked.rejected.length })}\n`);
}

let cursor = 0;
async function worker() {
	while (cursor < batches.length) {
		const index = cursor;
		cursor += 1;
		try {
			await reviewBatch(batches[index], index);
		} catch (error) {
			rejected += batches[index].flatMap((group) => group.relations).length;
			process.stdout.write(`${JSON.stringify({ batch: index + 1, total: batches.length, source_ids: batches[index].map((group) => group.source_id), error: error.message })}\n`);
		}
	}
}
await Promise.all(Array.from({ length: Math.min(args.concurrency, batches.length) }, () => worker()));

process.stdout.write(`${JSON.stringify({ output: args.output, batches: batches.length, accepted, rejected }, null, 2)}\n`);
