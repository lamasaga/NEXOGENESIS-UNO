import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCase, PROJECT_ROOT, readJson, validateCasePackage } from "./schema.mjs";

function safeSource(caseDir, relative) {
	const target = resolve(caseDir, relative);
	const base = resolve(caseDir);
	if (!target.startsWith(`${base}\\`) && !target.startsWith(`${base}/`)) throw new Error(`案例路径越界：${relative}`);
	if (!existsSync(target)) throw new Error(`案例文件不存在：${relative}`);
	return target;
}

function copy(source, target) {
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(source, target);
}

function markdownFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...markdownFiles(path));
		else if (entry.name.endsWith(".md")) out.push(path);
	}
	return out;
}

function cardId(path) {
	return /^---\r?\n[\s\S]*?^id:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim() ?? "";
}

function resolveProfile(caseData, profileName) {
	if (caseData.execution_profiles?.[profileName]) return structuredClone(caseData.execution_profiles[profileName]);
	const overlay = readJson(join(PROJECT_ROOT, "tools", "eval", "thinking-body-v1.json"));
	const spec = overlay.profiles?.[profileName];
	if (!spec) throw new Error(`未知执行 profile：${profileName}`);
	const base = structuredClone(caseData.execution_profiles?.[spec.base]);
	if (!base) throw new Error(`overlay 基线不存在：${spec.base}`);
	return {
		...base,
		skill: spec.skill,
		allowed_thinking_models: spec.thinking_models_by_case?.[caseData.case_id] ?? spec.allowed_thinking_models ?? base.allowed_thinking_models,
		allowed_ops: [...new Set([...(base.allowed_ops ?? []), ...(spec.additional_ops ?? [])])],
		...(spec.max_steps ? { max_steps: spec.max_steps } : {}),
		...(spec.max_card_reads ? { max_card_reads: spec.max_card_reads } : {}),
		overlay_version: overlay.version,
		overlay_profile: profileName
	};
}

function copyProgramContract(outputRoot, profile) {
	copy(join(PROJECT_ROOT, "AGENTS.md"), join(outputRoot, "AGENTS.md"));
	for (const reference of ["constraint-layers.md", "retrieval-design.md", "thinking-body.md", "thinking-output-contract.md", "evaluation-run-contract.md"]) {
		const source = join(PROJECT_ROOT, ".agent", "reference", reference);
		if (existsSync(source)) copy(source, join(outputRoot, ".agent", "reference", reference));
	}
	if (profile.skill) {
		const source = join(PROJECT_ROOT, ".agent", "skills", profile.skill, "SKILL.md");
		if (!existsSync(source)) throw new Error(`Skill 不存在：${profile.skill}`);
		copy(source, join(outputRoot, ".agent", "skills", profile.skill, "SKILL.md"));
	}
	for (const model of profile.allowed_thinking_models ?? []) {
		const source = join(PROJECT_ROOT, "schemes", "default", "thinking-models", `${model}.yaml`);
		if (!existsSync(source)) throw new Error(`Thinking Model 不存在：${model}`);
		copy(source, join(outputRoot, "schemes", "default", "thinking-models", `${model}.yaml`));
	}
}

function copyFixture(caseDir, manifest, releaseId, outputRoot) {
	const release = manifest.releases?.[releaseId];
	if (!release) throw new Error(`fixture release 不存在：${releaseId}`);
	const cardsDir = safeSource(caseDir, manifest.cards_dir ?? manifest.root_layout?.cards);
	const byId = new Map(markdownFiles(cardsDir).map((path) => [cardId(path), path]));
	for (const id of release.card_ids ?? []) {
		const source = byId.get(id);
		if (!source) throw new Error(`fixture 缺少 Card：${id}`);
		copy(source, join(outputRoot, "01-Cards", basename(source)));
	}
	if (manifest.archive_copies) {
		const allowed = new Set(release.archive_targets ?? []);
		for (const item of manifest.archive_copies.filter((candidate) => allowed.has(basename(candidate.to)))) {
			copy(safeSource(caseDir, item.from), join(outputRoot, item.to));
		}
	} else {
		const archiveDir = safeSource(caseDir, manifest.root_layout.archive);
		for (const file of release.archive_files ?? []) copy(safeSource(archiveDir, file), join(outputRoot, "03-Archive", file));
	}
	return { card_ids: release.card_ids ?? [], archive_files: release.archive_files ?? release.archive_targets ?? [] };
}

export function materializeFixture({ caseId, checkpointId, variant = "anonymous", profileName = "E_thinking_body_v1", outputRoot }) {
	const { dir: caseDir, case: caseData } = findCase(caseId);
	const validation = validateCasePackage(caseDir, caseData);
	if (!validation.valid) throw new Error(`案例契约无效：${JSON.stringify(validation.errors)}`);
	const checkpoint = caseData.checkpoints.find((item) => item.id === checkpointId);
	if (!checkpoint) throw new Error(`checkpoint 不存在：${checkpointId}`);
	if (!new Set(["named", "anonymous"]).has(variant)) throw new Error(`variant 必须是 named 或 anonymous`);
	const profile = resolveProfile(caseData, profileName);
	const target = outputRoot ? resolve(outputRoot) : mkdtempSync(join(tmpdir(), `nexo-eval-${caseId}-${checkpointId}-`));
	mkdirSync(target, { recursive: true });
	copyProgramContract(target, profile);
	let fixture = { card_ids: [], archive_files: [] };
	if (profile.fixture) {
		const manifest = readJson(safeSource(caseDir, caseData.fixture_manifest));
		fixture = copyFixture(caseDir, manifest, checkpoint.fixture_release ?? checkpoint.id, target);
	}
	const visible = variant === "anonymous" ? checkpoint.anonymous_visible_files ?? [] : checkpoint.named_visible_files ?? [];
	if (profile.visible_case_material) {
		for (const relative of visible) copy(safeSource(caseDir, relative), join(target, ".eval", "input", basename(relative)));
	}
	const questionFile = caseData.variant_question_files?.[variant] ?? (variant === "anonymous" ? "questions-anonymous.jsonl" : "questions.jsonl");
	copy(safeSource(caseDir, questionFile), join(target, ".eval", "questions.jsonl"));
	copy(safeSource(caseDir, "output-schema.json"), join(target, ".eval", "output-schema.json"));
	const checkpointIndex = caseData.checkpoints.findIndex((item) => item.id === checkpointId);
	const previous = checkpointIndex > 0 ? caseData.checkpoints[checkpointIndex - 1] : null;
	const scope = {
		case_id: caseId,
		current_checkpoint: checkpoint.id,
		previous_checkpoint: previous?.id ?? null,
		as_of: checkpoint.as_of,
		variant,
		execution_profile: profileName,
		allowed_thinking_models: profile.allowed_thinking_models ?? [],
		allow_experimental_models: (profile.allowed_thinking_models ?? []).some((id) => ["cross-sectional-vulnerability", "multi-timescale-shock-decomposition"].includes(id)),
		allowed_ops: profile.allowed_ops ?? [],
		read_only: profile.read_only === true,
		budget: { max_steps: profile.max_steps ?? 18, max_reads: profile.max_card_reads ?? 10, max_writes: 0 },
		previous_output: null,
		fixture
	};
	mkdirSync(join(target, ".eval"), { recursive: true });
	writeFileSync(join(target, ".eval", "run-scope.json"), JSON.stringify(scope, null, 2), "utf8");
	return { root: target, scope, profile, validation };
}

function argsOf(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 2) out[argv[index]?.replace(/^--/, "")] = argv[index + 1];
	return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = argsOf(process.argv.slice(2));
	const result = materializeFixture({
		caseId: args.case,
		checkpointId: args.checkpoint,
		variant: args.variant ?? "anonymous",
		profileName: args.profile ?? "E_thinking_body_v1",
		outputRoot: args.output
	});
	console.log(JSON.stringify(result, null, 2));
}
