import { describe, expect, it } from "vitest";
import { DEFAULT_FORCES, forceStorageKey, loadForceSettings } from "./forceSettings";

describe("graph force preferences", () => {
  it("migrates the existing gravity value without affecting new forces or other instances", () => {
    const storage = { getItem: (key: string) => key === "nexo:graph-gravity:v1:a" ? "0.5" : null };
    expect(loadForceSettings(storage, "a")).toEqual({ gravity: .5, repulsion: 1, linkAttraction: 1, domainCohesion: 0 });
    expect(loadForceSettings(storage, "b")).toEqual(DEFAULT_FORCES);
  });
  it("prioritizes new settings, clamps values, and tolerates damaged or unavailable storage", () => {
    const storage = { getItem: (key: string) => key === forceStorageKey("a")
      ? JSON.stringify({ gravity: 0, repulsion: 99, linkAttraction: "bad", domainCohesion: 2.25 }) : "3" };
    expect(loadForceSettings(storage, "a")).toEqual({ gravity: 0, repulsion: 4, linkAttraction: 1, domainCohesion: 2.3 });
    expect(loadForceSettings({ getItem: key => key === forceStorageKey("a")
      ? JSON.stringify({ gravity: 1, repulsion: 1, linkAttraction: 1, domainCohesion: "bad" }) : null }, "a"))
      .toEqual(DEFAULT_FORCES);
    expect(loadForceSettings({ getItem: () => "broken" }, "a")).toEqual(DEFAULT_FORCES);
    expect(loadForceSettings({ getItem: () => { throw new Error("unavailable"); } }, "a")).toEqual(DEFAULT_FORCES);
  });
  it("aligns legacy fine increments with the displayed decimal value", () => {
    expect(loadForceSettings({ getItem: key => key === forceStorageKey("a")
      ? JSON.stringify({ gravity: 1.05, repulsion: 1.25, linkAttraction: 3.95, domainCohesion: 1.45 }) : null }, "a"))
      .toEqual({ gravity: 1.1, repulsion: 1.3, linkAttraction: 4, domainCohesion: 1.5 });
  });
  it("migrates the three-force schema with domain cohesion disabled", () => {
    const storage = { getItem: (key: string) => key === "nexo:graph-forces:v1:a"
      ? JSON.stringify({ gravity: .5, repulsion: 2, linkAttraction: 3 }) : null };
    expect(loadForceSettings(storage, "a")).toEqual({ gravity: .5, repulsion: 2, linkAttraction: 3, domainCohesion: 0 });
  });
});
