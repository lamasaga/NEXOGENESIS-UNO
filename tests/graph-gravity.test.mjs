import test from "node:test";
import assert from "node:assert/strict";
import { simulate, normalizeForce } from "../packages/nexogenesis-tools/lib/graph-simulation.js";
import { nodeWorldRadius } from "../packages/nexogenesis-tools/lib/node-geometry.js";

test("center gravity can be disabled, strengthens compactness, and validates its range", () => {
  const nodes = [{ id: "a" }, { id: "b" }];
  const initial = { a: [-250, 0], b: [250, 0] };
  const width = result => result.b.x - result.a.x;
  assert.equal(width(simulate(nodes, [], 80, initial, undefined, { gravity: 0 })), 500);
  const normal = simulate(nodes, [], 80, initial);
  assert.ok(width(normal) < 500);
  assert.ok(width(simulate(nodes, [], 80, initial, undefined, { gravity: 4 })) < width(normal));
  for (const invalid of [null, NaN, Infinity, "2", {}]) assert.equal(normalizeForce(invalid), 1);
  assert.equal(normalizeForce(-1), 0);
  assert.equal(normalizeForce(12), 4);
});

test("every preview respects entity collisions and does not alter the final simulation", () => {
  const nodes = Array.from({ length: 32 }, (_, i) => ({ id: `n${i}` }));
  const edges = nodes.slice(1).map(node => ({ from: "n0", to: node.id }));
  const initial = Object.fromEntries(nodes.map(node => [node.id, [0, 0]]));
  const untouched = structuredClone(initial);
  for (const gravity of [0, 1, 4]) {
    let previews = 0;
    const check = positions => {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = positions[nodes[i].id], b = positions[nodes[j].id];
        const required = nodeWorldRadius(i === 0 ? 31 : 1) + nodeWorldRadius(j === 0 ? 31 : 1);
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= required);
      }
    };
    const result = simulate(nodes, edges, 64, initial, undefined, {
      gravity, onProgress: (positions, progress) => {
        previews++;
        assert.ok(progress > 0 && progress < 1);
        check(positions);
      },
    });
    assert.equal(previews, 3);
    check(result);
    assert.deepEqual(result, simulate(nodes, edges, 64, initial, undefined, { gravity }));
  }
  assert.deepEqual(initial, untouched);
  assert.deepEqual(simulate([], [], 80), {});
});

test("repulsion and link attraction independently control real forces", () => {
  const nodes = [{ id: "a" }, { id: "b" }], edges = [{ from: "a", to: "b" }];
  const width = result => result.b.x - result.a.x;
  const close = { a: [0, 0], b: [30, 0] };
  const run = (repulsion, linkAttraction, initial = close) =>
    simulate(nodes, edges, 40, initial, undefined, { gravity: 0, repulsion, linkAttraction });
  assert.equal(width(run(0, 0)), 30);
  assert.ok(width(run(4, 0)) > width(run(1, 0)));
  const far = { a: [0, 0], b: [200, 0] };
  assert.equal(width(run(0, 0, far)), 200);
  assert.ok(width(run(0, 1, far)) < 200);
  assert.ok(width(run(0, 4, far)) < width(run(0, 1, far)));
  const touching = { a: [0, 0], b: [1, 0] };
  assert.ok(width(run(0, 0, touching)) >= 6, "disabling forces keeps entity collision protection");
});

test("interactive range shortens strong links, remains finite and preserves collision protection", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }));
  const edges = nodes.slice(1).map(n => ({ from: "n0", to: n.id }));
  const initial = Object.fromEntries(nodes.map((n, i) => [n.id, [i * 8, i % 3 * 20]]));
  for (const forces of [{ gravity: 4, repulsion: 0, linkAttraction: 4 }, { gravity: 0, repulsion: 4, linkAttraction: 0 }]) {
    const check = positions => {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = positions[nodes[i].id], b = positions[nodes[j].id];
        assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= nodeWorldRadius(i ? 1 : 39) + nodeWorldRadius(j ? 1 : 39));
      }
    };
    check(simulate(nodes, edges, 220, initial, undefined, { interactive: true, ...forces, onProgress: check }));
  }
  const pair = nodes.slice(0, 2), edge = edges.slice(0, 1), seed = { n0: [0, 0], n1: [150, 0] };
  const distance = value => {
    const p = simulate(pair, edge, 220, seed, undefined, { interactive: true, gravity: 0, repulsion: 0, linkAttraction: value });
    return Math.hypot(p.n0.x - p.n1.x, p.n0.y - p.n1.y);
  };
  assert.ok(distance(4) < distance(1) * .6);
});

test("domain cohesion compacts domains, separates their centers, and stays opt-in", () => {
  const nodes = [
    { id: "a1", domains: ["a"] }, { id: "a2", domains: ["a"] },
    { id: "b1", domains: ["b"] }, { id: "b2", domains: ["b"] },
    { id: "free", domains: [] },
  ];
  const initial = { a1: [-240, -40], a2: [240, -40], b1: [-240, 40], b2: [240, 40], free: [0, 300] };
  const run = domainCohesion => simulate(nodes, [], 160, initial, undefined,
    { gravity: 0, repulsion: 0, linkAttraction: 0, domainCohesion });
  const disabled = run(0), enabled = run(1);
  const spread = (positions, left, right) => Math.hypot(positions[left].x - positions[right].x, positions[left].y - positions[right].y);
  const centerY = (positions, first, second) => (positions[first].y + positions[second].y) / 2;
  assert.deepEqual(disabled, { a1: { x: -240, y: -40 }, a2: { x: 240, y: -40 }, b1: { x: -240, y: 40 }, b2: { x: 240, y: 40 }, free: { x: 0, y: 300 } });
  assert.ok(spread(enabled, "a1", "a2") < spread(disabled, "a1", "a2") * .5);
  assert.ok(spread(enabled, "b1", "b2") < spread(disabled, "b1", "b2") * .5);
  assert.ok(centerY(enabled, "b1", "b2") - centerY(enabled, "a1", "a2") > 80);
  assert.deepEqual(enabled.free, disabled.free, "domainless nodes are not moved by domain cohesion");
});

test("multi-domain membership creates a bridge without depending on domain order", () => {
  const nodes = [
    { id: "a1", domains: ["a"] }, { id: "a2", domains: ["a"] },
    { id: "bridge", domains: ["b", "a", "a"] },
    { id: "b1", domains: ["b"] }, { id: "b2", domains: ["b"] },
  ];
  const initial = { a1: [-220, -20], a2: [-180, 20], bridge: [0, 0], b1: [180, -20], b2: [220, 20] };
  const options = { gravity: 0, repulsion: 0, linkAttraction: 0, domainCohesion: 1 };
  const result = simulate(nodes, [], 180, initial, undefined, options);
  const reordered = simulate(nodes.map(node => node.id === "bridge" ? { ...node, domains: ["a", "b"] } : node), [], 180, initial, undefined, options);
  assert.deepEqual(result, reordered);
  assert.ok(result.bridge.x > Math.max(result.a1.x, result.a2.x));
  assert.ok(result.bridge.x < Math.min(result.b1.x, result.b2.x));
});
