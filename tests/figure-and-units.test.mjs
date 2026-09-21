import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPdfFigureCandidates } from "../packages/nexogenesis-tools/lib/compile/figures.js";
import { listCardUnits, readCardUnit, searchCardUnits } from "../packages/nexogenesis-tools/lib/card-units.js";
import { annotateCardUnits } from "../packages/nexogenesis-tools/lib/card-unit-annotations.js";
import { commitCard, loadCards, traceCardSources } from "../packages/nexogenesis-tools/lib/cards.js";
import { relationReadiness } from "../packages/nexogenesis-tools/lib/harness/relation-semantics.js";

const candidates = detectPdfFigureCandidates(["前文 Figure 16.1 因果工具", "图 3.2 结果比较"]);
assert.deepEqual(candidates.map((item) => [item.page, item.label]), [[1, "Figure 16.1"], [2, "图 3.2"]]);
// Reproducible synthetic units and figure source; never reads an installed knowledge base.
const project = mkdtempSync(join(tmpdir(), "uno-figure-units-"));
process.once("exit", () => rmSync(project, { recursive: true, force: true }));
// A historical artifact remains readable without resurrecting its retired writer.
const sidecarPath = "03-Archive/figures/fixture.md";
mkdirSync(join(project, "03-Archive/figures"), { recursive: true });
writeFileSync(join(project, sidecarPath), "---\nkind: figure-source\nsource: fixture.pdf\nsource_locator: PDF page 1 / Figure 1\nimage: 03-Archive/figures/fixture.png\n---\n工具变量的合成路径，仅用于测试来源追溯。\n");
writeFileSync(join(project, "03-Archive/figures/fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const unitBody = ["claim-core", "mechanism-path", "condition-relevance", "condition-exclusion-restriction", "evidence-test", "boundary-primary"]
    .map((id, index) => `## 测试单元 ${index + 1}\n\n<!-- unit: ${id} -->\n\n排除限制与第一阶段分母的合成测试文字。`).join("\n\n");
for (const id of ["潜在结果反事实因果模型", "观察研究三项识别条件", "工具变量识别路径", "服从者局部平均处理效应", "弱工具变量偏误放大"]) {
    commitCard(project, { id, title: id, type: "claim", maturity: "growing", lifecycle: "active", domains: [], origin: "document",
        sources: [sidecarPath],
        relations: id === "弱工具变量偏误放大" ? [{ target: "工具变量识别路径", type: "based-on", note: "该合成判断依赖工具变量相关性条件，并只用于检验关系就绪判断。" }] : [],
        body: id === "弱工具变量偏误放大" ? unitBody : unitBody.replaceAll("第一阶段分母", "额外条件") });
}
const listed = listCardUnits(project, "工具变量识别路径");
assert.ok(listed.units.length >= 6);
assert.ok(listed.units.some((unit) => unit.address.endsWith("#condition-exclusion-restriction")));
const unit = readCardUnit(project, "工具变量识别路径#condition-exclusion-restriction");
assert.match(unit.text, /排除限制/);
const searched = searchCardUnits(project, "第一阶段 分母", 10);
assert.ok(searched.units.some((item) => item.parent_card === "弱工具变量偏误放大"));

const untaggedModel = "## 核心思想\n\n  这个模型解释约束如何通过反馈机制改变结果，并明确其分析对象、解释范围与可以接受的观察结果。\n\n## 关键组件\n\n  状态变量承担约束记录职责，反馈变量承担放大职责，结果变量承担可观察输出职责；三者不能被同名指标简单替换。\n\n## 因果链条\n\n  初始冲击改变状态变量，状态变量触发约束，约束再通过反馈变量放大并改变最终结果；每一步都需要独立证据。\n\n## 失效边界\n\n  当约束不生效或反馈渠道被外部机制完全抵消时，这个模型不能直接外推，也不能仅凭结果相关性倒推完整机制。";
const annotated = annotateCardUnits("测试模型", "model", untaggedModel);
assert.deepEqual(annotated.added.map((item) => item.unit_id), ["claim-core", "mechanism-components", "mechanism-structure", "boundary-primary"]);
assert.equal(annotateCardUnits("测试模型", "model", annotated.body).reason, "curated_units_preserved", "已有人工地址不得被迁移器重命名或重复插入");

const cards = loadCards(project);
for (const id of ["潜在结果反事实因果模型", "观察研究三项识别条件", "工具变量识别路径", "服从者局部平均处理效应", "弱工具变量偏误放大"]) {
	const card = cards.get(id);
	assert.ok(card, `正式样本卡存在：${id}`);
	for (const relation of card.meta.relations ?? []) {
		assert.equal(relationReadiness(card, relation, cards.get(relation.target)).ready, true, `${id} -> ${relation.target} 应达到 relation-ready`);
	}
}
const traced = traceCardSources(project, "工具变量识别路径", { limit: 8 });
const figure = traced.anchors.find((anchor) => ["archive-figure", "theme-figure"].includes(anchor.kind));
assert.ok(figure?.image_path?.endsWith(".png"));
assert.match(figure.preview, /工具变量/);

console.log("PASS historical figure reading + formal card units");
