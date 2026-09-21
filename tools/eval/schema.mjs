import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DATASET_ROOT = join(PROJECT_ROOT, "docs", "金融经济与国际贸易测试资料集", "02-测试集");

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function discoverCases(datasetRoot = DEFAULT_DATASET_ROOT) {
	return readdirSync(datasetRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(datasetRoot, entry.name, "case.json")))
		.map((entry) => {
			const dir = join(datasetRoot, entry.name);
			return { dir, case: readJson(join(dir, "case.json")) };
		})
		.sort((left, right) => left.case.case_id.localeCompare(right.case.case_id));
}

export function findCase(caseId, datasetRoot = DEFAULT_DATASET_ROOT) {
	const found = discoverCases(datasetRoot).find((item) => item.case.case_id === caseId);
	if (!found) throw new Error(`找不到测试案例：${caseId}`);
	return found;
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyChecksums(caseDir) {
	const file = join(caseDir, "checksums.sha256");
	if (!existsSync(file)) return { present: false, checked: 0, failures: [] };
	const failures = [];
	let checked = 0;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter((item) => item.trim() && !item.trim().startsWith("#"))) {
		const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
		if (!match) {
			failures.push({ file: null, reason: "invalid_checksum_line", line });
			continue;
		}
		const target = resolve(caseDir, match[2]);
		checked += 1;
		if (!target.startsWith(`${resolve(caseDir)}\\`) && !target.startsWith(`${resolve(caseDir)}/`)) {
			failures.push({ file: match[2], reason: "path_escape" });
		} else if (!existsSync(target)) {
			failures.push({ file: match[2], reason: "missing" });
		} else if (sha256(target) !== match[1].toLowerCase()) {
			failures.push({ file: match[2], reason: "hash_mismatch" });
		}
	}
	return { present: true, checked, failures };
}

export function validateCasePackage(caseDir, caseData = readJson(join(caseDir, "case.json"))) {
	const errors = [];
	const warnings = [];
	const requireFile = (relative, code = "missing_file") => {
		if (!relative || !existsSync(join(caseDir, relative))) errors.push({ code, path: relative ?? null });
	};
	for (const key of ["case_id", "dataset_version", "status", "checkpoints", "execution_profiles", "fixture_manifest"]) {
		if (caseData[key] === void 0) errors.push({ code: "missing_case_field", field: key });
	}
	requireFile("output-schema.json");
	requireFile(caseData.variant_question_files?.named ?? "questions.jsonl");
	requireFile(caseData.variant_question_files?.anonymous ?? "questions-anonymous.jsonl");
	requireFile(caseData.fixture_manifest);
	const checkpointIds = new Set();
	let priorAsOf = "";
	for (const checkpoint of caseData.checkpoints ?? []) {
		if (!checkpoint.id || checkpointIds.has(checkpoint.id)) errors.push({ code: "invalid_checkpoint_id", checkpoint: checkpoint.id ?? null });
		checkpointIds.add(checkpoint.id);
		if (!checkpoint.as_of || Number.isNaN(Date.parse(checkpoint.as_of))) errors.push({ code: "invalid_as_of", checkpoint: checkpoint.id });
		if (priorAsOf && checkpoint.as_of <= priorAsOf) errors.push({ code: "checkpoint_order", checkpoint: checkpoint.id });
		priorAsOf = checkpoint.as_of;
		for (const relative of [...(checkpoint.named_visible_files ?? []), ...(checkpoint.anonymous_visible_files ?? [])]) requireFile(relative, "missing_checkpoint_material");
	}
	for (const requiredProfile of ["A_naked", "B_fixed_packet", "C_graphops", "D_full"]) {
		const profile = caseData.execution_profiles?.[requiredProfile];
		if (!profile) errors.push({ code: "missing_execution_profile", profile: requiredProfile });
		else if (profile.read_only !== true) errors.push({ code: "profile_not_read_only", profile: requiredProfile });
	}
	let fixture = null;
	if (caseData.fixture_manifest && existsSync(join(caseDir, caseData.fixture_manifest))) {
		fixture = readJson(join(caseDir, caseData.fixture_manifest));
		for (const checkpoint of caseData.checkpoints ?? []) {
			const release = checkpoint.fixture_release ?? checkpoint.id;
			if (!fixture.releases?.[release]) errors.push({ code: "missing_fixture_release", checkpoint: checkpoint.id, release });
		}
	}
	const checksums = verifyChecksums(caseDir);
	for (const failure of checksums.failures) errors.push({ code: "checksum_failure", ...failure });
	const full = caseData.execution_profiles?.D_full;
	for (const op of ["inspect_checkpoint_state", "inspect_evidence_set", "verify_evidence_anchors"]) {
		if (full && !(full.allowed_ops ?? []).includes(op)) warnings.push({ code: "optimized_op_available_via_overlay", op });
	}
	return {
		case_id: caseData.case_id,
		dataset_version: caseData.dataset_version,
		folder: basename(caseDir),
		valid: errors.length === 0,
		errors,
		warnings,
		checksums,
		checkpoints: [...checkpointIds],
		profiles: Object.keys(caseData.execution_profiles ?? {}),
		fixture_version: fixture?.fixture_version ?? null
	};
}

function resolveRef(rootSchema, reference) {
	if (!String(reference).startsWith("#/")) throw new Error(`只支持案例内 JSON Pointer：${reference}`);
	return String(reference).slice(2).split("/").reduce((current, token) => current?.[token.replaceAll("~1", "/").replaceAll("~0", "~")], rootSchema);
}

function validateValue(schema, value, path = "$", rootSchema = schema) {
	const errors = [];
	const fail = (code, detail = {}) => errors.push({ path, code, ...detail });
	if (schema.$ref) {
		const resolved = resolveRef(rootSchema, schema.$ref);
		if (!resolved) return [{ path, code: "unresolved_ref", reference: schema.$ref }];
		return validateValue(resolved, value, path, rootSchema);
	}
	if (schema.const !== void 0 && value !== schema.const) fail("const", { expected: schema.const });
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail("enum", { expected: schema.enum });
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	const typeMatches = !types.length || types.includes(actual) || (types.includes("integer") && typeof value === "number" && Number.isInteger(value));
	if (!typeMatches) return [{ path, code: "type", expected: types, actual }];
	if (typeof value === "number") {
		if (schema.minimum !== void 0 && value < schema.minimum) fail("minimum", { expected: schema.minimum });
		if (schema.maximum !== void 0 && value > schema.maximum) fail("maximum", { expected: schema.maximum });
	}
	if (typeof value === "string" && schema.pattern && !(new RegExp(schema.pattern).test(value))) fail("pattern", { expected: schema.pattern });
	if (Array.isArray(value)) {
		if (schema.minItems !== void 0 && value.length < schema.minItems) fail("minItems", { expected: schema.minItems });
		if (schema.maxItems !== void 0 && value.length > schema.maxItems) fail("maxItems", { expected: schema.maxItems });
		if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail("uniqueItems");
		if (Array.isArray(schema.prefixItems)) {
			schema.prefixItems.forEach((child, index) => {
				if (index < value.length) errors.push(...validateValue(child, value[index], `${path}[${index}]`, rootSchema));
			});
			if (schema.items === false && value.length > schema.prefixItems.length) fail("additionalItems");
		} else if (schema.items && schema.items !== false) {
			value.forEach((item, index) => errors.push(...validateValue(schema.items, item, `${path}[${index}]`, rootSchema)));
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const key of schema.required ?? []) if (!(key in value)) errors.push({ path: `${path}.${key}`, code: "required" });
		for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) errors.push(...validateValue(child, value[key], `${path}.${key}`, rootSchema));
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push({ path: `${path}.${key}`, code: "additionalProperty" });
		}
	}
	return errors;
}

export function validateAnswer(schema, answer) {
	const errors = validateValue(schema, answer);
	return { valid: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const reports = discoverCases().map(({ dir, case: caseData }) => validateCasePackage(dir, caseData));
	console.log(JSON.stringify({ valid: reports.every((report) => report.valid), cases: reports }, null, 2));
	process.exitCode = reports.every((report) => report.valid) ? 0 : 1;
}
