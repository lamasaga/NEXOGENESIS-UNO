import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStep, ChatMessage, CognitiveInteraction, EmergenceCandidate, PipelineHistory, PipelineRunState, PipelineStage, SourceCard, WriteProposal } from "../api/client";
import type { CognitiveViewState } from "../cognition/store";
import { ConfirmCard } from "./ConfirmCard";
import { NativeQuestionForm } from "./WorkCenter";
import type { NativeQuestion, NativeAnswer, WorkItem } from "../api/client";
import { CardCitationLink, cardCitationMarkdown, cardCitationNumbers, cardIdFromCitationHref, citationUrlTransform } from "./CardCitation";
import { presentWorkItem } from "./workPresentation";
import { AnalysisDeliveryCard } from "./AnalysisDeliveryCard";

interface Props {
  conversationId?: string | null;
  title: string | null;
  messages: ChatMessage[];
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => void;
  sending: boolean;
  choiceBusy?: boolean;
  work?: WorkItem;
  onNativeAnswer?: (question: NativeQuestion, answers: NativeAnswer[]) => Promise<void>;
  proposals?: WriteProposal[];
  candidates?: EmergenceCandidate[];
  choiceRequests?: CognitiveInteraction[];
  confirmingId?: string | null;
  pipelineStage?: PipelineStage;
  pipelineHistory?: PipelineHistory;
  pipelineRun?: PipelineRunState | null;
  onConfirmProposal?: (proposalId: string, decision: "confirm" | "cancel") => void;
  onPrepareCandidate?: (candidateId: string) => void;
  onChoose?: (request: CognitiveInteraction, answer: { option_id?: string; answer?: string }) => void;
  onOpenCard?: (cardId: string) => void;
  cognition?: CognitiveViewState | null;
}

export function ChatPanel({ conversationId = null, title, messages, sending, proposals = [], candidates = [],
  confirmingId = null, pipelineStage, pipelineHistory, pipelineRun = null, onConfirmProposal, onPrepareCandidate,
  choiceRequests = [], onChoose, onOpenCard, cognition = null, choiceBusy = false, work, onNativeAnswer,
  hasOlderMessages = false, loadingOlderMessages = false, onLoadOlderMessages }: Props) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const previousConversationRef = useRef<string | null>(null);
  const previousFirstMessageRef = useRef<string | null>(null);
  const previousScrollHeightRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const visibleMessages = useMemo(() => messages.filter((message) => message.content.trim() !== ""), [messages]);
  const pipelineGroups = useMemo(() => pipelineStage ? splitPipelineMessages(visibleMessages, pipelineStage) : null, [pipelineStage, visibleMessages]);
  const firstMessageKey = visibleMessages[0] ? messageRenderKey(visibleMessages[0], 0) : null;
  const workPresentation = work ? presentWorkItem(work) : null;
  const workRecord = work?.uno_job_id ? work.detail.trim() : "";
  const showPending = () => messagesRef.current?.querySelector(".native-question, .user-choice-card, .proposal-card")?.scrollIntoView({ block: "start" });


  useLayoutEffect(() => {
    const switched = previousConversationRef.current !== conversationId;
    const panel = messagesRef.current;
    if (panel) {
      const prepended = !switched && previousFirstMessageRef.current !== null
        && previousFirstMessageRef.current !== firstMessageKey && !stickToBottomRef.current;
      if (switched || stickToBottomRef.current) {
        panel.scrollTo({ top: panel.scrollHeight, behavior: "auto" });
      } else if (prepended) {
        panel.scrollTop += panel.scrollHeight - previousScrollHeightRef.current;
      }
      previousScrollHeightRef.current = panel.scrollHeight;
    }
    previousConversationRef.current = conversationId;
    previousFirstMessageRef.current = firstMessageKey;
  }, [conversationId, firstMessageKey, messages, candidates.length, choiceRequests.length, proposals.length, sending]);

  useEffect(() => { if (work?.native_question || choiceRequests.length || proposals.length) showPending(); }, [conversationId, work?.native_question?.rpc_id, choiceRequests.length, proposals.length]);

  const updateFollowState = () => {
    const panel = messagesRef.current;
    if (!panel) return;
    stickToBottomRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
  };

  return (
    <div className="chat-panel">
      {/* 对话标题 */}
      <div className="chat-panel__header">
        <span className="chat-panel__status" />
        <span className="chat-panel__title">{title ?? "对话工作台"}</span>
        <span className="chat-panel__mode">Agent</span>
      </div>

      {pipelineHistory?.archived_runs ? <PipelineHistoryCard history={pipelineHistory} /> : null}
      {workPresentation && workPresentation.kind !== "idle" && <div className={`chat-work-status is-${workPresentation.kind}`} role="status">
        <strong>{workPresentation.label}</strong><span>{workRecord ? "进度与具体情况见下方工作记录。" : workPresentation.detail}</span>
        {workPresentation.kind === "waiting" && <button onClick={showPending}>查看待办</button>}
      </div>}

      {/* 消息区 */}
      <div ref={messagesRef} className="chat-panel__messages" onScroll={updateFollowState}>
        {hasOlderMessages && <button type="button" className="conversation-history-more"
          disabled={loadingOlderMessages} onClick={onLoadOlderMessages}>
          {loadingOlderMessages ? "正在读取更早消息…" : "读取更早消息"}
        </button>}
        {visibleMessages.length === 0 && !work?.uno_job_id && (pipelineStage ? (
          <PipelineThreadEmptyState stage={pipelineStage} />
        ) : (
          <p className="mt-8 text-center text-xs leading-6 text-zinc-600">
            对知识体提问。
            <br />
            对话与知识工作会唤起不同的神经信号流；实际使用的卡片仍会被单独点亮。
          </p>
        ))}
        {pipelineGroups ? <>
          {pipelineGroups.prefix.map((message, index) => <MessageView key={`prefix-${messageRenderKey(message, index)}`} message={message} onOpenCard={onOpenCard} />)}
          {pipelineGroups.runs.map((run, index) => (
            <PipelineResultGroup key={`${run[0]?.ts ?? "run"}-${index}`} messages={run}
              position={pipelineGroups.runs.length - index - 1} open={index === pipelineGroups.runs.length - 1}
              phase={index === pipelineGroups.runs.length - 1 ? pipelineRun?.phase : undefined}
              onOpenCard={onOpenCard} />
          ))}
        </> : visibleMessages.map((message, index) => <MessageView key={messageRenderKey(message, index)} message={message} onOpenCard={onOpenCard} />)}
        {workRecord && <section className="chat-work-record" aria-label="当前工作记录"><h3>当前工作记录</h3><p>{workRecord}</p></section>}
        <AnalysisDeliveryCard snapshot={cognition?.snapshot} onOpenCard={onOpenCard} />
        {candidates.map((candidate) => (
          <section key={candidate.candidate_id} className="proposal-card candidate-card" aria-label="待选择的涌现候选">
            <div className="proposal-card__eyebrow"><span className="proposal-card__dot" />涌现候选 · {candidate.type}</div>
            <p className="proposal-card__summary">{candidate.title}</p>
            <p className="candidate-card__detail">{candidate.summary}</p>
            <div className="proposal-card__actions">
              <button className="proposal-button proposal-button--confirm" onClick={() => onPrepareCandidate?.(candidate.candidate_id)}>
                选择并预检
              </button>
            </div>
          </section>
        ))}
        {work?.native_question && onNativeAnswer && <NativeQuestionForm key={work.native_question.rpc_id} question={work.native_question} onAnswer={onNativeAnswer} />}
        {choiceRequests.map((request) => <UserChoiceCard key={request.interaction_id} request={request} busy={choiceBusy} onChoose={onChoose} />)}
        {proposals.map((proposal) => (
          <ConfirmCard key={proposal.proposal_id} proposal={proposal}
            busy={confirmingId === proposal.proposal_id}
            onConfirm={() => onConfirmProposal?.(proposal.proposal_id, "confirm")}
            onCancel={() => onConfirmProposal?.(proposal.proposal_id, "cancel")} />
        ))}
        {sending && !pipelineRun && !cognition && (
          <div className="flex items-center gap-2 px-1 text-[12px] text-zinc-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
            请求已发送，正在等待模型响应…
          </div>
        )}
      </div>
    </div>
  );
}

const PIPELINE_NAMES = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" } as const;

function PipelineThreadEmptyState({ stage }: { stage: PipelineStage }) {
  return <section className="pipeline-thread-empty" aria-label={`${PIPELINE_NAMES[stage]}任务尚未开始`}>
    <span className="pipeline-thread-empty__dot" aria-hidden />
    <div>
      <strong>{PIPELINE_NAMES[stage]}任务尚未开始</strong>
      <p>这里保留此任务的结果。查看记录不会自动执行任务。</p>
    </div>
  </section>;
}

function splitPipelineMessages(messages: ChatMessage[], stage: PipelineStage) {
  const prefix: ChatMessage[] = [];
  const runs: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;
  for (const message of messages) {
    if (message.role === "user" && message.content.trim().toLowerCase() === `/${stage}`) {
      if (current) runs.push(current);
      current = [message];
    } else if (current) current.push(message);
    else prefix.push(message);
  }
  if (current) runs.push(current);
  return { prefix, runs };
}

function PipelineResultGroup({ messages, position, open, phase, onOpenCard }: {
  messages: ChatMessage[]; position: number; open: boolean; phase?: PipelineRunState["phase"]; onOpenCard?: (cardId: string) => void;
}) {
  const displayMessages = messages.filter((message) => !(message.role === "user" && message.content.trim().startsWith("/")));
  if (displayMessages.length === 0) return <PipelineSilentResult phase={phase} />;
  const result = [...displayMessages].reverse().find((message) => message.role === "assistant" || message.role === "system");
  const content = result?.content.trim() ?? "";
  const failed = phase === "failed" || content.startsWith("任务未完成") || content.startsWith("发送失败") || content.includes("自动修复两次后仍未通过");
  const waiting = phase === "waiting_user";
  const label = position === 0 ? "本次结果" : position === 1 ? "上一次结果" : "前一次结果";
  return <details className="pipeline-result" open={open}>
    <summary>
      <span className={`pipeline-result__state${failed ? " is-failed" : waiting ? " is-waiting" : ""}`} aria-hidden />
      <span className="pipeline-result__label">{label}</span>
      <span className="pipeline-result__status">{waiting ? "等你处理" : failed ? "未完成" : "已完成"}</span>
      <span className="pipeline-result__date">{formatHistoryDate(result?.ts ?? messages[0]?.ts ?? "")}</span>
      <span className="pipeline-result__chevron" aria-hidden>›</span>
    </summary>
    <div className="pipeline-result__body">
      {displayMessages.map((message, index) => <MessageView key={messageRenderKey(message, index)} message={message} onOpenCard={onOpenCard} />)}
    </div>
  </details>;
}

function PipelineSilentResult({ phase }: { phase?: PipelineRunState["phase"] }) {
  const active = phase === "starting" || phase === "running";
  const stopped = phase === "cancelled" || phase === "paused";
  const title = active ? "正在准备本轮结果" : stopped ? "本轮未形成结果" : "本轮没有可展示的结果";
  const detail = active ? "任务仍在执行，结果生成后会显示在这里。" : "没有正文输出被保存；不会把空记录标为已完成。";
  return <div className="pipeline-silent-result" role="status">
    <span className={`pipeline-silent-result__dot${active ? " is-active" : ""}`} aria-hidden />
    <span><strong>{title}</strong><small>{detail}</small></span>
  </div>;
}

const MARKDOWN_PLUGINS = [remarkGfm];

const MessageView = memo(function MessageView({ message, onOpenCard }: { message: ChatMessage; onOpenCard?: (cardId: string) => void }) {
  const citationNumbers = useMemo(() => message.role === "assistant" ? cardCitationNumbers(message.content) : new Map<string, number>(), [message.content, message.role]);
  const markdown = useMemo(() => cardCitationMarkdown(message.content), [message.content]);
  if (message.role === "user") return <div className="chat-message flex justify-end">
    <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-zinc-800 px-3.5 py-2 text-[13px] leading-5 text-zinc-100">{message.content}</div>
  </div>;
  if (message.role === "assistant") return <div className="chat-message assistant-turn">
    {message.intent?.action === "retrieve" && <details className="source-trace"><summary>本轮问题判断</summary><p className="text-[12px] text-zinc-400">{message.intent.judgment}</p></details>}
    <div className="md-body px-1 text-[13px] leading-6 text-zinc-200">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} urlTransform={citationUrlTransform} components={{
        a: ({ href, children }) => <CardCitationLink href={href} citationNumber={citationNumbers.get(cardIdFromCitationHref(href) ?? "")} onOpenCard={onOpenCard}>{children}</CardCitationLink>,
      }}>{markdown}</ReactMarkdown>
      {message.status && message.status !== "completed" && <p className="text-[12px] text-amber-200" role="status">{message.status === "aborted" ? "回答已停止" : "回答未完整结束"}{message.detail ? "：" + message.detail : ""}</p>}
    </div>
    {message.sources?.length ? <SourceChips cards={message.sources} onOpenCard={onOpenCard} /> : null}
    {message.tool_trace?.length ? <ToolTrace steps={message.tool_trace} /> : null}
  </div>;
  return <div className="chat-message border-l-2 border-sky-400/55 pl-3 text-[12px] leading-5 text-zinc-500">{message.content}</div>;
});

function messageRenderKey(message: ChatMessage, index: number) {
  return message.id ?? `${message.role}:${message.ts ?? "pending"}:${index}`;
}

function PipelineHistoryCard({ history }: { history: PipelineHistory }) {
  const cardChanges = history.cards_created + history.cards_enriched + history.cards_adjusted;
  const records = history.recent.slice(0, 5);
  return <details className="pipeline-history">
    <summary>
      <span className="pipeline-history__mark" aria-hidden>✓</span>
      <span className="pipeline-history__title">历史成果</span>
      <span className="pipeline-history__count">已收纳 {history.archived_runs} 次</span>
      <span className="pipeline-history__chevron" aria-hidden>›</span>
    </summary>
    <div className="pipeline-history__body">
      <p className="pipeline-history__intro">完整展示最近 3 次；更早结果已压缩为成果记录。</p>
      <div className="pipeline-history__metrics" aria-label="历史成果统计">
        <HistoryMetric value={history.completed_runs} label="完成" />
        {history.buffers > 0 && <HistoryMetric value={history.buffers} label="片 Buffer" />}
        {cardChanges > 0 && <HistoryMetric value={cardChanges} label="次卡片沉淀" />}
        {history.failed_runs > 0 && <HistoryMetric value={history.failed_runs} label="次未完成" muted />}
      </div>
      {records.length > 0 && <ol className="pipeline-history__records">
        {records.map((record, index) => <li key={`${record.ts}-${index}`}>
          <span className={`pipeline-history__state pipeline-history__state--${record.status}`} aria-hidden />
          <span className="pipeline-history__date">{formatHistoryDate(record.ts)}</span>
          <span className="pipeline-history__summary">{record.summary || `${PIPELINE_NAMES[record.stage]}记录`}</span>
        </li>)}
      </ol>}
    </div>
  </details>;
}

function HistoryMetric({ value, label, muted = false }: { value: number; label: string; muted?: boolean }) {
  return <span className={muted ? "is-muted" : undefined}><strong>{value}</strong>{label}</span>;
}

function formatHistoryDate(ts: string) {
  const match = ts.match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `${match[1]}/${match[2]}` : "历史";
}

function UserChoiceCard({ request, busy, onChoose }: { request: CognitiveInteraction; busy: boolean; onChoose?: (request: CognitiveInteraction, answer: { option_id?: string; answer?: string }) => void }) {
  const [other, setOther] = useState("");
  return <section className="user-choice-card" aria-label="请选择下一步">
    <div className="user-choice-card__eyebrow"><span className="user-choice-card__dot" />请选择下一步</div>
    <p className="user-choice-card__question">{request.question}</p>
    {busy && <p className="user-choice-card__waiting">正在整理刚才的观察，选项很快可以使用。</p>}
    <div className="user-choice-card__options">
      {request.options.map((option) => <button key={option.id} className="user-choice-card__option" disabled={busy} onClick={() => onChoose?.(request, { option_id: option.id })}>
        <strong>{option.label}</strong><span>{option.description}</span>
      </button>)}
    </div>
    <form className="user-choice-card__other" onSubmit={(event) => {
      event.preventDefault();
      const answer = other.trim();
      if (!answer || busy) return;
      setOther("");
      onChoose?.(request, { answer });
    }}>
      <input aria-label="其他想法" value={other} disabled={busy} onChange={(event) => setOther(event.target.value)} placeholder="其他想法…" />
      <button type="submit" disabled={busy || !other.trim()}>发送</button>
    </form>
  </section>;
}

function ToolTrace({ steps }: { steps: AgentStep[] }) {
  return <details className="source-trace" aria-label="已保存的真实工具轨迹">
    <summary>真实工具轨迹 · {steps.length}</summary>
    <div className="source-trace__body">
      {steps.map((step, i) => <span key={`${step.label}-${i}`} className="agent-step">{step.label}</span>)}
    </div>
  </details>;
}

function SourceChips({ cards, onOpenCard }: { cards: SourceCard[]; onOpenCard?: (cardId: string) => void }) {
  const groups = {
    evidence: cards.filter((card) => card.kind === "evidence"),
    read: cards.filter((card) => card.kind === "read"),
    retrieved: cards.filter((card) => card.kind === "retrieved"),
    legacy: cards.filter((card) => !card.kind || card.kind === "legacy"),
  };
  const chips = (label: string, sourceCards: SourceCard[], className = "") => sourceCards.length ? (
    <div className={`source-chips__group ${className}`}>
      <span className="source-chips__label">{label}</span>
      {sourceCards.map((card) => <button key={card.id} className="source-chip" title={card.title} onClick={() => onOpenCard?.(card.id)}>
        {card.title}
      </button>)}
    </div>
  ) : null;

  return <div className="source-chips" aria-label="本轮知识卡片使用情况">
    {chips("依据", groups.evidence)}
    {(groups.read.length > 0 || groups.retrieved.length > 0 || groups.legacy.length > 0) && (
      <details className="source-trace">
        <summary>检索轨迹 · {groups.read.length + groups.retrieved.length + groups.legacy.length}</summary>
        <div className="source-trace__body">
          {chips("已读", groups.read, "source-chips__group--trace")}
          {chips("召回候选", groups.retrieved, "source-chips__group--trace")}
          {chips("历史来源", groups.legacy, "source-chips__group--trace")}
        </div>
      </details>
    )}
  </div>;
}
