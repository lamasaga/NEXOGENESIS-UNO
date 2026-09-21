import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardCatalog } from "../packages/nexogenesis-web-host/lib/graph.js";

const root = mkdtempSync(join(tmpdir(), "nexo-card-catalog-"));
try {
  const cards = join(root, "01-Cards");
  mkdirSync(cards);
  writeFileSync(join(cards, "domain.md"), [
    "---", "id: domain", "title: 金融稳定", "type: domain", "domains: []", "relations: []", "updated: 2026-08-20", "---", "", "领域正文",
  ].join("\n"), "utf8");
  writeFileSync(join(cards, "claim.md"), [
    "---", "id: claim", "title: 流动性冲击会放大抛售", "type: claim", "domains:", "- domain", "sources:", "- buffer-a", "relations:",
    "- target: model", "  type: supports", "  note: 压力情景支持该机制", "updated: 2026-08-29", "---", "", "<!-- unit: core-thesis -->\n流动性螺旋会通过保证金压力放大资产抛售。",
  ].join("\n"), "utf8");
  writeFileSync(join(cards, "model.md"), [
    "---", "id: model", "title: 保证金螺旋模型", "type: model", "domains:", "- domain", "relations: []", "updated: 2026-08-28", "---", "", "模型解释抵押品价格与融资约束之间的反馈。",
  ].join("\n"), "utf8");

  const bodyMatch = buildCardCatalog(root, { query: "流动性螺旋" });
  assert.deepEqual(bodyMatch.items.map((item) => item.id), ["claim"]);
  assert.match(bodyMatch.items[0].excerpt, /流动性螺旋/);
  assert.doesNotMatch(bodyMatch.items[0].excerpt, /unit:|core thesis|<!/);

  const relationMatch = buildCardCatalog(root, { query: "保证金螺旋模型", relation: "supports" });
  assert.deepEqual(relationMatch.items.map((item) => item.id), ["model", "claim"]);
  assert.ok(relationMatch.items.some((item) => item.id === "claim"), "关联卡应能通过目标卡标题被检索到");

  const relatedCards = buildCardCatalog(root, { relation: "supports", sort: "title" });
  assert.deepEqual(relatedCards.items.map((item) => item.id).sort(), ["claim", "model"]);
  assert.deepEqual(relatedCards.facets.relations, [{ value: "supports", label: "supports", count: 2 }]);

  const models = buildCardCatalog(root, { type: "model" });
  assert.equal(models.total, 1);
  assert.equal(models.items[0].domain_titles.domain, "金融稳定");
  console.log("PASS card catalog searches body and relationships, then filters and sorts card summaries");
} finally {
  rmSync(root, { recursive: true, force: true });
}
