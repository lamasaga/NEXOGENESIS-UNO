import { simulate } from "../../../packages/nexogenesis-tools/lib/graph-simulation.js";
import type { GraphData } from "./types";
import type { GraphForces } from "./forceSettings";

self.onmessage = (event: MessageEvent<{ data: GraphData; forces: GraphForces }>) => {
  const { data, forces } = event.data;
  const initial = Object.fromEntries(data.nodes.map(node => [node.id, [node.x, node.y]]));
  const positions = simulate(data.nodes, data.edges, 220, initial, undefined, {
    ...forces,
    interactive: true,
    onProgress: positions => self.postMessage({ positions, done: false }),
  });
  self.postMessage({ positions, done: true });
};
