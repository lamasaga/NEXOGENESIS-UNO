import { describe, expect, it } from "vitest";
import { graphFingerprint, graphLayoutKey, loadGraphLayout } from "./layoutStorage";
import type { GraphData } from "./types";

const graph: GraphData = {
  nodes: ["a", "b", "c"].map(id => ({ id, title: id, type: "claim", domains: [], x: 0, y: 0 })),
  edges: [{ id: "e", from: "a", to: "b", kind: "relation", relation_type: null, bundle: "" }],
};
describe("saved graph layout", () => {
  it("reuses coordinates across ordering, labels, duplicates and backend coordinate refreshes", () => {
    const changed = { nodes: [...graph.nodes].reverse().map(n => ({ ...n, title: "new", x: 100 })),
      edges: [...graph.edges, { ...graph.edges[0], from: "b", to: "a" }] };
    expect(graphFingerprint(changed)).toBe(graphFingerprint(graph));
    expect(graphFingerprint({ ...graph, edges: [{ ...graph.edges[0], to: "c" }] })).not.toBe(graphFingerprint(graph));
    expect(graphFingerprint({ ...graph, nodes: graph.nodes.slice(1) })).not.toBe(graphFingerprint(graph));
  });
  it("isolates instances and rejects corrupt coordinates without losing valid partial layouts", () => {
    const saved = { fingerprint: graphFingerprint(graph), forces: { gravity: 1, repulsion: 2, linkAttraction: 3, domainCohesion: 1.5 },
      positions: { a: { x: 10, y: 20 } }, settled: false };
    const storage = { getItem: (key: string) => key === graphLayoutKey("a") ? JSON.stringify(saved) : null };
    expect(loadGraphLayout(storage, "a")).toEqual(saved);
    expect(loadGraphLayout(storage, "b")).toBeNull();
    expect(loadGraphLayout({ getItem: () => "broken" }, "a")).toBeNull();
    expect(loadGraphLayout({ getItem: () => JSON.stringify({ ...saved, positions: { a: { x: null, y: 2 } } }) }, "a")).toBeNull();
  });
  it("restores a legacy layout with domain cohesion safely disabled", () => {
    const saved = { fingerprint: graphFingerprint(graph), forces: { gravity: 1, repulsion: 2, linkAttraction: 3 },
      positions: { a: { x: 10, y: 20 } }, settled: true };
    const storage = { getItem: (key: string) => key === "nexo:graph-layout:v1:a" ? JSON.stringify(saved) : null };
    expect(loadGraphLayout(storage, "a")?.forces).toEqual({ ...saved.forces, domainCohesion: 0 });
  });
});
