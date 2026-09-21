import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerGraphOpsTools } from "../packages/nexogenesis-tools/lib/index.js";
import { registerCognitionTools } from "../packages/nexogenesis-tools/lib/cognition/tools.js";
import { getCognitiveRuntime } from "../packages/nexogenesis-tools/lib/cognition/run-store.js";
import { normalizeJsonValue } from "../packages/nexogenesis-tools/lib/json-value.js";

function assertJsonRoundTrip(value, message) {
	assert.deepEqual(JSON.parse(JSON.stringify(value)), value, message);
}

function registerTools(register, root) {
	const tools = new Map();
	register({ tools: { register(tool) { tools.set(tool.name, tool); } } }, root, () => new Set());
	return tools;
}

function card({ id, type = "claim", relations = [] }) {
	const relationBlock = relations.length
		? ["relations:", ...relations.flatMap((relation) => [
			`  - target: ${relation.target}`,
			`    type: ${relation.type}`,
			`    note: ${relation.note}`
		])]
		: ["relations: []"];
	return [
		"---", `id: ${id}`, `title: ${id}`, `type: ${type}`, "domains: []",
		"maturity: growing", "origin: document", "theory_status: draft",
		"sources:", "  - 测试材料", ...relationBlock,
		"---", "", `## ${id}机制`, "", `  ${id}用于验证工具返回值与图关系。`, ""
	].join("\n");
}

test("工具返回值规范化会省略对象可选字段并拒绝有损类型", () => {
	const normalized = normalizeJsonValue({ present: 1, omitted: undefined, nested: { omitted: undefined, kept: true } });
	assert.deepEqual(normalized, { present: 1, nested: { kept: true } });
	assertJsonRoundTrip(normalized, "规范化结果必须能完成稳定 JSON 往返");
	assert.throws(() => normalizeJsonValue([undefined]), /undefined/);
	assert.throws(() => normalizeJsonValue({ invalid: Number.NaN }), /非有限数字/);
	assert.throws(() => normalizeJsonValue({ invalid: new Map() }), /非普通对象/);
});

test("GraphOps 返回值可交付且重复结构债不会重复落盘", async () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-tool-output-graph-"));
	try {
		mkdirSync(join(root, "01-Cards"), { recursive: true });
		writeFileSync(join(root, "01-Cards", "a.md"), card({
			id: "甲机制", relations: [{ target: "乙机制", type: "supports", note: "甲机制为乙机制提供可定位的条件性支持" }]
		}), "utf8");
		writeFileSync(join(root, "01-Cards", "b.md"), card({
			id: "乙机制", relations: [{ target: "丙模型", type: "based-on", note: "乙机制以丙模型描述的传导结构为理论基础" }]
		}), "utf8");
		writeFileSync(join(root, "01-Cards", "c.md"), card({ id: "丙模型", type: "model" }), "utf8");

		const tools = registerTools(registerGraphOpsTools, root);
		const exec = { agent: { session: { id: "session-graph-json" } } };
		const search = await tools.get("graph_search").execute({ query: "甲机制", limit: 4 }, exec);
		const walk = await tools.get("graph_walk").execute({ card_id: "甲机制", direction: "out", hops: 2 }, exec);
		const path = await tools.get("graph_path").execute({ from_id: "甲机制", to_id: "丙模型", direction: "out", max_hops: 3 }, exec);
		const tension = await tools.get("trace_support_to_tension").execute({ card_id: "乙机制", max_depth: 2 }, exec);
		const inversion = await tools.get("probe_assumption_inversion").execute({
			card_id: "乙机制", assumption: "乙机制依赖丙模型",
			inverted_assumption: "乙机制不依赖丙模型", limit: 4
		}, exec);
		for (const [name, result] of Object.entries({ search, walk, path, tension, inversion })) {
			assertJsonRoundTrip(result, `${name} 返回值必须能完成稳定 JSON 往返`);
			assert.ok(result.observation?.data_digest, `${name} 必须返回模型可见 Observation`);
		}
		assert.equal(walk.reached_hops, 2);
		assert.equal(path.paths[0]?.node_ids?.join("→"), "甲机制→乙机制→丙模型");
		assert.ok(["support_exhausted", "depth_limit"].includes(tension.stop_reason), JSON.stringify(tension));
		assert.equal(inversion.write_evidence_eligible, false);
		assert.deepEqual(tension.observation.data.support_layers, tension.support_layers, "支持层必须写入 Episode Observation，供真实动画重放");
		assert.deepEqual(tension.observation.data.tension, tension.tension, "张力目标必须写入 Episode Observation");
		assert.equal(tension.observation.data.stop_reason, tension.stop_reason);
		assert.deepEqual(inversion.observation.data.candidate_ids, inversion.candidate_ids, "反转候选必须写入 Episode Observation");
		assert.equal(inversion.observation.data.assumption, inversion.assumption);
		assert.equal(inversion.observation.data.inverted_assumption, inversion.inverted_assumption);

		const firstDebt = await tools.get("graph_note").execute({
			kind: "relation_evidence_gap", cards: ["甲机制", "丙模型"], reason: "两者之间仍缺少直接来源证据。"
		}, exec);
		const repeatedDebt = await tools.get("graph_note").execute({
			kind: "relation_evidence_gap", cards: ["甲机制", "丙模型"], reason: "两者之间仍缺少直接来源证据。"
		}, exec);
		assert.equal(firstDebt.deduplicated, false);
		assert.equal(repeatedDebt.deduplicated, true);
		const debtLines = readFileSync(join(root, ".nexogenesis", "graph", "debts.jsonl"), "utf8").trim().split(/\r?\n/);
		assert.equal(debtLines.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("工作区检查保持只读，结束工具可安全重放", async () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-tool-output-finish-"));
	try {
		const tools = registerTools(registerCognitionTools, root);
		const exec = { agent: { session: { id: "session-finish-json" } } };
		const before = await tools.get("inspect_cognitive_workspace").execute({}, exec);
		assert.equal(before.status, "no_active_run");
		assert.equal(existsSync(join(root, ".nexogenesis", "cognition", "runs")), false);

		const runtime = getCognitiveRuntime(root);
		const started = runtime.start({ session_id: "session-finish-json", mode: "general", skill: "nexo-talk", goal: "验证安全结束" });
		const active = await tools.get("inspect_cognitive_workspace").execute({}, exec);
		assert.equal(active.active, true);

		const args = {
			status: "blocked", stop_reason: "当前证据不足，保留缺口后结束。",
			changed: ["已经确认主要依据仍不完整。"],
			unchanged: ["没有修改知识内容。"],
			pending: ["后续补充反向关系检查。"]
		};
		const finished = await tools.get("finish_cognitive_run").execute(args, exec);
		assert.equal(finished.idempotent_replay, false);
		assertJsonRoundTrip(finished, "结束回执必须完成稳定 JSON 往返");
		const stepCount = runtime.get(started.run.run_id).episode.steps.length;
		const runCount = readdirSync(join(root, ".nexogenesis", "cognition", "runs"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
		const replayed = await tools.get("finish_cognitive_run").execute(args, exec);
		assert.equal(replayed.idempotent_replay, true);
		assert.equal(runtime.get(started.run.run_id).episode.steps.length, stepCount);
		assert.equal(readdirSync(join(root, ".nexogenesis", "cognition", "runs"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, runCount);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
