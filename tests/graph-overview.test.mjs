import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraphOverview, handleGraphGet } from "../packages/nexogenesis-web-host/lib/graph.js";
import { writeDomainFixture } from "./fixtures/domain.mjs";

const root = mkdtempSync(join(tmpdir(), "nexo-overview-"));
try {
  const cards = join(root, "01-Cards");
  mkdirSync(cards);
  writeFileSync(join(cards, "a.md"), `---\nid: a\ntitle: 主张 A\ntype: claim\ndomains:\n- d\nrelations:\n- target: b\n  type: supports\n---\n\n正文`, "utf8");
  writeFileSync(join(cards, "b.md"), `---\nid: b\ntitle: 模型 B\ntype: model\ndomains:\n- d\nrelations: []\n---\n\n正文`, "utf8");
  writeDomainFixture(root, "d", "领域 D");
  const overview = buildGraphOverview(root);
  assert.equal(overview.node_count, 2);
  assert.equal(overview.edge_count, 1);
  assert.equal(overview.domain_count, 1);
  assert.deepEqual(overview.relation_types, [{ type: "supports", count: 1 }]);
  let payload;
  await handleGraphGet(null, null, {
    writeHead(status) { assert.equal(status, 200); },
    end(body) { payload = JSON.parse(body); },
  }, null, root);
  assert.equal(payload.layout_version, 9);
  assert.equal(payload.nodes.length, overview.node_count + overview.domain_count);
  assert.equal(payload.edges.length, overview.edge_count);
  assert.ok(payload.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  console.log("PASS graph overview derives counts from the same card relations as the canvas");
} finally {
  rmSync(root, { recursive: true, force: true });
}
