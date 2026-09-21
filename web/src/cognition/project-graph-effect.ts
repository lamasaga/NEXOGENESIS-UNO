import type { CognitiveEpisodeStep, CognitiveEvent } from "../api/client";
import type { GraphEdge, SimEvent } from "../graph/types";

function eventId(event: CognitiveEvent, suffix: string) { return `${event.event_id}:${suffix}`; }
function ids(event: CognitiveEvent) { return event.targets?.node_ids ?? []; }
function edges(event: CognitiveEvent) { return event.targets?.edge_ids ?? []; }
function sources(event: CognitiveEvent) { return event.targets?.source_ids ?? []; }

/**
 * Map auditable observations to the small, existing activation vocabulary.
 * A visual effect never creates targets that were absent from the observation.
 */
export function projectGraphEffects(event: CognitiveEvent): SimEvent[] {
  const operator = event.operator?.name;
  const targetIds = ids(event);
  const edgeIds = edges(event);
  const result: SimEvent[] = [];
  if (event.kind === "tm.selected") {
    result.push({ type: "thinking.model", ts: Date.now(), payload: {
      event_id: eventId(event, "tm"), title: event.presentation.title,
      detail: event.presentation.detail ?? "已选择本轮审视方式",
    } });
    return result;
  }
  if (event.kind === "op.started" && (operator === "retrieve" || operator === "graph_search")) {
    result.push({ type: "retrieve.query", ts: Date.now(), payload: { event_id: eventId(event, "query"), query: event.presentation.detail ?? "" } });
    return result;
  }
  if (!event.observation || ["rejected", "error", "cancelled"].includes(event.observation.status)) {
    if (event.observation?.status === "error") result.push({ type: "session.failed", ts: Date.now(), payload: { event_id: eventId(event, "failed"), reason: event.observation.summary } });
    return result;
  }
  if (event.kind === "proposal.created") {
    const sourceId = event.targets?.relation_source_id;
    const targetId = event.targets?.relation_target_id;
    result.push({ type: "proposal.pending", ts: Date.now(), payload: {
      event_id: eventId(event, "proposal"), node_ids: targetIds,
      source_id: sourceId, target_id: targetId,
      decision: event.targets?.relation_decision,
      relation_type: event.targets?.relation_type,
    } });
    return result;
  }
  if (operator === "retrieve" || operator === "graph_search") {
    result.push({ type: "graph.hit", ts: Date.now(), payload: { event_id: eventId(event, "seed"), node_ids: targetIds, edge_ids: [], role: "seed", depth: 0 } });
  } else if (operator === "read_card" || operator === "read_cards") {
    // 一次批量精读的所有已观察卡片必须进入画布；不能只取首张让其余真实阅读消失。
    if (targetIds.length) result.push({ type: "card.read", ts: Date.now(), payload: {
      event_id: eventId(event, "read"), card_ids: targetIds,
      title: targetIds.length > 1 ? `本次精读 ${targetIds.length} 张知识卡片` : (event.presentation.detail ?? targetIds[0]),
      read_index: 0,
    } });
  } else if (operator === "trace_source") {
    const cardId = targetIds[0];
    if (cardId) result.push({ type: "evidence.trace", ts: Date.now(), payload: { event_id: eventId(event, "source"), card_id: cardId, title: event.presentation.detail ?? cardId } });
  } else if (operator === "trace_support_to_tension") {
    const tensionNodeIds = event.targets?.insight_tension_node_ids ?? [];
    result.push({ type: "insight.tension-trace", ts: Date.now(), payload: {
      event_id: eventId(event, "tension-trace"), start_ids: sources(event),
      layers: event.targets?.walk_layers ?? [],
      requested_depth: event.targets?.walk_requested_depth ?? 1,
      reached_depth: event.targets?.walk_reached_depth ?? 0,
      tension_node_ids: tensionNodeIds,
      tension_edge_ids: event.targets?.insight_tension_edge_ids ?? [],
      anchor_ids: event.targets?.insight_anchor_ids ?? [],
      found: tensionNodeIds.length > 0,
      stop_reason: event.targets?.insight_stop_reason ?? "support_exhausted",
    } });
  } else if (operator === "probe_assumption_inversion") {
    result.push({ type: "insight.assumption-flip", ts: Date.now(), payload: {
      event_id: eventId(event, "assumption-flip"), source_ids: sources(event),
      candidate_ids: event.targets?.insight_candidate_ids ?? [], edge_ids: edgeIds,
      stop_reason: event.targets?.insight_stop_reason ?? "no_candidates",
    } });
  } else if (operator === "graph_walk" || operator === "graph_path") {
    const layers = event.targets?.walk_layers ?? [];
    if (layers.length) {
      result.push({ type: "graph.walk", ts: Date.now(), payload: {
        event_id: eventId(event, "walk"), start_ids: sources(event),
        requested_depth: event.targets?.walk_requested_depth ?? layers.at(-1)?.depth ?? 1,
        reached_depth: event.targets?.walk_reached_depth ?? layers.at(-1)?.depth ?? 0,
        plane: event.targets?.graph_plane ?? "argument",
        layers,
      } });
    } else {
      // 兼容升级前已持久化的一跳观察；只点亮其中确实出现的节点与边。
      result.push({ type: "graph.hit", ts: Date.now(), payload: { event_id: eventId(event, "walk"), node_ids: targetIds, edge_ids: edgeIds, source_ids: sources(event), role: "expand", depth: 1 } });
    }
  } else if (operator === "inspect_conflicts") {
    result.push({ type: "conflict.inspect", ts: Date.now(), payload: { event_id: eventId(event, "conflict"), node_ids: targetIds, edge_ids: edgeIds, source_ids: sources(event) } });
  } else if (operator === "inspect_argument") {
    result.push({ type: "lens.begin", ts: Date.now(), payload: { event_id: eventId(event, "argument"), index: 1, name: event.presentation.title, node_ids: targetIds, edge_ids: edgeIds, source_ids: sources(event), lens_kind: "argument" } });
  } else if (operator === "compare_cards" || operator === "compare_nodes") {
    result.push({ type: "lens.begin", ts: Date.now(), payload: { event_id: eventId(event, "compare"), index: 1, name: event.presentation.title, node_ids: targetIds, edge_ids: edgeIds, source_ids: sources(event), lens_kind: "compare" } });
  } else if (operator === "graph_analogize") {
    result.push({ type: "lens.begin", ts: Date.now(), payload: { event_id: eventId(event, "analogy"), index: 1, name: event.presentation.title, node_ids: targetIds, edge_ids: [], source_ids: sources(event), lens_kind: "analogy" } });
  } else if (operator === "graph_members" || operator === "inspect_domain_members") {
    result.push({ type: "catalog.read", ts: Date.now(), payload: { event_id: eventId(event, "members"), node_ids: targetIds } });
  } else if (operator === "inspect_structure_issues" || operator === "inspect_unconnected_cards" || operator === "inspect_knowledge_quality") {
    result.push({ type: "lens.begin", ts: Date.now(), payload: {
      event_id: eventId(event, "audit"), index: 1, name: event.presentation.title,
      node_ids: targetIds, edge_ids: edgeIds, source_ids: sources(event), lens_kind: "audit"
    } });
  } else if (operator === "inspect_evidence_set") {
    result.push({ type: "evidence.inspect", ts: Date.now(), payload: {
      event_id: eventId(event, "evidence-set"),
      roles: event.targets?.evidence_role_node_ids ?? {},
      claim_count: event.targets?.evidence_claim_count ?? 0,
    } });
  } else if (operator === "verify_evidence_anchors") {
    result.push({ type: "evidence.verify", ts: Date.now(), payload: {
      event_id: eventId(event, "verify-anchors"),
      valid_ids: event.targets?.evidence_valid_node_ids ?? [],
      invalid_ids: event.targets?.evidence_invalid_node_ids ?? [],
      all_valid: event.targets?.evidence_all_valid === true,
    } });
  } else if (operator === "inspect_cognitive_sufficiency") {
    result.push({ type: "cognition.sufficiency", ts: Date.now(), payload: {
      event_id: eventId(event, "sufficiency"),
      node_ids: event.targets?.sufficiency_node_ids ?? targetIds,
      ready: event.targets?.sufficiency_ready === true,
      missing: event.targets?.sufficiency_missing ?? [],
    } });
  } else if (operator === "inspect_integration_candidates" || operator === "inspect_entity_candidates") {
    result.push({ type: "structure.candidates", ts: Date.now(), payload: {
      event_id: eventId(event, "candidates"), node_ids: targetIds, source_ids: sources(event),
    } });
  } else if (operator === "inspect_relation_case" || operator === "simulate_relation_patch") {
    result.push({ type: operator === "simulate_relation_patch" ? "relation.simulate" : "relation.inspect", ts: Date.now(), payload: {
      event_id: eventId(event, operator === "simulate_relation_patch" ? "relation-simulate" : "relation-case"),
      node_ids: targetIds, edge_ids: edgeIds,
      source_id: event.targets?.relation_source_id ?? sources(event)[0],
      target_id: event.targets?.relation_target_id,
      decision: event.targets?.relation_decision,
      relation_type: event.targets?.relation_type,
      passed: event.targets?.relation_preflight_passed === true,
    } });
  } else if (operator === "graph_note" || operator === "record_structure_review") {
    result.push({ type: "structure.note", ts: Date.now(), payload: {
      event_id: eventId(event, "structure-note"), node_ids: targetIds,
    } });
  } else if (event.kind === "write.applied" && event.targets?.relation_source_id && event.targets?.relation_target_id) {
    result.push({ type: "relation.applied", ts: Date.now(), payload: {
      event_id: eventId(event, "relation-applied"), edge_ids: edgeIds,
      source_id: event.targets.relation_source_id, target_id: event.targets.relation_target_id,
      decision: event.targets.relation_decision, relation_type: event.targets.relation_type,
    } });
  } else if (event.kind === "write.applied") {
    result.push({ type: "write.applied", ts: Date.now(), payload: {
      event_id: eventId(event, "write"),
      created: event.targets?.created ?? [],
      enriched: event.targets?.enriched ?? [],
    } });
  } else if (event.kind === "run.completed") {
    result.push({ type: "session.idle", ts: Date.now(), payload: { event_id: eventId(event, "complete") } });
  }
  return result;
}

function replayEdgeIds(data: Record<string, unknown>, graphEdges: GraphEdge[]) {
  const tension = data.tension && typeof data.tension === "object" ? data.tension as Record<string, unknown> : {};
  const descriptors = [
    ...(Array.isArray(data.nodes) ? data.nodes.map((node) => (node as { edge?: unknown }).edge) : []),
    ...(Array.isArray(data.direct_relations) ? data.direct_relations : []),
    ...(Array.isArray(data.edges) ? data.edges : []),
    ...(Array.isArray(data.related_edges) ? data.related_edges : []),
    ...(Array.isArray(tension.edges) ? tension.edges : []),
    ...(Array.isArray(data.support_layers) ? data.support_layers.flatMap((raw) => {
      const layer = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return Array.isArray(layer.edges) ? layer.edges : [];
    }) : []),
  ].filter((item): item is { from?: string; to?: string; type?: string } => Boolean(item) && typeof item === "object");
  return graphEdges.filter((edge) => descriptors.some((descriptor) =>
    edge.from === descriptor.from && edge.to === descriptor.to
    && (!(descriptor as { declared_type?: string }).declared_type
      ? (!descriptor.type || edge.relation_type === descriptor.type || edge.kind === descriptor.type)
      : edge.relation_type === (descriptor as { declared_type?: string }).declared_type)
  )).map((edge) => edge.id);
}

function replayWalkLayers(data: Record<string, unknown>, graphEdges: GraphEdge[]) {
  const supportTrace = Array.isArray(data.support_layers);
  const rawLayers = supportTrace ? data.support_layers : data.layers;
  if (!Array.isArray(rawLayers)) return [];
  return rawLayers.map((raw) => {
    const layer = raw as { depth?: number; node_ids?: unknown[]; source_ids?: unknown[]; edges?: unknown[]; truncated?: boolean };
    const descriptors = (layer.edges ?? []).filter((edge): edge is Record<string, unknown> => Boolean(edge) && typeof edge === "object");
    return {
      depth: Math.min(supportTrace ? 6 : 3, Math.max(1, Number(layer.depth ?? 1))),
      node_ids: (layer.node_ids ?? []).map(String).filter(Boolean),
      source_ids: (layer.source_ids ?? []).map(String).filter(Boolean),
      edge_ids: replayEdgeIds({ nodes: descriptors.map((edge) => ({ edge })) }, graphEdges),
      ready_edge_ids: replayEdgeIds({ nodes: descriptors.filter((edge) => edge.ready !== false && edge.readiness !== "legacy_candidate").map((edge) => ({ edge })) }, graphEdges),
      legacy_edge_ids: replayEdgeIds({ nodes: descriptors.filter((edge) => edge.ready === false || edge.readiness === "legacy_candidate").map((edge) => ({ edge })) }, graphEdges),
      truncated: Boolean(layer.truncated),
    };
  }).filter((layer) => layer.node_ids.length || layer.edge_ids.length);
}

export function projectEpisodeStep(step: CognitiveEpisodeStep, runId: string, index: number, graphEdges: GraphEdge[] = []): SimEvent[] {
  const data = step.observation?.data ?? {};
  const adjudication = data.adjudication as { decision?: string; proposed_relation?: { from?: string; to?: string; type?: string }; old_relation?: { from?: string; to?: string; type?: string } } | undefined;
  const relation = adjudication?.proposed_relation ?? adjudication?.old_relation;
  const tension = data.tension && typeof data.tension === "object" ? data.tension as Record<string, unknown> : {};
  const nodes = [...new Set([
    ...(Array.isArray(data.nodes) ? data.nodes.map((node) => String((node as { id?: string }).id ?? "")) : []),
    ...(Array.isArray(data.results) ? data.results.map((item) => String((item as { card_id?: string }).card_id ?? "")) : []),
    ...(Array.isArray(data.evidence_anchors) ? data.evidence_anchors.map((item) => String(typeof item === "string" ? item : (item as { anchor?: string }).anchor ?? "").split("#", 1)[0]) : []),
    ...(Array.isArray(data.candidate_ids) ? data.candidate_ids.map(String) : []),
    ...(Array.isArray(tension.node_ids) ? tension.node_ids.map(String) : []),
  ].filter(Boolean))];
  const walkLayers = replayWalkLayers(data, graphEdges);
  const evidenceResults = Array.isArray(data.results) ? data.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  const roleIds = Object.fromEntries(["support", "counter", "boundary", "background", "inference"].map((role) => [
    role,
    [...new Set(evidenceResults.filter((item) => item.role === role && item.exists !== false).map((item) => String(item.card_id ?? "")).filter(Boolean))],
  ]));
  const anchorIds = Array.isArray(data.evidence_anchors)
    ? [...new Set(data.evidence_anchors.map((item) => String(typeof item === "string" ? item : (item as { anchor?: string }).anchor ?? "").split("#", 1)[0]).filter(Boolean))]
    : [];
  const event: CognitiveEvent = {
    schema_version: "1.0", event_id: `replay:${runId}:${step.step}:${index}`, session_id: "replay", run_id: runId,
    at: step.at, kind: "op.observed", operator: { name: step.action?.operator ?? "tool", mode: step.action?.mode },
    targets: {
      node_ids: nodes, edge_ids: replayEdgeIds(data, graphEdges),
      source_ids: typeof data.start === "string" ? [data.start] : [],
      ...(walkLayers.length ? {
        walk_layers: walkLayers,
        walk_requested_depth: Number(data.hops ?? data.requested_hops ?? data.requested_depth ?? walkLayers.length),
        walk_reached_depth: Number(data.reached_hops ?? data.reached_depth ?? walkLayers.at(-1)?.depth ?? 0),
      } : {}),
      graph_plane: data.plane === "context" ? "context" : "argument",
      insight_tension_node_ids: Array.isArray(tension.node_ids) ? tension.node_ids.map(String) : [],
      insight_tension_edge_ids: replayEdgeIds({ edges: Array.isArray(tension.edges) ? tension.edges : [] }, graphEdges),
      insight_anchor_ids: Array.isArray(tension.anchor_ids) ? tension.anchor_ids.map(String) : [],
      insight_candidate_ids: Array.isArray(data.candidate_ids) ? data.candidate_ids.map(String) : [],
      insight_stop_reason: typeof data.stop_reason === "string" ? data.stop_reason : undefined,
      evidence_role_node_ids: roleIds,
      evidence_valid_node_ids: [...new Set(evidenceResults.filter((item) => item.usable === true).map((item) => String(item.card_id ?? "")).filter(Boolean))],
      evidence_invalid_node_ids: [...new Set(evidenceResults.filter((item) => item.usable !== true && item.exists !== false).map((item) => String(item.card_id ?? "")).filter(Boolean))],
      evidence_claim_count: Array.isArray(data.claims) ? data.claims.length : 0,
      evidence_all_valid: data.all_deterministic_checks_passed === true,
      sufficiency_node_ids: anchorIds,
      sufficiency_ready: data.ready === true,
      sufficiency_missing: Array.isArray(data.missing) ? data.missing.map(String) : [],
      relation_decision: typeof (data.adjudication as Record<string, unknown> | undefined)?.decision === "string" ? String((data.adjudication as Record<string, unknown>).decision) : undefined,
      relation_source_id: relation?.from ?? (typeof data.source_id === "string" ? data.source_id : undefined),
      relation_target_id: relation?.to ?? (typeof data.target_id === "string" ? data.target_id : undefined),
      relation_type: relation?.type ?? (typeof data.requested_relation_type === "string" ? data.requested_relation_type : undefined),
      relation_preflight_passed: data.preflight_passed === true,
    },
    observation: step.observation, presentation: { title: step.action?.operator ?? "历史步骤", detail: step.observation?.summary, tone: "neutral" }
  };
  return projectGraphEffects(event);
}
