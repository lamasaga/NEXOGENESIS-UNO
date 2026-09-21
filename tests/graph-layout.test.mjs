import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureLayout, ensureLayoutAsync, layoutFingerprint, LAYOUT_VERSION, simulate } from "../packages/nexogenesis-web-host/lib/layout.js";
import { nodeWorldRadius } from "../packages/nexogenesis-tools/lib/node-geometry.js";

const nodesOf = count => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, domains: [] }));
const cacheFile = root => join(root, ".nexogenesis", "graph", "layout.json");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nexo-layout-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("layout ignores input order, duplicate relations, direction and self links", () => {
  const nodes = nodesOf(8);
  const edges = [{ from: "n0", to: "n1" }, { from: "n1", to: "n2" }];
  const repeated = [...edges, ...edges, { from: "n1", to: "n0" }, { from: "n0", to: "n0" }, { from: "n0", to: "missing" }];
  assert.equal(layoutFingerprint(nodes, edges), layoutFingerprint([...nodes].reverse(), repeated));
  assert.deepEqual(simulate(nodes, edges, 80), simulate([...nodes].reverse(), repeated.reverse(), 80));
});

test("edge additions and removals refresh coordinates without adding a node; unchanged graph reuses cache", t => {
  const root = fixture(t), nodes = nodesOf(12);
  const before = ensureLayout(root, nodes, []);
  const edge = [{ from: "n0", to: "n11" }];
  const added = ensureLayout(root, nodes, edge);
  assert.notDeepEqual(added, before);
  assert.equal(JSON.parse(readFileSync(cacheFile(root))).fingerprint, layoutFingerprint(nodes, edge));
  const cacheText = readFileSync(cacheFile(root), "utf8");
  assert.deepEqual(ensureLayout(root, [...nodes].reverse(), edge), added);
  assert.equal(readFileSync(cacheFile(root), "utf8"), cacheText);
  ensureLayout(root, nodes, []);
  assert.equal(JSON.parse(readFileSync(cacheFile(root))).fingerprint, layoutFingerprint(nodes, []));
  const smaller = ensureLayout(root, nodes.slice(0, 4), []);
  assert.equal(Object.keys(smaller).length, 4);
});

test("coincident star nodes separate by their actual diameters and remain finite", () => {
  const nodes = nodesOf(32), edges = nodes.slice(1).map(n => ({ from: "n0", to: n.id }));
  const initial = Object.fromEntries(nodes.map(n => [n.id, [0, 0]]));
  const positions = simulate(nodes, edges, 160, initial);
  for (let i = 0; i < nodes.length; i++) {
    const a = positions[nodes[i].id];
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    for (let j = i + 1; j < nodes.length; j++) {
      const b = positions[nodes[j].id];
      const required = nodeWorldRadius(i === 0 ? 31 : 1) + nodeWorldRadius(j === 0 ? 31 : 1);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= required, `overlap ${nodes[i].id}/${nodes[j].id}`);
    }
  }
});

test("collision finalization separates existing overlaps without extra padding", () => {
  const nodes = nodesOf(2);
  const positions = simulate(nodes, [], 0, { n0: [0, 0], n1: [1, 0] });
  const distance = Math.hypot(positions.n0.x - positions.n1.x, positions.n0.y - positions.n1.y);
  assert.ok(distance >= 6 && distance <= 6.02);
  assert.deepEqual(simulate(nodes, [], 0, { n0: [0, 0], n1: [20, 0] }), { n0: { x: 0, y: 0 }, n1: { x: 20, y: 0 } });
});

test("repulsion includes distance 100 but stops beyond it in both nearby and distant grid cells", () => {
  const nodes = nodesOf(2);
  const atBoundary = simulate(nodes, [], 1, { n0: [0, 0], n1: [100, 0] });
  assert.deepEqual(atBoundary, { n0: { x: 0.07, y: 0 }, n1: { x: 99.93, y: 0 } });
  for (const distance of [100.1, 101, 300]) {
    const result = simulate(nodes, [], 1, { n0: [0, 0], n1: [distance, 0] });
    // 无连线且超过排斥范围时，只剩向心力和速度阻尼。
    const shift = 0.0025 * (distance / 2) * 0.85;
    assert.deepEqual(result, {
      n0: { x: Math.round(shift * 100) / 100, y: 0 },
      n1: { x: Math.round((distance - shift) * 100) / 100, y: 0 },
    });
  }
});

test("old or damaged layout upgrades with a backup and repairs invalid positions", t => {
  const root = fixture(t), nodes = nodesOf(6);
  mkdirSync(join(root, ".nexogenesis", "graph"), { recursive: true });
  const old = { layout_version: 2, positions: { n0: { x: 0, y: 0 }, n1: null } };
  writeFileSync(cacheFile(root), JSON.stringify(old));
  const result = ensureLayout(root, nodes, []);
  assert.equal(Object.keys(result).length, 6);
  assert.deepEqual(JSON.parse(readFileSync(`${cacheFile(root)}.previous`)), old);
  assert.equal(JSON.parse(readFileSync(cacheFile(root))).layout_version, LAYOUT_VERSION);
  assert.equal(existsSync(`${cacheFile(root)}.${process.pid}.tmp`), false);
  assert.deepEqual(simulate([], [], 100), {});
});

test("worker layout keeps the main loop responsive and serializes changes to one instance", async t => {
  const root = fixture(t), nodes = nodesOf(90);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const a = ensureLayoutAsync(root, nodes, []);
    const same = ensureLayoutAsync(root, nodes, []);
    const edges = [{ from: "n0", to: "n89" }];
    const b = ensureLayoutAsync(root, nodes, edges);
    const [first, duplicate, changed] = await Promise.all([a, same, b]);
    assert.deepEqual(first, duplicate);
    assert.notDeepEqual(first, changed);
    assert.ok(ticks > 2, `event loop must keep running: ${ticks}`);
    assert.equal(JSON.parse(readFileSync(cacheFile(root))).fingerprint, layoutFingerprint(nodes, edges));
    assert.deepEqual(await ensureLayoutAsync(root, nodes, edges), changed);
  } finally { clearInterval(timer); }
});
