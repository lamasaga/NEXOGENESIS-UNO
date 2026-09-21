import type { GraphData, SimEvent } from "../graph/types";
import type { NeuralFlowKind } from "../activation/engine";

const TERMINAL = new Set(["completed", "failed", "aborted", "cancelled", "paused", "blocked", "partial"]);
const CONSTRUCT_PHASES = new Set(["strategy_pending", "authoring", "reviewing", "repairing", "verifying", "publishing", "organize", "settle", "batch_done"]);

export function projectWorkNeuralFlow(payload: Record<string, unknown>): SimEvent | null {
  const status = String(payload.status ?? "").toLowerCase();
  if (TERMINAL.has(status)) return { type: "neural.stop", ts: Date.now(), payload: { reason: status } };

  const phase = String(payload.phase ?? "").toLowerCase();
  const declared = String(payload.workflow ?? "").toLowerCase();
  const workflow = declared || (CONSTRUCT_PHASES.has(phase) || payload.role ? "construct" : phase ? "compile" : "dialogue");
  let kind: NeuralFlowKind;
  let title: string;
  let detail: string;

  if (workflow === "dialogue" || workflow === "quick") {
    if (["answer", "synthesize", "respond"].includes(phase)) {
      kind = "convergence"; title = "回答正在形成"; detail = "检索到的知识信号正在向当前问题汇聚";
    } else {
      kind = "inquiry"; title = "知识网络正在回应"; detail = "问题正在唤起图谱中的相关知识活动";
    }
  } else if (workflow === "construct") {
    if (["reviewing", "verifying", "settle"].includes(phase)) {
      kind = "convergence"; title = "建构结果正在收束"; detail = "候选结构正在独立复核与校验";
    } else if (["publishing", "batch_done", "done"].includes(phase)) {
      kind = "commit"; title = "知识结构正在形成"; detail = "确认后的卡片与关系正在进入图谱";
    } else {
      kind = "rewiring"; title = "知识网络正在重组"; detail = "现有知识正在比较、改写并建立新的连接";
    }
  } else {
    if (["check", "review", "reviewing", "verify", "domain_review"].includes(phase)) {
      kind = "convergence"; title = "知识单元正在复核"; detail = "候选卡片正在聚合为可发布的知识结构";
    } else if (["publish", "publishing", "done"].includes(phase)) {
      kind = "commit"; title = "知识单元正在写入"; detail = "通过审核的知识正在进入图谱";
    } else {
      kind = "encoding"; title = "材料正在编码"; detail = "原始材料正被组织为可复用的知识单元";
    }
  }

  return {
    type: "neural.flow",
    ts: Date.now(),
    payload: {
      kind, title, detail,
      intensity: workflow === "construct" ? 0.92 : 0.78,
      duration: 8,
      node_ids: Array.isArray(payload.node_ids) ? payload.node_ids : [],
    },
  };
}

export function visibleGraphNodeIds(ids: unknown, graph: GraphData | null, activeInstanceId: string): string[] {
  if (!Array.isArray(ids) || !graph) return [];
  const visible = new Set(graph.nodes.map(node => node.id));
  const prefix = `kb:${activeInstanceId}:`;
  return [...new Set(ids.map(String).map(id => id.startsWith(prefix) ? id.slice(prefix.length) : id).filter(id => visible.has(id)))];
}

export function graphTopologyDelta(previous: GraphData | null, next: GraphData): { nodeIds: string[]; edgeIds: string[] } {
  if (!previous) return { nodeIds: [], edgeIds: [] };
  const oldNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const oldEdges = new Map(previous.edges.map(edge => [edge.id, edge]));
  return {
    nodeIds: next.nodes.filter(node => {
      const old = oldNodes.get(node.id);
      return !old || old.title !== node.title || old.type !== node.type || old.domains.join("\0") !== node.domains.join("\0");
    }).map(node => node.id),
    edgeIds: next.edges.filter(edge => {
      const old = oldEdges.get(edge.id);
      return !old || old.from !== edge.from || old.to !== edge.to || old.relation_type !== edge.relation_type;
    }).map(edge => edge.id),
  };
}
