export type ConstructGoal = "connect" | "decentralize" | "organize" | "relations" | "domains" | "recommend";
export const CONSTRUCT_CONTEXT_MARKER: string;
export type ConstructWorkload = "advice" | "group" | "systematic";
export interface ConstructRequest {
  snapshot: string;
  goal: ConstructGoal;
  workload: ConstructWorkload;
  scope: { kind: "instance" | "domain" | "neighborhood"; id?: string };
  changes: "relations" | "organization";
  notes: string;
}
export interface ConstructPreparation {
  snapshot: string;
  authority: string;
  cards: { id: string; title: string; domains: string[]; neighbors: string[]; type: string }[];
  domains: { id: string; title: string }[];
  summary: { cards: number; isolated: number; concentrated: number };
}
export const CONSTRUCT_GOALS: { id: ConstructGoal; label: string; description: string }[];
export const CONSTRUCT_WORKLOADS: { id: ConstructWorkload; label: string; description: string }[];
