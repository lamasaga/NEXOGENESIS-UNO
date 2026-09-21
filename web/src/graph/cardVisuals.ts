import type { Color } from "./types-extra";
import { nodeWorldRadius } from "../../../packages/nexogenesis-tools/lib/node-geometry.js";
export { sizeFactorOf } from "../../../packages/nexogenesis-tools/lib/node-geometry.js";

export type CardVisualKind = "standard" | "domain" | "conflict";

export interface NodeVisual {
  color: Color;
  alpha: number;
  halo: number;
}

/**  实体与布局间距同比缩放，不用最小屏幕圆点突破碰撞边界。 */
export function nodeRadius(degree: number, _cameraScale: number): number {
  return nodeWorldRadius(degree);
}

const CARD_TYPE_COLORS: Record<string, Color> = {
  //  现行十种卡片分类与领域节点均有稳定的低饱和星云色，不再落入灰色兜底。
  conflict: [177, 133, 205], entity: [121, 190, 184], case: [201, 155, 151],
  concept: [132, 171, 211], method: [219, 193, 149], mechanism: [109, 181, 163],
  model: [143, 158, 211], claim: [113, 179, 190], phenomenon: [193, 167, 189],
  undetermined: [158, 164, 178], domain: [240, 218, 179],
};
const FALLBACK_COLOR: Color = [148, 163, 184];

export function cardTypeColor(type: string): Color {
  return Object.hasOwn(CARD_TYPE_COLORS, type) ? CARD_TYPE_COLORS[type] : FALLBACK_COLOR;
}

export function cardTypeCssColor(type: string): string {
  return `rgb(${cardTypeColor(type).join(", ")})`;
}

const GEOMETRY: Record<CardVisualKind, Pick<NodeVisual, "halo">> = {
  standard: { halo: 8 },
  domain: { halo: 18 },
  conflict: { halo: 12 },
};
const FALLBACK_VISUAL: NodeVisual = { color: FALLBACK_COLOR, alpha: 1, ...GEOMETRY.standard };
const VISUALS: Record<string, NodeVisual> = Object.fromEntries(
  Object.keys(CARD_TYPE_COLORS).map(type => [type, { color: cardTypeColor(type), alpha: 1, ...GEOMETRY[cardVisualKind(type)] }]),
);

export function cardVisualKind(type: string): CardVisualKind {
  if (type === "domain") return "domain";
  if (type === "conflict") return "conflict";
  return "standard";
}

export function nodeVisual(type: string): NodeVisual {
  return Object.hasOwn(VISUALS, type) ? VISUALS[type] : FALLBACK_VISUAL;
}

export function cardTypeLabel(type: string): string {
  if (type === "domain") return "领域";
  if (type === "conflict") return "冲突";
  return type;
}
