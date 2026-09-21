import { describe, expect, it, vi } from "vitest";
import { ActivationEngine } from "../activation/engine";
import { THEME } from "../activation/theme";
import { Camera } from "./camera";
import { buildFibers } from "./bundles";
import { activeSignalColor, buildScene, compactTitleLines, drawLabelLayer, drawRestLayer, readPulseScale } from "./render";

describe("graph activation visuals", () => {
  it("静态图每条真实关系只绘制一根线", () => {
    const nodes = ["a", "b"].map((id, i) => ({ id, title: id, type: "claim", domains: [], x: i * 60, y: 0 }));
    const { fibers } = buildFibers({ nodes, edges: [{ id: "ab", from: "a", to: "b", kind: "relation", relation_type: "supports", bundle: "test" }] });
    const stroke = vi.fn();
    const ctx = { stroke, beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), arc: vi.fn(), fill: vi.fn(), createRadialGradient: () => ({ addColorStop: vi.fn() }) } as unknown as CanvasRenderingContext2D;
    drawRestLayer(ctx, buildScene(nodes, fibers), 0, 0.5);
    expect(stroke).toHaveBeenCalledTimes(1);
  });

  it("counts distinct neighboring cards, excluding duplicate, reversed and self relations", () => {
    const nodes = ["a", "b", "c", "isolated"].map((id, i) => ({ id, title: id, type: "claim", domains: [], x: i * 10, y: 0 }));
    const edges = [["a", "b"], ["a", "b"], ["b", "a"], ["a", "a"], ["a", "c"], ["a", "missing"]]
      .map(([from, to], i) => ({ id: String(i), from, to, kind: "relation", relation_type: "supports", bundle: "test" }));
    const { fibers } = buildFibers({ nodes, edges });
    expect(Object.fromEntries(buildScene(nodes, fibers).degrees)).toEqual({ a: 2, b: 1, c: 1, isolated: 0 });
  });

  it("沿边检索光从金色尾迹抬亮到暖白金前锋", () => {
    expect(activeSignalColor(0)).toEqual(THEME.colors.signal);
    expect(activeSignalColor(1)).toEqual(THEME.colors.signalHead);
  });

  it("精读节点在 5.5 秒内完成两次缓慢脉冲", () => {
    expect(readPulseScale(0)).toBeCloseTo(0.68);
    expect(readPulseScale(THEME.timing.readPulseDuration / 4)).toBeCloseTo(1);
    expect(readPulseScale(THEME.timing.readPulseDuration / 2)).toBeCloseTo(0.68);
    expect(readPulseScale(THEME.timing.readPulseDuration * 3 / 4)).toBeCloseTo(1);
    expect(readPulseScale(THEME.timing.readPulseDuration)).toBeCloseTo(0.68);
  });

  it("非精读认知激活不自动绘制卡片标题", () => {
    const engine = new ActivationEngine([]);
    engine.handleEvent({ type: "evidence.verify", ts: 0, payload: { valid_ids: ["card-a"] } }, 10);
    const fillText = vi.fn();
    const scene = buildScene([{ id: "card-a", title: "很长的卡片标题", type: "claim", domains: [], x: 0, y: 0 }], []);
    drawLabelLayer({ fillText } as unknown as CanvasRenderingContext2D, scene, engine, new Camera(), null, 11, { width: 800, height: 600 });
    expect(fillText).not.toHaveBeenCalled();
  });

  it("精读长标题限制为两行，并为被截断内容保留省略号", () => {
    const ctx = { measureText: (text: string) => ({ width: Array.from(text).length * 11 }) } as CanvasRenderingContext2D;
    const lines = compactTitleLines(ctx, "流动性缓冲为什么可能在市场压力条件下引发被迫出售的自我强化反馈及其适用边界", 154);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines.every((line) => ctx.measureText(line).width <= 154)).toBe(true);
  });
});
