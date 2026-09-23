import type { ActivationEngine, NeuralFlowKind } from "../activation/engine";
import { THEME } from "../activation/theme";
import { controlPoint, hash01, qPoint, type Fiber } from "./bundles";
import type { Camera } from "./camera";
import { nodeRadius, nodeVisual, sizeFactorOf } from "./cardVisuals";
import type { GraphNode } from "./types";
import type { Color } from "./types-extra";
import { DARK_GRAPH_PALETTE, graphColor, graphNodeColor, type GraphPalette } from "./palette";

const SEG = 22;

export interface Scene {
  nodes: GraphNode[];
  fibers: Fiber[];
  clusterCenters: Map<string, { x: number; y: number }>;
  domains: Map<string, { x: number; y: number; label: string }>;
  center: { x: number; y: number };
  scanRadius: number;
  /**  直接关联的不同卡片数，重复关系和自环不增加大小。 */
  degrees: Map<string, number>;
  neuralFibers: Record<NeuralFlowKind, Fiber[]>;
  fibersByNode: Map<string, Fiber[]>;
}

/** 从图数据派生场景（簇心 = 各 domain 节点坐标均值；连接度来自关系纤维） */
export function buildScene(nodes: GraphNode[], fibers: Fiber[]): Scene {
  const neighbors = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const f of fibers) {
    if (f.a.id === f.b.id || !neighbors.has(f.a.id) || !neighbors.has(f.b.id)) continue;
    neighbors.get(f.a.id)!.add(f.b.id);
    neighbors.get(f.b.id)!.add(f.a.id);
  }
  const degrees = new Map([...neighbors].map(([id, linked]) => [id, linked.size]));
  const sums = new Map<string, { x: number; y: number; n: number }>();
  for (const nd of nodes) {
    const d = nd.domains[0] ?? "_none";
    const s = sums.get(d) ?? { x: 0, y: 0, n: 0 };
    s.x += nd.x; s.y += nd.y; s.n++;
    sums.set(d, s);
  }
  // 全图质心：标签沿「簇心 → 外侧」径向摆放
  let gx = 0, gy = 0;
  for (const nd of nodes) { gx += nd.x; gy += nd.y; }
  gx /= nodes.length; gy /= nodes.length;
  const clusterCenters = new Map<string, { x: number; y: number }>();
  const domains = new Map<string, { x: number; y: number; label: string }>();
  for (const [d, s] of sums) {
    const c = { x: s.x / s.n, y: s.y / s.n };
    clusterCenters.set(d, c);
    let dx = c.x - gx, dy = c.y - gy;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const domainNode = nodes.find((nd) => nd.id === d);
    domains.set(d, {
      x: c.x + dx * 95,
      y: c.y + dy * 95,
      label: domainNode?.title ?? d,
    });
  }
  const scanRadius = Math.max(...nodes.map((node) => Math.hypot(node.x - gx, node.y - gy)), 1) * 1.08;
  const kinds: NeuralFlowKind[] = ["inquiry", "encoding", "rewiring", "convergence", "commit"];
  const neuralFibers = Object.fromEntries(kinds.map(kind => [kind, [...fibers]
    .sort((a, b) => hash01(a.edge.id, kind) - hash01(b.edge.id, kind))
    .slice(0, kind === "convergence" ? 72 : 54)])) as Record<NeuralFlowKind, Fiber[]>;
  const fibersByNode = new Map<string, Fiber[]>();
  for (const fiber of fibers) {
    for (const id of [fiber.a.id, fiber.b.id]) fibersByNode.set(id, [...(fibersByNode.get(id) ?? []), fiber]);
  }
  return { nodes, fibers, clusterCenters, domains, center: { x: gx, y: gy }, scanRadius, degrees, neuralFibers, fibersByNode };
}

function strandPath(
  ctx: CanvasRenderingContext2D, f: Fiber, scene: Scene, offset: number
): void {
  const cp = controlPoint(f, scene.clusterCenters);
  const dx = f.b.x - f.a.x;
  const dy = f.b.y - f.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = cp.x + offset * (-dy / len);
  const cy = cp.y + offset * (dx / len);
  ctx.moveTo(f.a.x, f.a.y);
  ctx.quadraticCurveTo(cx, cy, f.b.x, f.b.y);
}

/**  静息层：每条关系一根细线，节点与光晕按当前视口缓存。 */
export function drawRestLayer(
  ctx: CanvasRenderingContext2D, scene: Scene, _now: number, cameraScale = 1, palette = DARK_GRAPH_PALETTE
): void {
  for (const f of scene.fibers) {
    const [r, g, b] = graphColor(f.relationColor, palette);
    const alpha = f.intra ? 0.2 : 0.26;
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.7 / cameraScale;
    ctx.beginPath();
    strandPath(ctx, f, scene, 0);
    ctx.stroke();
  }
  for (const [, c] of scene.clusterCenters) {
    const grd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 95);
    grd.addColorStop(0, "rgba(135,161,208,0.035)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 95, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const nd of scene.nodes) {
    const visual = nodeVisual(nd.type);
    const [r, g, b] = graphNodeColor(nd.type, visual.color, palette);
    //  节点面积只由不同邻居数决定，光晕保留类型风格。
    const factor = sizeFactorOf(scene.degrees.get(nd.id) ?? 0);
    if (visual.halo > 0) {
      const glow = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, visual.halo * factor);
      glow.addColorStop(0, `rgba(${r},${g},${b},${palette.light ? 0.045 : 0.16})`);
      glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, visual.halo * factor, 0, Math.PI * 2);
      ctx.fill();
    }
    const drawRadius = nodeRadius(scene.degrees.get(nd.id) ?? 0, cameraScale);
    ctx.fillStyle = `rgba(${r},${g},${b},${visual.alpha})`;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, drawRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 激活层：活跃束逐段顺序点亮 + 节点光晕（每帧） */
export function drawActivationLayer(
  ctx: CanvasRenderingContext2D, scene: Scene, engine: ActivationEngine, now: number,
  reducedMotion = false, cameraScale = 1,
): void {
  drawSearchMotion(ctx, scene, engine, now, reducedMotion, cameraScale);
  drawNeuralFlow(ctx, scene, engine, now, reducedMotion, cameraScale);
  for (const f of scene.fibers) {
    // Agent 返回的是精确 edge id：不能因为视觉上同属一个 bundle 就点亮整束关系。
    const heat = engine.heatOf(f.edge.id, now);
    if (!heat || heat.fade <= 0) continue;
    // 静息边继续保留关系类型色；只有沿边检索的传播光统一改用金色。
    const [sR, sG, sB] = heat.signal === "tension" ? THEME.colors.tensionSignal
      : heat.signal === "inversion" ? THEME.colors.inversionSignal : THEME.colors.signal;
    const [hR, hG, hB] = heat.signal === "tension" ? THEME.colors.tensionHead
      : heat.signal === "inversion" ? THEME.colors.inversionHead : THEME.colors.signalHead;
    for (let strandIndex = 0; strandIndex < f.strands.length; strandIndex++) {
      const st = f.strands[strandIndex];
      const cp = controlPoint(f, scene.clusterCenters);
      const dx = f.b.x - f.a.x;
      const dy = f.b.y - f.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ccx = cp.x + st.offset * (-dy / len);
      const ccy = cp.y + st.offset * (dx / len);
      const front = reducedMotion ? 1.3 : Math.max(0, heat.front - st.delay);
      let px = f.a.x, py = f.a.y;
      for (let s = 1; s <= SEG; s++) {
        const q = s / SEG;
        const p = qPoint(f.a.x, f.a.y, ccx, ccy, f.b.x, f.b.y, q);
        const travel = heat.signal === "tension" ? Math.min((s - 0.5) / SEG, 1 - (s - 0.5) / SEG) * 2
          : heat.direction === 1 ? (s - 0.5) / SEG : 1 - (s - 0.5) / SEG;
        const passed = front - travel;
        const lit = passed <= 0 ? 0 : Math.min(1, passed * 12);
        const hot = Math.max(0, 1 - Math.abs(passed) * 18);
        if (lit <= 0) { px = p.x; py = p.y; continue; }
        // 前锋从金色抬亮到暖白金，尾迹不再回落为关系类型色。
        const [r, g, b] = activeSignalColor(hot, heat.signal);
        const readinessAlpha = heat.readiness === "legacy" ? 0.38 : 1;
        ctx.strokeStyle = `rgba(${r},${g},${b},${THEME.fibers.litAlpha * lit * heat.fade * readinessAlpha})`;
        ctx.lineWidth = ((heat.readiness === "legacy" ? 0.62 : 0.9) + hot * (heat.readiness === "legacy" ? 0.28 : 0.75)) / cameraScale;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        px = p.x; py = p.y;
      }
      // 只在真实 edge 的中心纤维上绘制神经信号包；它们的位置就是当前传播进度。
      if (heat.signal === "tension" && strandIndex === 0 && front > 0) {
        const progress = Math.min(1, front);
        ctx.fillStyle = `rgba(${hR},${hG},${hB},${heat.fade})`;
        for (const q of [progress / 2, 1 - progress / 2]) {
          const point = qPoint(f.a.x, f.a.y, ccx, ccy, f.b.x, f.b.y, q);
          ctx.beginPath(); ctx.arc(point.x, point.y, 2.4 / cameraScale, 0, Math.PI * 2); ctx.fill();
        }
        if (progress === 1) {
          const point = qPoint(f.a.x, f.a.y, ccx, ccy, f.b.x, f.b.y, 0.5);
          const r = 6 / cameraScale;
          ctx.strokeStyle = `rgba(${hR},${hG},${hB},${heat.fade})`; ctx.lineWidth = 1.5 / cameraScale;
          ctx.beginPath(); ctx.moveTo(point.x, point.y - r); ctx.lineTo(point.x, point.y + r); ctx.stroke();
        }
      }
      if (heat.signal !== "tension" && !reducedMotion && heat.readiness === "ready" && strandIndex === 0 && front > 0.015 && front < 1.02) {
        // 一前两后的微粒形成可辨的神经脉冲列，但不增加不存在的关系或方向。
        for (const [packet, lag] of [0, 0.105, 0.21].entries()) {
          const travel = front - lag;
          if (travel <= 0 || travel >= 1.02) continue;
          const q = heat.direction === 1 ? travel : 1 - travel;
          const head = qPoint(f.a.x, f.a.y, ccx, ccy, f.b.x, f.b.y, q);
          const packetAlpha = heat.fade * (1 - packet * 0.25);
          const haloRadius = (4.8 + heat.depth * 0.45 - packet * 0.55) / cameraScale;
          const halo = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, haloRadius);
          halo.addColorStop(0, `rgba(${hR},${hG},${hB},${0.72 * packetAlpha})`);
          halo.addColorStop(0.34, `rgba(${sR},${sG},${sB},${0.28 * packetAlpha})`);
          halo.addColorStop(1, `rgba(${sR},${sG},${sB},0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(head.x, head.y, haloRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(${hR},${hG},${hB},${(0.88 - packet * 0.16) * packetAlpha})`;
          ctx.beginPath();
          ctx.arc(head.x, head.y, (0.9 - packet * 0.12) / cameraScale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const target = heat.direction === 1 ? f.b.id : f.a.id;
      const source = heat.direction === 1 ? f.a.id : f.b.id;
      if (front >= 1) engine.pokeFromRenderer(target, 1.0 * heat.fade, now, heat.depth, heat.signal);
      if (front > 0.05) engine.pokeFromRenderer(source, 0.55 * heat.fade, now, Math.max(1, heat.depth - 1), heat.signal);
    }
  }
  for (const nd of scene.nodes) {
    const motion = engine.nodeMotionOf(nd.id, now);
    if (!motion || motion.act <= 0.25) continue;
    const { act, kind, age, depth } = motion;
    const visualAct = kind === "read" && !reducedMotion ? act * readPulseScale(age) : act;
    const [r, g, b] = motion.color;
    const [glowR, glowG, glowB] = motion.color;
    //  激活以颜色和光晕表达，实心节点不因任务高亮突破面积上限。
    const radius = nodeRadius(scene.degrees.get(nd.id) ?? 0, cameraScale);
    const glowRadius = radius * (kind === "read" ? 5.6 : 4.6);
    const grd = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, glowRadius);
    grd.addColorStop(0, `rgba(${glowR},${glowG},${glowB},${Math.min(0.42, visualAct * 0.34)})`);
    grd.addColorStop(1, `rgba(${glowR},${glowG},${glowB},0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(0.85, visualAct * 0.8)})`;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, radius, 0, Math.PI * 2);
    ctx.fill();
    drawNodeGesture(ctx, nd.x, nd.y, Math.max(radius, 5 / cameraScale), kind, age, visualAct, depth, cameraScale, reducedMotion, motion.color);
  }
  drawOperationOverlays(ctx, scene, engine, now, cameraScale, reducedMotion);
}

/** 操作级标记只连接明确的关系端点；比较与类比候选不伪造知识边。 */
function drawOperationOverlays(
  ctx: CanvasRenderingContext2D, scene: Scene, engine: ActivationEngine,
  now: number, scale: number, reducedMotion: boolean,
): void {
  for (const overlay of engine.overlaysAt(now)) {
    const age = now - overlay.startedAt;
    const progress = reducedMotion ? 1 : Math.min(1, age / THEME.timing.gestureDuration);
    const alpha = Math.min(1, age / THEME.timing.nodeEntryDuration, (overlay.endsAt - now) / THEME.timing.gestureExit);
    const ids = new Set(overlay.nodeIds);
    const nodes = scene.nodes.filter((node) => ids.has(node.id));
    if (!nodes.length) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.lineWidth = 1.3 / scale;
    if (overlay.kind === "compare" || overlay.kind === "analogy") {
      const sources = new Set(overlay.sourceIds ?? []);
      for (const node of nodes) {
        const source = sources.has(node.id);
        if (overlay.kind === "analogy" && !source && !reducedMotion && age < THEME.timing.frontDuration) continue;
        const r = (14 + (1 - progress) * 6) / scale;
        ctx.strokeStyle = overlay.kind === "compare" ? "rgba(255,205,135,.85)" : source ? "rgba(34,211,238,.95)" : "rgba(167,139,250,.85)";
        ctx.beginPath();
        if (overlay.kind === "analogy" && !source) ctx.setLineDash([3 / scale, 3 / scale]);
        const turn = reducedMotion ? 0 : progress * (source ? 1 : -1) * Math.PI * 0.7;
        ctx.arc(node.x, node.y, r, turn - Math.PI * 0.18, turn + Math.PI * 0.72);
        ctx.moveTo(node.x + Math.cos(turn + Math.PI) * (r + 3 / scale), node.y + Math.sin(turn + Math.PI) * (r + 3 / scale));
        ctx.arc(node.x, node.y, r + 3 / scale, turn + Math.PI, turn + Math.PI * 1.62);
        ctx.stroke(); ctx.setLineDash([]);
      }
    } else if (overlay.kind === "sufficient" || overlay.kind === "insufficient") {
      const ready = overlay.kind === "sufficient";
      const cx = nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length;
      const cy = nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length;
      const radius = Math.max(24 / scale, ...nodes.map(node => Math.hypot(node.x - cx, node.y - cy) + 14 / scale));
      ctx.strokeStyle = ready ? "rgba(52,211,153,.6)" : "rgba(251,191,36,.8)";
      ctx.setLineDash(ready ? [] : [5 / scale, 5 / scale]);
      for (let ring = 0; ring < 2; ring++) {
        const drift = reducedMotion ? 0 : progress * (ready ? -0.35 : 0.45);
        ctx.beginPath();
        ctx.arc(cx, cy, radius + ring * 7 / scale, drift + ring * Math.PI, drift + (ready ? Math.PI * 2 : Math.PI * 1.48));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.08);
      glow.addColorStop(0, ready ? "rgba(52,211,153,.08)" : "rgba(251,191,36,.07)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, radius * 1.08, 0, Math.PI * 2); ctx.fill();
    } else {
      const a = scene.nodes.find((node) => node.id === overlay.sourceId);
      const b = scene.nodes.find((node) => node.id === overlay.targetId);
      if (a && b && a.id !== b.id) {
        const applied = overlay.kind === "applied";
        const removing = overlay.decision === "remove";
        const t = overlay.kind === "pending" || reducedMotion ? 1 : progress;
        ctx.strokeStyle = removing ? "rgba(251,113,133,.9)" : applied ? "rgba(196,181,253,.95)" : "rgba(192,132,252,.85)";
        ctx.setLineDash(applied && !removing ? [] : [6 / scale, 5 / scale]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); ctx.stroke();
        ctx.setLineDash([]);
        if (!removing && t >= 1) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x);
          const tipX = b.x - Math.cos(angle) * 8 / scale, tipY = b.y - Math.sin(angle) * 8 / scale;
          ctx.beginPath();
          ctx.moveTo(tipX - Math.cos(angle - 0.5) * 8 / scale, tipY - Math.sin(angle - 0.5) * 8 / scale);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(tipX - Math.cos(angle + 0.5) * 8 / scale, tipY - Math.sin(angle + 0.5) * 8 / scale);
          ctx.stroke();
        }
        const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
        ctx.font = `500 ${10 / scale}px "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(235,225,250,.95)";
        ctx.fillText(applied ? removing ? "已移除" : "已写入" : overlay.kind === "pending" ? "待确认" : `预演 · ${removing ? "移除" : overlay.decision === "defer" ? "延后" : overlay.decision === "keep" ? "保留" : "调整"}`, x, y - 8 / scale);
        if (removing) {
          const r = 5 / scale;
          ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

/**
 * 工作级神经流使用真实图纤维作为视觉介质，但未把抽样纤维冒充为模型的精确检索路径。
 * 有明确 node_ids 时优先围绕这些真实节点活动；精确语义仍由 graph.hit/card.read 等事件承担。
 */
function drawNeuralFlow(
  ctx: CanvasRenderingContext2D, scene: Scene, engine: ActivationEngine, now: number,
  reducedMotion: boolean, cameraScale: number,
): void {
  const motion = engine.neuralFlow(now);
  if (!motion || motion.alpha <= 0.01 || !scene.fibers.length) return;
  const anchored = new Set(motion.nodeIds);
  const exactFibers = [...anchored].flatMap(id => scene.fibersByNode.get(id) ?? []);
  const fibers = [...new Map([...(exactFibers.length ? exactFibers : scene.neuralFibers[motion.kind])]
    .map(fiber => [fiber.edge.id, fiber])).values()].slice(0, 72);
  const palette: Record<NeuralFlowKind, { signal: Color; head: Color }> = {
    inquiry: { signal: [49, 190, 205], head: [207, 250, 254] },
    encoding: { signal: [82, 197, 151], head: [220, 252, 231] },
    rewiring: { signal: [157, 123, 233], head: [237, 233, 254] },
    convergence: { signal: [224, 176, 92], head: [255, 247, 215] },
    commit: { signal: [116, 205, 244], head: [240, 249, 255] },
  };
  const { signal, head } = palette[motion.kind];
  const [sR, sG, sB] = signal, [hR, hG, hB] = head;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (reducedMotion) {
    ctx.strokeStyle = `rgba(${sR},${sG},${sB},${0.16 * motion.alpha * motion.intensity})`;
    ctx.lineWidth = 1 / cameraScale;
    for (const fiber of fibers.slice(0, 28)) { ctx.beginPath(); strandPath(ctx, fiber, scene, 0); ctx.stroke(); }
  } else {
    for (const fiber of fibers) {
      const cp = controlPoint(fiber, scene.clusterCenters);
      const phaseOffset = hash01(fiber.edge.id, motion.kind);
      const cycle = (motion.phase * (motion.kind === "rewiring" ? 1.35 : 1) + phaseOffset) % 1;
      const aDistance = Math.hypot(fiber.a.x - scene.center.x, fiber.a.y - scene.center.y);
      const bDistance = Math.hypot(fiber.b.x - scene.center.x, fiber.b.y - scene.center.y);
      const towardCenter = motion.kind === "encoding" || motion.kind === "convergence";
      const outward = motion.kind === "inquiry" || motion.kind === "commit";
      const aToB = towardCenter ? bDistance <= aDistance : outward ? bDistance >= aDistance : true;
      const flows = motion.kind === "rewiring" ? [cycle, 1 - cycle] : [aToB ? cycle : 1 - cycle];
      for (let flowIndex = 0; flowIndex < flows.length; flowIndex++) {
        const q = Math.max(0.015, Math.min(0.985, flows[flowIndex]));
        const point = qPoint(fiber.a.x, fiber.a.y, cp.x, cp.y, fiber.b.x, fiber.b.y, q);
        const tailQ = Math.max(0, Math.min(1, q + (aToB ? -1 : 1) * 0.09 * (flowIndex ? -1 : 1)));
        const tail = qPoint(fiber.a.x, fiber.a.y, cp.x, cp.y, fiber.b.x, fiber.b.y, tailQ);
        const pulse = 0.55 + 0.45 * Math.sin((cycle + flowIndex * 0.5) * Math.PI);
        const alpha = motion.alpha * motion.intensity * pulse;
        ctx.strokeStyle = `rgba(${sR},${sG},${sB},${0.2 * alpha})`;
        ctx.lineWidth = (0.8 + motion.intensity * 0.5) / cameraScale;
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(point.x, point.y); ctx.stroke();
        const haloRadius = (motion.kind === "convergence" ? 5.8 : 4.6) / cameraScale;
        const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, haloRadius);
        glow.addColorStop(0, `rgba(${hR},${hG},${hB},${0.86 * alpha})`);
        glow.addColorStop(0.32, `rgba(${sR},${sG},${sB},${0.38 * alpha})`);
        glow.addColorStop(1, `rgba(${sR},${sG},${sB},0)`);
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(point.x, point.y, haloRadius, 0, Math.PI * 2); ctx.fill();
      }
      if (motion.kind === "rewiring" && Math.abs(cycle - 0.5) < 0.035) {
        const junction = qPoint(fiber.a.x, fiber.a.y, cp.x, cp.y, fiber.b.x, fiber.b.y, 0.5);
        ctx.strokeStyle = `rgba(${hR},${hG},${hB},${0.55 * motion.alpha})`;
        ctx.lineWidth = 0.75 / cameraScale;
        for (let ray = 0; ray < 4; ray++) {
          const angle = ray * Math.PI / 2 + phaseOffset;
          ctx.beginPath(); ctx.moveTo(junction.x, junction.y);
          ctx.lineTo(junction.x + Math.cos(angle) * 5 / cameraScale, junction.y + Math.sin(angle) * 5 / cameraScale); ctx.stroke();
        }
      }
    }
  }
  const focusNodes = motion.nodeIds.length
    ? scene.nodes.filter(node => anchored.has(node.id)).slice(0, 16)
    : [{ id: "__center", x: scene.center.x, y: scene.center.y } as GraphNode];
  for (const node of focusNodes) {
    const radius = (motion.kind === "commit" ? 18 + motion.phase * 32 : 18 + Math.sin(motion.phase * Math.PI) * 10) / cameraScale;
    ctx.strokeStyle = `rgba(${hR},${hG},${hB},${(reducedMotion ? 0.18 : 0.28) * motion.alpha})`;
    ctx.lineWidth = 0.8 / cameraScale;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, motion.kind === "inquiry" ? motion.phase * Math.PI * 2 : 0, motion.kind === "inquiry" ? motion.phase * Math.PI * 2 + Math.PI * 1.45 : Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSearchMotion(
  ctx: CanvasRenderingContext2D, scene: Scene, engine: ActivationEngine, now: number,
  reducedMotion: boolean, cameraScale: number,
): void {
  const search = engine.searchMotion(now);
  if (!search) return;
  const [r, g, b] = THEME.colors.read;
  if (reducedMotion) {
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.11 * search.alpha})`;
    ctx.lineWidth = 0.8 / cameraScale;
    ctx.beginPath();
    ctx.arc(scene.center.x, scene.center.y, scene.scanRadius * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  for (let index = 0; index < 2; index++) {
    const progress = (search.progress + index * 0.46) % 1;
    const edgeEase = Math.sin(Math.PI * progress);
    const alpha = (search.missed ? 0.12 : 0.2) * edgeEase * search.alpha;
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = (0.75 + 0.25 * edgeEase) / cameraScale;
    ctx.beginPath();
    ctx.arc(scene.center.x, scene.center.y, scene.scanRadius * (0.12 + 0.88 * progress), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawNodeGesture(
  ctx: CanvasRenderingContext2D, x: number, y: number, radius: number,
  kind: import("../activation/engine").NodeMotionKind, age: number, act: number,
  depth: number, cameraScale: number, reducedMotion: boolean, color: Color,
): void {
  // 减少动态效果时显示动作的静态结果，不删去它的辨识符号。
  if (reducedMotion) age = THEME.timing.gestureDuration;
  const [r, g, b] = color;
  if (kind === "read") {
    const breath = (readPulseScale(age) - 0.68) / 0.32;
    const cycle = (age % 1.72) / 1.72;
    const alpha = Math.min(0.48, act * 0.4) * (0.58 + breath * 0.42);
    // 精读是对已确认节点的局部扫描：环和粒子只围绕该节点，不暗示一条图上关系。
    for (const offset of [0, 0.46]) {
      const wave = (cycle + offset) % 1;
      const ringRadius = radius * (1.32 + breath * 0.34 + wave * 2.5);
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * (1 - wave) * 0.86})`;
      ctx.lineWidth = (0.74 + (1 - wave) * 0.28) / cameraScale;
      ctx.setLineDash([2.6 / cameraScale, 2.2 / cameraScale]);
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, -Math.PI * 0.18 + wave, Math.PI * 1.36 + wave);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 三枚向核心收束的微粒使“深入读取”具有比普通点亮更明确的视觉语义。
    for (let index = 0; index < 3; index++) {
      const phase = (cycle + index / 3) % 1;
      const angle = age * 1.45 + index * Math.PI * 2 / 3;
      const distance = radius * (2.8 - phase * 1.55);
      const px = x + Math.cos(angle) * distance;
      const py = y + Math.sin(angle) * distance;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha * (0.36 + phase * 0.54)})`;
      ctx.beginPath();
      ctx.arc(px, py, (0.78 + phase * 0.34) / cameraScale, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === "source") {
    const cycle = Math.min(0.6, age / THEME.timing.gestureDuration * 0.6);
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.58, act * 0.46);
    const ringRadius = radius * (2.7 - cycle * 1.3);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.88 / cameraScale;
    ctx.setLineDash([3 / cameraScale, 2.2 / cameraScale]);
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, -Math.PI * 0.15 + cycle, Math.PI * 1.5 + cycle);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let index = 0; index < 3; index++) {
      const angle = index * Math.PI * 2 / 3 - cycle * 0.9;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.8})`;
      ctx.beginPath();
      ctx.arc(x + Math.cos(angle) * ringRadius, y + Math.sin(angle) * ringRadius, 0.82 / cameraScale, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  // 手势展开后停留，退出由 nodeMotionOf 的统一包络控制。
  const cycle = Math.min(0.6, age / THEME.timing.gestureDuration * 0.6);
  if (kind === "tension") {
    // 两段对向弧线在节点处相撞：表达“支持脊柱首次遇到反对”，不是普通冲突泛光。
    const ringRadius = radius * (2.4 - cycle * 0.72);
    const alpha = Math.sin(Math.PI * cycle) * Math.min(0.68, act * 0.54);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 1.15 / cameraScale;
    for (const direction of [-1, 1]) {
      const center = direction < 0 ? Math.PI : 0;
      const closing = 0.42 + cycle * 0.38;
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, center - closing, center + closing);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.9})`;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.7, (1.8 - cycle) / cameraScale), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (kind === "inversion") {
    // 两个反向旋转的开环表示假设翻面；它只围绕真实候选节点，不添加虚拟边。
    const ringRadius = radius * (1.48 + cycle * 0.82);
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.62, act * 0.48);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.9 / cameraScale;
    ctx.setLineDash([3.1 / cameraScale, 2.1 / cameraScale]);
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, -Math.PI * 0.78 + cycle * 1.8, Math.PI * 0.22 + cycle * 1.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = `rgba(34,211,238,${alpha})`;
    ctx.arc(x, y, ringRadius + 2.4 / cameraScale, Math.PI * 0.28 - cycle * 1.8, Math.PI * 1.28 - cycle * 1.8);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (kind === "conflict") {
    const ringRadius = radius * (2.35 - cycle * 0.7);
    const alpha = Math.sin(Math.PI * cycle) * Math.min(0.68, act * 0.54);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 1.1 / cameraScale;
    for (const center of [0, Math.PI]) {
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, center - 0.38 - cycle * 0.32, center + 0.38 + cycle * 0.32);
      ctx.stroke();
    }
    return;
  }
  if (kind === "argument") {
    const ringRadius = radius * (1.45 + cycle * 1.25);
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.58, act * 0.48);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.85 / cameraScale;
    for (const turn of [0, Math.PI]) {
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, turn - Math.PI * 0.28, turn + Math.PI * 0.28);
      ctx.stroke();
    }
    return;
  }
  if (kind === "compare") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.56, act * 0.46);
    for (const [offset, direction] of [[0, 1], [2.8 / cameraScale, -1]] as const) {
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * (direction > 0 ? 1 : 0.68)})`;
      ctx.lineWidth = 0.78 / cameraScale;
      ctx.beginPath();
      ctx.arc(x, y, radius * (1.35 + cycle * 1.4) + offset, cycle * direction, Math.PI + cycle * direction);
      ctx.stroke();
    }
    return;
  }
  if (kind === "analogy") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.52, act * 0.44);
    for (let index = 0; index < 3; index++) {
      const echo = Math.max(0, Math.min(1, cycle - index * 0.14));
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * (1 - index * 0.24)})`;
      ctx.lineWidth = 0.72 / cameraScale;
      ctx.beginPath();
      ctx.arc(x, y, radius * (1.3 + echo * 1.9), 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }
  if (kind === "audit") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.5, act * 0.42);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.82 / cameraScale;
    ctx.setLineDash([2.6 / cameraScale, 2.2 / cameraScale]);
    ctx.beginPath();
    ctx.arc(x, y, radius * (1.45 + cycle), -Math.PI * 0.25, Math.PI * 1.35);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (kind.startsWith("evidence-")) {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.62, act * 0.5);
    const ringRadius = radius * (1.42 + cycle * 0.9);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.9 / cameraScale;
    if (kind === "evidence-support") {
      for (let index = 0; index < 3; index++) {
        const angle = index * Math.PI * 2 / 3 + cycle * 0.35;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * ringRadius, y + Math.sin(angle) * ringRadius);
        ctx.lineTo(x + Math.cos(angle) * radius * 1.22, y + Math.sin(angle) * radius * 1.22);
        ctx.stroke();
      }
    } else if (kind === "evidence-counter") {
      for (const center of [0, Math.PI]) {
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, center - 0.48, center + 0.48);
        ctx.stroke();
      }
    } else if (kind === "evidence-boundary") {
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, Math.PI * 0.12, Math.PI * 1.42);
      ctx.stroke();
    } else {
      ctx.setLineDash([2.2 / cameraScale, 2.2 / cameraScale]);
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    return;
  }
  if (kind === "verify-valid" || kind === "verify-invalid") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.68, act * 0.54);
    const ringRadius = radius * (1.72 - cycle * 0.28);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.95 / cameraScale;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, Math.PI * (kind === "verify-valid" ? 2 : 1.55));
    ctx.stroke();
    const mark = radius * 1.1;
    ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, act)})`;
    ctx.lineWidth = 1.5 / cameraScale;
    ctx.beginPath();
    if (kind === "verify-valid") {
      ctx.moveTo(x - mark * 0.65, y);
      ctx.lineTo(x - mark * 0.12, y + mark * 0.48);
      ctx.lineTo(x + mark * 0.72, y - mark * 0.56);
    } else {
      ctx.moveTo(x - mark * 0.55, y - mark * 0.55);
      ctx.lineTo(x + mark * 0.55, y + mark * 0.55);
      ctx.moveTo(x + mark * 0.55, y - mark * 0.55);
      ctx.lineTo(x - mark * 0.55, y + mark * 0.55);
    }
    ctx.stroke();
    return;
  }
  if (kind === "sufficient" || kind === "insufficient") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.62, act * 0.5);
    const ringRadius = radius * (kind === "sufficient" ? 2.25 - cycle * 0.72 : 1.45 + cycle * 0.65);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 1 / cameraScale;
    if (kind === "insufficient") ctx.setLineDash([3 / cameraScale, 2.4 / cameraScale]);
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, kind === "sufficient" ? 0 : Math.PI * 0.18, kind === "sufficient" ? Math.PI * 2 : Math.PI * 1.55);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (kind === "candidate" || kind === "simulation") {
    const alpha = Math.max(0, 1 - cycle) * Math.min(0.5, act * 0.42);
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = 0.78 / cameraScale;
    ctx.setLineDash(kind === "simulation" ? [3 / cameraScale, 2.5 / cameraScale] : []);
    ctx.beginPath();
    ctx.arc(x, y, radius * (1.35 + cycle * 1.6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  let ringRadius = radius * (1.25 + cycle * 2.2);
  let alpha = Math.max(0, 1 - cycle) * Math.min(0.5, act * 0.42);
  if (kind === "enriched") {
    ringRadius = radius * (3.6 - cycle * 2.15);
    alpha = Math.sin(Math.PI * cycle) * Math.min(0.52, act * 0.4);
  }
  if (kind === "path") {
    alpha *= 0.62;
    const rings = Math.min(3, Math.max(1, Math.trunc(depth || 1)));
    for (let index = 0; index < rings; index++) {
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * (1 - index * 0.18)})`;
      ctx.lineWidth = 0.68 / cameraScale;
      ctx.beginPath();
      ctx.arc(x, y, ringRadius + (index * 2.2) / cameraScale, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }
  if (kind === "lens") {
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.8})`;
    ctx.lineWidth = 0.75 / cameraScale;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, -Math.PI * 0.2, Math.PI * 0.65);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, Math.PI * 0.8, Math.PI * 1.65);
    ctx.stroke();
    return;
  }
  ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
  ctx.lineWidth = (kind === "created" ? 1.05 : 0.8) / cameraScale;
  ctx.beginPath();
  ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
  if (kind === "created") {
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.55})`;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius * 1.45, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** 精读节点在 5.5 秒内完成两次缓慢呼吸；减弱动态时渲染器不调用此缩放。 */
export function readPulseScale(age: number): number {
  const progress = Math.min(1, Math.max(0, age / THEME.timing.readPulseDuration));
  const wave = 0.5 - 0.5 * Math.cos(progress * THEME.timing.readPulseCycles * Math.PI * 2);
  return 0.68 + wave * 0.32;
}

/** 沿边检索光的尾迹为金色，只有前锋向暖白金抬亮。 */
export function activeSignalColor(hot: number, signal: import("../activation/engine").EdgeSignalKind = "normal"): Color {
  const [sR, sG, sB] = signal === "tension" ? THEME.colors.tensionSignal
    : signal === "inversion" ? THEME.colors.inversionSignal : THEME.colors.signal;
  const [hR, hG, hB] = signal === "tension" ? THEME.colors.tensionHead
    : signal === "inversion" ? THEME.colors.inversionHead : THEME.colors.signalHead;
  const glow = Math.min(1, Math.max(0, hot) * 2.2);
  return [
    Math.round(sR + (hR - sR) * glow),
    Math.round(sG + (hG - sG) * glow),
    Math.round(sB + (hB - sB) * glow),
  ];
}

/** 标注层：主动悬停优先；自动标题仅用于精读，最多一个。 */
export function drawLabelLayer(
  ctx: CanvasRenderingContext2D, scene: Scene, engine: ActivationEngine,
  camera: Camera, hoverId: string | null, now?: number, viewport?: { width: number; height: number },
  palette: GraphPalette = DARK_GRAPH_PALETTE,
): void {
  if (hoverId) {
    const nd = scene.nodes.find((n) => n.id === hoverId);
    if (nd) drawActiveNodeLabel(ctx, nd, graphNodeColor(nd.type, nodeVisual(nd.type).color, palette), camera, palette);
    return;
  }
  if (now === undefined || !viewport) return;
  const focus = engine.readingFocus(now);
  const nd = focus && scene.nodes.find((node) => node.id === focus.id);
  if (!focus || !nd) return;
  const [sx, sy] = camera.toScreen(nd.x, nd.y, viewport.width, viewport.height);
  if (sx < 0 || sy < 0 || sx > viewport.width || sy > viewport.height) return;
  const scale = camera.scale;
  ctx.save();
  ctx.globalAlpha = focus.alpha;
  ctx.font = `500 ${11 / scale}px "Microsoft YaHei", sans-serif`;
  const maxWidth = Math.min(176, viewport.width - 32) / scale;
  const lines = compactTitleLines(ctx, nd.title, maxWidth - 20 / scale);
  const width = Math.min(maxWidth, Math.max(60 / scale, ...lines.map((line) => ctx.measureText(line).width + 20 / scale)));
  const height = (14 + lines.length * 17) / scale;
  let px = Math.max(8, Math.min(viewport.width - width * scale - 8, sx + 18));
  let py = sy - height * scale / 2;
  if (sx + 18 + width * scale > viewport.width - 8) px = Math.max(8, sx - width * scale - 18);
  py = Math.max(8, Math.min(viewport.height - height * scale - 8, py));
  const [x, y] = camera.toWorld(px, py, viewport.width, viewport.height);
  // 柔和渐隐底色，没有描边、实心长条或标题位移动画。
  const wash = ctx.createLinearGradient(x, y, x + width, y);
  wash.addColorStop(0, `rgba(${palette.labelRgb},.9)`);
  wash.addColorStop(1, `rgba(${palette.labelRgb},.5)`);
  ctx.fillStyle = wash;
  ctx.beginPath(); ctx.roundRect(x, y, width, height, 7 / scale); ctx.fill();
  ctx.fillStyle = "rgba(88,191,229,.8)";
  ctx.fillRect(x, y + 9 / scale, 2 / scale, height - 18 / scale);
  ctx.fillStyle = palette.labelInk;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  lines.forEach((line, index) => ctx.fillText(line, x + 10 / scale, y + (7 + index * 17) / scale));
  ctx.restore();
}

export function compactTitleLines(ctx: CanvasRenderingContext2D, title: string, width: number): string[] {
  const chars = Array.from(title.trim());
  let first = "";
  while (chars.length && ctx.measureText(first + chars[0]).width <= width) first += chars.shift();
  if (!first && chars.length) first = chars.shift()!;
  if (!chars.length) return [first];
  return [first, fitLabel(ctx, chars.join(""), width)];
}

function drawActiveNodeLabel(
  ctx: CanvasRenderingContext2D, node: GraphNode, color: [number, number, number], camera: Camera,
  palette: GraphPalette,
): void {
  const fontSize = 11 / camera.scale;
  const padX = 7 / camera.scale;
  const height = 24 / camera.scale;
  const offset = 10 / camera.scale;
  ctx.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
  const maxWidth = 220 / camera.scale;
  const title = fitLabel(ctx, node.title, maxWidth - padX * 2);
  const width = Math.min(maxWidth, ctx.measureText(title).width + padX * 2);
  const x = node.x + offset;
  const y = node.y - height / 2;
  const radius = 6 / camera.scale;
  ctx.fillStyle = palette.labelBackground;
  ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},0.48)`;
  ctx.lineWidth = 0.7 / camera.scale;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = palette.labelInk;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + padX, y + height / 2);
}

function fitLabel(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let result = value;
  while (result.length > 4 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}
