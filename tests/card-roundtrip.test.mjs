// Card 元数据与关系说明的无损往返回归。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitCard, expandEnrichWrite, readCard, traceCardSources, validateCardRecord
} from "../packages/nexogenesis-tools/lib/cards.js";

const root = mkdtempSync(join(tmpdir(), "nexo-card-roundtrip-"));
try {
  mkdirSync(join(root, "01-Cards"), { recursive: true });
	  mkdirSync(join(root, "05-Buffer", "meaning-unit"), { recursive: true });
	  writeFileSync(join(root, "05-Buffer", "meaning-unit", "来源.md"), [
	    "---", 'title: "来源质料"', 'role: "meaning-unit"', "---", "\n可追溯的来源正文。"
	  ].join("\n"), "utf8");
	  mkdirSync(join(root, "05-Buffer", "themes", "topic", "figures"), { recursive: true });
	  writeFileSync(join(root, "05-Buffer", "themes", "topic", "figures", "机制图.png"), "png-fixture");
	  writeFileSync(join(root, "05-Buffer", "themes", "topic", "figures", "机制图.md"), [
	    "---", 'kind: "figure-source"', 'title: "机制图"', 'image: "机制图.png"', "---", "", "# 机制图", "", "  图像语义说明。"
	  ].join("\n"), "utf8");
  writeFileSync(join(root, "01-Cards", "领域A.md"), [
    "---", 'id: "领域A"', 'title: "领域A"', 'type: "domain"', 'domains: []', 'origin: "user"',
    'created: "2026-08-27"', 'updated: "2026-08-27"', "---", "\n领域正文"
  ].join("\n"), "utf8");
  writeFileSync(join(root, "01-Cards", "测试卡.md"), [
    "---", 'id: "测试卡"', 'title: "测试卡"', 'type: "claim"', 'maturity: "growing"', 'lifecycle: "active"',
    'domains:', '  - "领域A"', 'origin: "user"', 'school: "制度主义"', 'applicable_scope:', '  - "金融危机"', '  - "政策分析"',
    'theory_status: "active"', 'superseded_by: "后继卡"', 'sources:', '  - "05-Buffer/meaning-unit/来源.md"', '  - "05-Buffer/themes/topic/figures/机制图.md"', 'relations:',
    '  - target: "领域A"', '    type: "applies-to"', '    note: "用于政策分析时成立"',
    'created: "2026-08-27"', 'updated: "2026-08-27"', "---", "\n## 诠释\n\n原有正文。"
  ].join("\n"), "utf8");

  const original = readCard(root, "测试卡");
  assert.equal(original.school, "制度主义");
  assert.deepEqual(original.applicable_scope, ["金融危机", "政策分析"]);
  assert.equal(original.theory_status, "active");
  assert.equal(original.metadata.superseded_by, "后继卡");
  assert.equal(original.relations[0].note, "用于政策分析时成立");
	  const trace = traceCardSources(root, "测试卡");
	  assert.equal(trace.anchors[0].kind, "buffer");
	  assert.match(trace.anchors[0].preview, /可追溯的来源正文/);
	  assert.equal(trace.anchors[1].kind, "theme-figure");
	  assert.equal(trace.anchors[1].image_path, "05-Buffer/themes/topic/figures/机制图.png");

  const { write } = expandEnrichWrite(root, {
    mode: "enrich", id: "测试卡", append_sections: { "诠释": "补充观察。" },
    add_relations: [{ target: "领域A", type: "applies-to", note: "用于政策分析时成立" }]
  });
  const validated = validateCardRecord(write);
  commitCard(root, validated);
  const roundtripped = readCard(root, "测试卡");
  assert.equal(roundtripped.school, "制度主义");
  assert.deepEqual(roundtripped.applicable_scope, ["金融危机", "政策分析"]);
  assert.equal(roundtripped.theory_status, "active");
  assert.equal(roundtripped.metadata.superseded_by, "后继卡");
  assert.equal(roundtripped.relations[0].note, "用于政策分析时成立");
  assert.match(readFileSync(join(root, "01-Cards", "测试卡.md"), "utf8"), /note: "用于政策分析时成立"/);
  const withoutOptionalMetadata = validateCardRecord({
    id: "无扩展元数据", title: "无扩展元数据", type: "claim", domains: ["领域A"], origin: "user",
    sources: [], relations: [], created: "2026-08-30", updated: "2026-08-30",
    school: "", applicable_scope: [], theory_status: "", metadata: { confidence: 0.75, reviewed: false },
    body: "## 一句话主张\n\n  没有可选投影字段的卡片也必须无损往返。\n\n## 依据\n\n  序列化器会忽略空字段，并保持数字与布尔元数据的类型。\n\n## 已知限制\n\n  本样本只验证数据保持。\n\n## 来源与证据边界\n\n  来自受控测试。"
  });
  assert.doesNotThrow(() => commitCard(root, withoutOptionalMetadata));
  const optionalRoundTrip = readCard(root, "无扩展元数据");
  assert.equal(optionalRoundTrip.metadata.confidence, 0.75);
  assert.equal(optionalRoundTrip.metadata.reviewed, false);
	const entityRecord = validateCardRecord({
		id: "机构实体", title: "机构实体", type: "entity", maturity: "growing", lifecycle: "active",
		domains: ["领域A"], origin: "user", sources: [], relations: [], created: "2026-08-30", updated: "2026-08-30",
		entity_kind: "institution", aliases: ["Entity Institute", "机构简称"],
		body: "## 定义\n\n  这是供多张卡引用的稳定机构对象。\n\n## 关键属性\n\n  它在知识体中承担对象归一与关系承接。\n\n## 边界与局限\n\n  不把无关沿革写成百科。\n\n## 来源\n\n  依据来自受控测试。\n\n## 来源与证据边界\n\n  本样本只验证实体元数据往返。"
	});
	commitCard(root, entityRecord);
	const entityRoundTrip = readCard(root, "机构实体");
	assert.equal(entityRoundTrip.entity_kind, "institution");
	assert.deepEqual(entityRoundTrip.aliases, ["Entity Institute", "机构简称"]);
  console.log("PASS card metadata and relation note survive enrich/write/read roundtrip");
} finally {
  rmSync(root, { recursive: true, force: true });
}
