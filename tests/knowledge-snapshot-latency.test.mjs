import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitCard, knowledgeSnapshotStats, loadCards, resetKnowledgeSnapshot } from "../packages/nexogenesis-tools/lib/cards.js";
import { loadGraphOps } from "../packages/nexogenesis-tools/lib/graph-ops.js";
import { apply as applyKnowledgeTools } from "../packages/nexogenesis-tools/lib/index.js";
import { createChatLatencyTrace } from "../packages/nexogenesis-web-host/lib/latency-telemetry.js";
import { buildGraphOverview } from "../packages/nexogenesis-web-host/lib/graph.js";

const today = new Date().toISOString().slice(0, 10);

function card(id) {
	return {
		id, title: id, type: "claim", maturity: "growing", lifecycle: "active",
		domains: [], origin: "user", relations: [], sources: [], created: today, updated: today,
		body: "## 一句话主张\n\n  这是用于验证知识快照与批量精读的受控正文。"
	};
}

test("Cards 与 GraphOps 复用快照，写入后自动失效", () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-snapshot-"));
	try {
		commitCard(root, card("卡片甲"));
		resetKnowledgeSnapshot(root);
		assert.equal(loadCards(root).has("卡片甲"), true);
		assert.equal(loadCards(root).has("卡片甲"), true);
		let stats = knowledgeSnapshotStats(root);
		assert.equal(stats.scans, 1);
		assert.equal(stats.hits, 1);
		const first = loadGraphOps(root, new Set(["卡片甲"]));
		const second = loadGraphOps(root, new Set());
		assert.equal(first.cards, second.cards);
		assert.notEqual(first.seenIds, second.seenIds);
		commitCard(root, card("卡片乙"));
		assert.equal(loadCards(root).has("卡片乙"), true);
		stats = knowledgeSnapshotStats(root);
		assert.equal(stats.scans, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Web 图谱投影复用同一知识快照", () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-web-graph-snapshot-"));
	try {
		commitCard(root, card("卡片甲"));
		commitCard(root, card("卡片乙"));
		resetKnowledgeSnapshot(root);
		assert.equal(buildGraphOverview(root).node_count, 2);
		assert.equal(buildGraphOverview(root).node_count, 2);
		const stats = knowledgeSnapshotStats(root);
		assert.equal(stats.scans, 1, "Web 图谱不能维持第二套逐文件扫描路径");
		assert.equal(stats.hits,1,"重复图谱投影只需命中一次卡片快照，关系索引由同一版本复用");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("read_cards 最多精读三张并共享正文预算", async () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-batch-read-"));
	try {
		for (const id of ["卡片甲", "卡片乙", "卡片丙", "卡片丁"]) commitCard(root, card(id));
		const registered = new Map();
		applyKnowledgeTools({ tools: { register(tool) { registered.set(tool.name, tool); } } }, { projectRoot: root });
		const tool = registered.get("read_cards");
		const exec = { agent: { session: { id: "batch-read-test" } } };
		const result = await tool.execute({ ids: ["卡片甲", "卡片乙", "卡片丙"], max_characters: 1000 }, exec);
		assert.equal(result.cards.length, 3);
		assert.ok(result.total_characters <= 1000);
		const rejected = await tool.execute({ ids: ["卡片甲", "卡片乙", "卡片丙", "卡片丁"] }, exec);
		assert.match(rejected.error, /1–3/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("延迟遥测只记录计时、路由与缓存，不记录正文", () => {
	const root = mkdtempSync(join(tmpdir(), "nexo-telemetry-"));
	try {
		const trace = createChatLatencyTrace(root);
		trace.selectModel({ provider: "test", model: "test-model" });
		trace.toolStarted({ id: "1", name: "retrieve" });
		trace.toolFinished({ id: "1", name: "retrieve" });
		trace.toolStarted({ id: "2", name: "graph_search", args: { intent: { focus: ["不得保存的检索词"] } } });
		trace.toolFinished({ id: "2", name: "graph_search" });
		trace.text("不应写入遥测的回答正文");
		trace.finish({ status: "completed" });
		const record = JSON.parse(readFileSync(join(root, ".nexogenesis", "telemetry", "chat-latency.jsonl"), "utf8").trim());
		assert.equal(record.route, "grounded_quick");
		assert.deepEqual(record.retrieval, { calls: 2, intent_calls: 1 });
		assert.equal(JSON.stringify(record).includes("不应写入遥测"), false);
		assert.equal(JSON.stringify(record).includes("不得保存的检索词"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
