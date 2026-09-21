import type { CognitiveEpisodeStep } from "../api/client";
import type { CognitiveViewState } from "./store";

const GROUPS = [
  ["hypotheses", "假设"], ["evidence", "依据"], ["counter_evidence", "反证"],
  ["conflicts", "冲突"], ["open_questions", "开放问题"], ["candidate_actions", "下一步"], ["deferred_items", "延后项"]
] as const;

function textOf(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["description", "question", "title", "summary", "text", "id", "card_id"]) if (typeof item[key] === "string") return item[key] as string;
  }
  return "未命名条目";
}

function cardIdOf(value: unknown): string | null {
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return typeof item.card_id === "string" ? item.card_id : typeof item.id === "string" && !item.id.includes(" ") ? item.id : null;
  }
  return null;
}

export function WorkspaceInspector({ cognition, onOpenCard, onReplayStep }: {
  cognition: CognitiveViewState | null; onOpenCard?: (id: string) => void; onReplayStep?: (step: CognitiveEpisodeStep, index: number) => void;
}) {
  if (!cognition) return null;
  const { snapshot, latest } = cognition;
  return <details className="cognitive-workspace" open={snapshot.run.status === "running"}>
    <summary>
      <span className="cognitive-workspace__signal" aria-hidden />
      <span>思维工作区</span>
      <small>{latest?.presentation.detail ?? snapshot.projection?.finding ?? "尚未形成新的观察"}</small>
    </summary>
    <div className="cognitive-workspace__body">
      <div className="cognitive-workspace__groups">
        {GROUPS.map(([key, label]) => {
          const values = snapshot.workspace[key] ?? [];
          if (!values.length) return null;
          return <section key={key} className="cognitive-workspace__group">
            <h4>{label}<small>{values.length}</small></h4>
            <ul>{values.slice(-3).map((value, index) => {
              const cardId = cardIdOf(value);
              return <li key={`${key}-${index}`}>
                {cardId ? <button onClick={() => onOpenCard?.(cardId)}>{textOf(value)}</button> : <span>{textOf(value)}</span>}
              </li>;
            })}</ul>
          </section>;
        })}
      </div>
      {snapshot.episode.steps.length ? <section className="cognitive-workspace__timeline">
        <h4>可审计步骤</h4>
        <ol>{snapshot.episode.steps.slice(-6).reverse().map((step, index) => <li key={step.step}>
          <button onClick={() => onReplayStep?.(step, index)}><strong>{step.action?.operator ?? "操作"}</strong><span>{step.observation?.summary ?? "已完成观察"}</span></button>
        </li>)}</ol>
      </section> : null}
    </div>
  </details>;
}
