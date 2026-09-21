import { describe, expect, it } from "vitest";
import { graphTopologyDelta, projectWorkNeuralFlow, visibleGraphNodeIds } from "./project-neural-flow";

describe("work neural flow projection", () => {
  it("distinguishes dialogue, compilation, construction and publishing", () => {
    expect(projectWorkNeuralFlow({ workflow: "dialogue", phase: "retrieve" })?.payload.kind).toBe("inquiry");
    expect(projectWorkNeuralFlow({ workflow: "compile", phase: "generate" })?.payload.kind).toBe("encoding");
    expect(projectWorkNeuralFlow({ workflow: "construct", phase: "authoring" })?.payload.kind).toBe("rewiring");
    expect(projectWorkNeuralFlow({ workflow: "construct", phase: "reviewing" })?.payload.kind).toBe("convergence");
    expect(projectWorkNeuralFlow({ workflow: "construct", phase: "publishing" })?.payload.kind).toBe("commit");
  });

  it("stops a flow when a work item reaches a terminal status", () => {
    expect(projectWorkNeuralFlow({ workflow: "dialogue", status: "completed" })?.type).toBe("neural.stop");
  });

  it("only resolves namespaced ids that belong to the visible knowledge base", () => {
    const graph = { nodes: [{ id: "a", title: "A", type: "claim", domains: [], x: 0, y: 0 }], edges: [] };
    expect(visibleGraphNodeIds(["kb:main:a", "kb:other:a", "missing"], graph, "main")).toEqual(["a"]);
  });

  it("derives commit targets from actual graph topology changes", () => {
    const previous = { nodes: [{ id: "a", title: "A", type: "claim", domains: [], x: 0, y: 0 }], edges: [] };
    const next = {
      nodes: [...previous.nodes, { id: "b", title: "B", type: "concept", domains: [], x: 1, y: 1 }],
      edges: [{ id: "ab", from: "a", to: "b", kind: "relation", relation_type: "supplement", bundle: "x" }],
    };
    expect(graphTopologyDelta(previous, next)).toEqual({ nodeIds: ["b"], edgeIds: ["ab"] });
  });
});
