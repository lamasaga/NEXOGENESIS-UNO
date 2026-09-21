import { describe, expect, it } from "vitest";
import { Camera } from "./camera";

describe("Camera", () => {
  it("restores position, zoom and limits while rejecting invalid stored values", () => {
    const camera = new Camera(50, -30, 1.2);
    camera.setScaleBounds(.05, 2);
    const restored = new Camera(0, 0, 1);
    expect(restored.restore(camera.snapshot())).toBe(true);
    expect(restored.snapshot()).toEqual(camera.snapshot());
    for (const invalid of [null, {}, { ...camera.snapshot(), scale: 0 }, { ...camera.snapshot(), x: Infinity }]) {
      expect(restored.restore(invalid)).toBe(false);
      expect(restored.snapshot()).toEqual(camera.snapshot());
    }
  });
  it("世界/屏幕坐标互转可逆", () => {
    const cam = new Camera(10, 20, 1.5);
    const [sx, sy] = cam.toScreen(100, 50, 800, 600);
    const [wx, wy] = cam.toWorld(sx, sy, 800, 600);
    expect(wx).toBeCloseTo(100, 6);
    expect(wy).toBeCloseTo(50, 6);
  });

  it("zoomAt 后光标下的世界点保持不动", () => {
    const cam = new Camera(0, 0, 1);
    const [wx, wy] = cam.toWorld(600, 300, 800, 600);
    cam.zoomAt(600, 300, 800, 600, 1.2);
    const [sx2, sy2] = cam.toScreen(wx, wy, 800, 600);
    expect(sx2).toBeCloseTo(600, 4);
    expect(sy2).toBeCloseTo(300, 4);
  });

  it("缩放范围受限 [0.2, 4]", () => {
    const cam = new Camera(0, 0, 1);
    for (let i = 0; i < 50; i++) cam.zoomAt(400, 300, 800, 600, 1.5);
    expect(cam.scale).toBeLessThanOrEqual(4);
    for (let i = 0; i < 100; i++) cam.zoomAt(400, 300, 800, 600, 0.5);
    expect(cam.scale).toBeGreaterThanOrEqual(0.2);
  });

  it("支持以初始构图为基准的非对称缩放范围", () => {
    const cam = new Camera(0, 0, 1);
    cam.setScaleBounds(0.14, 1.18);
    for (let i = 0; i < 20; i++) cam.zoomAt(400, 300, 800, 600, 1.2);
    expect(cam.scale).toBeCloseTo(1.18);
    for (let i = 0; i < 40; i++) cam.zoomAt(400, 300, 800, 600, 0.5);
    expect(cam.scale).toBeCloseTo(0.14);
  });

  it("panBy 平移", () => {
    const cam = new Camera(0, 0, 2);
    cam.panBy(10, -20);
    expect(cam.x).toBeCloseTo(-5);
    expect(cam.y).toBeCloseTo(10);
  });
});
