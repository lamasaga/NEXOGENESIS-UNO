import { topology, type Positions } from "../../../packages/nexogenesis-tools/lib/graph-simulation.js";
import type { GraphForces } from "./forceSettings";
import type { GraphData } from "./types";

export interface SavedGraphLayout {
  fingerprint: string;
  forces: GraphForces;
  positions: Positions;
  settled: boolean;
}
export const graphLayoutKey = (viewKey: string) => `nexo:graph-layout:v2:${viewKey}`;
const legacyGraphLayoutKey = (viewKey: string) => `nexo:graph-layout:v1:${viewKey}`;
export const sameForces = (a: GraphForces, b: GraphForces) =>
  a.gravity === b.gravity && a.repulsion === b.repulsion && a.linkAttraction === b.linkAttraction
  && a.domainCohesion === b.domainCohesion;
const isForceValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4;
const isPosition = (value: any) => value && Number.isFinite(value.x) && Number.isFinite(value.y);

/** Labels and backend coordinate refreshes do not invalidate a user's layout. */
export function graphFingerprint(data: GraphData): string {
  const graph = topology(data.nodes, data.edges);
  const text = JSON.stringify([graph.nodes.map(n => [n.id, [...(n.domains ?? [])].sort()]), graph.edges]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `interactive-2:${text.length}:${a >>> 0}:${b >>> 0}`;
}

export function loadGraphLayout(storage: Pick<Storage, "getItem">, viewKey: string): SavedGraphLayout | null {
  try {
    const current = storage.getItem(graphLayoutKey(viewKey));
    const item = JSON.parse(current ?? storage.getItem(legacyGraphLayoutKey(viewKey)) ?? "null");
    const domainCohesion = item?.forces?.domainCohesion ?? 0;
    if (!item || typeof item.fingerprint !== "string" || typeof item.settled !== "boolean"
      || !item.positions || Array.isArray(item.positions) || typeof item.positions !== "object"
      || !item.forces || ![item.forces.gravity, item.forces.repulsion, item.forces.linkAttraction, domainCohesion].every(isForceValue)
      || !Object.values(item.positions).every(isPosition)) return null;
    return { ...item, forces: { ...item.forces, domainCohesion } };
  } catch { return null; }
}

export function saveGraphLayout(viewKey: string, layout: SavedGraphLayout) {
  try { localStorage.setItem(graphLayoutKey(viewKey), JSON.stringify(layout)); } catch { /* storage can be unavailable or full */ }
}
