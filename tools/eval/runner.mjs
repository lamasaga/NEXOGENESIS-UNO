import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCase } from "./schema.mjs";
import { materializeFixture } from "./materialize-fixture.mjs";

function argsOf(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 2) out[argv[index]?.replace(/^--/, "")] = argv[index + 1];
	return out;
}

export function prepareRunPlan({ caseId, profile = "E_thinking_body_v1", variant = "anonymous", repeat = 3, outputRoot }) {
	const { case: caseData } = findCase(caseId);
	const root = resolve(outputRoot);
	mkdirSync(root, { recursive: true });
	const runs = [];
	for (let repetition = 1; repetition <= repeat; repetition += 1) {
		for (const checkpoint of caseData.checkpoints) {
			const target = join(root, `repeat-${repetition}`, checkpoint.id);
			const prepared = materializeFixture({ caseId, checkpointId: checkpoint.id, variant, profileName: profile, outputRoot: target });
			runs.push({
				repetition,
				checkpoint: checkpoint.id,
				root: prepared.root,
				scope_file: join(prepared.root, ".eval", "run-scope.json"),
				questions_file: join(prepared.root, ".eval", "questions.jsonl"),
				output_schema_file: join(prepared.root, ".eval", "output-schema.json"),
				answer_file: join(root, `repeat-${repetition}`, "answers", `${checkpoint.id}.json`),
				previous_answer_file: checkpoint.id === caseData.checkpoints[0].id ? null : join(root, `repeat-${repetition}`, "answers", `${caseData.checkpoints[caseData.checkpoints.findIndex((item) => item.id === checkpoint.id) - 1].id}.json`)
			});
		}
	}
	const plan = { plan_version: "1.0", case_id: caseId, dataset_version: caseData.dataset_version, profile, variant, repeat, runs };
	writeFileSync(join(root, "run-plan.json"), JSON.stringify(plan, null, 2), "utf8");
	return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = argsOf(process.argv.slice(2));
	if (!args.case || !args.output) throw new Error("准备测试需要 --case 与 --output");
	const plan = prepareRunPlan({
		caseId: args.case,
		profile: args.profile ?? "E_thinking_body_v1",
		variant: args.variant ?? "anonymous",
		repeat: Math.max(1, Number(args.repeat ?? 3)),
		outputRoot: args.output
	});
	console.log(JSON.stringify({ prepared: plan.runs.length, plan: join(resolve(args.output), "run-plan.json") }, null, 2));
}
