import type { CognitiveViewState } from "../cognition/store";
import type { CognitiveInteraction, CognitiveTargetSet, PipelineRunState, WriteProposal } from "../api/client";

export interface AppliedChange {
  created: string[];
  enriched: string[];
}

interface Props {
  sending: boolean;
  pipelineRun?: PipelineRunState | null;
  cognition?: CognitiveViewState | null;
  choiceRequests?: CognitiveInteraction[];
  proposals?: WriteProposal[];
  candidates?: { candidate_id: string }[];
  queuedCount?: number;
  appliedChange?: AppliedChange | null;
  cardTitles?: Record<string, string>;
  onOpenCard?: (cardId: string) => void;
}

type StateTone = "active" | "waiting" | "success" | "warning" | "neutral";

interface DisplayState {
  tone: StateTone;
  eyebrow: string;
  title: string;
  detail: string;
  next?: string;
  completion?: string;
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function receiptFromTargets(targets?: CognitiveTargetSet): AppliedChange | null {
  if (!targets) return null;
  const created = asIds(targets.created);
  const enriched = asIds(targets.enriched);
  return created.length || enriched.length ? { created, enriched } : null;
}

function receiptFromCognition(cognition?: CognitiveViewState | null): AppliedChange | null {
  if (!cognition) return null;
  const latest = cognition.latest;
  if (latest?.kind === "write.applied") {
    const receipt = receiptFromTargets(latest.targets);
    if (receipt) return receipt;
  }
  for (const step of [...cognition.snapshot.episode.steps].reverse()) {
    if (step.action?.operator !== "user_write_decision") continue;
    const data = step.observation?.data;
    const created = asIds(data?.created);
    const enriched = asIds(data?.enriched);
    if (created.length || enriched.length) return { created, enriched };
  }
  return null;
}

function activePipeline(run?: PipelineRunState | null) {
  return run?.phase === "starting" || run?.phase === "running";
}

function deriveState({ sending, pipelineRun, cognition, choices, proposals, candidates, queuedCount, receipt }: {
  sending: boolean; pipelineRun?: PipelineRunState | null; cognition?: CognitiveViewState | null;
  choices: number; proposals: number; candidates: number; queuedCount: number; receipt: AppliedChange | null;
}): DisplayState | null {
  const snapshot = cognition?.snapshot;
  const status = snapshot?.run.status;
  const openCount = snapshot?.workspace.open_questions.length ?? 0;
  const deferredCount = snapshot?.workspace.deferred_items.length ?? 0;
  const continuationCount = snapshot?.projection?.continuation_pending ?? 0;
  const waiting = choices > 0 || proposals > 0 || candidates > 0 || status === "waiting_user" || pipelineRun?.phase === "waiting_user";

  if (waiting) {
    const count = choices + proposals + candidates;
    return {
      tone: "waiting", eyebrow: "需要你确认", title: "本轮停在你的决定处",
      detail: count > 0 ? `有 ${count} 项需要你处理；系统不会在未授权时写入知识体。` : "当前步骤需要你的判断，系统尚未继续执行。",
      next: "处理下方的选择卡或确认卡后，Agent 会从当前证据继续。",
      completion: "你的意图尚未落实完成。",
    };
  }
  if (sending || activePipeline(pipelineRun) || status === "running") {
    return {
      tone: "active", eyebrow: "正在执行", title: pipelineRun?.label ?? cognition?.latest?.presentation.title ?? "正在处理你的请求",
      detail: cognition?.latest?.presentation.detail ?? snapshot?.projection?.finding ?? "正在等待本轮真实操作的结果。",
      next: snapshot?.projection?.next ?? (queuedCount ? `当前轮结束后会接续 ${queuedCount} 条已排队内容。` : "完成后会在此处给出可核验的结果。"),
      completion: "本轮尚未结束。",
    };
  }
  if (status === "failed" || status === "cancelled" || pipelineRun?.phase === "failed" || pipelineRun?.phase === "cancelled") {
    return {
      tone: "warning", eyebrow: "本轮未完成", title: status === "cancelled" || pipelineRun?.phase === "cancelled" ? "任务已停止" : "需要处理运行问题",
      detail: pipelineRun?.detail ?? cognition?.latest?.presentation.detail ?? "没有把未确认的内容写入知识体。",
      next: "可以补充约束、重新执行，或换一个更小的目标继续。",
      completion: "你的意图尚未完整落实。",
    };
  }
  if (receipt) {
    const pendingText = continuationCount > 0 ? "Agent 仍在检查这次变更的后续影响。" : "写入回执已确认，知识图谱会同步刷新。";
    const unresolved = openCount + deferredCount;
    return {
      tone: "success", eyebrow: "变更已落实", title: "本次知识变更已写入",
      detail: pendingText,
      next: continuationCount > 0 ? "等待后续检查结果；你也可以继续补充要求。" : unresolved ? `仍保留 ${unresolved} 项待继续核对的内容。` : "本次确认已经完成。",
      completion: continuationCount > 0 || unresolved ? "已写入，但本轮尚有后续检查。" : "本次确认已落实。",
    };
  }
  if (status === "completed" || pipelineRun?.phase === "completed") {
    const unresolved = openCount + deferredCount;
    return {
      tone: "success", eyebrow: "本轮已收束", title: unresolved ? "已得到阶段性结果" : "本轮任务已完成",
      detail: snapshot?.projection?.result ? "Agent 已留下本轮结论与可审计记录。" : (pipelineRun?.label ?? "已完成本轮可执行操作。"),
      next: unresolved ? `仍有 ${unresolved} 项未决内容，可继续追问或指定下一步。` : "如需深化，可以继续追问、比较证据或提出新的任务。",
      completion: unresolved ? "已完成当前阶段，尚有未决项。" : "当前已无待确认或待执行操作。",
    };
  }
  return null;
}

function ChangeLinks({ receipt, cardTitles = {}, onOpenCard }: { receipt: AppliedChange; cardTitles?: Record<string, string>; onOpenCard?: (cardId: string) => void }) {
  const groups = [
    ["新建", receipt.created],
    ["更新", receipt.enriched],
  ] as const;
  return <div className="conversation-state__changes" aria-label="本轮已落实的知识卡片">
    <span>已落实的知识卡</span>
    {groups.map(([label, ids]) => ids.map((id) => <button key={`${label}-${id}`} type="button" title={id} onClick={() => onOpenCard?.(id)}>
      <small>{label}</small>{cardTitles[id] ?? id}
    </button>))}
  </div>;
}

export function ConversationStateCard({ sending, pipelineRun, cognition, choiceRequests = [], proposals = [], candidates = [], queuedCount = 0, appliedChange = null, cardTitles, onOpenCard }: Props) {
  const receipt = appliedChange ?? receiptFromCognition(cognition);
  const state = deriveState({
    sending, pipelineRun, cognition, choices: choiceRequests.length, proposals: proposals.length,
    candidates: candidates.length, queuedCount, receipt,
  });
  if (!state) return null;
  return <section className={`conversation-state conversation-state--${state.tone}`} aria-live="polite" aria-label="Agent 当前状态">
    <div className="conversation-state__heading">
      <span className="conversation-state__signal" aria-hidden />
      <span>{state.eyebrow}</span>
      {queuedCount > 0 && <small>待接续 {queuedCount}</small>}
    </div>
    <strong>{state.title}</strong>
    <p>{state.detail}</p>
    {state.next && <p className="conversation-state__next"><span>下一步</span>{state.next}</p>}
    {state.completion && <p className="conversation-state__completion">{state.completion}</p>}
    {receipt && <ChangeLinks receipt={receipt} cardTitles={cardTitles} onOpenCard={onOpenCard} />}
  </section>;
}
