import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  balancedConstructSample, collectConstructCandidates, prepareConstructCases
} from "../tools/eval/prepare-construct-cases.mjs";

const root = mkdtempSync(join(tmpdir(), "nexo-construct-eval-"));
try {
  const records = [
    { at: "2026-08-30T00:00:00Z", reviews: [
      { source_id: "甲", target_id: "乙", old_relation_type: "supports", decision: "keep", confidence: "high", evidence: "甲为乙提供机制证据", reason: "方向成立", note: "具体说明" },
      { source_id: "丙", target_id: "丁", old_relation_type: "influences", decision: "remove", confidence: "high", evidence: "只是共同出现", reason: "没有影响机制" },
      { source_id: "戊", target_id: "己", old_relation_type: "based-on", decision: "defer", confidence: "medium", evidence: "方向不明", reason: "需要原始来源" },
      { source_id: "庚", target_id: "辛", old_relation_type: "extends", decision: "change", confidence: "medium", evidence: "实际为组成关系", reason: "原类型错误", new_relation_type: "part-of" }
    ] }
  ];
  writeFileSync(join(root, "model-relation-review.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  const candidates = collectConstructCandidates(root);
  assert.equal(candidates.length, 4);
  const sample = balancedConstructSample(candidates, 4);
  assert.deepEqual(sample.map((item) => item.expected.decision), ["keep", "change", "remove", "defer"]);
  assert.ok(sample.every((item) => item.status === "candidate_requires_human_validation"));
  const summary = prepareConstructCases({ inputDirectory: root, output: join(root, "candidates.jsonl"), limit: 4 });
  assert.equal(summary.sample_total, 4);
  assert.equal(summary.status, "candidate_manifest_only_not_gold");
  console.log("PASS construct eval preparation: balanced real-review manifest remains non-gold until human validation");
} finally {
  rmSync(root, { recursive: true, force: true });
}
