import type { Color } from "./types-extra";

export interface GraphPalette {
  light: boolean;
  background: string;
  labelBackground: string;
  labelInk: string;
  labelRgb: string;
}

export const DARK_GRAPH_PALETTE: GraphPalette = {
  light: false, background: "#343a43", labelBackground: "#2b3139", labelInk: "#f2f5f7", labelRgb: "43, 49, 57",
};

export function readGraphPalette(): GraphPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    light: document.documentElement.dataset.theme === "warm-white",
    background: read("--graph-background"), labelBackground: read("--graph-label-background"),
    labelInk: read("--graph-label-ink"), labelRgb: read("--graph-label-rgb"),
  };
}

export function graphColor(color: Color, palette: GraphPalette): Color {
  return palette.light ? color.map(channel => Math.round(channel * .64)) as Color : color;
}

const LIGHT_NODE_COLORS: Record<string, Color> = {
  conflict: [146, 83, 193],
  entity: [10, 158, 171],
  case: [230, 120, 97],
  concept: [39, 139, 208],
  method: [207, 144, 31],
  mechanism: [38, 155, 100],
  model: [102, 116, 213],
  claim: [30, 154, 197],
  phenomenon: [206, 100, 153],
  undetermined: [120, 150, 174],
  domain: [194, 163, 46],
};

export function graphNodeColor(type: string, color: Color, palette: GraphPalette): Color {
  if (!palette.light) return color;
  return Object.hasOwn(LIGHT_NODE_COLORS, type) ? LIGHT_NODE_COLORS[type] : LIGHT_NODE_COLORS.undetermined;
}
