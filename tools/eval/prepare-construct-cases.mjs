#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DECISIONS = ["keep", "change", "remove", "defer"];
const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

function relationKey(review) {
	return `${review.source_id}\u0000${review.old_relation_type}\u0000${review.target_id}`;
}

export function collectConstructCandidates(inputDirectory, { minimumConfidence = "medium" } = {}) {
	if (!existsSync(inputDirectory)) return [];
	const selected = new Map();
	for (const name of readdirSync(inputDirectory).filter((item) => /^model-relation-review.*\.jsonl$/u.test(item)).sort()) {
		const path = resolve(inputDirectory, name);
		let lineNumber = 0;
		for (const line of readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean)) {
			lineNumber++;
			let record;
			try { record = JSON.parse(line); } catch { continue; }
			for (const review of record.reviews ?? []) {
				if (!DECISIONS.includes(review?.decision)) continue;
				if ((CONFIDENCE_RANK[review.confidence] ?? 0) < (CONFIDENCE_RANK[minimumConfidence] ?? 2)) continue;
				const key = relationKey(review);
				const candidate = {
					case_key: key,
					status: "candidate_requires_human_validation",
					provenance: { file: name, line: lineNumber, reviewed_at: record.at ?? null },
					source_id: review.source_id,
					target_id: review.target_id,
					old_relation_type: review.old_relation_type,
					expected: {
						decision: review.decision,
						new_source_id: review.new_source_id || null,
						new_target_id: review.new_target_id || null,
						new_relation_type: review.new_relation_type || null,
						note: review.note || null
					},
					confidence: review.confidence,
					evidence_summary: review.evidence || "",
					reason: review.reason || "",
					fixture_requirements: [
						"人工确认裁决仍然成立",
						"冻结裁决时可见的源卡与目标卡版本",
						"补充支持、反证和边界锚点",
						"标注是否涉及 conflict、镜像、枢纽、跨域或路径切断"
					]
				};
				const prior = selected.get(key);
				if (!prior || (CONFIDENCE_RANK[candidate.confidence] ?? 0) > (CONFIDENCE_RANK[prior.confidence] ?? 0)) selected.set(key, candidate);
			}
		}
	}
	return [...selected.values()];
}

export function balancedConstructSample(candidates, limit = 100) {
	const buckets = new Map(DECISIONS.map((decision) => [decision, candidates
		.filter((item) => item.expected.decision === decision)
		.sort((left, right) => (CONFIDENCE_RANK[right.confidence] ?? 0) - (CONFIDENCE_RANK[left.confidence] ?? 0)
			|| left.case_key.localeCompare(right.case_key, "zh-CN"))]));
	const output = [];
	let index = 0;
	while (output.length < limit) {
		let added = false;
		for (const decision of DECISIONS) {
			const candidate = buckets.get(decision)?.[index];
			if (!candidate || output.length >= limit) continue;
			output.push({ case_id: `CR-${String(output.length + 1).padStart(3, "0")}`, ...candidate });
			added = true;
		}
		if (!added) break;
		index++;
	}
	return output;
}

export function prepareConstructCases({ inputDirectory, output, limit = 100, minimumConfidence = "medium" }) {
	const candidates = collectConstructCandidates(inputDirectory, { minimumConfidence });
	const sample = balancedConstructSample(candidates, limit);
	if (output) {
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, `${sample.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
	}
	return {
		input_directory: inputDirectory,
		output: output ?? null,
		candidate_total: candidates.length,
		sample_total: sample.length,
		by_decision: Object.fromEntries(DECISIONS.map((decision) => [decision, sample.filter((item) => item.expected.decision === decision).length])),
		status: "candidate_manifest_only_not_gold"
	};
}

function argsOf(argv) {
	const values = Object.fromEntries(argv.map((item) => {
		const [key, ...rest] = item.replace(/^--/u, "").split("=");
		return [key, rest.join("=")];
	}));
	const root = resolve(values.root || ".");
	return {
		inputDirectory: resolve(root, values.input || ".nexogenesis/graph"),
		output: values.output ? resolve(root, values.output) : null,
		limit: Math.max(1, Math.min(500, Number(values.limit) || 100)),
		minimumConfidence: values["min-confidence"] || "medium"
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.stdout.write(`${JSON.stringify(prepareConstructCases(argsOf(process.argv.slice(2))), null, 2)}\n`);
}
