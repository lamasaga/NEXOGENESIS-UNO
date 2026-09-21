import { normalizeForce } from "../../../packages/nexogenesis-tools/lib/graph-simulation.js";

export interface GraphForces { gravity: number; repulsion: number; linkAttraction: number; domainCohesion: number }
export const DEFAULT_FORCES: GraphForces = { gravity: 1, repulsion: 1, linkAttraction: 1, domainCohesion: 0 };
export const forceStorageKey = (viewKey: string) => `nexo:graph-forces:v2:${viewKey}`;
const legacyForceStorageKey = (viewKey: string) => `nexo:graph-forces:v1:${viewKey}`;
export const isDefaultForces = (forces: GraphForces) =>
  forces.gravity === 1 && forces.repulsion === 1 && forces.linkAttraction === 1 && forces.domainCohesion === 0;
const sliderValue = (value: unknown, fallback = 1) => typeof value === "number" && Number.isFinite(value)
  ? Math.round(normalizeForce(value) * 10) / 10
  : fallback;
const parseSavedForces = (value: string): GraphForces => {
  const parsed = JSON.parse(value);
  return {
    gravity: sliderValue(parsed?.gravity),
    repulsion: sliderValue(parsed?.repulsion),
    linkAttraction: sliderValue(parsed?.linkAttraction),
    domainCohesion: sliderValue(parsed?.domainCohesion, 0),
  };
};

export function loadForceSettings(storage: Pick<Storage, "getItem">, viewKey: string): GraphForces {
  try {
    const saved = storage.getItem(forceStorageKey(viewKey));
    if (saved === null) {
      const legacyForces = storage.getItem(legacyForceStorageKey(viewKey));
      if (legacyForces !== null) return parseSavedForces(legacyForces);
      const legacy = storage.getItem(`nexo:graph-gravity:v1:${viewKey}`);
      return { ...DEFAULT_FORCES, gravity: legacy === null ? 1 : sliderValue(JSON.parse(legacy)) };
    }
    return parseSavedForces(saved);
  } catch { return { ...DEFAULT_FORCES }; }
}
