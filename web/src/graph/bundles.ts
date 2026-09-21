import type { GraphData, GraphEdge, GraphNode } from "./types";
import type { Color } from "./types-extra";

/** 关系类型 → 激活色相（映射表，后续可配） */
export const RELATION_COLORS: Record<string, Color> = {
  specialization: [139, 157, 222],
  supplement: [91, 176, 211],
  contrast: [210, 126, 171],
  challenge: [226, 122, 135],
  analogy: [99, 200, 207],
  example: [139, 191, 225],
  application: [102, 195, 159],
  supports: [96, 165, 250],
  extends: [56, 189, 248],
  "conflicts-with": [226, 120, 245],
  involves: [226, 120, 245],
  "applies-to": [125, 211, 252],
  "based-on": [167, 139, 250],
  influences: [96, 165, 250],
  "example-of": [147, 197, 253],
};
export const DEFAULT_COLOR: Color = [96, 165, 250];

export interface Strand {
  offset: number;
  phase: number;
  delay: number;
}

export interface Fiber {
  edge: GraphEdge;
  a: GraphNode;
  b: GraphNode;
  strands: Strand[];
  intra: boolean;
  domainKey: string;
  relationColor: Color;
}

export interface Bundle {
  id: string;
  fibers: Fiber[];
}

/** FNV-1a 字符串哈希 → [0,1)，跨会话确定 */
export function hash01(seed: string, salt: string): number {
  let h = 2166136261;
  const s = `${seed}:${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function buildFibers(data: GraphData): { bundles: Bundle[]; fibers: Fiber[] } {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const bundleMap = new Map<string, Bundle>();
  const fibers: Fiber[] = [];

  for (const edge of data.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const da = a.domains[0] ?? "_none";
    const db = b.domains[0] ?? "_none";
    const intra = da === db;
    const domainKey = edge.bundle;
    let bundle = bundleMap.get(domainKey);
    if (!bundle) {
      bundle = { id: domainKey, fibers: [] };
      bundleMap.set(domainKey, bundle);
    }
    const strandCount = intra ? 2 : 3 + Math.floor(hash01(edge.id, "sc") * 3);
    const strands: Strand[] = [];
    for (let s = 0; s < strandCount; s++) {
      strands.push({
        offset: s === 0 ? 0 : (hash01(edge.id, `o${s}`) - 0.5) * 8,
        phase: hash01(edge.id, `p${s}`) * Math.PI * 2,
        delay: hash01(edge.id, `d${s}`) * 0.25,
      });
    }
    const fiber: Fiber = {
      edge,
      a,
      b,
      strands,
      intra,
      domainKey,
      relationColor: RELATION_COLORS[edge.relation_type ?? ""] ?? DEFAULT_COLOR,
    };
    bundle.fibers.push(fiber);
    fibers.push(fiber);
  }
  return { bundles: [...bundleMap.values()], fibers };
}

/**  中心路径直接连接真实端点；不再按领域弯折出额外的视觉聚类。 */
export function controlPoint(
  f: Fiber,
  _clusterCenters: Map<string, { x: number; y: number }>
): { x: number; y: number } {
  const mx = (f.a.x + f.b.x) / 2;
  const my = (f.a.y + f.b.y) / 2;
  return { x: mx, y: my };
}

/** 贝塞尔取点 */
export function qPoint(
  ax: number, ay: number, cx: number, cy: number, bx: number, by: number, q: number
): { x: number; y: number } {
  const u = 1 - q;
  return {
    x: u * u * ax + 2 * u * q * cx + q * q * bx,
    y: u * u * ay + 2 * u * q * cy + q * q * by,
  };
}
