#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadCards, validateCardRecord } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway } from "../packages/nexogenesis-tools/lib/harness/gateway.js";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const args = { root: DEFAULT_ROOT, decisions: "", apply: false, batchSize: 3 };
	for (const item of argv) {
		if (item === "--apply") args.apply = true;
		else if (item.startsWith("--root=")) args.root = resolve(item.slice("--root=".length));
		else if (item.startsWith("--decisions=")) args.decisions = item.slice("--decisions=".length);
		else if (item.startsWith("--batch-size=")) args.batchSize = Math.max(1, Math.min(3, Number(item.slice("--batch-size=".length)) || 3));
	}
	if (!args.decisions) throw new Error("必须提供 --decisions=<json>");
	args.decisions = isAbsolute(args.decisions) ? args.decisions : resolve(args.root, args.decisions);
	return args;
}

function signature(relation, decision) {
	return String(relation?.type ?? "") === String(decision.relation_type)
		&& String(relation?.target ?? "") === String(decision.target_id);
}

function operationFromCard(card, relations) {
	return validateCardRecord({
		...card.meta,
		relations,
		updated: new Date().toISOString().slice(0, 10),
		body: card.body
	});
}

function buildOperations(root, decisions) {
	const cards = loadCards(root);
	const grouped = new Map();
	for (const decision of decisions) {
		if (!["upsert", "remove"].includes(decision?.action)) throw new Error(`未知 action：${decision?.action}`);
		if (!decision?.source_id || !decision?.target_id || !decision?.relation_type) throw new Error("每项决定都必须包含 source_id、target_id、relation_type");
		if (decision.action === "upsert" && !String(decision.note ?? "").trim()) throw new Error("upsert 决定必须包含 note");
		const list = grouped.get(decision.source_id) ?? [];
		list.push(decision);
		grouped.set(decision.source_id, list);
	}
	const operations = [];
	for (const [sourceId, sourceDecisions] of grouped) {
		const card = cards.get(sourceId);
		if (!card) throw new Error(`来源卡不存在：${sourceId}`);
		let relations = Array.isArray(card.meta.relations) ? [...card.meta.relations] : [];
		for (const decision of sourceDecisions) {
			const before = relations.length;
			relations = relations.filter((relation) => !signature(relation, decision));
			if (decision.action === "remove" && before === relations.length) {
				throw new Error(`未找到待移除关系：${sourceId} ${decision.relation_type} ${decision.target_id}`);
			}
			if (decision.action === "upsert") relations.push({
				target: decision.target_id,
				type: decision.relation_type,
				note: String(decision.note).trim()
			});
		}
		operations.push({ source_id: sourceId, decisions: sourceDecisions, operation: operationFromCard(card, relations) });
	}
	return operations;
}

function chunks(items, size) {
	const result = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

const args = parseArgs(process.argv.slice(2));
const payload = JSON.parse(readFileSync(args.decisions, "utf8"));
const decisions = Array.isArray(payload) ? payload : payload.decisions;
if (!Array.isArray(decisions) || decisions.length === 0) throw new Error("决定文件没有 decisions");
const operations = buildOperations(args.root, decisions);
const summary = {
	decisions: args.decisions,
	apply: args.apply,
	atomic_decisions: decisions.length,
	changed_cards: operations.length,
	committed_batches: 0
};

const gateway = new HarnessGateway(args.root);
for (const [batchIndex, batch] of chunks(operations, args.batchSize).entries()) {
	const checked = gateway.preflight({ operations: batch.map((item) => item.operation), layer: "relation" });
	if (!args.apply) continue;
	gateway.commit({
		proposal_id: `legacy-relation-decisions-${Date.now()}-${batchIndex + 1}`,
		operations: checked.cards,
		layer: checked.layer,
		revisions: checked.revisions
	});
	summary.committed_batches += 1;
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
