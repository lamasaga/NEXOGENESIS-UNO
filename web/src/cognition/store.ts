import type { CognitiveEvent, CognitiveRunSnapshot, CognitiveWorkspace } from "../api/client";

export interface CognitiveViewState {
  snapshot: CognitiveRunSnapshot;
  events: CognitiveEvent[];
  latest: CognitiveEvent | null;
}

export function cognitiveViewFromSnapshot(snapshot: CognitiveRunSnapshot): CognitiveViewState {
  return { snapshot, events: [], latest: null };
}

export function applyCognitiveEvent(current: CognitiveViewState | null, event: CognitiveEvent): CognitiveViewState | null {
  if (!current) return current;
  if (event.run_id && event.run_id !== current.snapshot.run.run_id) return current;
  if (current.events.some((item) => item.event_id === event.event_id || (event.seq !== undefined && item.seq === event.seq))) return current;
  const events = [...current.events, event].slice(-48);
  return {
    snapshot: event.workspace_delta ? {
      ...current.snapshot,
      workspace: applyWorkspaceDelta(current.snapshot.workspace, event.workspace_delta),
    } : current.snapshot,
    events,
    latest: event,
  };
}

function applyWorkspaceDelta(workspace: CognitiveWorkspace, delta: NonNullable<CognitiveEvent["workspace_delta"]>): CognitiveWorkspace {
  const next = { ...workspace } as CognitiveWorkspace;
  for (const [bucket, values] of Object.entries(delta.added ?? {})) {
    const existing = Array.isArray(next[bucket as keyof CognitiveWorkspace]) ? next[bucket as keyof CognitiveWorkspace] as unknown[] : [];
    (next as unknown as Record<string, unknown>)[bucket] = [...existing, ...values];
  }
  for (const [bucket, values] of Object.entries(delta.changed ?? {})) {
    if (!values.length) continue;
    (next as unknown as Record<string, unknown>)[bucket] = values;
  }
  return next;
}
