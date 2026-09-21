import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, validateAnswer } from "./schema.mjs";

function probabilitySums(value, path = "$") {
	const failures = [];
	if (Array.isArray(value)) {
		const probabilities = value.map((item) => item && typeof item === "object" ? item.probability : undefined);
		if (value.length >= 2 && probabilities.every((item) => typeof item === "number")) {
			const sum = probabilities.reduce((total, item) => total + item, 0);
			if (Math.abs(sum - 1) > 0.0001 && Math.abs(sum - 100) > 0.01) failures.push({ path, code: "probability_sum", sum });
		}
		value.forEach((item, index) => failures.push(...probabilitySums(item, `${path}[${index}]`)));
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) failures.push(...probabilitySums(child, `${path}.${key}`));
	}
	return failures;
}

function crossFieldChecks(value, path = "$") {
	const failures = [];
	if (Array.isArray(value)) {
		value.forEach((item, index) => failures.push(...crossFieldChecks(item, `${path}[${index}]`)));
		return failures;
	}
	if (!value || typeof value !== "object") return failures;
	const interval50 = value.interval_50;
	const interval90 = value.interval_90;
	if (typeof value.point === "number" && Array.isArray(interval50) && interval50.length === 2 && Array.isArray(interval90) && interval90.length === 2) {
		if (!(interval50[0] <= value.point && value.point <= interval50[1])) failures.push({ path, code: "point_outside_interval_50" });
		if (!(interval90[0] <= value.point && value.point <= interval90[1])) failures.push({ path, code: "point_outside_interval_90" });
		if (!(interval90[0] <= interval50[0] && interval50[1] <= interval90[1])) failures.push({ path, code: "interval_90_not_cover_interval_50" });
	}
	const children = Object.values(value).filter((child) => child && typeof child === "object" && !Array.isArray(child));
	for (const rankKey of ["severity_rank", "drawdown_rank"]) {
		const ranks = children.map((child) => child[rankKey]).filter((rank) => Number.isInteger(rank));
		if (ranks.length >= 2 && new Set(ranks).size !== ranks.length) failures.push({ path, code: "duplicate_rank", rank_key: rankKey, ranks });
	}
	for (const [key, child] of Object.entries(value)) failures.push(...crossFieldChecks(child, `${path}.${key}`));
	return failures;
}

export function scoreStructure(schema, answer, { asOf } = {}) {
	const schemaResult = validateAnswer(schema, answer);
	const crossFieldErrors = [...probabilitySums(answer), ...crossFieldChecks(answer)];
	if (asOf && answer?.as_of !== asOf) crossFieldErrors.push({ path: "$.as_of", code: "as_of_mismatch", expected: asOf, actual: answer?.as_of });
	return {
		schema_valid: schemaResult.valid,
		cross_fields_valid: crossFieldErrors.length === 0,
		errors: [...schemaResult.errors, ...crossFieldErrors]
	};
}

function argsOf(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 2) out[argv[index]?.replace(/^--/, "")] = argv[index + 1];
	return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = argsOf(process.argv.slice(2));
	if (!args.schema || !args.answer) throw new Error("需要 --schema 与 --answer");
	const answer = JSON.parse(readFileSync(resolve(args.answer), "utf8"));
	console.log(JSON.stringify(scoreStructure(readJson(resolve(args.schema)), answer, { asOf: args["as-of"] }), null, 2));
}
