#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
	const [key, ...value] = item.replace(/^--/u, "").split("=");
	return [key, value.join("=")];
}));
const root = resolve(args.root || ".");
const input = resolve(root, args.input || ".nexogenesis/graph/model-relation-review.jsonl");
const output = resolve(root, args.output || ".nexogenesis/graph/model-relation-decisions.json");
const minimumConfidence = args["min-confidence"] || "medium";
const confidenceRank = { low: 1, medium: 2, high: 3 };
const decisions = [];
const deferred = [];
const rejected = [];

function durableNote(review) {
	return String(review.note ?? "")
		.replace(/\bsource\b/giu, `“${review.source_id}”`)
		.replace(/\btarget\b/giu, `“${review.target_id}”`)
		.replace(/源卡/gu, `“${review.source_id}”`)
		.replace(/目标卡/gu, `“${review.target_id}”`)
		.replace(/\s+/gu, " ")
		.trim();
}

for (const line of readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean)) {
	const record = JSON.parse(line);
	rejected.push(...(record.rejected ?? []).map((item) => ({ source_ids: record.source_ids ?? [record.source_id].filter(Boolean), ...item })));
	for (const review of record.reviews ?? []) {
		if ((confidenceRank[review.confidence] ?? 0) < (confidenceRank[minimumConfidence] ?? 2)) {
			deferred.push({ ...review, reason: `${review.reason ?? ""}（低于自动编译置信门槛 ${minimumConfidence}）` });
			continue;
		}
		if (review.decision === "defer") {
			deferred.push(review);
			continue;
		}
		if (review.decision === "remove") {
			decisions.push({
				source_id: review.source_id,
				action: "remove",
				relation_type: review.old_relation_type,
				target_id: review.target_id,
				reason: review.reason
			});
			continue;
		}
		const newSourceId = review.new_source_id || review.source_id;
		const newTargetId = review.new_target_id || review.target_id;
		const changedSignature = review.decision === "change" && (
			review.new_relation_type !== review.old_relation_type
			|| newSourceId !== review.source_id
			|| newTargetId !== review.target_id
		);
		if (changedSignature) {
			decisions.push({
				source_id: review.source_id,
				action: "remove",
				relation_type: review.old_relation_type,
				target_id: review.target_id,
				reason: review.reason
			});
		}
		decisions.push({
			source_id: newSourceId,
			action: "upsert",
			relation_type: review.new_relation_type,
			target_id: newTargetId,
			note: durableNote(review),
			reason: review.reason
		});
	}
}

writeFileSync(output, `${JSON.stringify({ input, decisions, deferred, rejected }, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, decisions: decisions.length, deferred: deferred.length, rejected: rejected.length }, null, 2)}\n`);
