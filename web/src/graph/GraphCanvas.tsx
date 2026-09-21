import { useEffect, useRef } from "react";
import { ActivationEngine } from "../activation/engine";
import { activationNow } from "../activation/clock";
import { THEME } from "../activation/theme";
import { buildFibers } from "./bundles";
import { Camera } from "./camera";
import { buildScene, drawActivationLayer, drawLabelLayer, drawRestLayer } from "./render";
import { nodeRadius } from "./cardVisuals";
import type { GraphData, GraphNode } from "./types";
import { useGraphForces } from "./useGraphForces";
import { GraphControls } from "./GraphControls";

interface Props {
  data: GraphData;
  engine: ActivationEngine;
  onNodeClick: (id: string) => void;
  activityTick?: number;
  viewKey?: string;
  onNarrationChange?: (narration: import("../activation/engine").GraphNarration) => void;
  focusMode: boolean;
  onFocusModeChange: (active: boolean) => void;
}

export function GraphCanvas(props: Props) {
  return <GraphCanvasView key={props.viewKey ?? "default"} {...props} />;
}

function GraphCanvasView({ data: source, engine, onNodeClick, activityTick = 0, onNarrationChange, viewKey = "default", focusMode, onFocusModeChange }: Props) {
  const { data, forces, changeForce, resetForces, status, retry } = useGraphForces(source, viewKey);
  const restRef = useRef<HTMLCanvasElement>(null);
  const actRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(new Camera(0, 0, 1));
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; startX: number; startY: number; pointerId: number; moved: boolean } | null>(null);
  const lastViewKey = useRef<string | null>(null);
  const callbacks = useRef({ onNodeClick, onNarrationChange });
  const wakeRef = useRef<(() => void) | null>(null);
  const updateDataRef = useRef<((next: GraphData) => void) | null>(null);

  useEffect(() => { callbacks.current = { onNodeClick, onNarrationChange }; }, [onNodeClick, onNarrationChange]);

  useEffect(() => { wakeRef.current?.(); }, [activityTick]);

  useEffect(() => {
    const { fibers } = buildFibers(data);
    let scene = buildScene(data.nodes, fibers);
    let graph = data;
    const camera = cameraRef.current;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionPreference.matches;
    let raf = 0;
    let disposed = false;
    let last = performance.now();

    // 静息层：按当前视口的实际像素缓存；缩放/平移后重新矢量化，避免放大旧位图。
    const off = document.createElement("canvas");
    let restCacheDirty = true;
    const pad = 200;
    const xs = data.nodes.map((n) => n.x);
    const ys = data.nodes.map((n) => n.y);
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    // 初始取景：整图居中
    const host = restRef.current!.parentElement!;
    const fit = () => {
      const w = host.clientWidth, h = host.clientHeight;
      const fittedScale = Math.min(4, Math.max(0.08,
        Math.min(w / (maxX - minX), h / (maxY - minY)) * 0.95));
      // 保留约 63% 的放大余量（原上限再提高 15%），缩小则允许拉开上下文。
      const resetView = lastViewKey.current !== viewKey;
      if (resetView) camera.scale = fittedScale;
      if (resetView) camera.setScaleBounds(Math.max(0.05, fittedScale * 0.14), fittedScale * 1.633);
      if (resetView) {
        camera.x = (minX + maxX) / 2;
        camera.y = (minY + maxY) / 2;
        try { camera.restore(JSON.parse(localStorage.getItem(`nexo:graph-camera:v1:${viewKey}`) ?? "null")); } catch { /* use fitted view */ }
      }
      lastViewKey.current = viewKey;
    };
    fit();
    const saveCamera = () => {
      try { localStorage.setItem(`nexo:graph-camera:v1:${viewKey}`, JSON.stringify(camera.snapshot())); } catch { /* optional persistence */ }
    };
    window.addEventListener("pagehide", saveCamera);

    const renderRestCache = (w: number, h: number, dpr: number, now: number) => {
      const pixelWidth = Math.max(1, Math.round(w * dpr));
      const pixelHeight = Math.max(1, Math.round(h * dpr));
      if (off.width !== pixelWidth || off.height !== pixelHeight) {
        off.width = pixelWidth;
        off.height = pixelHeight;
      }

      const offCtx = off.getContext("2d")!;
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtx.fillStyle = THEME.colors.background;
      offCtx.fillRect(0, 0, pixelWidth, pixelHeight);

      const tx = w / 2 - camera.x * camera.scale;
      const ty = h / 2 - camera.y * camera.scale;
      offCtx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale,
        dpr * tx, dpr * ty);
      drawRestLayer(offCtx, scene, now, camera.scale);
      restCacheDirty = false;
    };

    const schedule = () => {
      if (!disposed && !raf) raf = requestAnimationFrame(frame);
    };
    const frame = (nowMs: number) => {
      raf = 0;
      const canvases = [restRef.current, actRef.current, labelRef.current];
      if (disposed || canvases.some(canvas => !canvas) || !host.isConnected) return;
      // 与 SSE 事件共用页面级单调时钟；数据刷新重建画布时不能重置时间原点。
      const now = activationNow(nowMs);
      const dt = Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;
      const progressed = engine.decay(dt, now);
      if (progressed) callbacks.current.onNarrationChange?.(engine.graphNarration());

      const w = host.clientWidth, h = host.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      let resized = false;
      for (const cv of canvases as HTMLCanvasElement[]) {
        if (cv.width !== w * dpr || cv.height !== h * dpr) {
          cv.width = w * dpr; cv.height = h * dpr;
          resized = true;
        }
      }
      if (resized) restCacheDirty = true;
      const actCtx = actRef.current!.getContext("2d")!;
      const labelCtx = labelRef.current!.getContext("2d")!;
      const restCtx = restRef.current!.getContext("2d")!;

      // 世界变换：dpr * scale，平移到相机
      const tx = w / 2 - camera.x * camera.scale;
      const ty = h / 2 - camera.y * camera.scale;
      const setWorld = (ctx: CanvasRenderingContext2D) =>
        ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale,
          dpr * tx, dpr * ty);

      if (restCacheDirty) renderRestCache(w, h, dpr, now);
      restCtx.setTransform(1, 0, 0, 1, 0, 0);
      restCtx.clearRect(0, 0, w * dpr, h * dpr);
      restCtx.drawImage(off, 0, 0);

      // 清屏必须回到像素坐标；沿用上帧世界变换会留下矩形遮罩和文字残影。
      actCtx.setTransform(1, 0, 0, 1, 0, 0);
      actCtx.clearRect(0, 0, w * dpr, h * dpr);
      const attention = engine.attentionLevel(now);
      if (attention > 0) {
        const [r, g, b] = THEME.colors.attentionVeil;
        actCtx.setTransform(1, 0, 0, 1, 0, 0);
        actCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${THEME.colors.attentionVeilAlpha * attention})`;
        actCtx.fillRect(0, 0, w * dpr, h * dpr);
      }
      setWorld(actCtx);
      actCtx.lineWidth = 1 / camera.scale;
      drawActivationLayer(actCtx, scene, engine, now, reducedMotion, camera.scale);

      labelCtx.setTransform(1, 0, 0, 1, 0, 0);
      labelCtx.clearRect(0, 0, w * dpr, h * dpr);
      setWorld(labelCtx);
      drawLabelLayer(labelCtx, scene, engine, camera, hoverRef.current, now, { width: w, height: h });

      if (engine.hasAttention() || dragRef.current !== null || restCacheDirty) schedule();
    };
    wakeRef.current = schedule;
    updateDataRef.current = next => {
      graph = next;
      scene = buildScene(next.nodes, buildFibers(next).fibers);
      restCacheDirty = true;
      schedule();
    };
    const onMotionPreference = () => { reducedMotion = motionPreference.matches; schedule(); };
    motionPreference.addEventListener("change", onMotionPreference);
    schedule();
    const resizeObserver = new ResizeObserver(() => {
      restCacheDirty = true;
      schedule();
    });
    resizeObserver.observe(host);

    // 交互
    const labelCv = labelRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = labelCv.getBoundingClientRect();
      camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top,
        rect.width, rect.height, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      saveCamera();
      restCacheDirty = true;
      schedule();
    };
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0) return;
      dragRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, moved: false };
      labelCv.style.cursor = "grabbing";
      labelCv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const rect = labelCv.getBoundingClientRect();
      const d = dragRef.current;
      if (d) {
        if (e.pointerId !== d.pointerId) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4) d.moved = true;
        camera.panBy(dx, dy);
        restCacheDirty = true;
        d.x = e.clientX; d.y = e.clientY;
      } else {
        const [wx, wy] = camera.toWorld(e.clientX - rect.left, e.clientY - rect.top,
          rect.width, rect.height);
        hoverRef.current = nearestNode(graph.nodes, scene.degrees, wx, wy, camera.scale)?.id ?? null;
        labelCv.style.cursor = hoverRef.current ? "pointer" : "grab";
      }
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      saveCamera();
      if (labelCv.hasPointerCapture(e.pointerId)) labelCv.releasePointerCapture(e.pointerId);
      labelCv.style.cursor = "grab";
      if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= 4) {
        const rect = labelCv.getBoundingClientRect();
        const [wx, wy] = camera.toWorld(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
        const node = nearestNode(graph.nodes, scene.degrees, wx, wy, camera.scale);
        if (node) callbacks.current.onNodeClick(node.id);
      }
      schedule();
    };
    const cancelDrag = () => { dragRef.current = null; labelCv.style.cursor = "grab"; schedule(); };
    const onLeave = () => { hoverRef.current = null; schedule(); };
    labelCv.addEventListener("wheel", onWheel, { passive: false });
    labelCv.addEventListener("pointerdown", onDown);
    labelCv.addEventListener("pointermove", onMove);
    labelCv.addEventListener("pointerup", onUp);
    labelCv.addEventListener("pointercancel", cancelDrag);
    labelCv.addEventListener("lostpointercapture", cancelDrag);
    labelCv.addEventListener("pointerleave", onLeave);

    return () => {
      disposed = true;
      saveCamera();
      window.removeEventListener("pagehide", saveCamera);
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      motionPreference.removeEventListener("change", onMotionPreference);
      wakeRef.current = null;
      updateDataRef.current = null;
      dragRef.current = null;
      labelCv.removeEventListener("wheel", onWheel);
      labelCv.removeEventListener("pointerdown", onDown);
      labelCv.removeEventListener("pointermove", onMove);
      labelCv.removeEventListener("pointerup", onUp);
      labelCv.removeEventListener("pointercancel", cancelDrag);
      labelCv.removeEventListener("lostpointercapture", cancelDrag);
      labelCv.removeEventListener("pointerleave", onLeave);
    };
  }, [engine, viewKey]);

  // Position previews update the scene without interrupting an active pointer gesture.
  useEffect(() => { updateDataRef.current?.(data); }, [data]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={restRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={actRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={labelRef} className="absolute inset-0 h-full w-full touch-none cursor-grab" />
      <GraphControls forces={forces} onChange={changeForce} onReset={resetForces} status={status} onRetry={retry}
        focusMode={focusMode} onFocusModeChange={onFocusModeChange} />
    </div>
  );
}

function nearestNode(
  nodes: GraphNode[],
  degreeOf: Map<string, number>,
  wx: number, wy: number, cameraScale: number
): GraphNode | null {
  let best: GraphNode | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const nd of nodes) {
    //  命中区域和绘制共用尺寸，小节点仍保留足够的点击空间。
    const hit = Math.max(12 / cameraScale, nodeRadius(degreeOf.get(nd.id) ?? 0, cameraScale) * 2.2);
    const d = Math.hypot(nd.x - wx, nd.y - wy);
    if (d < hit && d < bestD) { bestD = d; best = nd; }
  }
  return best;
}
