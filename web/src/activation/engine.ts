import type { GraphEdge, SimEvent } from "../graph/types";
import type { Color } from "../graph/types-extra";
import { LENS_ORDINALS, THEME } from "./theme";

export type NodeMotionKind =
  | "seed" | "path" | "read" | "source" | "catalog" | "lens" | "argument" | "compare" | "analogy" | "audit"
  | "conflict" | "tension" | "inversion"
  | "evidence-support" | "evidence-counter" | "evidence-boundary" | "evidence-other"
  | "verify-valid" | "verify-invalid" | "sufficient" | "insufficient"
  | "candidate" | "simulation" | "created" | "enriched";
export type EdgeSignalKind = "normal" | "tension" | "inversion";
export type NeuralFlowKind = "inquiry" | "encoding" | "rewiring" | "convergence" | "commit";

export interface NeuralFlowMotion {
  kind: NeuralFlowKind;
  phase: number;
  alpha: number;
  intensity: number;
  nodeIds: string[];
}

export interface Heat {
  front: number;
  fade: number;
  direction: 1 | -1;
  depth: number;
  readiness: "ready" | "legacy";
  signal: EdgeSignalKind;
}

export interface NodeMotion {
  act: number;
  color: Color;
  kind: NodeMotionKind;
  age: number;
  depth: number;
}

export interface SearchMotion {
  progress: number;
  alpha: number;
  missed: boolean;
}

interface EdgeState {
  igniteAt: number;
  direction: 1 | -1;
  releaseAt: number | null;
  depth: number;
  readiness: "ready" | "legacy";
  signal: EdgeSignalKind;
}

interface NodeState {
  act: number;
  color: Color;
  visibleAt: number;
  kind: NodeMotionKind;
  depth: number;
}

export interface GraphOverlay {
  kind: "compare" | "analogy" | "sufficient" | "insufficient" | "simulation" | "pending" | "applied";
  nodeIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  targetId?: string;
  decision?: string;
  startedAt: number;
  endsAt: number;
}

export const gestureLifetime = () => THEME.timing.gestureDuration + THEME.timing.gestureHold + THEME.timing.gestureExit;
const motionLifetime = (kind: NodeMotionKind) => kind === "read" ? THEME.timing.readPulseDuration : gestureLifetime();
const batchOffset = (index: number, stagger: number) => Math.min(index * stagger, THEME.timing.maxStaggerSpan);

interface SearchState {
  startedAt: number;
  releaseAt: number | null;
  missed: boolean;
}

interface NeuralFlowState {
  kind: NeuralFlowKind;
  startedAt: number;
  updatedAt: number;
  releaseAt: number | null;
  activeUntil: number;
  intensity: number;
  nodeIds: string[];
}

interface QueuedEvent {
  event: SimEvent;
  scheduledAt: number;
  eventId: string | null;
}

export interface GraphNarration {
  phase: "idle" | "retrieving" | "miss" | "seed" | "expanding" | "insight" | "reading" | "judging" | "writing" | "complete" | "failed";
  title: string;
  detail: string;
}

/**
 * 将 Agent 的认知事件翻译为可渲染状态。
 *
 * 引擎只消费真实事件：检索阶段不假造命中节点，关系阶段只激活事件中列出的
 * edge id。拓扑可以在写入后热更新，因此刷新图数据不会中断正在播放的状态。
 */
export class ActivationEngine {
  skillLabel: string | null = null;
  lensLabel: string | null = null;
  private topology = new Map<string, Pick<GraphEdge, "from" | "to">>();
  private edges = new Map<string, EdgeState>();
  private nodeAct = new Map<string, NodeState[]>();
  private overlays: GraphOverlay[] = [];
  private visualUntil = 0;
  private replaying = false;
  private search: SearchState | null = null;
  private neuralFlowState: NeuralFlowState | null = null;
  private seenEvents = new Set<string>();
  private seenOrder: string[] = [];
  private eventQueue: QueuedEvent[] = [];
  private queuedEventIds = new Set<string>();
  private queueTailAt = 0;
  private narration: GraphNarration = {
    phase: "idle", title: "知识图谱", detail: "等待新的问题",
  };

  constructor(edges: GraphEdge[] | Map<string, string>) {
    this.updateTopology(edges);
  }

  updateTopology(edges: GraphEdge[] | Map<string, string>): void {
    if (edges instanceof Map) {
      // 兼容旧测试与调用；缺少端点时按关系定义方向播放。
      this.topology = new Map([...edges.keys()].map((id) => [id, { from: "", to: "" }]));
      return;
    }
    this.topology = new Map(edges.map((edge) => [edge.id, { from: edge.from, to: edge.to }]));
  }

  /**
   * 将已经发生的认知事件按实际展示窗口交给画布。队列不创建任何新目标：它只避免
   * 同一帧吞掉多次真实工具观察，使用户能读出 Agent 的实际行动次序。
   */
  enqueueEvent(event: SimEvent, now: number): boolean {
    const eventId = String(event.payload.event_id ?? "").trim() || null;
    if (eventId && (this.seenEvents.has(eventId) || this.queuedEventIds.has(eventId))) return false;

    // 错误状态必须立即可见，且不能让旧队列继续伪装为仍在运行。
    if (event.type === "session.failed") {
      this.clearQueue();
      return this.handleEvent(event, now);
    }
    // 工作阶段更新是连续状态，不应被旧的逐步认知回放排队数秒。
    if (event.type === "neural.flow" || event.type === "neural.stop" || event.type === "topology.changed") {
      return this.handleEvent(event, now);
    }
    // 一个明确的新技能开始意味着上一轮残留的可视化不应串入下一轮。
    if (event.type === "skill.trigger") {
      this.clearQueue();
      return this.handleEvent(event, now);
    }

    const scheduledAt = Math.max(now, this.queueTailAt);
    this.eventQueue.push({ event, scheduledAt, eventId });
    if (eventId) this.queuedEventIds.add(eventId);
    return true;
  }

  enqueueEvents(events: SimEvent[], now: number): boolean {
    return events.reduce((changed, event) => this.enqueueEvent(event, now) || changed, false);
  }

  pendingEventCount(): number {
    return this.eventQueue.length;
  }

  handleEvent(ev: SimEvent, now: number): boolean {
    const p = ev.payload as Record<string, unknown>;
    const eventId = String(p.event_id ?? "");
    if (eventId && this.seenEvents.has(eventId)) return false;
    if (eventId) this.rememberEvent(eventId);

    switch (ev.type) {
      case "neural.flow": {
        const kind = isNeuralFlowKind(p.kind) ? p.kind : "inquiry";
        const previous = this.neuralFlowState;
        const nodeIds = Array.isArray(p.node_ids) ? [...new Set(p.node_ids.map(String).filter(Boolean))].slice(0, 24) : [];
        const duration = Math.max(2.4, Math.min(18, Number(p.duration ?? 7.5)));
        this.neuralFlowState = {
          kind,
          startedAt: previous?.kind === kind ? previous.startedAt : now,
          updatedAt: now,
          releaseAt: null,
          activeUntil: now + duration,
          intensity: Math.max(0.35, Math.min(1, Number(p.intensity ?? 0.78))),
          nodeIds,
        };
        const copy: Record<NeuralFlowKind, [GraphNarration["phase"], string, string]> = {
          inquiry: ["retrieving", "知识网络正在回应", "信号正在图谱中寻找可用的知识锚点"],
          encoding: ["reading", "知识正在编码", "原始材料正被组织为可复用的知识结构"],
          rewiring: ["judging", "知识网络正在重组", "多个知识对象正在比较、校验并建立新的结构"],
          convergence: ["judging", "思考正在汇聚", "分散信号正向当前判断收束"],
          commit: ["writing", "新结构正在形成", "已确认的变化正进入知识图谱"],
        };
        this.setNarration(copy[kind][0], String(p.title ?? copy[kind][1]), String(p.detail ?? copy[kind][2]));
        this.visualUntil = Math.max(this.visualUntil, now + Math.min(duration, 3.2));
        break;
      }
      case "neural.stop":
        if (this.neuralFlowState && this.neuralFlowState.releaseAt === null) this.neuralFlowState.releaseAt = now;
        break;
      case "topology.changed": {
        const nodeIds = Array.isArray(p.node_ids) ? [...new Set(p.node_ids.map(String).filter(Boolean))] : [];
        const edgeIds = Array.isArray(p.edge_ids) ? [...new Set(p.edge_ids.map(String).filter(Boolean))] : [];
        this.neuralFlowState = {
          kind: "commit", startedAt: now, updatedAt: now, releaseAt: null, activeUntil: now + 4.8,
          intensity: 1, nodeIds: nodeIds.slice(0, 24),
        };
        this.bumpNodes(nodeIds, THEME.node.writeAct, THEME.colors.write, now, "created", 0.045);
        this.ignite(edgeIds, nodeIds, now + 0.08, 1);
        this.setNarration("writing", "知识图谱已更新", `${nodeIds.length} 个节点 · ${edgeIds.length} 条关系进入可见结构`);
        break;
      }
      case "skill.trigger":
        this.releaseActive(now);
        this.edges.clear();
        this.nodeAct.clear();
        this.overlays = [];
        this.visualUntil = now;
        this.skillLabel = String(p.skill ?? "");
        this.lensLabel = null;
        this.setNarration("retrieving", this.skillLabel || "智能体", "准备调用知识体");
        break;
      case "thinking.model":
        this.setNarration("judging", String(p.title ?? "已选择审视方式"), String(p.detail ?? "本轮分析约束已生效"));
        break;
      case "retrieve.query": {
        const query = String(p.query ?? "").trim();
        this.search = { startedAt: now, releaseAt: null, missed: false };
        this.setNarration("retrieving", "正在检索知识体", query ? `围绕「${shorten(query)}」寻找直接依据` : "正在寻找直接依据");
        break;
      }
      case "context.ready": {
        const core = Number(p.core_count ?? 0);
        const conflict = Number(p.conflict_count ?? 0);
        const expansion = Number(p.expansion_count ?? 0);
        const material = Number(p.material_count ?? 0);
        this.setNarration(
          "retrieving", "检索上下文已组装",
          `核心 ${core} · 冲突 ${conflict} · 扩展 ${expansion} · 质料 ${material}`,
        );
        break;
      }
      case "graph.miss":
        if (!this.search) this.search = { startedAt: now, releaseAt: now + 0.35, missed: true };
        else this.search = { ...this.search, releaseAt: now + 0.35, missed: true };
        this.setNarration("miss", "未找到直接命中", "Agent 将调整检索角度或依据通用知识继续");
        break;
      case "graph.hit":
        this.releaseSearch(now);
        this.onGraphHit(p as unknown as {
          node_ids: string[]; edge_ids: string[]; source_ids?: string[]; role: string; depth?: number;
        }, now);
        break;
      case "graph.walk":
        this.releaseSearch(now);
        this.onGraphWalk(p as unknown as {
          start_ids?: string[]; requested_depth?: number; reached_depth?: number; plane?: "argument" | "context";
          layers: Array<{
            depth: number; node_ids: string[]; edge_ids: string[];
            ready_edge_ids?: string[]; legacy_edge_ids?: string[];
            source_ids: string[]; truncated?: boolean;
          }>;
        }, now);
        break;
      case "insight.tension-trace": {
        this.releaseSearch(now);
        const tp = p as unknown as {
          start_ids?: string[]; requested_depth?: number; reached_depth?: number;
          layers: Array<{
            depth: number; node_ids: string[]; edge_ids: string[];
            ready_edge_ids?: string[]; legacy_edge_ids?: string[];
            source_ids: string[]; truncated?: boolean;
          }>;
          tension_node_ids?: string[]; tension_edge_ids?: string[]; anchor_ids?: string[];
          found?: boolean; stop_reason?: string;
        };
        const tensionAt = this.onGraphWalk({ ...tp, plane: "argument" }, now, 6);
        this.ignite(tp.tension_edge_ids ?? [], tp.anchor_ids ?? [], tensionAt, Number(tp.reached_depth ?? 0) + 1, [], "tension");
        this.bumpNodes(
          tp.tension_node_ids ?? [], THEME.node.writeAct, THEME.colors.tension,
          tensionAt + THEME.timing.frontDuration, "tension", THEME.timing.nodeStagger,
          Number(tp.reached_depth ?? 0) + 1,
        );
        const supportEdges = (tp.layers ?? []).reduce((sum, layer) => sum + (layer.edge_ids?.length ?? 0), 0);
        this.setNarration(
          "insight", tp.found ? "沿支持链发现首个张力" : "支持链探索已收束",
          `${Number(tp.reached_depth ?? 0)} 层支持回溯 · ${supportEdges} 条支持关系 · ${humanizeInsightStop(tp.stop_reason)}`,
        );
        break;
      }
      case "insight.assumption-flip": {
        this.releaseSearch(now);
        const ip = p as unknown as {
          source_ids?: string[]; candidate_ids?: string[]; edge_ids?: string[]; stop_reason?: string;
        };
        this.bumpNodes(ip.source_ids ?? [], THEME.node.seedAct, THEME.colors.inversion, now, "inversion", 0.05);
        this.ignite(ip.edge_ids ?? [], ip.source_ids ?? [], now + THEME.timing.pathNodeDelay, 1, [], "inversion");
        this.bumpNodes(
          ip.candidate_ids ?? [], THEME.node.readAct, THEME.colors.inversion,
          now + THEME.timing.pathNodeDelay, "inversion", THEME.timing.nodeStagger, 1,
        );
        this.setNarration(
          "insight", "正在反转关键假设",
          `${ip.candidate_ids?.length ?? 0} 个待核验候选 · ${humanizeInsightStop(ip.stop_reason)}`,
        );
        break;
      }
      case "lens.begin": {
        this.releaseSearch(now);
        const lp = p as unknown as {
          index: number; name: string; node_ids: string[]; edge_ids: string[]; source_ids?: string[];
          lens_kind?: "argument" | "compare" | "analogy" | "audit";
        };
        const ordinal = LENS_ORDINALS[lp.index - 1] ?? String(lp.index);
        const lensKind = lp.lens_kind ?? "lens";
        const labels = {
          argument: "论证结构", compare: "并置比较", analogy: "跨域类比", audit: "结构诊断", lens: `透镜${ordinal}`,
        } as const;
        const colors = {
          argument: THEME.colors.lens, compare: THEME.colors.seed, analogy: THEME.colors.analogy,
          audit: THEME.colors.boundary, lens: THEME.colors.lens,
        } as const;
        this.lensLabel = `${labels[lensKind]} · ${lp.name}`;
        if (lensKind === "analogy") {
          const sourceSet = new Set(lp.source_ids ?? []);
          this.bumpNodes(lp.source_ids ?? [], THEME.node.seedAct, colors.analogy, now, "analogy");
          this.bumpNodes(lp.node_ids.filter((id) => !sourceSet.has(id)), THEME.node.readAct, colors.analogy, now + THEME.timing.frontDuration, "analogy");
        } else {
          this.bumpNodes(lp.node_ids, THEME.node.readAct, colors[lensKind], now, lensKind, lensKind === "compare" ? 0 : THEME.timing.nodeStagger);
          this.ignite(lp.edge_ids, lp.source_ids ?? [], now, 1);
        }
        if (lensKind === "compare" || lensKind === "analogy") this.addOverlay({ kind: lensKind, nodeIds: lp.node_ids, sourceIds: lp.source_ids }, now);
        this.setNarration("judging", this.lensLabel, `检视 ${lp.node_ids.length} 张卡片与 ${lp.edge_ids.length} 条真实关系`);
        break;
      }
      case "conflict.inspect": {
        const cp = p as unknown as { node_ids?: string[]; edge_ids?: string[]; source_ids?: string[] };
        this.ignite(cp.edge_ids ?? [], cp.source_ids ?? [], now, 1, [], "tension");
        this.bumpNodes(cp.node_ids ?? [], THEME.node.writeAct, THEME.colors.conflict, now + THEME.timing.pathNodeDelay, "conflict");
        this.setNarration("judging", "正在检查冲突结构", `${cp.node_ids?.length ?? 0} 张卡片 · ${cp.edge_ids?.length ?? 0} 条真实冲突关系`);
        break;
      }
      case "evidence.inspect": {
        const ep = p as unknown as { roles?: Record<string, string[]>; claim_count?: number };
        const roles = ep.roles ?? {};
        const groups: Array<[string[], Color, NodeMotionKind]> = [
          [roles.support ?? [], THEME.colors.support, "evidence-support"],
          [roles.counter ?? [], THEME.colors.counter, "evidence-counter"],
          [roles.boundary ?? [], THEME.colors.boundary, "evidence-boundary"],
          [[...(roles.background ?? []), ...(roles.inference ?? [])], THEME.colors.read, "evidence-other"],
        ];
        let offset = 0;
        for (const [nodeIds, color, kind] of groups) {
          this.bumpNodes(nodeIds, THEME.node.readAct, color, now + offset * THEME.timing.nodeStagger, kind);
          offset += nodeIds.length;
        }
        const total = groups.reduce((sum, [nodeIds]) => sum + nodeIds.length, 0);
        this.setNarration("judging", "正在审视证据结构", `${ep.claim_count ?? 0} 个结论 · ${total} 个可定位证据节点`);
        break;
      }
      case "evidence.verify": {
        const vp = p as unknown as { valid_ids?: string[]; invalid_ids?: string[]; all_valid?: boolean };
        this.bumpNodes(vp.valid_ids ?? [], THEME.node.readAct, THEME.colors.verified, now, "verify-valid");
        this.bumpNodes(vp.invalid_ids ?? [], THEME.node.writeAct, THEME.colors.invalid, now, "verify-invalid");
        this.setNarration(
          "judging", vp.all_valid ? "证据锚点核验通过" : "证据锚点存在缺口",
          `${vp.valid_ids?.length ?? 0} 个有效 · ${vp.invalid_ids?.length ?? 0} 个待修正`,
        );
        break;
      }
      case "cognition.sufficiency": {
        const sp = p as unknown as { node_ids?: string[]; ready?: boolean; missing?: string[] };
        const ready = sp.ready === true;
        this.bumpNodes(
          sp.node_ids ?? [], ready ? THEME.node.seedAct : THEME.node.readAct,
          ready ? THEME.colors.sufficient : THEME.colors.insufficient,
          now, ready ? "sufficient" : "insufficient",
        );
        this.addOverlay({ kind: ready ? "sufficient" : "insufficient", nodeIds: sp.node_ids ?? [] }, now);
        this.setNarration(
          "judging", ready ? "证据已经足够，正在收束" : "证据尚未闭合",
          ready ? `已用 ${sp.node_ids?.length ?? 0} 个核验锚点完成闭合` : `仍缺少 ${sp.missing?.length ?? 0} 项条件`,
        );
        break;
      }
      case "structure.candidates": {
        const cp = p as unknown as { node_ids?: string[]; source_ids?: string[] };
        const sources = new Set(cp.source_ids ?? []);
        this.bumpNodes(cp.source_ids ?? [], THEME.node.seedAct, THEME.colors.seed, now, "candidate");
        this.bumpNodes((cp.node_ids ?? []).filter((id) => !sources.has(id)), THEME.node.readAct, THEME.colors.analogy, now + THEME.timing.pathNodeDelay, "candidate");
        this.setNarration("judging", "正在比较结构接入候选", `${cp.node_ids?.length ?? 0} 个真实候选；尚未建立关系`);
        break;
      }
      case "relation.inspect":
      case "relation.simulate":
      case "proposal.pending": {
        const rp = p as unknown as { node_ids?: string[]; edge_ids?: string[]; source_id?: string; target_id?: string; decision?: string; relation_type?: string; passed?: boolean };
        const endpoints = [...new Set([rp.source_id, rp.target_id, ...(rp.node_ids ?? [])].filter((id): id is string => Boolean(id)))];
        this.bumpNodes(endpoints, THEME.node.readAct, THEME.colors.simulation, now, "simulation");
        if (ev.type !== "relation.inspect") this.addOverlay({
          kind: ev.type === "proposal.pending" ? "pending" : "simulation", nodeIds: endpoints,
          sourceId: rp.source_id, targetId: rp.target_id, decision: rp.decision,
        }, now);
        if (ev.type === "relation.inspect") this.ignite(rp.edge_ids ?? [], rp.source_id ? [rp.source_id] : [], now, 1);
        const pending = ev.type === "proposal.pending";
        this.setNarration(
          "judging",
          pending ? "关系提案等待确认" : ev.type === "relation.simulate" ? "正在幽灵层预演关系" : "正在核对关系案件",
          `${rp.decision ? `动作 ${rp.decision} · ` : ""}${rp.relation_type ?? "尚未确定关系类型"}${rp.passed ? " · 预检通过" : ""}`,
        );
        break;
      }
      case "relation.applied": {
        const rp = p as unknown as { edge_ids?: string[]; source_id?: string; target_id?: string; decision?: string; relation_type?: string };
        const endpoints = [rp.source_id, rp.target_id].filter((id): id is string => Boolean(id));
        this.releaseActive(now);
        this.bumpNodes(endpoints, THEME.node.writeAct, THEME.colors.write, now, "enriched");
        this.addOverlay({ kind: "applied", nodeIds: endpoints, sourceId: rp.source_id, targetId: rp.target_id, decision: rp.decision }, now);
        if (rp.decision !== "remove") this.ignite(rp.edge_ids ?? [], rp.source_id ? [rp.source_id] : [], now, 1);
        this.setNarration(
          "writing", rp.decision === "remove" ? "知识关系已移除" : "知识关系已写入",
          `${rp.relation_type ?? "关系"} · ${rp.source_id ?? "?"} → ${rp.target_id ?? "?"}`,
        );
        break;
      }
      case "structure.note": {
        const np = p as unknown as { node_ids?: string[] };
        this.bumpNodes(np.node_ids ?? [], THEME.node.catalogAct, THEME.colors.boundary, now, "audit");
        this.setNarration("judging", "已记录结构观察", `${np.node_ids?.length ?? 0} 个相关知识对象`);
        break;
      }
      case "card.read": {
        const cardIds = Array.isArray(p.card_ids)
          ? [...new Set(p.card_ids.map(String).filter(Boolean))]
          : [String(p.card_id ?? "")].filter(Boolean);
        const title = String(p.title ?? "").trim();
        const readIndex = Math.max(0, Number(p.read_index ?? 0));
        cardIds.forEach((cardId, index) => this.bumpNode(
          cardId, THEME.node.readAct, THEME.colors.read,
          now + (readIndex + index) * THEME.timing.readStagger, "read", true,
        ));
        if (cardIds.length) this.setNarration(
          "reading", cardIds.length > 1 ? "正在逐张精读知识卡片" : "正在精读知识卡片",
          title || (cardIds.length > 1 ? `本次读取 ${cardIds.length} 张卡片` : cardIds[0]),
        );
        break;
      }
      case "evidence.trace": {
        const cardId = String(p.card_id ?? "");
        const title = String(p.title ?? "").trim();
        if (cardId) this.bumpNode(cardId, THEME.node.readAct, THEME.colors.read, now, "source", true);
        if (cardId) this.setNarration("reading", "正在追溯来源依据", title || cardId);
        break;
      }
      case "catalog.read": {
        const nodeIds = Array.isArray(p.node_ids) ? p.node_ids.map(String) : [];
        this.bumpNodes(nodeIds, THEME.node.catalogAct, THEME.colors.expand, now, "catalog", 0.045);
        this.setNarration("reading", "正在读取领域目录", `检查 ${nodeIds.length} 张领域成员卡`);
        break;
      }
      case "write.applied": {
        const wp = p as unknown as { created: string[]; enriched: string[] };
        this.releaseActive(now);
        this.bumpNodes(wp.created, THEME.node.writeAct, THEME.colors.write, now, "created");
        this.bumpNodes(wp.enriched, THEME.node.seedAct, THEME.colors.write, now + 0.08, "enriched");
        const parts = [
          wp.created.length ? `新建 ${wp.created.length} 张` : "",
          wp.enriched.length ? `丰富 ${wp.enriched.length} 张` : "",
        ].filter(Boolean);
        this.setNarration("writing", "知识已沉淀", parts.join(" · ") || "写入已完成");
        break;
      }
      case "session.idle":
        this.releaseActive(now);
        this.lensLabel = null;
        this.skillLabel = null;
        this.setNarration("complete", "本轮知识调用完成", "调用路径正在自然收束");
        break;
      case "session.failed":
        this.clearQueue();
        this.edges.clear();
        this.nodeAct.clear();
        this.overlays = [];
        this.visualUntil = now;
        this.neuralFlowState = null;
        this.releaseActive(now);
        this.lensLabel = null;
        this.skillLabel = null;
        this.setNarration("failed", "本轮知识调用中断", humanizeFailure(String(p.reason ?? "")));
        break;
      default:
        return false;
    }
    return true;
  }

  private onGraphHit(
    p: { node_ids: string[]; edge_ids: string[]; source_ids?: string[]; role: string; depth?: number },
    now: number,
  ): void {
    if (p.role === "seed") {
      this.bumpNodes(p.node_ids, THEME.node.seedAct, THEME.colors.seed, now, "seed");
      this.setNarration("seed", "找到相关知识", `命中 ${p.node_ids.length} 张卡片`);
      return;
    }
    const depth = Math.max(1, Number(p.depth ?? 1));
    const phaseNow = now + (depth - 1) * THEME.timing.pathStagger;
    const color = p.role === "conflict" ? THEME.colors.conflict : pathColor(depth);
    this.ignite(p.edge_ids, p.source_ids ?? [], phaseNow, depth);
    this.bumpNodes(p.node_ids, THEME.node.readAct, color, phaseNow + THEME.timing.pathNodeDelay, "path", THEME.timing.nodeStagger, depth);
    const title = p.role === "conflict" ? "发现并检视冲突关系" : "沿真实知识关系展开";
    this.setNarration(
      "expanding", title,
      `第 ${depth} 跳 · 访问 ${p.node_ids.length} 张卡片 · ${p.edge_ids.length} 条关系`,
    );
  }

  private onGraphWalk(
    p: {
      start_ids?: string[]; requested_depth?: number; reached_depth?: number; plane?: "argument" | "context";
      layers: Array<{
        depth: number; node_ids: string[]; edge_ids: string[];
        ready_edge_ids?: string[]; legacy_edge_ids?: string[];
        source_ids: string[]; truncated?: boolean;
      }>;
    },
    now: number,
    maximumDepth = 3,
  ): number {
    const layers = (Array.isArray(p.layers) ? p.layers : [])
      .filter((layer) => layer && Number(layer.depth) >= 1 && Number(layer.depth) <= maximumDepth)
      .sort((a, b) => a.depth - b.depth);
    this.bumpNodes(p.start_ids ?? [], THEME.node.catalogAct, THEME.colors.seed, now, "seed", 0.05);
    let phaseNow = now;
    for (const layer of layers) {
      const depth = Math.min(maximumDepth, Math.max(1, Number(layer.depth)));
      this.ignite(layer.edge_ids ?? [], layer.source_ids ?? [], phaseNow, depth, layer.legacy_edge_ids ?? []);
      const arrivalAt = phaseNow + batchOffset(Math.max(0, (layer.edge_ids?.length ?? 0) - 1), THEME.timing.stagger) + THEME.timing.frontDuration;
      this.bumpNodes(
        layer.node_ids ?? [], THEME.node.readAct, pathColor(depth),
        arrivalAt, "path", THEME.timing.nodeStagger, depth,
      );
      phaseNow = arrivalAt + batchOffset(Math.max(0, (layer.node_ids?.length ?? 0) - 1), THEME.timing.nodeStagger) + THEME.timing.pathStagger;
    }
    const requested = Math.min(maximumDepth, Math.max(1, Number(p.requested_depth ?? layers.at(-1)?.depth ?? 1)));
    const reached = Math.min(maximumDepth, Math.max(0, Number(p.reached_depth ?? layers.at(-1)?.depth ?? 0)));
    const nodes = layers.reduce((sum, layer) => sum + (layer.node_ids?.length ?? 0), 0);
    const edgeCount = layers.reduce((sum, layer) => sum + (layer.edge_ids?.length ?? 0), 0);
    const clipped = layers.some((layer) => layer.truncated);
    this.setNarration(
      "expanding", `沿${p.plane === "context" ? "情境" : "论证"}关系探索 ${requested} 跳`,
      `到达 ${reached} 跳 · 访问 ${nodes} 张卡片 · ${edgeCount} 条关系${layers.some((layer) => layer.legacy_edge_ids?.length) ? " · 含待核验旧边" : ""}${clipped ? " · 已按预算收束" : ""}`,
    );
    return phaseNow;
  }

  private ignite(
    edgeIds: string[], sourceIds: string[], now: number, depth = 1,
    legacyEdgeIds: string[] = [], signal: EdgeSignalKind = "normal",
  ): void {
    const sources = new Set(sourceIds);
    const legacy = new Set(legacyEdgeIds);
    [...new Set(edgeIds)].forEach((edgeId, index) => {
      const edge = this.topology.get(edgeId);
      if (!edge) return;
      const direction: 1 | -1 = edge.to && sources.has(edge.to) && !sources.has(edge.from) ? -1 : 1;
      this.edges.set(edgeId, {
        igniteAt: now + batchOffset(index, THEME.timing.stagger),
        direction,
        releaseAt: null,
        depth,
        readiness: legacy.has(edgeId) ? "legacy" : "ready",
        signal,
      });
      this.visualUntil = Math.max(this.visualUntil, now + batchOffset(index, THEME.timing.stagger) + THEME.timing.holdUntil + THEME.timing.fadeDuration);
    });
  }

  private bumpNodes(
    ids: string[], act: number, color: Color, now: number, kind: NodeMotionKind,
    stagger = THEME.timing.nodeStagger, depth = 0,
  ): void {
    [...new Set(ids)].forEach((id, index) =>
      this.bumpNode(id, act, color, now + batchOffset(index, stagger), kind, true, depth)
    );
  }

  private bumpNode(
    id: string, act: number, color: Color, visibleAt: number,
    kind: NodeMotionKind, restart = false, depth = 0,
  ): void {
    const states = this.nodeAct.get(id) ?? [];
    // 边传播只能补充无语义动作的节点，不能覆盖精读、核验或已安排的动作。
    if (!restart && states.length) return;
    const previous = states.at(-1);
    const startsAt = restart && previous ? Math.max(visibleAt, previous.visibleAt + motionLifetime(previous.kind)) : visibleAt;
    states.push({ act, color, kind, visibleAt: startsAt, depth });
    this.nodeAct.set(id, states);
    this.visualUntil = Math.max(this.visualUntil, startsAt + motionLifetime(kind));
  }

  /** 渲染器回写：传播前锋抵达端点时，才点亮目标节点。 */
  pokeFromRenderer(id: string, act: number, now: number, depth = 1, signal: EdgeSignalKind = "normal"): void {
    const color = signal === "tension" ? THEME.colors.tension
      : signal === "inversion" ? THEME.colors.inversion : pathColor(depth);
    const kind: NodeMotionKind = signal === "tension" ? "tension" : signal === "inversion" ? "inversion" : "path";
    this.bumpNode(id, act, color, now, kind, false, depth);
  }

  heatOf(edgeId: string, now: number): Heat | null {
    const state = this.edges.get(edgeId);
    if (!state) return null;
    const age = now - state.igniteAt;
    if (age < 0) return { front: 0, fade: 0, direction: state.direction, depth: state.depth, readiness: state.readiness, signal: state.signal };
    const timing = THEME.timing;
    const naturalFadeAt = state.igniteAt + timing.holdUntil;
    const releaseFadeAt = state.releaseAt === null
      ? naturalFadeAt
      : Math.max(state.igniteAt + timing.minReadable, state.releaseAt);
    const fadeAt = Math.min(naturalFadeAt, releaseFadeAt);
    const expiresAt = fadeAt + timing.fadeDuration;
    if (now > expiresAt) {
      this.edges.delete(edgeId);
      return null;
    }
    const front = 1.25 * cubicBezierProgress(
      Math.min(1, age / timing.frontDuration), 0.23, 1, 0.32, 1,
    );
    const fade = now < fadeAt ? 1 : 1 - cubicBezierProgress(
      Math.min(1, (now - fadeAt) / timing.fadeDuration), 0.77, 0, 0.175, 1,
    );
    return { front, fade, direction: state.direction, depth: state.depth, readiness: state.readiness, signal: state.signal };
  }

  nodeMotionOf(id: string, now = Number.POSITIVE_INFINITY): NodeMotion | null {
    const states = this.nodeAct.get(id);
    const state = Number.isFinite(now)
      ? states?.find((item) => now >= item.visibleAt && now < item.visibleAt + motionLifetime(item.kind))
      : states?.at(-1);
    if (!state) return null;
    const elapsed = Number.isFinite(now) ? now - state.visibleAt : THEME.timing.nodeEntryDuration;
    if (elapsed <= 0) return null;
    if (state.kind === "read" && elapsed >= THEME.timing.readPulseDuration) {
      return null;
    }
    const entry = cubicBezierProgress(
      Math.min(1, elapsed / THEME.timing.nodeEntryDuration), 0.23, 1, 0.32, 1,
    );
    const exit = state.kind === "read"
      ? readExitEnvelope(elapsed)
      : Math.max(0, Math.min(1, (gestureLifetime() - elapsed) / THEME.timing.gestureExit));
    return { act: state.act * entry * exit, color: state.color, kind: state.kind, age: elapsed, depth: state.depth };
  }

  nodeActOf(id: string, now = Number.POSITIVE_INFINITY): number {
    return this.nodeMotionOf(id, now)?.act ?? 0;
  }

  nodeColorOf(id: string): Color {
    return this.nodeAct.get(id)?.at(-1)?.color ?? THEME.colors.rest;
  }

  searchMotion(now: number): SearchMotion | null {
    const state = this.search;
    if (!state) return null;
    const age = Math.max(0, now - state.startedAt);
    const enter = cubicBezierProgress(Math.min(1, age / THEME.search.entryDuration), 0.23, 1, 0.32, 1);
    let alpha = enter;
    if (state.releaseAt !== null && now >= state.releaseAt) {
      alpha *= 1 - cubicBezierProgress(
        Math.min(1, (now - state.releaseAt) / THEME.search.exitDuration), 0.77, 0, 0.175, 1,
      );
      if (alpha <= 0.01) {
        this.search = null;
        return null;
      }
    }
    return {
      progress: (age % THEME.search.cycleDuration) / THEME.search.cycleDuration,
      alpha,
      missed: state.missed,
    };
  }

  neuralFlow(now: number): NeuralFlowMotion | null {
    const state = this.neuralFlowState;
    if (!state) return null;
    const fadeAt = Math.min(state.activeUntil, state.releaseAt ?? state.activeUntil);
    const expiresAt = fadeAt + 0.9;
    if (now >= expiresAt) {
      this.neuralFlowState = null;
      return null;
    }
    const age = Math.max(0, now - state.startedAt);
    const enter = cubicBezierProgress(Math.min(1, age / 0.5), 0.23, 1, 0.32, 1);
    const exit = now < fadeAt ? 1 : 1 - cubicBezierProgress(Math.min(1, (now - fadeAt) / 0.9), 0.77, 0, 0.175, 1);
    return {
      kind: state.kind,
      phase: (age % 3.6) / 3.6,
      alpha: Math.max(0, enter * exit),
      intensity: state.intensity,
      nodeIds: state.nodeIds,
    };
  }

  graphNarration(): GraphNarration {
    return this.replaying ? { ...this.narration, detail: `操作回放 · ${this.narration.detail}${this.eventQueue.length ? ` · 后续 ${this.eventQueue.length} 步` : ""}` } : this.narration;
  }

  private addOverlay(overlay: Omit<GraphOverlay, "startedAt" | "endsAt">, now: number): void {
    const endsAt = Math.max(now + gestureLifetime(), this.visualUntil);
    this.overlays.push({ ...overlay, startedAt: now, endsAt });
    this.visualUntil = Math.max(this.visualUntil, endsAt);
  }

  overlaysAt(now: number): GraphOverlay[] {
    return this.overlays.filter((overlay) => now >= overlay.startedAt && now < overlay.endsAt);
  }

  /** 自动标题只跟随当前精读窗口，最多一个，不随其他 OPS 出现。 */
  readingFocus(now: number): { id: string; alpha: number } | null {
    const reads = [...this.nodeAct.entries()].flatMap(([id, states]) => states
      .filter((state) => state.kind === "read" && now > state.visibleAt && now < state.visibleAt + THEME.timing.readPulseDuration)
      .map((state) => ({ id, at: state.visibleAt })));
    // 较新读卡获得标题窗口；其余节点仍保留精读反馈。
    reads.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    const focus = reads[0];
    return focus ? { id: focus.id, alpha: Math.min(1, (now - focus.at) / 0.2, (focus.at + THEME.timing.readPulseDuration - now) / 0.2) } : null;
  }

  hasAttention(): boolean {
    return this.edges.size > 0 || this.nodeAct.size > 0 || this.overlays.length > 0 || this.search !== null || this.neuralFlowState !== null || this.eventQueue.length > 0;
  }

  attentionLevel(now: number): number {
    let level = (this.searchMotion(now)?.alpha ?? 0) * 0.28;
    const neural = this.neuralFlow(now);
    if (neural) level = Math.max(level, neural.alpha * neural.intensity * 0.42);
    for (const edgeId of [...this.edges.keys()]) {
      const heat = this.heatOf(edgeId, now);
      if (heat) level = Math.max(level, heat.fade * 0.62);
    }
    for (const id of this.nodeAct.keys()) level = Math.max(level, this.nodeActOf(id, now) * 0.62);
    return Math.min(1, level);
  }

  /** 每帧调用：先推进一个到期事件，再按绝对时钟清理已完成动作。 */
  decay(dt: number, now = Number.POSITIVE_INFINITY): boolean {
    const changed = Number.isFinite(now) ? this.flushQueue(now) : false;
    const factor = Math.pow(THEME.node.decayPerFrame, dt * 60);
    this.overlays = this.overlays.filter((overlay) => now < overlay.endsAt);
    for (const [id, states] of this.nodeAct) {
      const remaining = states.filter((state) => !Number.isFinite(now) || now < state.visibleAt + motionLifetime(state.kind));
      // 正常播放由绝对时钟控制停留和淡出；保留无时钟调用的兼容衰减。
      if (!Number.isFinite(now)) for (const state of remaining) if (state.kind !== "read") state.act *= factor;
      if (!remaining.length) this.nodeAct.delete(id);
      else this.nodeAct.set(id, remaining);
    }
    return changed;
  }

  hasActiveBundles(): boolean {
    return this.edges.size > 0;
  }

  private releaseSearch(now: number): void {
    if (this.search && this.search.releaseAt === null) this.search.releaseAt = now;
  }

  private releaseActive(now: number): void {
    this.releaseSearch(now);
    if (this.neuralFlowState && this.neuralFlowState.releaseAt === null) this.neuralFlowState.releaseAt = now;
    for (const state of this.edges.values()) {
      if (state.releaseAt === null) state.releaseAt = now;
    }
  }

  private flushQueue(now: number): boolean {
    if (!this.eventQueue.length || now < Math.max(this.queueTailAt, this.visualUntil) || this.eventQueue[0].scheduledAt > now) return false;
    const queued = this.eventQueue.shift()!;
    if (queued.eventId) this.queuedEventIds.delete(queued.eventId);
    // 恢复后台标签页时仍一次只播放一个事件，不在同一帧赶完历史步骤。
    this.replaying = this.eventQueue.length > 0 || now - queued.scheduledAt > THEME.timing.eventQueueGap;
    const changed = this.handleEvent(queued.event, now);
    this.queueTailAt = Math.max(now + THEME.timing.eventQueueGap, this.visualUntil);
    return changed;
  }

  private clearQueue(): void {
    this.eventQueue = [];
    this.queuedEventIds.clear();
    this.queueTailAt = 0;
    this.replaying = false;
  }

  private rememberEvent(eventId: string): void {
    this.seenEvents.add(eventId);
    this.seenOrder.push(eventId);
    if (this.seenOrder.length > 256) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenEvents.delete(oldest);
    }
  }

  private setNarration(phase: GraphNarration["phase"], title: string, detail: string): void {
    this.narration = { phase, title, detail };
  }
}

function isNeuralFlowKind(value: unknown): value is NeuralFlowKind {
  return value === "inquiry" || value === "encoding" || value === "rewiring" || value === "convergence" || value === "commit";
}

function cubicBezierProgress(x: number, x1: number, y1: number, x2: number, y2: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const t = (lo + hi) / 2;
    const mt = 1 - t;
    const tx = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
    if (tx < x) lo = t;
    else hi = t;
  }
  const t = (lo + hi) / 2;
  const mt = 1 - t;
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

function readExitEnvelope(elapsed: number): number {
  const exitAt = THEME.timing.readPulseDuration - THEME.timing.readExitDuration;
  if (elapsed <= exitAt) return 1;
  return 1 - cubicBezierProgress(
    Math.min(1, (elapsed - exitAt) / THEME.timing.readExitDuration), 0.77, 0, 0.175, 1,
  );
}

function shorten(value: string, limit = 22): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function pathColor(depth: number): Color {
  const index = Math.min(3, Math.max(1, Math.trunc(depth))) - 1;
  return THEME.colors.pathDepth[index] ?? THEME.colors.expand;
}

function humanizeFailure(reason: string): string {
  if (reason.includes("Timeout")) return "模型或知识服务响应超时";
  if (reason.includes("HTTP")) return "模型服务返回异常";
  if (reason.includes("Network") || reason.includes("Connect")) return "模型或知识服务连接失败";
  return "Agent 已停止当前流程，可检查右侧详情后重试";
}

function humanizeInsightStop(reason: string | undefined): string {
  const labels: Record<string, string> = {
    tension_found: "已遇到真实反对关系",
    support_exhausted: "支持链已无可继续的 ready 边",
    depth_limit: "已到深度上限",
    node_budget: "已按节点预算收束",
    candidates_found: "已找到反转假设候选",
    no_candidates: "没有找到可核验候选",
  };
  return labels[String(reason ?? "")] ?? "已记录停止原因";
}
