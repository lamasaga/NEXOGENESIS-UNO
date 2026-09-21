// enrich 段落补丁回归测试（消化 v2.1 语义，移植上游 card_overlay.py）
// 运行：node tests/enrich-patch.test.mjs（读取 01-Cards 合成卡做展开验证）
// 覆盖：splitSections 层级保留 / replace / append / 新增节 / sources·relations
//       合并去重 / expandEnrichWrite 元数据保留与错误路径 / 校验与序列化往返
import {
  splitSections, joinSections, applySectionPatches, mergeUnique,
  expandEnrichWrite, validateCardRecord, serializeCard, readCard
} from "../packages/nexogenesis-tools/lib/cards.js";

import { isolatedGraphFixture } from "./fixtures/isolated-graph.mjs";
const root = isolatedGraphFixture();
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, detail); } };

// 1. splitSections 保留三级标题层级
const parts = splitSections("## 诠释\n第一段\n### 核心分歧点\n点1\n## 模式描述\n描述");
check("split: 3 sections", parts.length === 3, JSON.stringify(parts.map(p => p.heading)));
check("split: 三级标题 level=3", parts[1].level === 3, `level=${parts[1].level}`);
const rejoined = joinSections(parts);
check("join: 三级标题还原", rejoined.includes("### 核心分歧点"), rejoined);

// 2. applySectionPatches（内部 API = camelCase）
const body0 = "## 诠释\n旧诠释内容\n## 模式描述\n旧模式内容\n";
const patched = applySectionPatches(body0, {
  replaceSections: { "模式描述": "新模式内容（替换）" },
  appendSections: { "诠释": "追加的诠释补充" },
});
check("patch: 替换已有节", patched.includes("新模式内容（替换）") && !patched.includes("旧模式内容"), patched);
check("patch: 追加到已有节", patched.includes("旧诠释内容\n\n追加的诠释补充"), patched);
const added = applySectionPatches(body0, { replaceSections: { "失效边界": "新节内容" } });
check("patch: 新增节", added.includes("## 失效边界\n\n新节内容"), added);
check("patch: 未改节保留", added.includes("旧模式内容"), added);

// 3. expandEnrichWrite（工具载荷 = snake_case，与上游 JSON 契约一致）
const realId = "测试周期观察";
const existing = readCard(root, realId);
check("enrich: 目标卡存在", existing !== undefined);
const { write, warnings } = expandEnrichWrite(root, {
  mode: "enrich",
  id: realId,
  replace_sections: { "模式描述": "（补丁测试）波动性排序：股票 > 商业地产 > 住宅地产；周期与实体经济同步。\n" },
  append_sections: { "诠释": "（补丁测试）追加：该规律支持金融失衡可在通胀低迷期累积。\n" },
  add_sources: ["05-Buffer/meaning-unit/2026-08-14-补丁测试.md"],
  add_relations: [{ target: "测试反馈机制", type: "example-of", note: "合成观察用于测试机制举例和关系去重。" }], // 与已有关系完全一致，应去重
});
check("enrich: 展开保留元数据", write.id === realId && write.title === existing.title && write.created === existing.created, JSON.stringify(write.created));
check("enrich: 替换生效", write.body.includes("（补丁测试）波动性排序"), write.body.slice(0, 200));
check("enrich: 追加生效", write.body.includes("（补丁测试）追加"), "");
check("enrich: sources 合并去重", write.sources.includes("05-Buffer/meaning-unit/2026-08-14-补丁测试.md"), JSON.stringify(write.sources));
check("enrich: relations 去重不重复", write.relations.filter(r => r.target === "测试反馈机制").length === 1, JSON.stringify(write.relations));
check("enrich: warnings 说明补丁", warnings.length >= 2, JSON.stringify(warnings));
check("enrich: updated 刷新为今天", write.updated === new Date().toISOString().slice(0, 10), write.updated);
check("enrich: 展开记录通过校验", (() => { try { validateCardRecord(write); return true; } catch (e) { return e.message; } })() === true);

// 4. 序列化往返：展开记录 → markdown → 含新节
const serialized = serializeCard(write);
check("serialize: 含新节标题", serialized.includes("（补丁测试）追加"), "");

// 5. 错误路径
let threwMissing = false;
try { expandEnrichWrite(root, { mode: "enrich", id: "不存在的卡xyz", replace_sections: { "诠释": "x" } }); } catch { threwMissing = true; }
check("enrich: 目标卡不存在报错", threwMissing);
let threwEmpty = false;
try { expandEnrichWrite(root, { mode: "enrich", id: realId }); } catch { threwEmpty = true; }
check("enrich: 空补丁报错", threwEmpty);

// 6. mergeUnique
check("mergeUnique: 字符串去重", mergeUnique(["a", "b"], ["b", "c"]).join() === "a,b,c");
check("mergeUnique: 对象去重", mergeUnique([{target:"x"}], [{target:"x"}]).length === 1);

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
