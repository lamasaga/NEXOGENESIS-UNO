import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCard } from "../packages/nexogenesis-tools/lib/cards.js";
import { HarnessGateway, HarnessRejected } from "../packages/nexogenesis-tools/lib/harness/gateway.js";
import { auditCardQuality } from "../packages/nexogenesis-tools/lib/harness/knowledge-quality.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

const root = mkdtempSync(join(tmpdir(), "nexo-quality-"));
const today = new Date().toISOString().slice(0, 10);
const fullClaim = (overrides = {}) => ({
	id: "完整主张", title: "完整主张", type: "claim", maturity: "growing", lifecycle: "active",
	domains: ["测试领域"], origin: "document", sources: ["05-Buffer/meaning-unit/来源.md"], relations: [],
	created: today, updated: today,
	body: "## 一句话主张\n\n  金融支持只有在资产仍具长期价值时才能缓解短期流动性冲击。\n\n## 依据\n\n  融资减少被迫抛售，并阻断价格下跌反向侵蚀资产负债表的反馈。\n\n## 已知限制\n\n  已经资不抵债的机构不能仅靠新增融资恢复偿付能力。\n\n## 原文摘录\n\n  “流动性支持不能替代对资产质量的判断。”",
	...overrides
});

try {
	mkdirSync(join(root, "05-Buffer", "meaning-unit"), { recursive: true });
	mkdirSync(join(root, "05-Buffer", "themes", "test-topic", "sources", "book"), { recursive: true });
	writeFileSync(join(root, "05-Buffer", "meaning-unit", "来源.md"), "正式来源。", "utf8");
	writeFileSync(join(root, "05-Buffer", "meaning-unit", "领域.md"), "领域来源。", "utf8");
	writeFileSync(join(root, "05-Buffer", "themes", "test-topic", "sources", "book", "chapter.md"), "正式主题章节来源。", "utf8");
	writeDomainFixture(root, "测试领域");
	const gateway = new HarnessGateway(root);
	assert.throws(() => gateway.commitBuffer({ role: "meaning-unit", title: "无来源质料", source: "", body: "这是一段看似完整但没有任何来源锚点的机制说明。".repeat(8) }), (error) => error instanceof HarnessRejected && error.receipt.reason_code === "missing_buffer_source");
	const caution = gateway.commitBuffer({
		role: "meaning-unit", title: "自由段落质料", source: "材料.md#段落一",
		body: "这是一份来自短文或对话的自由段落质料，它包含明确判断、作用机制、适用条件和失效边界，因此不应仅因没有四层标题而被拒绝。它同时说明当前证据只覆盖一个局部案例，不能外推到所有机构和所有市场环境；后续消化仍需与既有卡片比较，确认它究竟形成增量、重复还是冲突。"
	});
	assert.equal(caution.quality.status, "caution", "非硬性结构问题必须随成功写入回执返回");

	const good = gateway.preflight({ operations: [fullClaim()], layer: "creation" });
	assert.equal(good.quality[0].status, "caution", "无关系只应形成结构复核告警，不阻断新卡");

	assert.throws(() => gateway.preflight({ operations: [fullClaim({
		id: "错型现象", title: "错型现象", type: "phenomenon",
		body: "## 核心思想\n\n  这是模型骨架。\n\n## 关键组件\n\n  组件承担解释职责。\n\n## 因果链条\n\n  变量沿路径传导。\n\n## 失效边界\n\n  条件变化时失效。\n\n## 原文摘录\n\n  “模型摘录。”"
	})], layer: "creation" }), (error) => error instanceof HarnessRejected && error.receipt.reason_code === "missing_required_slot");

	const placeholder = auditCardQuality(fullClaim({ body: fullClaim().body.replace("已经资不抵债的机构不能仅靠新增融资恢复偿付能力。", "原文未提及。") }));
	assert.ok(placeholder.findings.some((item) => item.code === "placeholder_required_slot" && item.severity === "error"));
	const historicalModel = auditCardQuality({
		...fullClaim({ type: "model", title: "历史章节兼容", id: "历史章节兼容" }),
		body: "## 核心思想\n\n  这是一个具有明确解释对象的机制模型。\n\n## 关键组件\n\n  变量、约束与反馈共同决定结果。\n\n## 结构关系/因果链条\n\n  初始条件变化会经由约束与反馈改变结果。\n\n## 失效边界\n\n  当关键约束不存在时不能直接套用。\n\n## 原文摘录\n\n  “机制应在明确条件下理解。”"
	});
	assert.ok(!historicalModel.findings.some((item) => item.field === "body.relations" && item.severity === "error"), "历史并列标题应被识别为关系语义槽");
	const duplicateUnits = auditCardQuality(fullClaim({ body: fullClaim().body.replace("## 依据", "## 依据\n\n<!-- unit: claim-core -->").replace("## 一句话主张", "## 一句话主张\n\n<!-- unit: claim-core -->") }));
	assert.ok(duplicateUnits.findings.some((item) => item.code === "duplicate_card_unit_id" && item.severity === "error"));
	const invalidUnit = auditCardQuality(fullClaim({ body: fullClaim().body.replace("## 依据", "## 依据\n\n<!-- unit: 中文标签 -->") }));
	assert.ok(invalidUnit.findings.some((item) => item.code === "invalid_card_unit_id" && item.severity === "error"));
	const duplicateHeading = auditCardQuality(fullClaim({ body: `${fullClaim().body}\n\n## 已知限制\n\n  另一段边界说明不能使用相同二级标题悄悄覆盖前一段。` }));
	assert.ok(duplicateHeading.findings.some((item) => item.code === "duplicate_semantic_heading" && item.severity === "error"));
	const weakExcerpt = auditCardQuality(fullClaim({ body: fullClaim().body.replace("“流动性支持不能替代对资产质量的判断。”", "> A Pause for Thought") }));
	assert.ok(weakExcerpt.findings.some((item) => item.code === "weak_source_excerpt" && item.severity === "warning"));
	const weakThemeExcerpt = auditCardQuality(fullClaim({
		sources: ["05-Buffer/themes/test-topic/sources/book/chapter.md"],
		body: fullClaim().body
			.replace("## 一句话主张", "## 一句话主张\n\n<!-- unit: claim-core -->")
			.replace("## 依据", "## 依据\n\n<!-- unit: evidence-basis -->")
			.replace("“流动性支持不能替代对资产质量的判断。”", "> A Pause for Thought")
	}), { root });
	assert.ok(weakThemeExcerpt.findings.some((item) => item.code === "weak_source_excerpt" && item.severity === "error"), "主题卡不得用章节标题冒充证据摘录");
	const unaddressableTheme = auditCardQuality(fullClaim({ sources: ["05-Buffer/themes/test-topic/sources/book/chapter.md"] }), { root });
	assert.ok(unaddressableTheme.findings.some((item) => item.code === "theme_units_insufficient" && item.severity === "error"), "主题卡至少需要两个可寻址语义单元");
	console.log("PASS knowledge quality: Buffer 来源门槛、新卡槽契约、错型与占位拦截");
} finally {
	rmSync(root, { recursive: true, force: true });
}
