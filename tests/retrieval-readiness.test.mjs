import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard, searchCards } from "../packages/nexogenesis-tools/lib/cards.js";

const root = mkdtempSync(join(tmpdir(), "nexo-retrieve-ready-"));
const today = new Date().toISOString().slice(0, 10);
const card = (id, body, relations = []) => ({
	id, title: id, type: "claim", maturity: "growing", lifecycle: "active",
	domains: [], origin: "user", sources: [], relations, created: today, updated: today, body
});

try {
	commitCard(root, card("可靠起点", "独有检索词用于定位可靠起点。", [
		{ target: "可靠扩展", type: "supports", note: "该机制证据直接支持目标判断在测试条件下成立" },
		{ target: "旧边扩展", type: "supports" },
		{ target: "情境扩展", type: "influences", note: "该条件变化会改变目标现象出现的概率" }
	]));
	commitCard(root, card("可靠扩展", "可靠关系的目标。"));
	commitCard(root, card("旧边扩展", "缺少关系说明的旧目标。"));
	commitCard(root, card("情境扩展", "情境关系目标。"));
	const result = searchCards(root, "独有检索词");
	assert.ok(result.some((item) => item.id === "可靠扩展" && item.role === "expansion"));
	assert.ok(!result.some((item) => item.id === "旧边扩展"), "默认检索不得沿 legacy 旧边扩散");
	assert.ok(!result.some((item) => item.id === "情境扩展"), "默认检索不得把情境关系混入论证候选");
	console.log("PASS retrieve only diffuses through ready argument relations");
} finally {
	rmSync(root, { recursive: true, force: true });
}
