export interface GraphNode {
  id: string;
  title: string;
  type: string;
  domains: string[];
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  relation_type: string | null;
  bundle: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SimEvent {
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}
