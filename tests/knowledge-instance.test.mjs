import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	activateKnowledgeInstance, configureInstanceContext, createKnowledgeInstance, instanceSummary,
	readInstanceRegistry, registerExistingKnowledgeInstance, subscribeActiveInstance, unregisterKnowledgeInstance
} from "../packages/nexogenesis-tools/lib/instances/registry.js";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { apply as applyKnowledgeTools } from "../packages/nexogenesis-tools/lib/index.js";
import { instanceListPayload } from "../packages/nexogenesis-web-host/lib/instances.js";

function legacyRoot(parent, name) {
	const root = join(parent, name);
	mkdirSync(join(root, "01-Cards"), { recursive: true });
	writeFileSync(join(root, "01-Cards", "sample.md"), "---\ntitle: 测试卡\n---\n\n  这是测试卡。\n", "utf8");
	return root;
}

test("知识实例登记不修改既有目录，激活会向同进程订阅者发布新根目录", () => {
	const parent = mkdtempSync(join(tmpdir(), "nexo-instance-"));
	const primary = legacyRoot(parent, "primary");
	const registryPath = join(parent, ".nexogenesis", "instances.json");
	configureInstanceContext({ registryPath, fallbackRoot: primary });
	const secondary = legacyRoot(parent, "secondary");
	const registered = registerExistingKnowledgeInstance(registryPath, secondary, "第二知识图谱");
	assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).instances.some((instance) => instance.root === secondary), true);
	let observed = null;
	const unsubscribe = subscribeActiveInstance((instance) => { observed = instance; });
	const active = activateKnowledgeInstance(registryPath, registered.id);
	unsubscribe();
	assert.equal(active.root, secondary);
	assert.equal(observed.id, registered.id);
	assert.equal(readInstanceRegistry(registryPath).active_instance_id, registered.id);
	assert.equal(instanceSummary(active, registered.id).card_count, 1);
});

test("新建、列出与移出实例不删除磁盘知识目录，也不向接口泄露目录路径", () => {
	const parent = mkdtempSync(join(tmpdir(), "nexo-instance-api-"));
	const primary = legacyRoot(parent, "primary");
	const registryPath = join(parent, ".nexogenesis", "instances.json");
	configureInstanceContext({ registryPath, fallbackRoot: primary });
	const created = createKnowledgeInstance(registryPath, join(parent, "instances"), "宏观研究");
	assert.equal(readInstanceRegistry(registryPath).instances.some((instance) => instance.id === created.id), true);
	assert.match(readFileSync(join(created.root, "README.md"), "utf8"), /独立知识图谱实例/);
	const payload = instanceListPayload({ instanceRegistry: registryPath, projectRoot: primary, appRoot: parent });
	assert.equal(payload.instances.some((instance) => "root" in instance), false);
	activateKnowledgeInstance(registryPath, created.id);
	unregisterKnowledgeInstance(registryPath, "legacy");
	assert.equal(readInstanceRegistry(registryPath).instances.some((instance) => instance.id === "legacy"), false);
	assert.equal(readFileSync(join(created.root, "nexogenesis.instance.yml"), "utf8").includes("宏观研究"), true);
});

test("活动实例切换会改变已注册检索工具的实际读取根目录", async () => {
	const parent = mkdtempSync(join(tmpdir(), "nexo-instance-tools-"));
	const primary = legacyRoot(parent, "primary");
	const secondary = legacyRoot(parent, "secondary");
	const registryPath = join(parent, ".nexogenesis", "instances.json");
	commitCard(primary, { id: "甲图谱卡", title: "甲图谱卡", type: "claim", maturity: "growing", lifecycle: "active", domains: [], origin: "user", relations: [], sources: [], created: "2026-09-03", updated: "2026-09-03", body: "## 一句话主张\n\n  甲图谱的独有机制。" });
	commitCard(secondary, { id: "乙图谱卡", title: "乙图谱卡", type: "claim", maturity: "growing", lifecycle: "active", domains: [], origin: "user", relations: [], sources: [], created: "2026-09-03", updated: "2026-09-03", body: "## 一句话主张\n\n  乙图谱的独有机制。" });
	configureInstanceContext({ registryPath, fallbackRoot: primary });
	const registered = registerExistingKnowledgeInstance(registryPath, secondary, "乙图谱");
	const tools = new Map();
	applyKnowledgeTools({ tools: { register(tool) { tools.set(tool.name, tool); } } }, { projectRoot: primary, instanceRegistry: registryPath });
	const exec = { agent: { session: { id: "instance-switch-tool-test" } } };
	const before = await tools.get("retrieve").execute({ query: "甲图谱卡", limit: 4 }, exec);
	assert.equal(before.cards.some((card) => card.id === "甲图谱卡"), true);
	activateKnowledgeInstance(registryPath, registered.id);
	const after = await tools.get("retrieve").execute({ query: "乙图谱卡", limit: 4 }, exec);
	assert.equal(after.cards.some((card) => card.id === "乙图谱卡"), true);
	assert.equal(after.cards.some((card) => card.id === "甲图谱卡"), false);
});
