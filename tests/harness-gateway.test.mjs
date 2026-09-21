import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway, HarnessRejected } from "../packages/nexogenesis-tools/lib/harness/gateway.js";
import { preserveContentMetadata } from "../packages/nexogenesis-tools/lib/harness/content-operation.js";
import { writeDomainFixture } from './fixtures/domain.mjs';

const root = mkdtempSync(join(tmpdir(), "nexo-harness-"));
const today = new Date().toISOString().slice(0, 10);
const card = (overrides) => ({
	id: "主张甲", title: "主张甲", type: "claim", maturity: "growing", lifecycle: "active",
	domains: ["领域甲"], origin: "user", relations: [], sources: [], created: today, updated: today,
	body: "## 一句话主张\n\n  这是一段足够完整、可以独立理解并用于测试统一写入网关的主张正文。\n\n## 依据\n\n  测试通过一条明确事实与一段机制说明验证原子写入行为，不以标题回声代替知识内容。\n\n## 已知限制\n\n  这里只验证 Harness 行为，不把测试结论外推到真实知识质量。\n\n## 来源与证据边界\n\n  依据来自本测试构造的受控样本。",
	...overrides
});

try {
	writeDomainFixture(root,'领域甲');
	commitCard(root, card({}));
	commitCard(root,card({id:'主张目标',title:'主张目标'}));
	const gateway = new HarnessGateway(root);
	let rejected;
	try {
		gateway.preflight({ operations: [card({ relations: [{ target: "主张目标", type: "characterizes", note:"主张不能作为实体承接刻画关系" }] })], layer: "relation" });
	} catch (error) { rejected = error; }
	assert.ok(rejected instanceof HarnessRejected);
	assert.equal(rejected.receipt.reason_code, "invalid_relation_signature");
	assert.equal(rejected.receipt.next_actions.length, 2);
	const phenomenonSupport = card({
		id: "现象甲", title: "现象甲", type: "phenomenon",
		relations: [{ target: "主张甲", type: "supports", note: "观察模式为主张提供反例边界" }],
		body: "## 模式描述\n\n  在受控样本中，可重复观察到该模式。\n\n## 典型实例\n\n  测试实例显示该模式会影响判断。\n\n## 反例与失效条件\n\n  条件改变时该模式不能外推。\n\n## 原文摘录\n\n  “受控样本中的可观察模式。”"
	});
	const checkedPhenomenon = gateway.preflight({ operations: [phenomenonSupport], layer: "creation" });
	assert.equal(checkedPhenomenon.cards[0].id, "现象甲", "非领域对象应能承担有说明的论证角色");
	commitCard(root, card({
		id: "机构实体", title: "机构实体", type: "entity", entity_kind: "institution", relations: [],
		body: "## 定义\n\n  这是稳定机构对象。\n\n## 关键属性\n\n  用于承接对象引用。\n\n## 边界与局限\n\n  不承担论证证明。\n\n## 来源\n\n  依据来自测试。\n\n## 来源与证据边界\n\n  本样本只验证关系签名。"
	}));
	assert.doesNotThrow(() => gateway.preflight({ operations: [card({ relations: [{ target: "机构实体", type: "characterizes", note: "该主张明确描述机构实体在测试机制中的角色" }] })], layer: "relation" }));
	assert.doesNotThrow(() => gateway.preflight({ operations: [card({ relations: [{ target: "机构实体", type: "attributed-to", note: "测试材料明确把该主张归因于机构实体" }] })], layer: "relation" }));
	const modelBody = "## 核心思想\n\n  该模型把受控样本中的机制组织为可检查的解释结构。\n\n## 关键组件\n\n  组件包括输入条件、作用机制与结果指标。\n\n## 结构关系\n\n  输入条件通过作用机制改变结果指标，并受边界条件约束。\n\n## 失效边界\n\n  本模型只用于 Harness 重分类测试，不能外推到真实知识。\n\n## 来源与证据边界\n\n  依据来自本测试构造的受控样本。";
	const reclassified = gateway.preflight({ operations: [card({ type: "model", body: modelBody })], layer: "reclassification" });
	assert.equal(reclassified.cards[0].type, "model", "完整新类型正文应能通过受控重分类预检");
	assert.throws(() => gateway.preflight({ operations: [card({ type: "model" })], layer: "reclassification" }), (error) => (
		error instanceof HarnessRejected && error.receipt.reason_code === "missing_required_slot"
	), "重分类不能只改 type 而沿用旧类型正文");
	commitCard(root, card({
		id: "思想归属", title: "思想归属", relations: [{ target: "机构实体", type: "attributed-to", note: "测试材料明确把这项思想归属于该机构实体" }]
	}));
	assert.throws(() => gateway.preflight({ operations: [{
		...card({ id: "机构实体", title: "机构实体", type: "model", body: modelBody }), metadata: {}
	}], layer: "reclassification" }), (error) => (
		error instanceof HarnessRejected && error.receipt.reason_code === "incoming_relation_signature_invalidated"
	), "重分类必须检查其他卡片指向目标的入边");
	assert.throws(() => gateway.preflight({ operations: [card({ metadata: { aliases: ["不应夹带"] } })], layer: "content" }), (error) => (
		error instanceof HarnessRejected && error.receipt.reason_code === "cross_layer_mutation"
	), "普通内容更新不能借 metadata 漏洞修改结构标注");

	let missingNote;
	try {
		gateway.preflight({ operations: [card({ id: "缺说明关系", title: "缺说明关系", relations: [{ target: "主张甲", type: "supports" }] })], layer: "creation" });
	} catch (error) { missingNote = error; }
	assert.ok(missingNote instanceof HarnessRejected);
	assert.equal(missingNote.receipt.reason_code, "missing_relation_note");
	const next = card({ id: "主张乙", title: "主张乙", relations: [{ target: "主张甲", type: "supports", note: "该主张提供一个可独立核对的机制前提，因此支持目标主张在测试范围内成立" }] });
	const checked = gateway.preflight({ operations: [next], layer: "creation" });
	const proposal = { proposal_id: "proposal-ok", operations: checked.cards, revisions: checked.revisions, layer: checked.layer };
	const receipt = gateway.commit(proposal);
	assert.equal(receipt.status, "ok");
	assert.ok(existsSync(join(root, "01-Cards", "主张乙.md")));
	const migratedOrigin = card({ origin: "document" });
	assert.doesNotThrow(() => gateway.preflight({ operations: [migratedOrigin], layer: "origin" }), "来源类型必须能以单层迁移修正，不应要求夹带正文或来源改写");
	assert.throws(() => gateway.preflight({ operations: [card({ origin: "document", sources: ["材料.md"] })], layer: "origin" }), (error) => error instanceof HarnessRejected && error.receipt.reason_code === "cross_layer_mutation");

	const changed = card({ body: "## 一句话主张\n\n  准备测试修订冲突的更新正文，长度足够并且含义明确。\n\n## 依据\n\n  通过文件摘要变化模拟提案生成后的并发修改。\n\n## 已知限制\n\n  本样本只验证修订冲突保护。\n\n## 来源与证据边界\n\n  依据来自本测试构造的受控样本。" });
	const stale = gateway.preflight({ operations: [changed], layer: "content" });
	writeFileSync(join(root, "01-Cards", "主张甲.md"), `${readFileSync(join(root, "01-Cards", "主张甲.md"), "utf8")}\n外部更新\n`, "utf8");
	assert.throws(() => gateway.commit({ proposal_id: "stale", operations: stale.cards, revisions: stale.revisions, layer: "content" }), (error) => error instanceof HarnessRejected && error.receipt.reason_code === "revision_conflict");
	const contentWithMetadataDrift = card({
		relations: [{ target: "领域甲", type: "conflicts-with" }],
		domains: []
	});
	let drift;
	try { gateway.preflight({ operations: [contentWithMetadataDrift], layer: "content" }); }
	catch (error) { drift = error; }
	assert.ok(drift instanceof HarnessRejected && drift.receipt.reason_code === "cross_layer_mutation");
	assert.deepEqual(drift.receipt.data.violations.map((item) => item.code), ["cross_layer_mutation"], "跨层内容提案不应混入关系签名噪音");
	assert.match(drift.receipt.summary, /元数据发生漂移/);

	const projected = preserveContentMetadata(root, contentWithMetadataDrift);
	assert.deepEqual(projected.ignored_fields.sort(), ["domains", "relations"], "正文投影必须识别并保留越界元数据");
	assert.deepEqual(projected.operation.relations, [], "正文投影必须保留磁盘中的真实关系");
	assert.deepEqual(projected.operation.domains, ["领域甲"], "正文投影必须保留磁盘中的真实领域归属");
	assert.doesNotThrow(() => gateway.preflight({ operations: [projected.operation], layer: "content" }), "投影后的正文更新应可通过，不依赖正文措辞规避关系校验");
	assert.throws(() => gateway.preflight({ operations: [card({}), card({ body: "## 一句话主张\n\n  第二个同 id 版本不应进入同一批次，否则会覆盖第一个版本。\n\n## 依据\n\n  同批重复目标会导致后写覆盖。\n\n## 已知限制\n\n  只验证同批目标唯一性。\n\n## 来源与证据边界\n\n  依据来自测试构造。" })], layer: "content" }), (error) => error instanceof HarnessRejected && error.receipt.reason_code === "duplicate_card_operation");
	console.log("PASS harness gateway: 关系拒绝、受控重分类、原子提交、修订冲突");
} finally {
	rmSync(root, { recursive: true, force: true });
}
