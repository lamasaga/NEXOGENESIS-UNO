#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCards, validateCardRecord } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway } from "../packages/nexogenesis-tools/lib/harness/gateway.js";
import { relationReadiness } from "../packages/nexogenesis-tools/lib/harness/relation-semantics.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
	const args = { root: DEFAULT_ROOT, phase: "conflict-contract", apply: false, batchSize: 3 };
	for (const item of argv) {
		if (item === "--apply") args.apply = true;
		else if (item.startsWith("--root=")) args.root = resolve(item.slice("--root=".length));
		else if (item.startsWith("--phase=")) args.phase = item.slice("--phase=".length);
		else if (item.startsWith("--batch-size=")) args.batchSize = Math.max(1, Math.min(3, Number(item.slice("--batch-size=".length)) || 3));
	}
	if (!["conflict-contract", "reciprocal-conflict-edges"].includes(args.phase)) {
		throw new Error("phase 必须是 conflict-contract 或 reciprocal-conflict-edges");
	}
	return args;
}

function stripMarkdown(value) {
	return String(value ?? "")
		.replace(/<!--[^>]*-->/gu, " ")
		.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu, "$1")
		.replace(/[*_`>#]/gu, " ")
		.replace(/^\s*[-+•]\s*/u, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function aliasesOf(target) {
	return [...new Set([
		String(target?.meta?.title ?? "").trim(),
		String(target?.meta?.id ?? "").trim(),
		...(Array.isArray(target?.meta?.aliases) ? target.meta.aliases : [])
	].filter((item) => item.length >= 2))];
}

function directEvidenceLine(conflict, target) {
	const aliases = aliasesOf(target);
	const lines = String(conflict?.body ?? "").split(/\r?\n/);
	const candidates = lines.map(stripMarkdown).filter((line) => line.length >= 4);
	for (const alias of aliases) {
		const exact = candidates.find((line) => line.includes(alias));
		if (exact) return exact;
	}
	return "";
}

function stanceSummary(target) {
	const body = String(target?.body ?? "")
		.replace(/<!--[^>]*-->/gu, " ")
		.replace(/^#{1,6}\s+.+$/gmu, " ")
		.replace(/^>.*$/gmu, " ");
	const sentences = body.split(/[。！？!?；;\n]/u).map(stripMarkdown).filter((item) => (
		item.length >= 12 && item.length <= 140 && !/^(?:来源|原文摘录|证据边界)/u.test(item)
	));
	return (sentences[0] ?? stripMarkdown(body).slice(0, 120)).slice(0, 140);
}

function operationFromCard(card, relations) {
	return validateCardRecord({
		...card.meta,
		relations,
		updated: new Date().toISOString().slice(0, 10),
		body: card.body
	});
}

function buildConflictContractPlan(root) {
	const cards = loadCards(root);
	const changes = [];
	for (const [id, card] of cards) {
		if (card.meta.type !== "conflict") continue;
		let removed = 0;
		let repaired = 0;
		let deferred = 0;
		const relations = [];
		for (const relation of Array.isArray(card.meta.relations) ? card.meta.relations : []) {
			if (relation.type !== "involves") {
				removed += 1;
				continue;
			}
			const target = cards.get(String(relation.target ?? ""));
			const readiness = relationReadiness(card, relation, target);
			if (readiness.ready) {
				relations.push(relation);
				continue;
			}
			const evidence = target ? directEvidenceLine(card, target) : "";
			if (!evidence) {
				deferred += 1;
				relations.push(relation);
				continue;
			}
			repaired += 1;
			relations.push({
				target: relation.target,
				type: "involves",
				note: `争议档案正文明确列出“${target.meta.title ?? relation.target}”为参与方；该方立场是：${stanceSummary(target)}`
			});
		}
		if (removed === 0 && repaired === 0) continue;
		changes.push({
			card_id: id,
			removed_non_involves: removed,
			repaired_involves: repaired,
			deferred_involves: deferred,
			before_relations: Array.isArray(card.meta.relations) ? card.meta.relations : [],
			operation: operationFromCard(card, relations)
		});
	}
	return changes;
}

function buildReciprocalConflictPlan(root) {
	const cards = loadCards(root);
	const changes = [];
	for (const [id, card] of cards) {
		if (card.meta.type === "conflict") continue;
		const currentRelations = Array.isArray(card.meta.relations) ? card.meta.relations : [];
		const removed = [];
		const relations = currentRelations.filter((relation) => {
			const target = cards.get(String(relation?.target ?? ""));
			if (target?.meta?.type !== "conflict") return true;
			const reciprocal = (Array.isArray(target.meta.relations) ? target.meta.relations : [])
				.some((candidate) => candidate?.type === "involves" && candidate?.target === id);
			if (!reciprocal) return true;
			removed.push(relation);
			return false;
		});
		if (removed.length === 0) continue;
		changes.push({
			card_id: id,
			removed_reciprocal_edges: removed,
			before_relations: currentRelations,
			operation: operationFromCard(card, relations)
		});
	}
	return changes;
}

function chunks(items, size) {
	const result = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

function writePlan(root, phase, changes) {
	const path = resolve(root, `.nexogenesis/graph/${phase}-migration.json`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({
		generated_at: new Date().toISOString(),
		phase,
		cards: changes.map(({ operation, ...change }) => ({
			...change,
			after_relations: operation.relations
		}))
	}, null, 2)}\n`, "utf8");
	return path;
}

const args = parseArgs(process.argv.slice(2));
const changes = args.phase === "conflict-contract"
	? buildConflictContractPlan(args.root)
	: buildReciprocalConflictPlan(args.root);
const planPath = writePlan(args.root, args.phase, changes);
const summary = {
	phase: args.phase,
	apply: args.apply,
	plan: planPath,
	changed_cards: changes.length,
	removed_non_involves: changes.reduce((sum, item) => sum + (item.removed_non_involves ?? 0), 0),
	removed_reciprocal_edges: changes.reduce((sum, item) => sum + (item.removed_reciprocal_edges?.length ?? 0), 0),
	repaired_involves: changes.reduce((sum, item) => sum + (item.repaired_involves ?? 0), 0),
	deferred_involves: changes.reduce((sum, item) => sum + (item.deferred_involves ?? 0), 0),
	committed_batches: 0
};

if (args.apply) {
	const gateway = new HarnessGateway(args.root);
	for (const [batchIndex, batch] of chunks(changes, args.batchSize).entries()) {
		const checked = gateway.preflight({ operations: batch.map((item) => item.operation), layer: "relation" });
		gateway.commit({
			proposal_id: `legacy-conflict-contract-${Date.now()}-${batchIndex + 1}`,
			operations: checked.cards,
			layer: checked.layer,
			revisions: checked.revisions
		});
		summary.committed_batches += 1;
	}
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
