import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectEvidenceSet, verifyEvidenceAnchors } from "../packages/nexogenesis-tools/lib/cognition/evidence-inspection.js";

const root = mkdtempSync(join(tmpdir(), "nexo-evidence-inspection-"));
try {
  mkdirSync(join(root, "01-Cards"), { recursive: true });
  writeFileSync(join(root, "01-Cards", "support.md"), [
    "---", "id: support", "title: 支持卡", "type: claim", "domains: []", "sources:", "- 03-Archive/source-a.md#第一节", "relations: []", "---", "",
    "## 机制", "", "<!-- unit: mechanism-main -->", "需求收缩通过耐用品和资本品渠道放大贸易下降。"
  ].join("\n"), "utf8");
  writeFileSync(join(root, "01-Cards", "counter.md"), [
    "---", "id: counter", "title: 反证卡", "type: claim", "domains: []", "sources:", "- 03-Archive/source-b.md#第二节", "relations: []", "---", "",
    "## 反证与边界", "", "信用没有冻结时，金融渠道不足以单独解释全部降幅。"
  ].join("\n"), "utf8");
  const state = { episode: { steps: [
    { action: { operator: "read_card_unit" }, observation: { status: "ok", evidence: [{ card_id: "support", address: "support#mechanism-main" }], data: { address: "support#mechanism-main" } } },
    { action: { operator: "read_card" }, observation: { status: "ok", evidence: [{ card_id: "counter" }], data: { id: "counter", reading: { coverage: "full" } } } }
  ] } };
  const items = [
    { anchor: "support#mechanism-main", role: "support", claim_id: "trade-drop" },
    { anchor: "counter", role: "counter", claim_id: "trade-drop" }
  ];
  const verified = verifyEvidenceAnchors(root, state, items);
  assert.equal(verified.all_deterministic_checks_passed, true);
  assert.deepEqual(verified.roles_present.sort(), ["counter", "support"]);
  assert.equal(verified.results[0].semantic_fit, "model_review_required", "工具不得冒充语义裁判");
  const inspected = inspectEvidenceSet(root, state, items);
  assert.equal(inspected.claims[0].source_family_count, 2);
  assert.equal(inspected.claims[0].independent_source_count, null, "不同路径不能证明来源独立");
  assert.equal(inspected.claims[0].has_counter_or_boundary, true);
  const unread = verifyEvidenceAnchors(root, state, [{ anchor: "support", role: "support", claim_id: "other" }]);
  assert.equal(unread.results[0].read_in_run, true, "精读 unit 同时证明父卡已被本轮读取");
  assert.equal(unread.results[0].usable, false, "局部读取不能证明父卡全文已读");
  const missing = verifyEvidenceAnchors(root, state, [{ anchor: "ghost", role: "support", claim_id: "other" }]);
  assert.equal(missing.all_deterministic_checks_passed, false);
  console.log("PASS evidence anchors and evidence-set structure are deterministic without pretending semantic proof");
} finally {
  rmSync(root, { recursive: true, force: true });
}
