import { useEffect, useState } from "react";
import type { GraphNarration } from "../activation/engine";
import type { AgentStep, CognitiveInteraction, PipelineRunState, WriteProposal, WorkItem } from "../api/client";
import type { CognitiveViewState } from "../cognition/store";
import type { AppliedChange } from "./ConversationStateCard";
import { presentWorkItem } from "./workPresentation";

interface Props {
  narration: GraphNarration;
  sending: boolean;
  work?: WorkItem;
  pipelineRun?: PipelineRunState | null;
  cognition?: CognitiveViewState | null;
  choiceRequests?: CognitiveInteraction[];
  proposals?: WriteProposal[];
  candidates?: { candidate_id: string }[];
  queuedCount?: number;
  appliedChange?: AppliedChange | null;
  cardTitles?: Record<string, string>;
  steps?: AgentStep[];
  onOpenCard?: (cardId: string) => void;
  onRetryPipeline?: () => void;
  onStopPipeline?: (afterWave: boolean) => void;
}

type WorkbenchTone = "active" | "waiting" | "success" | "warning" | "neutral";
type WorkbenchKind = "active" | "waiting" | "failed" | "partial" | "paused" | "cancelled" | "completed" | "idle";

interface WorkbenchState {
  kind: WorkbenchKind;
  label: string;
  tone: WorkbenchTone;
  live: boolean;
}

function workbenchState({ sending, pipelineRun, cognition, pendingCount, hasAppliedChange, work }: {
  sending: boolean;
  pipelineRun?: PipelineRunState | null;
  cognition?: CognitiveViewState | null;
  pendingCount: number;
  hasAppliedChange: boolean;
  work?: WorkItem;
}): WorkbenchState {
  if (work?.outcome === "ended") return { kind: "cancelled", label: "已结束", tone: "neutral", live: false };
  const pipelinePhase = work?.phase ?? pipelineRun?.phase;
  const cognitionStatus = work ? undefined : cognition?.snapshot.run.status;
  if (pendingCount > 0 || pipelinePhase === "waiting_user" || cognitionStatus === "waiting_user") {
    return { kind: "waiting", label: "等待决定", tone: "waiting", live: false };
  }
  if (sending || pipelinePhase === "starting" || pipelinePhase === "running" || cognitionStatus === "running") {
    return { kind: "active", label: "进行中", tone: "active", live: true };
  }
  if (pipelinePhase === "failed" || pipelinePhase === "blocked" || cognitionStatus === "failed") {
    if (work && !work.can_continue && work.stage === null) {
      if (pipelinePhase === 'failed') return { kind: 'failed', label: '回答未完成', tone: 'warning', live: false };
      return { kind: "partial", label: "阶段性结束", tone: "neutral", live: false };
    }
    return { kind: "failed", label: work?.can_continue ? "可继续" : "本轮未完成", tone: "warning", live: false };
  }
  if (pipelinePhase === "paused") return { kind: "paused", label: "已暂停", tone: "neutral", live: false };
  if (pipelinePhase === "closed" || cognitionStatus === "closed") {
    const delivery = work?.delivery ?? cognition?.snapshot.run.delivery;
    return { kind: "partial", label: delivery?.state === "delivered" ? delivery.coverage === "partial" ? "已回答部分" : "已交付" : "本轮已结束", tone: "neutral", live: false };
  }
  if (pipelinePhase === "cancelled" || cognitionStatus === "cancelled") return { kind: "cancelled", label: "已停止", tone: "neutral", live: false };
  if (pipelinePhase === "completed" || cognitionStatus === "completed" || hasAppliedChange) {
    return { kind: "completed", label: "已完成", tone: "success", live: false };
  }
  return { kind: "idle", label: "就绪", tone: "neutral", live: false };
}

export function AgentWorkDock({ narration, sending, pipelineRun = null, cognition = null,
  choiceRequests = [], proposals = [], candidates = [], queuedCount = 0, appliedChange = null,
  cardTitles, steps = [], onOpenCard, onRetryPipeline, onStopPipeline, work }: Props) {
  const pendingCount = choiceRequests.length + proposals.length + candidates.length + (work?.native_question ? 1 : 0);
  const hasAppliedChange = Boolean(appliedChange && (appliedChange.created.length > 0 || appliedChange.enriched.length > 0));
  const state = workbenchState({ sending, pipelineRun, cognition, pendingCount, hasAppliedChange, work });
  const elapsed = useElapsed(pipelineRun);
  const pipelineSteps = pipelineRun?.steps ?? [];
  const recentProgress = uniqueProgress(pipelineSteps.length > 0 ? pipelineSteps : steps.map((step) => step.label)).slice(-2);
  const appliedCards = [
    ...(appliedChange?.created ?? []).map((id) => ({ id, action: "新建" })),
    ...(appliedChange?.enriched ?? []).map((id) => ({ id, action: "更新" })),
  ].slice(0, 3);
  const pendingPrompt = work?.native_question?.questions[0]?.question ?? choiceRequests[0]?.question
    ?? proposals[0]?.presentation?.title
    ?? (candidates.length > 0 ? "发现了需要你判断的知识候选" : "需要你决定下一步如何处理");
  const title = work?.outcome === "ended" ? "本次任务已结束" : (work?.phase ?? cognition?.snapshot.run.status) === "closed" ? "本轮分析已结束" : focusTitle({ state, pipelineRun, cognition, appliedChange, narration, recentProgress, pendingPrompt });
  const workPresentation = work ? presentWorkItem(work) : null;
  const detail = workPresentation && state.kind !== "active" ? workPresentation.detail
    : focusDetail({ state, pipelineRun, cognition, appliedChange, narration, recentProgress });
  const cognitivePipeline = cognitionPipelineName(cognition?.snapshot.run.mode);
  const mode = pipelineRun ? pipelineName(pipelineRun.stage) : cognitivePipeline ?? "思维体";
  const hasContext = pendingCount > 0 || queuedCount > 0 || appliedCards.length > 0 || state.kind === "completed" || state.kind === "partial";

  return <section className={`agent-workbench agent-workbench--${state.tone}`} data-state={state.kind}
    aria-label="思维体工作状态" aria-live="polite">
    <div className="agent-workbench__identity">
      <div className="agent-workbench__presence">
        <span className={`agent-workbench__signal graph-phase--${narration.phase} ${state.live ? "agent-workbench__signal--live" : ""}`} aria-hidden />
        <strong>{mode}</strong>
      </div>
      <span className="agent-workbench__state">{state.label}</span>
    </div>

    <div className="agent-workbench__content">
      <div className="agent-workbench__headline">
        <strong className="agent-workbench__title">{title}</strong>
        <div className="agent-workbench__actions">
          {elapsed && <span className="agent-workbench__elapsed">{elapsed}</span>}
        <div className="agent-workbench__controls">
        {onStopPipeline && state.live && pipelineRun?.jobId && <>
          <button type="button" disabled={pipelineRun.pauseRequested} onClick={() => onStopPipeline?.(true)}>
            {pipelineRun.pauseRequested ? "即将暂停" : "当前操作后暂停"}
          </button>
          <button type="button" className="agent-workbench__stop" onClick={() => onStopPipeline?.(false)}>停止</button>
        </>}
        {!state.live && work?.outcome !== "ended" && (pipelineRun?.phase === "paused" || pipelineRun?.phase === "cancelled") && onRetryPipeline &&
          <button type="button" onClick={onRetryPipeline}>继续此任务</button>}
        {!state.live && (pipelineRun?.phase === "failed" || pipelineRun?.phase === "blocked") && onRetryPipeline &&
          <button type="button" onClick={onRetryPipeline}>继续此任务</button>}
        </div>
        </div>
      </div>
      <div className="agent-workbench__support">
        <p className="agent-workbench__detail">{detail}</p>
        {hasContext && <div className="agent-workbench__context" aria-label="当前任务补充信息">
          {pendingCount > 0 && <span className="agent-workbench__attention">右侧有 {pendingCount} 项待处理</span>}
          {queuedCount > 0 && <span>已排队 {queuedCount} 条补充</span>}
          {appliedCards.length > 0 && <span className="agent-workbench__applied">
            {appliedCards.map(({ id, action }) => <button type="button" key={`${action}-${id}`} onClick={() => onOpenCard?.(id)}>{action} {cardTitles?.[id] ?? id}</button>)}
          </span>}
          {state.kind === "completed" && appliedCards.length === 0 && <span>详细结果在右侧工作区</span>}
          {state.kind === "partial" && <span>结论在右侧对话，可继续追问</span>}
        </div>}
      </div>
    </div>
  </section>;
}

function focusTitle({ state, pipelineRun, cognition, appliedChange, narration, recentProgress, pendingPrompt }:
  Pick<Props, "pipelineRun" | "cognition" | "appliedChange" | "narration"> &
  { state: WorkbenchState; recentProgress: string[]; pendingPrompt: string }) {
  if (state.kind === "waiting") return pendingPrompt;
  if (state.kind === "active") {
    const semanticFocus = cognition?.latest?.presentation.title ?? cognition?.snapshot.projection?.attention;
    if (semanticFocus) return readableProgress(semanticFocus, pipelineRun?.stage);
    if (pipelineRun) {
      const phaseMatches = pipelineRun.phase === "starting" || pipelineRun.phase === "running";
      return phaseMatches
        ? readableProgress(recentProgress.at(-1) ?? pipelineRun.label, pipelineRun.stage)
        : `正在继续${pipelineName(pipelineRun.stage)}任务`;
    }
    return narration.phase === "idle" || narration.phase === "complete"
      ? (recentProgress.length ? "正在综合本轮回答" : "正在等待模型响应") : readableProgress(narration.title);
  }
  if (appliedChange && (appliedChange.created.length > 0 || appliedChange.enriched.length > 0)) return "知识变更已经写入";
  if (state.kind === "failed") return `${pipelineRun ? pipelineName(pipelineRun.stage) : "本轮工作"}暂未完成`;
  if (state.kind === "partial") return "本轮已形成阶段性结论";
  if (state.kind === "paused") return `${pipelineRun ? pipelineName(pipelineRun.stage) : "本轮工作"}已暂停`;
  if (state.kind === "cancelled") return `${pipelineRun ? pipelineName(pipelineRun.stage) : "本轮工作"}已停止`;
  if (state.kind === "completed") {
    const completedMode = pipelineRun ? pipelineName(pipelineRun.stage) : cognitionPipelineName(cognition?.snapshot.run.mode);
    return completedMode ? `${completedMode}任务已完成` : "本轮任务已完成";
  }
  return "当前没有运行中的任务";
}

function focusDetail({ state, pipelineRun, cognition, appliedChange, narration, recentProgress }:
  Pick<Props, "pipelineRun" | "cognition" | "appliedChange" | "narration"> &
  { state: WorkbenchState; recentProgress: string[] }) {
  if (state.kind === "waiting") {
    return "确认前不会改动知识体，请在右侧完成判断。";
  }
  if (state.kind === "active") {
    if (pipelineRun?.pauseRequested) return "正在完成当前最小操作，随后会安全暂停。";
    const semanticDetail = cognition?.latest?.presentation.detail
      ?? cognition?.snapshot.projection?.finding
      ?? cognition?.snapshot.projection?.next;
    if (semanticDetail) return readableProgress(semanticDetail, pipelineRun?.stage);
    if (narration.phase !== "idle" && narration.phase !== "complete" && narration.detail) return readableProgress(narration.detail, pipelineRun?.stage);
    const current = recentProgress.at(-1);
    const pipelineSnapshotIsLive = pipelineRun?.phase === "starting" || pipelineRun?.phase === "running";
    if (current && !pipelineSnapshotIsLive) return `${readableProgress(current, pipelineRun?.stage)}，随后会继续判断下一步。`;
    if (current) return "相关知识与结构变化会在上方图谱中同步呈现。";
    return pipelineRun ? "正在结合当前上下文推进任务，并判断下一步。" : "请求已接收；工具执行与知识发现会按实际结果显示。";
  }
  if (appliedChange && (appliedChange.created.length > 0 || appliedChange.enriched.length > 0)) {
    return `新建 ${appliedChange.created.length} 张，更新 ${appliedChange.enriched.length} 张；图谱与索引已同步。`;
  }
  if (state.kind === "failed") {
    return pipelineRun?.detail ?? cognition?.snapshot.workspace.stop_reason ?? "本轮没有继续写入；查看右侧记录后可以重新执行。";
  }
  if (state.kind === "paused" || state.kind === "cancelled") return "已经落盘的原子操作仍然有效；再次执行会从剩余材料接续。";
  if (state.kind === "completed") {
    return cognition?.snapshot.projection?.finding ?? pipelineRun?.detail ?? "本轮结果与可审计记录已经保留。";
  }
  return "可以直接提问，或从左侧开始一次知识工作。";
}

function uniqueProgress(items: string[]) {
  const seen = new Set<string>();
  return [...items].reverse().filter((item) => {
    const normalized = item.trim();
    if (normalized === "" || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).reverse();
}

function readableProgress(raw: string, stage?: PipelineRunState["stage"]) {
  const value = raw.trim();
  const exact: Record<string, string> = {
    request_user_choice: "等待你选择处理方向",
    inspect_cognitive_workspace: "整理思维工作区",
    graph_search: "定位相关知识",
    graph_walk: "沿知识关系展开",
    read_card: "精读知识卡片",
    read_cards: "批量精读知识卡片",
    propose_write: "准备知识变更",
    finish_cognitive_run: "收束本轮任务",
  };
  if (exact[value]) return exact[value];
  const withoutPrefix = value.replace(/^正在\s*/, "");
  if (exact[withoutPrefix]) return `正在${exact[withoutPrefix]}`;
  if (/发送.*上下文|上下文.*[\d,]+\s*字/.test(value)) return "正在整理本轮需要理解的材料";
  if (/初稿完成|准备解析|模型生成|解析第\s*\d+\s*\/\s*\d+\s*版草稿/.test(value)) return "正在检查刚形成的判断";
  if (/Harness|安全校验|安全检查|未通过.*校验/.test(value)) return "正在根据安全检查反馈调整下一步";
  if (/归档/.test(value)) return "正在整理并归档已处理材料";
  if (/读取|阅读窗|read_cards?/.test(value)) return "正在阅读相关材料与知识卡片";
  if (/搜索|定位|graph_search/.test(value)) return "正在定位相关知识";
  if (/关系|连接|graph_walk/.test(value)) return "正在梳理知识之间的联系";
  if (/写入|提交|propose_write/.test(value)) return "正在准备一项知识变更";
  if (/[A-Za-z]:[\\/]|[/\\][^\s]+[/\\]|\.(md|pdf|epub|docx)\b/i.test(value) || value.length > 84) {
    return stage ? `正在推进${pipelineName(stage)}任务` : "正在推进当前工作";
  }
  return value;
}

function useElapsed(run: PipelineRunState | null) {
  const active = run?.phase === "starting" || run?.phase === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active || !run) return null;
  return formatElapsed(Math.max(0, Math.floor((now - run.startedAt) / 1000)));
}

function pipelineName(stage: PipelineRunState["stage"]) {
  return stage === "compile" ? "编译" : stage === "theme_compile" ? "主题编译" : stage === "digest" ? "消化" : "建构";
}

function cognitionPipelineName(mode?: string) {
  return mode === "compile" ? "编译" : mode === "theme_compile" ? "主题编译" : mode === "digest" ? "消化" : mode === "construct" ? "建构" : null;
}

function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `已运行 ${minutes}分${String(remainder).padStart(2, "0")}秒` : `已运行 ${remainder}秒`;
}
