type Node = { id: string; domains?: string[] };
type Edge = { from: string; to: string };
export type Positions = Record<string, { x: number; y: number }>;
export function normalizeForce(value?: unknown): number;
export function topology(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] };
export function simulate(nodes: Node[], edges: Edge[], iterations: number,
  initial?: Record<string, number[]>, softPin?: Set<string>, options?: {
    gravity?: number;
    repulsion?: number;
    linkAttraction?: number;
    domainCohesion?: number;
    interactive?: boolean;
    hash01?: (seed: string, salt: string) => number;
    onProgress?: (positions: Positions, progress: number) => void;
  }): Positions;
