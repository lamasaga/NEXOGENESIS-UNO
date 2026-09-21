import { describe, expect, it } from "vitest";
import { cardTypeLabel, cardVisualKind, nodeRadius, nodeVisual } from "./cardVisuals";

describe("card visuals", () => {
  it("grows uniformly from 1 to 20 neighbors and caps the radius at 3:1 at every zoom", () => {
    for (const scale of [0.05, 0.14, 0.6, 1, 4, 12]) {
      const radii = Array.from({ length: 20 }, (_, i) => nodeRadius(i + 1, scale));
      expect(radii[0]).toBe(3);
      expect(radii.at(-1)! / radii[0]).toBeCloseTo(3, 12);
      for (let i = 1; i < radii.length; i++) {
        expect(radii[i] - radii[i - 1]).toBeCloseTo(6 / 19, 12);
      }
      expect(nodeRadius(0, scale)).toBe(radii[0]);
      for (const degree of [21, 99, 10000]) {
        expect(nodeRadius(degree, scale)).toBe(radii.at(-1));
      }
    }
  });

  it("uses distinct but muted visual identities for domain and conflict cards", () => {
    expect(cardVisualKind("domain")).toBe("domain");
    expect(cardVisualKind("conflict")).toBe("conflict");
    expect(cardVisualKind("claim")).toBe("standard");
    expect(nodeVisual("domain").color).not.toEqual(nodeVisual("conflict").color);
  });

  it("uses Chinese labels for the two structural card types", () => {
    expect(cardTypeLabel("domain")).toBe("领域");
    expect(cardTypeLabel("conflict")).toBe("冲突");
  });

  it("covers every current unit-card classification without the fallback color", () => {
    const current = ["conflict", "entity", "case", "concept", "method", "mechanism", "model", "claim", "phenomenon", "undetermined"];
    const fallback = nodeVisual("unknown-type").color;
    for (const type of current) expect(nodeVisual(type).color).not.toEqual(fallback);
  });
});
