import { cardTypeLabel } from "./components/cardReading";
import { workSyncErrorMessage } from './conversations/syncError';
import { savedView, rememberConversation, forgetView, pendingStart, completeStart } from './conversations/recovery';
import { ConversationControls } from "./components/ConversationControls";
import { ownedStreamHandlers } from "./conversations/ownership";
import { fetchUnoJob, updateUnoJob } from "./api/client";
import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cards, ClockCounterClockwise, ListChecks, Question, ShareNetwork, Star } from "@phosphor-icons/react";
import { ActivationEngine, type GraphNarration } from "./activation/engine";
import { activationNow } from "./activation/clock";
import {
  createConversation, deleteConversation, deleteConversations, fetchConversationWindow, fetchGraph,
  fetchProjects, fetchReplay, fetchSettings, sendChatStream, sendInteractionResponseStream, simulate, confirmWrite,
  subscribeEvents, uploadInboxInBatches, type InboxUploadProgress, prepareCandidate, ensurePipelineConversation, fetchPipelineStatus, fetchPipelineJob, updateConversation, stopPipelineJob,
  fetchCognitiveSession, cancelChat, resetPipelineConversation,
  controlConversation, steerCognitiveSession, type ThinkingRequest,
  invalidateGraphOverviewCache, createKnowledgeInstance, fetchKnowledgeInstances, registerKnowledgeInstance,
  renameKnowledgeInstance, switchKnowledgeInstance, unregisterKnowledgeInstance,
  type AgentStep, type ChatMessage, type Conversation, type ConversationSummary, type Project, type WriteProposal, type EmergenceCandidate, type SourceCard,
  type PipelineStage, type PipelineStatus, type ConstructRequest,
  type CognitiveInteraction, type PipelineRunState, type CognitiveRunSnapshot,
  type KnowledgeInstanceList,
  fetchWork, answerNativeQuestion, answerCognitiveChoice, controlWork, type WorkItem,
} from "./api/client";
import { workPhaseLabel } from "./components/WorkCenter";
import { CardReader, type ViewedCard } from "./components/CardReader";
import { AgentWorkDock } from "./components/AgentWorkDock";
import { ChatComposer } from "./components/ChatComposer";
import { ChatPanel } from "./components/ChatPanel";
import { ConversationLoadNotice, type ConversationLoadState } from "./components/ConversationLoadNotice";
import type { AppliedChange } from "./components/ConversationStateCard";
import { Sidebar, type ConversationBatchDeleteResult } from "./components/Sidebar";
import { InboxImportStatus } from "./components/InboxImportStatus";
import { canApplyConversationSnapshot, removeConversationFromProjects, updateConversationInProjects } from "./conversations/state";
import { GraphOverview } from "./components/GraphOverview";
import { parseCompileCommand } from '../../packages/nexogenesis-tools/lib/compile-options.js';
import { InstanceManager } from "./components/InstanceManager";
import { EmptyKnowledgeState } from "./components/EmptyKnowledgeState";
import { HelpPopover } from "./components/HelpPopover";
import { GraphCanvas } from "./graph/GraphCanvas";
import type { GraphData, SimEvent } from "./graph/types";
import { applyCognitiveEvent, cognitiveViewFromSnapshot, type CognitiveViewState } from "./cognition/store";
import { projectGraphEffects } from "./cognition/project-graph-effect";
import { graphTopologyDelta, projectWorkNeuralFlow, visibleGraphNodeIds } from "./cognition/project-neural-flow";
import { useUnoUnassignedQueue } from './uno/unassignedQueue';
import { readConversationCache, removeConversationCache, updateConversationCache, writeConversationCache } from './conversations/conversationCache';

const PromptInspector=lazy(()=>import('./components/PromptInspector').then(module=>({default:module.PromptInspector})));
const SettingsModal=lazy(()=>import('./components/SettingsModal').then(module=>({default:module.SettingsModal})));
const UnoKnowledgePanel=lazy(()=>import('./components/UnoKnowledgePanel').then(module=>({default:module.UnoKnowledgePanel})));
const CardBrowser=lazy(()=>import('./components/CardBrowser').then(module=>({default:module.CardBrowser})));

const PIPELINE_LABELS: Record<PipelineStage, string> = {
  compile: "编译",
  theme_compile: "主题编译",
  digest: "消化",
  construct: "建构",
};



const SOURCE_KIND_WEIGHT = { legacy: 0, retrieved: 1, read: 2, evidence: 3 } as const;

function mergeSourceCards(current: SourceCard[] | undefined, incoming: SourceCard[]): SourceCard[] {
  const merged = new Map<string, SourceCard>();
  for (const card of [...(current ?? []), ...incoming]) {
    const previous = merged.get(card.id);
    const previousWeight = SOURCE_KIND_WEIGHT[previous?.kind ?? "legacy"];
    const nextWeight = SOURCE_KIND_WEIGHT[card.kind ?? "legacy"];
    merged.set(card.id, {
      id: card.id,
      title: card.title || previous?.title || card.id,
      kind: nextWeight >= previousWeight ? card.kind : previous?.kind,
    });
  }
  return [...merged.values()];
}

function reconcileChoiceRequest(current: CognitiveInteraction[], sessionId: string, interaction: CognitiveInteraction | null) {
  const remaining = current.filter((item) => item.session_id !== sessionId);
  return interaction?.status === "pending" ? [...remaining, interaction] : remaining;
}

function readStoredCards(key: string, limit?: number): ViewedCard[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(key);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? (limit ? parsed.slice(0, limit) : parsed) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const dataRef = useRef<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCardIds, setOpenCardIds] = useState<string[]>([]);
  const [recentCards, setRecentCards] = useState<ViewedCard[]>([]);
  const [favoriteCards, setFavoriteCards] = useState<ViewedCard[]>([]);
  const [activityTick, setTick] = useState(0);
  const [graphNarration, setGraphNarration] = useState<GraphNarration>({
    phase: "idle", title: "知识图谱", detail: "等待新的问题",
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>({ inbox: 0, scratch: 0 });
  const [pipelineRun, setPipelineRun] = useState<PipelineRunState | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const convIdRef = useRef<string | null>(null);
  const [conversationLoad, setConversationLoad] = useState<ConversationLoadState | null>(null);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const conversationLoadVersion = useRef(0);
  const conversationLoadController = useRef<AbortController | null>(null);
  const olderMessagesController = useRef<AbortController | null>(null);

  useEffect(() => {
    convIdRef.current = conv?.id ?? null;
  }, [conv?.id]);

  const [localMsgs, setLocalMsgs] = useState<ChatMessage[]>([]);
  const [importProgress, setImportProgress] = useState<InboxUploadProgress | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importTarget, setImportTarget] = useState<{id: string; name: string} | null>(null);
  const importLock = useRef(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [backendCompatible,setBackendCompatible]=useState(false);
  const [transitioning,setTransitioning]=useState(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [proposals, setProposals] = useState<WriteProposal[]>([]);
  const [candidates, setCandidates] = useState<EmergenceCandidate[]>([]);
  const [choiceRequests, setChoiceRequests] = useState<CognitiveInteraction[]>([]);
  const [cognition, setCognition] = useState<CognitiveViewState | null>(null);
  const [appliedChange, setAppliedChange] = useState<{ conversationId: string; change: AppliedChange } | null>(null);
  const [railWidth, setRailWidth] = useState(392);
  const [sidebarCollapsed,setSidebarCollapsed]=useState(()=>{
    try{return window.localStorage.getItem("nexo.sidebar.collapsed")==="true";}catch{return false;}
  });
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unoPanel,setUnoPanel]=useState<{mode:"compile"|"construct";id?:string;notes?:string}|null>(null);
  const [inserting, setInserting] = useState(false);
  const [inputNotice, setInputNotice] = useState("");
  const insertLock = useRef(false);
  const inlineInsert = useRef<{ session: string; text: string; id: string; runId: string | null } | null>(null);
  const navigationVersion = useRef(0);
  const [mobileNavigation,setMobileNavigation]=useState(false);
  const transitionLock = useRef(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [cardBrowserOpen, setCardBrowserOpen] = useState(false);
  const [cardBrowserPool,setCardBrowserPool]=useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [username, setUsername] = useState("用户");
  const [knowledgeInstances, setKnowledgeInstances] = useState<KnowledgeInstanceList>({ active_instance_id: null, instances: [] });
  const [switchingInstance, setSwitchingInstance] = useState(false);
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const activeInstanceId = knowledgeInstances.active_instance_id ?? "legacy";
  const refreshConversationWindow = useCallback(async (id: string, options: { signal?: AbortSignal; forceTail?: boolean } = {}) => {
    const cached = readConversationCache(activeInstanceId, id);
    const afterSeq = options.forceTail ? undefined : cached?.history.newest_seq ?? undefined;
    const page = await fetchConversationWindow(id, { afterSeq, signal: options.signal });
    const merged = writeConversationCache(activeInstanceId, page, afterSeq === undefined ? "tail" : "delta");
    if (convIdRef.current === id) startTransition(() => setConv(merged));
    return merged;
  }, [activeInstanceId]);
  const loadOlderMessages = useCallback(async () => {
    const current = conv;
    const beforeSeq = current?.history?.oldest_seq;
    if (!current || beforeSeq === null || beforeSeq === undefined || !current.history?.has_older || olderMessagesLoading) return;
    olderMessagesController.current?.abort();
    const controller = new AbortController();
    olderMessagesController.current = controller;
    setOlderMessagesLoading(true);
    try {
      const page = await fetchConversationWindow(current.id, { beforeSeq, signal: controller.signal });
      const merged = writeConversationCache(activeInstanceId, page, "older");
      if (convIdRef.current === current.id) startTransition(() => setConv(merged));
    } catch (error) {
      if (!controller.signal.aborted && convIdRef.current === current.id) setInputNotice(`更早消息读取失败：${String(error)}`);
    } finally {
      if (olderMessagesController.current === controller) {
        olderMessagesController.current = null;
        setOlderMessagesLoading(false);
      }
    }
  }, [activeInstanceId, conv, olderMessagesLoading]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workError, setWorkError] = useState<string | null>(null);
  const [promptInspectorOpen, setPromptInspectorOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [workStage, setWorkStage] = useState<PipelineStage | null>(null);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [graphFocusMode, setGraphFocusMode] = useState(false);
  const currentWork = workItems.find(item => item.id === conv?.id);
  const waitingCount = workItems.filter(item => item.phase === "waiting_user").length;
  const [workConnected,setWorkConnected]=useState(false);
  const workSyncEpoch=useRef(0);
  const workSyncRequest=useRef<Promise<Awaited<ReturnType<typeof fetchWork>>|null>|null>(null);
  const handleQueuedUnoJob=useCallback((job:Awaited<ReturnType<typeof fetchUnoJob>>)=>{
    setCardBrowserOpen(false);
    setUnoPanel({mode:job.mode,id:job.id});
  },[]);
  const unassignedQueue=useUnoUnassignedQueue({onJob:handleQueuedUnoJob});
  const refreshWork = useCallback(() => {
    if(workSyncRequest.current)return workSyncRequest.current;
    const epoch=workSyncEpoch.current;
    const request=(async()=>{
      try {const result=await fetchWork(AbortSignal.timeout(10000));if(epoch!==workSyncEpoch.current)return null;
        setWorkItems(result.items);setBackendCompatible(result.controls_version===1&&result.start_request_version===1);setWorkConnected(true);setWorkError(null);return result;
      }catch (error) {if(epoch===workSyncEpoch.current){setWorkConnected(false);setWorkError(workSyncErrorMessage(error));}return null;}
    })().finally(()=>{if(workSyncRequest.current===request)workSyncRequest.current=null;});
    workSyncRequest.current=request;return request;
  }, []);
  useEffect(() => {
    let disposed=false,syncing=false,timer:ReturnType<typeof setTimeout>;
    const sync=async()=>{
      if(syncing||disposed)return;syncing=true;
      try{
        const result=await refreshWork();if(!result||disposed)return;
        const selected=result.items.find(item=>item.id===convIdRef.current);
        if(selected){setChoiceRequests(selected.interaction?[selected.interaction]:[]);setProposals(selected.proposals);}
      }catch{/* A history fetch failure does not infer that execution stopped. */}
      finally{syncing=false;if(!disposed){clearTimeout(timer);timer=setTimeout(()=>void sync(),2000);}}
    };
    const wake=()=>void sync();
    const offline=()=>{setWorkConnected(false);setWorkError('连接中断，后台任务未被暂停。重新联网后会自动核对进度。');};
    void sync();window.addEventListener('online',wake);window.addEventListener('focus',wake);window.addEventListener('offline',offline);
    return()=>{disposed=true;clearTimeout(timer);workSyncEpoch.current++;workSyncRequest.current=null;window.removeEventListener('online',wake);window.removeEventListener('focus',wake);window.removeEventListener('offline',offline);};
  }, [activeInstanceId,refreshWork]);

  const refreshProjects = useCallback(() => {
    fetchProjects().then(setProjects).catch(() => { /* 忽略 */ });
  }, []);

  const openCard = useCallback((cardId: string) => {
    setOpenCardIds((current) => [...current.filter((id) => id !== cardId), cardId].slice(-3));
  }, []);

  const closeCard = useCallback((cardId: string) => {
    setOpenCardIds((current) => current.filter((id) => id !== cardId));
  }, []);

  const recordViewedCard = useCallback((card: ViewedCard) => {
    setRecentCards((current) => [card, ...current.filter((item) => item.id !== card.id)].slice(0, 12));
  }, []);

  const toggleFavorite = useCallback((card: ViewedCard) => {
    setFavoriteCards((current) => current.some((item) => item.id === card.id)
      ? current.filter((item) => item.id !== card.id)
      : [card, ...current]);
  }, []);

  const isFavorite = useCallback((cardId: string) => favoriteCards.some((card) => card.id === cardId), [favoriteCards]);

  const changeGraphFocusMode = useCallback((active: boolean) => {
    setGraphFocusMode(active);
    if (!active) return;
    setWorkOpen(false);
    setOverviewOpen(false);
    setCardBrowserOpen(false);
    setSettingsOpen(false);

    setHelpOpen(false);
    setHistoryOpen(false);
    setFavoritesOpen(false);
  }, []);

  useEffect(() => {
    if (!graphFocusMode) return;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openCardIds.length === 0) setGraphFocusMode(false);
    };
    window.addEventListener("keydown", exitOnEscape);
    return () => window.removeEventListener("keydown", exitOnEscape);
  }, [graphFocusMode, openCardIds.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`nexogenesis-recent-cards.${activeInstanceId}`, JSON.stringify(recentCards));
  }, [activeInstanceId, recentCards]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`nexogenesis-favorite-cards.${activeInstanceId}`, JSON.stringify(favoriteCards));
  }, [activeInstanceId, favoriteCards]);

  useEffect(() => {
    setUnoPanel(null);
    setRecentCards(readStoredCards(`nexogenesis-recent-cards.${activeInstanceId}`, 12));
    setFavoriteCards(readStoredCards(`nexogenesis-favorite-cards.${activeInstanceId}`));
  }, [activeInstanceId]);

  const refreshPipelineStatus = useCallback(() => {
    fetchPipelineStatus().then(setPipelineStatus).catch(() => { /* 忽略 */ });
  }, []);

  const loadCognition = useCallback((sessionId: string) => {
    return fetchCognitiveSession(sessionId)
      .then((snapshot: CognitiveRunSnapshot | null) => {
        if (convIdRef.current !== sessionId) return null;
        if (snapshot === null) {
          setCognition(null);
          setChoiceRequests((current) => reconcileChoiceRequest(current, sessionId, null));
          setProposals([]);
          return null;
        }
        setCognition((current) => current?.snapshot.run.run_id === snapshot.run.run_id
          ? { ...current, snapshot }
          : cognitiveViewFromSnapshot(snapshot));
        setChoiceRequests((current) => reconcileChoiceRequest(current, sessionId, snapshot.interaction));
        setProposals(snapshot.pending_proposals ?? []);
        return snapshot;
      })
      .catch(() => setCognition(null));
  }, []);

  useEffect(() => {
    fetchGraph().then(setData).catch((e) => setError(String(e)));
    refreshProjects();
    refreshPipelineStatus();
    fetchKnowledgeInstances().then(setKnowledgeInstances).catch((e) => setInstanceError(String(e)));
    fetchSettings()
      .then((s) => setUsername(s.username))
      .catch(() => { /* 设置不可用时保持默认名 */ });
  }, [refreshPipelineStatus, refreshProjects]);

  const changeKnowledgeInstance = useCallback(async (instanceId: string) => {
    if (!instanceId || instanceId === knowledgeInstances.active_instance_id || switchingInstance) return;
    conversationLoadController.current?.abort(); conversationLoadController.current = null;
    olderMessagesController.current?.abort(); olderMessagesController.current = null; setOlderMessagesLoading(false);
    conversationLoadVersion.current++; setConversationLoad(null);
    setSwitchingInstance(true); setInstanceError(null);
    try {
      await switchKnowledgeInstance(instanceId);
      activeRequestRef.current?.abort(); activeRequestRef.current = null; setSending(false); setWorkItems([]); setWorkOpen(false);
      invalidateGraphOverviewCache();
      const [instances, graph, nextProjects, status] = await Promise.all([fetchKnowledgeInstances(), fetchGraph(), fetchProjects(), fetchPipelineStatus()]);
      setKnowledgeInstances(instances); setData(graph); setProjects(nextProjects); setPipelineStatus(status);
      setConv(null); convIdRef.current = null; setLocalMsgs([]); setSteps([]); setProposals([]); setCandidates([]); setChoiceRequests([]); setCognition(null); setPipelineRun(null); setOpenCardIds([]);
      setGraphNarration({ phase: "idle", title: "知识图谱", detail: "已切换知识实例" });
    } catch (error) { const message = `切换知识实例失败：${String(error)}`; setInstanceError(message); setWorkStage(null); setWorkOpen(true); void refreshWork(); throw new Error(message); }
    finally { setSwitchingInstance(false); }
  }, [knowledgeInstances.active_instance_id, pipelineRun?.phase, sending, switchingInstance]);

  const refreshKnowledgeInstances = useCallback(async () => setKnowledgeInstances(await fetchKnowledgeInstances()), []);
  const createManagedInstance = useCallback(async (name: string) => { await createKnowledgeInstance(name); await refreshKnowledgeInstances(); }, [refreshKnowledgeInstances]);
  const registerManagedInstance = useCallback(async (path: string, name: string) => { await registerKnowledgeInstance(path, name); await refreshKnowledgeInstances(); }, [refreshKnowledgeInstances]);
  const renameManagedInstance = useCallback(async (id: string, name: string) => { await renameKnowledgeInstance(id, name); await refreshKnowledgeInstances(); }, [refreshKnowledgeInstances]);
  const removeManagedInstance = useCallback(async (id: string) => { await unregisterKnowledgeInstance(id); await refreshKnowledgeInstances(); }, [refreshKnowledgeInstances]);

  useEffect(() => {
    const syncJob = () => fetchPipelineJob().then((job) => {
      if (!job || !["running", "waiting_user", "completed", "blocked", "paused", "cancelled", "failed"].includes(job.state)) return;
      setPipelineRun((current) => current?.jobId === job.id ? {
        ...current, phase: job.state, label: job.label, detail: job.detail, pauseRequested: job.pause_requested,
      } : {
        stage: job.stage, phase: job.state, label: job.label,
        detail: job.detail, jobId: job.id, steps: [], startedAt: Date.now(), pauseRequested: job.pause_requested,
      });
    }).catch(() => { /* 后台任务状态不可用时不阻断页面 */ });
    syncJob();
    const timer = window.setInterval(syncJob, 3000);
    return () => window.clearInterval(timer);
  }, []);

  // 写入确认和方向选择会由服务端把结果交回同一 Agent Loop；这段继续运行
  // 不属于最初的 SSE 请求，因此固定线程需要短暂轮询会话，避免界面停在旧结果。
  useEffect(() => {
    if (sending || !conv?.task_kind || !pipelineRun || !["running", "waiting_user", "completed"].includes(pipelineRun.phase)) return;
    let disposed = false;
    const syncFollowUp = async () => {
      try {
        const fresh = await refreshConversationWindow(conv.id);
        // 请求可能在发送之前发出、之后才返回。不能把服务器刚落盘的
        // user/assistant 再拼到本地 SSE 副本前面，也不能覆盖另一会话。
        if (disposed || !canApplyConversationSnapshot(convIdRef.current, fresh.id, activeRequestRef.current !== null)) return;
        setConv((current) => {
          if (!current || current.id !== fresh.id) return current;
          const previousTail = current.messages.at(-1)?.content;
          const freshTail = fresh.messages.at(-1)?.content;
          return current.messages.length === fresh.messages.length && previousTail === freshTail ? current : fresh;
        });
        const cognitive = await fetchCognitiveSession(fresh.id);
        if (!disposed) setCognition((current) => cognitive === null ? null : current?.snapshot.run.run_id === cognitive.run.run_id
          ? { ...current, snapshot: cognitive }
          : cognitiveViewFromSnapshot(cognitive));
        if (!disposed) {
          setChoiceRequests((current) => reconcileChoiceRequest(current, fresh.id, cognitive?.interaction ?? null));
          setProposals(cognitive?.pending_proposals ?? []);
        }
      } catch { /* 后台同步失败不打断当前任务 */ }
    };
    void syncFollowUp();
    if (pipelineRun.phase !== "running") return () => { disposed = true; };
    const timer = window.setInterval(() => void syncFollowUp(), 1200);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [conv?.id, conv?.task_kind, pipelineRun?.phase, refreshConversationWindow, sending]);

  // CognitiveRun 是可恢复事实：SSE 负责即时感，轮询只在任务活跃时补足刷新/断线后的快照。
  useEffect(() => {
    if (!conv?.id) { setCognition(null); return; }
    let disposed = false;
    const sync = () => fetchCognitiveSession(conv.id)
      .then((snapshot) => {
        if (snapshot === null) {
          if (!disposed && convIdRef.current === conv.id) {
            setCognition(null);
            setChoiceRequests((current) => reconcileChoiceRequest(current, conv.id, null));
            setProposals([]);
          }
          return;
        }
        if (!disposed && convIdRef.current === conv.id) setCognition((current) => current?.snapshot.run.run_id === snapshot.run.run_id
          ? { ...current, snapshot }
          : cognitiveViewFromSnapshot(snapshot));
        if (!disposed && convIdRef.current === conv.id) {
          setChoiceRequests((current) => reconcileChoiceRequest(current, conv.id, snapshot.interaction));
          setProposals(snapshot.pending_proposals ?? []);
        }
      })
      .catch(() => { if (!disposed && convIdRef.current === conv.id) setCognition(null); });
    void sync();
    if (!sending && pipelineRun?.phase !== "running") return () => { disposed = true; };
    const timer = window.setInterval(sync, 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [conv?.id, sending, pipelineRun?.phase]);

  // 激活引擎必须跨图数据刷新存活：写入事件常先于新图返回，重建引擎会丢掉
  // created/enriched 动效。拓扑热更新即可，时间与事件状态保持连续。
  const engine = useMemo(() => new ActivationEngine([]), []);

  useEffect(() => {
    dataRef.current = data;
    if (data) engine.updateTopology(data.edges);
  }, [data, engine]);

  useEffect(() => {
    // 截图走查模式（replay）不挂 SSE：常驻挂起的 EventSource 会冻结 headless 虚拟时钟
    if (new URLSearchParams(window.location.search).get("nosse") === "1") return;
    return subscribeEvents(conv?.id ?? null, (ev: SimEvent) => {
      if (ev.type === "work.updated") {
        void refreshWork();
        const payload = {
          ...ev.payload,
          node_ids: visibleGraphNodeIds(ev.payload.node_ids, dataRef.current, activeInstanceId),
        };
        const neural = projectWorkNeuralFlow(payload);
        if (neural && engine.enqueueEvent(neural, activationNow())) {
          setGraphNarration(engine.graphNarration());
          setTick((n) => n + 1);
        }
        return;
      }
      if (ev.type === "graph_changed") {
        void (async () => {
          try {
            const next = await fetchGraph();
            const delta = graphTopologyDelta(dataRef.current, next);
            dataRef.current = next;
            engine.updateTopology(next.edges);
            setData(next);
            const signal: SimEvent = delta.nodeIds.length || delta.edgeIds.length
              ? { type: "topology.changed", ts: Date.now(), payload: { node_ids: delta.nodeIds, edge_ids: delta.edgeIds } }
              : { type: "neural.flow", ts: Date.now(), payload: { kind: "commit", duration: 4, title: "知识图谱已同步", detail: "已确认的知识变化进入当前图谱" } };
            engine.enqueueEvent(signal, activationNow());
            setGraphNarration(engine.graphNarration());
            setTick((n) => n + 1);
            invalidateGraphOverviewCache();
          } catch { /* 图谱刷新失败时保留当前可用画布 */ }
        })();
        return;
      }
      const cognitiveEvent = ev.type === "cognitive.event" ? ev.payload as unknown as import("./api/client").CognitiveEvent : null;
      if (cognitiveEvent?.event_id) {
        setCognition((current) => applyCognitiveEvent(current, cognitiveEvent));
        const changed = engine.enqueueEvents(projectGraphEffects(cognitiveEvent), activationNow());
        if (changed) {
          setGraphNarration(engine.graphNarration());
          setTick((n) => n + 1);
        }
        return;
      }
      if (engine.enqueueEvent(ev, activationNow())) {
        setGraphNarration(engine.graphNarration());
        setTick((n) => n + 1);
      }
    },()=>{void refreshWork();refreshProjects();fetchKnowledgeInstances().then(setKnowledgeInstances).catch(()=>{});invalidateGraphOverviewCache();fetchGraph().then(setData).catch(()=>{});});
  }, [engine, conv?.id, activeInstanceId, refreshWork]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autoplay = params.get("autoplay");
    if (!autoplay) return;
    if (params.get("replay") === "1") {
      // 截图走查：一次性取剧本事件表，本地按 0.35x 压缩调度（不经 SSE）
      let cancelled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      fetchReplay(autoplay).then((events) => {
        if (cancelled) return;
        for (const ev of events) {
          timers.push(setTimeout(() => {
            const now = activationNow();
            engine.enqueueEvent({ type: ev.type, ts: ev.t, payload: ev.payload }, now);
            setGraphNarration(engine.graphNarration());
            setTick((n) => n + 1);
          }, 1500 + ev.t * 350));
        }
      });
      return () => { cancelled = true; timers.forEach(clearTimeout); };
    }
    const batch = params.get("batch") === "1";
    const timer = setTimeout(() => simulate(autoplay, batch), 1500);
    return () => clearTimeout(timer);
  }, [engine]);

  // ---------- 会话操作 ----------

  const pushLocal = useCallback((m: ChatMessage) => {
    setLocalMsgs((list) => [...list, m]);
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    setMobileNavigation(false);
    setInputNotice("");
    conversationLoadController.current?.abort();
    olderMessagesController.current?.abort(); olderMessagesController.current = null; setOlderMessagesLoading(false);
    const controller = new AbortController();
    conversationLoadController.current = controller;
    const version = ++navigationVersion.current;
    const request = ++conversationLoadVersion.current;
    const isCurrent = () => request === conversationLoadVersion.current && version === navigationVersion.current;
    const cached = readConversationCache(activeInstanceId, id);
    const project = projects.find(candidate => candidate.conversations.some(thread => thread.id === id));
    const summary = project?.conversations.find(thread => thread.id === id);
    const immediate: Conversation = cached ?? {
      id,
      project_id: project?.id ?? projects[0]?.id ?? "",
      title: summary?.title ?? "新会话",
      created_at: summary?.updated_at ?? new Date().toISOString(),
      updated_at: summary?.updated_at ?? new Date().toISOString(),
      ...(summary?.pinned ? { pinned: true } : {}),
      ...(summary?.task_kind ? { task_kind: summary.task_kind } : {}),
      ...(summary?.uno_job_id ? { uno_job_id: summary.uno_job_id } : {}),
      messages: [],
    };
    convIdRef.current = id;
    setConv(immediate);
    setUnoPanel(summary?.uno_job_id && summary.task_kind !== "construct" ? { mode: "compile", id: summary.uno_job_id } : null);
    setLocalMsgs([]);
    setSteps([]);
    setProposals([]);
    setCandidates([]);
    setChoiceRequests([]);
    setAppliedChange(null);
    setConversationLoad({ id, pending: true, cached: Boolean(cached) });
    void loadCognition(id);
    const timeout = window.setTimeout(() => controller.abort(new DOMException("对话读取超时", "TimeoutError")), 15000);
    try {
      const loaded = await refreshConversationWindow(id, { signal: controller.signal, forceTail: !cached });
      if (!isCurrent()) return;
      activeRequestRef.current?.abort(); activeRequestRef.current = null; setSending(false);
      setConversationLoad(null);
      convIdRef.current = loaded.id;
      setConv(loaded);
      if(loaded.uno_job_id&&loaded.task_kind!=="construct")setUnoPanel({mode:"compile",id:loaded.uno_job_id});
    } catch (e) {
      if (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError") return;
      if (isCurrent()) setConversationLoad({ id, pending: false, cached: Boolean(cached), error: e });
    } finally {
      window.clearTimeout(timeout);
      if (conversationLoadController.current === controller) conversationLoadController.current = null;
    }
  }, [activeInstanceId, loadCognition, projects, refreshConversationWindow]);

  const restoredView=useRef<string|null>(null);
  useEffect(()=>{
    if(!knowledgeInstances.active_instance_id||!workConnected||restoredView.current===activeInstanceId)return;
    if(convIdRef.current||unoPanel){restoredView.current=activeInstanceId;return;}
    const view=savedView(activeInstanceId);if(!view){restoredView.current=activeInstanceId;return;}
    restoredView.current=activeInstanceId;const version=navigationVersion.current;
    if(view.kind==='conversation'){void selectConversation(view.id);return;}
    void fetchUnoJob(view.id).then(job=>{
      completeStart(activeInstanceId,view.id,job.owner_session_id??job.session_id);
      if(version===navigationVersion.current)void selectConversation(job.owner_session_id??job.session_id);
    }).catch(()=>{
      if(version!==navigationVersion.current)return;
      const pending=pendingStart(activeInstanceId);
      if(pending?.id===view.id)setUnoPanel({mode:pending.input.mode});
      else forgetView(activeInstanceId);
    });
  },[activeInstanceId,knowledgeInstances.active_instance_id,workConnected,selectConversation]);
  useEffect(()=>{if(knowledgeInstances.active_instance_id&&conv?.id)rememberConversation(activeInstanceId,conv.id);},[activeInstanceId,knowledgeInstances.active_instance_id,conv?.id]);

  const newConversation = useCallback(async () => {
    setMobileNavigation(false);
    const version=++navigationVersion.current;
    setConversationLoad(null);
    setUnoPanel(null);


    const defaultProjectId = projects[0]?.id;
    if (!defaultProjectId) {
      pushLocal({ role: "system", content: "对话容器尚未就绪，请稍后重试" });
      return;
    }
    try {
      const created = await createConversation(defaultProjectId, "quick");
      if(version!==navigationVersion.current){refreshProjects();return;}
      activeRequestRef.current?.abort(); activeRequestRef.current = null; setSending(false);
      convIdRef.current = created.id; setInputNotice("");
      refreshProjects();
      setConv(created);
      setLocalMsgs([]);
      setSteps([]);
      setProposals([]);
      setCandidates([]);
      setChoiceRequests([]);
      setCognition(null);
      setAppliedChange(null);
    } catch (e) {
      pushLocal({ role: "system", content: `新建对话失败：${e}` });
    }
  }, [projects, refreshProjects, pushLocal]);

  const renameConversation = useCallback(async (thread: ConversationSummary, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === thread.title) return true;
    try {
      const updated = await updateConversation(thread.id, { title: nextTitle });
      updateConversationCache(activeInstanceId, thread.id, { title: updated.title });
      setProjects((current) => updateConversationInProjects(current, updated));
      if (convIdRef.current === updated.id) setConv((current) => current ? { ...current, title: updated.title } : current);
      return true;
    } catch (e) {
      pushLocal({ role: "system", content: `对话改名失败：${e}` });
      return false;
    }
  }, [activeInstanceId, pushLocal]);

  const toggleConversationPinned = useCallback(async (thread: ConversationSummary) => {
    try {
      const updated = await updateConversation(thread.id, { pinned: !thread.pinned });
      updateConversationCache(activeInstanceId, thread.id, { pinned: updated.pinned });
      setProjects((current) => updateConversationInProjects(current, updated));
      if (convIdRef.current === updated.id) setConv((current) => current ? { ...current, pinned: updated.pinned } : current);
      return true;
    } catch (e) {
      pushLocal({ role: "system", content: `调整对话失败：${e}` });
      return false;
    }
  }, [activeInstanceId, pushLocal]);

  const removeConversation = useCallback(async (thread: ConversationSummary) => {
    try {
      await deleteConversation(thread.id);
      removeConversationCache(activeInstanceId, thread.id);
      setProjects((current) => removeConversationFromProjects(current, thread.id));
      if (convIdRef.current === thread.id) {
        convIdRef.current = null;
        setConv(null);
        setLocalMsgs([]);
        setSteps([]);
        setProposals([]);
        setCandidates([]);
        setChoiceRequests([]);
        setCognition(null);
        setAppliedChange(null);
      }
      return true;
    } catch (e) {
      pushLocal({ role: "system", content: `删除对话失败：${e}` });
      return false;
    }
  }, [activeInstanceId, pushLocal]);

  const removeConversations = useCallback(async (threads: ConversationSummary[]): Promise<ConversationBatchDeleteResult> => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const result = await deleteConversations(threads.map((thread) => thread.id));
    if (result.deletedIds.length > 0) {
      const deletedIds = new Set(result.deletedIds);
      result.deletedIds.forEach((id) => removeConversationCache(activeInstanceId, id));
      setProjects((current) => result.deletedIds.reduce(removeConversationFromProjects, current));
      if (convIdRef.current && deletedIds.has(convIdRef.current)) {
        convIdRef.current = null;
        setConv(null);
        setLocalMsgs([]);
        setSteps([]);
        setProposals([]);
        setCandidates([]);
        setChoiceRequests([]);
        setCognition(null);
        setAppliedChange(null);
      }
    }
    return {
      deletedIds: result.deletedIds,
      failures: result.failures.map((failure) => ({
        ...failure,
        title: byId.get(failure.id)?.title ?? "未命名对话",
      })),
    };
  }, [activeInstanceId]);

  const clearPipelineConversation = useCallback(async (stage: PipelineStage) => {
    try {
      const fresh = await resetPipelineConversation(stage);
      refreshProjects();
      if (conv?.task_kind === stage) {
        convIdRef.current = fresh.id;
        setConv(fresh);
        setLocalMsgs([]);
        setSteps([]);
        setProposals([]);
        setCandidates([]);
        setChoiceRequests([]);
        setCognition(null);
        setAppliedChange(null);
      }
      setPipelineRun((current) => current?.stage === stage ? null : current);
      return true;
    } catch (e) {
      pushLocal({ role: "system", content: `清理${PIPELINE_LABELS[stage]}对话失败：${e}` });
      return false;
    }
  }, [conv?.task_kind, pushLocal, refreshProjects]);

  const send = useCallback(async (text: string, target?: Conversation, pipelineStage?: PipelineStage, interaction?: { id: string; response: { option_id?: string; answer?: string } }, pipelineSources: string[] = [], resumeTask = false, constructRequest?: ConstructRequest, options: { thinkingRequest?: ThinkingRequest; expectedRunId?: string | null } = {}) => {
    const compileCommand=parseCompileCommand(text);
    if(compileCommand&&!interaction){setUnoPanel({mode:'compile',notes:compileCommand.notes});setWorkOpen(false);setGraphFocusMode(false);return true;}
    const activeConv = target ?? conv;
    if (!activeConv) return;
    if(!backendCompatible)return false;
    if (activeRequestRef.current || (!target && currentWork?.executing)) {
      if(interaction||(!activeConv.uno_job_id&&activeConv.thinking_mode==='quick')||currentWork?.discussing)return false;
      const id=activeConv.id;
      if(!inlineInsert.current||inlineInsert.current.session!==id||inlineInsert.current.text!==text)inlineInsert.current={session:id,text,id:crypto.randomUUID(),runId:currentWork?.run_id??null};
      const receipt=inlineInsert.current;
      await steerCognitiveSession(id,text,receipt.id,receipt.runId);
      inlineInsert.current=null;
      if(convIdRef.current===id)setInputNotice('补充要求已保存，将在原工作步骤边界接收。');
      return true;
    }

    const convId = activeConv.id;
    const startCount = activeConv.messages.length;
    const generation=navigationVersion.current;
    const isCurrent=()=>navigationVersion.current===generation&&convIdRef.current===convId;
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setSending(true);
    setSteps([]);
    if (pipelineStage) {
      const label = PIPELINE_LABELS[pipelineStage];
      setPipelineRun((current) => {
        const sameRun = current?.stage === pipelineStage;
        const wasInactive = !sameRun || ["completed", "failed", "blocked", "paused", "cancelled"].includes(current.phase);
        return {
          stage: pipelineStage,
          phase: "running",
          label: wasInactive ? `正在继续${label}任务` : current.label,
          steps: sameRun ? current.steps : [],
          startedAt: wasInactive ? Date.now() : current.startedAt,
          jobId: convId,
        };
      });
    }
    // 乐观追加 user 消息 + 空 assistant 气泡（流式填充）
    const optimisticUserId=crypto.randomUUID(),optimisticAssistantId=crypto.randomUUID();
    setLocalMsgs((list) => [
      ...list,
      { id:optimisticUserId,role:"user",content:text },
      { id:optimisticAssistantId,role:"assistant",content:"" },
    ]);
    const alignFromServer = async () => {
      const fresh = await refreshConversationWindow(convId);
      if (isCurrent()) {
        setConv(fresh);
        // 保留本地系统提示；乐观消息已由服务端落盘
        setLocalMsgs((list) => list.filter((m) => m.role === "system"));
      }
      refreshProjects();
    };
    let delivered = true;
    const showStreamError = (detail: string) => { delivered = false; setLocalMsgs((list) => [
      ...list.filter((message) => !(message.role === "assistant" && message.content === "")),
      { role: "system", content: `模型调用失败：${detail}` },
    ]); };
    let pipelineOutcome: { state: PipelineRunState["phase"]; label: string; detail?: string; jobId?: string } | null = null;
    try {
      const stream = interaction
        ? sendInteractionResponseStream(convId, interaction.id, interaction.response, ownedStreamHandlers(isCurrent, {
          onDelta: (d) => setLocalMsgs((list) => {
            const next = [...list];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + d };
            return next;
          }),
          onDone: () => undefined,
          onError: (detail) => {
            pipelineOutcome = { state: "failed", label: "任务未完成", detail };
            showStreamError(detail);
          },
          onFrameError: (detail) => setLocalMsgs((list) => [...list, { role: "system", content: detail }]),
          onStep: (step) => setSteps((list) => [...list, step]),
          onSources: (sources) => setLocalMsgs((list) => {
            const next = [...list]; const last = next[next.length - 1];
            if (last?.role === "assistant") next[next.length - 1] = { ...last, sources: mergeSourceCards(last.sources, sources) };
            return next;
          }),
          onConfirmRequest: (proposal) => setProposals((list) => [...list, proposal]),
          onCandidateRequest: (items) => setCandidates((list) => [...list, ...items]),
          onChoiceRequest: (request) => setChoiceRequests((list) => [...list.filter((item) => item.interaction_id !== request.interaction_id), request]),
        }), controller.signal)
        : sendChatStream(convId, text, ownedStreamHandlers(isCurrent, {
        onDelta: (d) =>
          setLocalMsgs((list) => {
            const next = [...list];
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = { ...last, content: last.content + d };
            }
            return next;
          }),
        onDone: () => undefined,
        onError: (detail) => {
          pipelineOutcome = { state: "failed", label: "任务未完成", detail };
          showStreamError(detail);
          if (pipelineStage) {
            setPipelineRun((current) => current?.stage === pipelineStage ? {
              ...current, phase: "failed", label: "任务未完成", detail,
            } : current);
          }
        },
        onFrameError: (detail) => setLocalMsgs((list) => [...list, { role: "system", content: detail }]),
        onStep: (step) => {
          setSteps((list) => [...list, step]);
          if (pipelineStage) {
            setPipelineRun((current) => current?.stage === pipelineStage ? {
              ...current,
              phase: "running",
              label: step.label,
              steps: [...current.steps, step.label].slice(-8),
            } : current);
          }
        },
        onIntent: (intent) => setLocalMsgs((list) => {
          const next = [...list], last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, intent };
          return next;
        }),
        onSources: (sources) => setLocalMsgs((list) => {
          const next = [...list];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, sources: mergeSourceCards(last.sources, sources) };
          return next;
        }),
        onConfirmRequest: (proposal) => setProposals((list) => [...list, proposal]),
        onCandidateRequest: (items) => setCandidates((list) => [...list, ...items]),
        onChoiceRequest: (request) => setChoiceRequests((list) => [...list.filter((item) => item.interaction_id !== request.interaction_id), request]),
        onPipelineStatus: (outcome) => {
          pipelineOutcome = outcome;
          if (!pipelineStage) return;
          setPipelineRun((current) => current?.stage === pipelineStage ? {
            ...current,
            phase: outcome.state,
            label: outcome.label,
            detail: outcome.detail,
            jobId: outcome.jobId ?? current.jobId,
          } : current);
        },
      }), controller.signal, { pipelineSources, resumeTask, constructRequest, ...options });
      await stream;
      await alignFromServer();
      if (pipelineStage && pipelineOutcome === null) {
        setPipelineRun((current) => current?.stage === pipelineStage ? {
          ...current, phase: "paused", label: "连接已结束，正在核对任务状态",
        } : current);
      }
    } catch (e) {
      if (controller.signal.aborted) {
        if (isCurrent()) setLocalMsgs((list) => list.filter((message) => !(message.role === "assistant" && message.content === "")));
        return;
      }
      delivered = false;
      // 非流式错误（400/404/网络中断）：服务端若已落盘则以服务端为准
      let aligned = false;
      try {
        const fresh = await refreshConversationWindow(convId);
        if (fresh.messages.length > startCount) {
          if (isCurrent()) {
            setConv(fresh);
            setLocalMsgs((list) => list.filter((m) => m.role === "system"));
          }
          aligned = true;
        }
      } catch { /* 落到下方失败提示 */ }
      if (!aligned && isCurrent()) {
        // 移除空 assistant 占位，保留乐观 user 消息，追加失败提示
        setLocalMsgs((list) =>
          list.filter((m) => !(m.role === "assistant" && m.content === "")));
        pushLocal({ role: "system", content: `发送失败：${e}` });
      }
      if (pipelineStage) {
        const detail = String(e);
        setPipelineRun((current) => current?.stage === pipelineStage ? {
          ...current, phase: "failed", label: "连接或服务异常", detail,
        } : current);
        setGraphNarration({ phase: "judging", title: `${PIPELINE_LABELS[pipelineStage]}未完成`, detail: "连接或服务异常，请重试" });
      }
    } finally {
      if (activeRequestRef.current === controller) { activeRequestRef.current = null; setSending(false); }
      void refreshWork();
      if (activeConv.task_kind) {
        refreshPipelineStatus();
        invalidateGraphOverviewCache();
        fetchGraph().then(setData).catch(() => { /* 任务失败不影响当前图谱 */ });
      }
    }
    return delivered;
  }, [conv, sending, currentWork, backendCompatible, pushLocal, refreshConversationWindow, refreshPipelineStatus, refreshProjects]);

  const interruptConversation = useCallback(async () => {
    if (!conv || (!sending && !currentWork?.executing) || interrupting) return;
    setInterrupting(true);
    activeRequestRef.current?.abort();
    try {
      await cancelChat(conv.id);
      if(convIdRef.current===conv.id)setInputNotice("暂停请求已接收；实际退出以会话状态为准。");
      await refreshWork();
    } catch (e) {
      pushLocal({ role: "system", content: `中断未完成：${e}` });
    } finally {
      setSending(false);
      setInterrupting(false);
    }
  }, [conv, currentWork?.executing, interrupting, pushLocal, sending]);

  const answerChoice = useCallback(async (request: CognitiveInteraction, response: { option_id?: string; answer?: string }) => {
    if (choiceBusy) return;
    setChoiceBusy(true);
    try {
      await answerCognitiveChoice(request.interaction_id, response);
      setChoiceRequests(list => list.filter(item => item.interaction_id !== request.interaction_id));
      await refreshWork();
    } catch (e) { pushLocal({ role: "system", content: `回答未提交，选项仍保留：${String(e)}` }); }
    finally { setChoiceBusy(false); }
  }, [choiceBusy, refreshWork, pushLocal]);

  const startRailResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth;
    const onMove = (move: PointerEvent) => {
      const max = Math.max(360, Math.floor(window.innerWidth * 0.58));
      setRailWidth(Math.min(max, Math.max(320, startWidth + startX - move.clientX)));
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }, [railWidth]);

  const toggleSidebar=useCallback(()=>setSidebarCollapsed(collapsed=>{
    const next=!collapsed;
    try{window.localStorage.setItem("nexo.sidebar.collapsed",String(next));}catch{/* Keep the current-session preference when storage is unavailable. */}
    return next;
  }),[]);

  const runPipeline = useCallback(async (stage: PipelineStage) => {
    navigationVersion.current++;
    setConversationLoad(null);
    if(stage==="digest"){pushLocal({role:"system",content:"历史消化请从原任务继续；新材料统一使用编译入口。"});return;}
    const mode=stage==="construct"?"construct":"compile";
    const existing=workItems.find(item=>item.uno_job_id&&item.stage===mode&&!["completed","cancelled","closed"].includes(item.phase));
    if(existing){await selectConversation(existing.id);return;}
    setUnoPanel({mode:stage==="construct"?"construct":"compile"});setWorkOpen(false);setGraphFocusMode(false);
  },[pushLocal,workItems,selectConversation]);

  const continueWork = async (item: WorkItem) => {
    if (!item.can_continue || !item.stage || transitionLock.current) return;
    if(item.uno_job_id){
      transitionLock.current=true;setTransitioning(true);
      try {const job=await fetchUnoJob(item.uno_job_id);await updateUnoJob(job,'resume');await refreshWork();}
      catch(e){if(convIdRef.current===item.id)setInputNotice(String(e));}
      finally {transitionLock.current=false;setTransitioning(false);}
      return;
    }
    if (item.discussing && item.task_run_id) {
      const result = await controlConversation(item.id, "restore", item.task_run_id);
      if (convIdRef.current === item.id) setInputNotice(result.waiting ? "已返回原建构，请先处理保留的待办。" : "已返回原建构，将沿用原范围和累计用量继续。");
      await refreshWork();
      if (result.waiting) { await selectConversation(item.id); return; }
    }

    activeRequestRef.current?.abort(); activeRequestRef.current = null; setSending(false);
    const thread = await refreshConversationWindow(item.id, { forceTail: true });
    convIdRef.current = thread.id; setConv(thread); setLocalMsgs([]); setSteps([]);
    setWorkOpen(false);
    await send("继续任务", thread, item.stage, undefined, [], true);
  };

  const stopPipeline = useCallback(async (afterWave: boolean) => {
    const jobId = currentWork?.stage ? currentWork.id : pipelineRun?.jobId;
    if (!jobId) return;
    try {
      const control = await stopPipelineJob(jobId, afterWave);
      setPipelineRun((current) => current ? {
        ...current,
        label: afterWave ? "将在当前最小工作单元完成后暂停" : "正在安全停止",
        detail: control.detail,
        pauseRequested: afterWave && control.accepted && control.state !== "paused",
        ...(control.state === "paused" ? { phase: "paused" as const } : {}),
      } : current);
    } catch (e) {
      pushLocal({ role: "system", content: `停止任务失败：${e}` });
    }
  }, [currentWork?.id, currentWork?.stage, pipelineRun?.jobId, pushLocal]);

  const prepareEmergenceCandidate = useCallback(async (candidateId: string) => {
    try {
      const result = await prepareCandidate(candidateId);
      const { proposal_id: proposalId, summary, operations, warnings } = result;
      if (!result.prepared || !proposalId || !summary || !operations) {
        pushLocal({ role: "system", content: `候选未能形成写入提案：${result.detail ?? "请检查候选"}` });
        return;
      }
      setCandidates((list) => list.filter((candidate) => candidate.candidate_id !== candidateId));
      setProposals((list) => [...list, {
        proposal_id: proposalId, summary, operations, warnings,
      }]);
    } catch (e) {
      pushLocal({ role: "system", content: `候选准备失败：${e}` });
    }
  }, [pushLocal]);

  const decideProposal = useCallback(async (proposalId: string, decision: "confirm" | "cancel") => {
    setConfirmingId(proposalId);
    try {
      const result = await confirmWrite(proposalId, decision);
      setProposals((list) => list.filter((p) => p.proposal_id !== proposalId));
      if (conv?.task_kind) {
        setPipelineRun((current) => {
          if (!current || current.stage !== conv.task_kind) return current;
          return { ...current, phase: "running", label: decision === "confirm" ? "已保存调整，正在检查后续影响" : "已保留原状，正在重新判断下一步" };
        });
        refreshPipelineStatus();
      }
      if (result.applied) {
        invalidateGraphOverviewCache();
        setAppliedChange(conv ? { conversationId: conv.id, change: {
          created: result.created ?? [], enriched: result.enriched ?? [],
        } } : null);
        const [graph, fresh] = await Promise.all([
          fetchGraph(), conv ? refreshConversationWindow(conv.id) : Promise.resolve(null),
        ]);
        setData(graph);
        if (fresh && convIdRef.current === fresh.id) {
          setConv(fresh);
          setLocalMsgs((list) => list.filter((m) => m.role === "system"));
        }
        refreshProjects();
        if ((result.outbox_count ?? 0) > 0) {
          pushLocal({ role: "system", content: `专题报告已保存到 OutBox（${result.outbox_count} 份）。` });
        }
      } else if (decision === "confirm") {
        pushLocal({ role: "system", content: `写入未完成：${result.detail ?? "请查看提案"}` });
      }
    } catch (e) {
      pushLocal({ role: "system", content: `提案处理失败：${e}` });
    } finally {
      setConfirmingId(null);
    }
  }, [conv, pushLocal, refreshConversationWindow, refreshPipelineStatus, refreshProjects]);

  const performImport = useCallback(async (files: File[], target: {id: string; name: string}) => {
    if (importLock.current || !files.length) return;
    importLock.current = true; setImportBusy(true); setImportTarget(target);
    try {
      await uploadInboxInBatches(files, target.id, setImportProgress);
    } finally {
      importLock.current = false; setImportBusy(false);
      refreshPipelineStatus();
    }
  }, [refreshPipelineStatus]);
  const upload = useCallback((files: FileList) => {
    const target = knowledgeInstances.instances.find(instance => instance.id === activeInstanceId);
    if (target) void performImport(Array.from(files), {id: target.id, name: target.name});
  }, [knowledgeInstances, activeInstanceId, performImport]);

  const discussWork = async () => {
    if (!currentWork?.task_run_id || transitionLock.current) return;
    const id = currentWork.id;
    transitionLock.current = true;
    setTransitioning(true);
    try {
      const result = await controlConversation(id, "discuss", currentWork.task_run_id);
      if (convIdRef.current === id) setInputNotice(result.ready ? "已进入只读讨论；原建构进度和待办保留。" : "正在暂停建构；等待当前执行停止后进入讨论。");
      await refreshWork();
    } catch (e) { setInputNotice(String(e)); }
    finally { transitionLock.current = false; setTransitioning(false); }
  };

  if (error) return <div className="p-8 text-red-400">加载失败：{error}</div>;
  if (!data) return <div className="p-8 text-zinc-500">加载中…</div>;

  const selectedPipeline: PipelineRunState | null = currentWork?.discussing ? null : currentWork?.stage && !["idle", "history"].includes(currentWork.phase) && !sending
    ? { stage: currentWork.stage, phase: currentWork.phase as PipelineRunState["phase"], label: currentWork.outcome === "ended" ? "已结束" : workPhaseLabel(currentWork.phase), detail: currentWork.detail, jobId: currentWork.id, steps: pipelineRun?.jobId === currentWork.id ? pipelineRun.steps : [], startedAt: pipelineRun?.jobId === currentWork.id ? pipelineRun.startedAt : Date.parse(currentWork.updated_at) }
    : conv?.id === pipelineRun?.jobId ? pipelineRun : null;
  const backgroundUnoWork = workItems.find(item=>item.uno_job_id&&item.stage&&item.outcome!=="ended"&&(item.executing||["starting","queued","running","executing","review","pausing","stopping","waiting_user"].includes(item.phase)));
  const backgroundPanelJob = unoPanel&&backgroundUnoWork?.uno_job_id&&backgroundUnoWork.uno_job_id!==unoPanel.id ? backgroundUnoWork : null;
  const sidebarPipeline: PipelineRunState | null = selectedPipeline ?? (backgroundUnoWork ? {
    stage:backgroundUnoWork.stage!,phase:backgroundUnoWork.phase as PipelineRunState["phase"],label:backgroundUnoWork.id===currentWork?.id?workPhaseLabel(backgroundUnoWork.phase):"另一任务执行中",
    detail:backgroundUnoWork.detail,jobId:backgroundUnoWork.id,steps:[],startedAt:Date.parse(backgroundUnoWork.updated_at),
  } : workItems.some(item=>item.uno_job_id) ? null : pipelineRun);

  const messages = conv ? [...conv.messages, ...localMsgs] : localMsgs;
  const cardTitles = Object.fromEntries(data.nodes.map((node) => [node.id, node.title]));
  const pipelineThreads = Object.fromEntries(
    projects.flatMap((project) => project.conversations)
      .filter((thread) => thread.pinned && thread.task_kind)
      .map((thread) => [thread.task_kind!, thread])
  ) as Partial<Record<PipelineStage, Project["conversations"][number]>>;
  const conversations = projects.flatMap((project) => project.conversations)
    .filter((thread) => !thread.task_kind || thread.task_kind === "construct" || thread.uno_job_id)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

  return (
    <div className={`app-shell${mobileNavigation ? " app-shell--navigation-open" : ""}${graphFocusMode ? " app-shell--graph-focus" : ""}${unoPanel ? " app-shell--construct-setup" : ""}`}>
      {importProgress && importTarget && <InboxImportStatus progress={importProgress} busy={importBusy} libraryName={importTarget.name}
        onRetry={() => void performImport(importProgress.failed.map(item => item.file), importTarget)} onClose={() => setImportProgress(null)} />}

      <header className="app-topbar">
        <button className="mobile-navigation-toggle app-topbar__tool" aria-label="打开会话列表" aria-expanded={mobileNavigation} onClick={()=>setMobileNavigation(open=>!open)}>对话</button>
        <div className="app-brand" aria-label="NEXOGENESIS-UNO">
          <span className="app-brand__mark">N</span>
          <span className="app-brand__name">Nexogenesis UNO</span>
        </div>
        <div className="app-topbar__right">
          <button className="app-topbar__tool" title="最近 30 次模型请求的提示词" aria-haspopup="dialog" onClick={() => setPromptInspectorOpen(true)}><span className="app-topbar__tool-icon" aria-hidden><ListChecks size={17} weight="duotone" /></span>提示词</button>
          {knowledgeInstances.instances.length ? <div className="instance-switcher">
            <select id="knowledge-instance" aria-label="知识实例" value={knowledgeInstances.active_instance_id ?? ""} disabled={switchingInstance || importBusy} onChange={(event) => void changeKnowledgeInstance(event.target.value).catch(() => {})}>
              {knowledgeInstances.instances.map((instance) => <option key={instance.id} value={instance.id}>{instance.name} · {instance.card_count} 卡</option>)}
            </select>
            <InstanceManager value={knowledgeInstances} busy={switchingInstance || importBusy} onSwitch={changeKnowledgeInstance} onCreate={createManagedInstance} onRegister={registerManagedInstance} onRename={renameManagedInstance} onRemove={removeManagedInstance} />
            {instanceError ? <span className="instance-switcher__error" role="status">{instanceError}</span> : null}
          </div> : null}

          <div className="overview-menu">
            <button className="overview-menu__trigger app-topbar__tool" title="图谱概览" aria-label="图谱概览" aria-expanded={overviewOpen} onClick={() => {
              setOverviewOpen((open) => !open);
              setCardBrowserOpen(false);
              setHistoryOpen(false); setHelpOpen(false); setFavoritesOpen(false);
            }}>
              <span className="app-topbar__tool-icon" aria-hidden><ShareNetwork size={17} weight="duotone" /></span> 图谱
            </button>
          </div>
          <div className="card-library-menu">
            <button className="card-library-menu__trigger app-topbar__tool" title="知识卡片" aria-label="知识卡片" aria-expanded={cardBrowserOpen} onClick={() => {
              setCardBrowserPool(false);
              setCardBrowserOpen(true);
              setOverviewOpen(false); setHistoryOpen(false); setHelpOpen(false); setFavoritesOpen(false);
            }}>
              <span className="app-topbar__tool-icon" aria-hidden><Cards size={17} weight="duotone" /></span> 卡片
            </button>
          </div>
          <div className="history-menu">
            <button className="history-menu__trigger app-topbar__tool" title="浏览历史" aria-label="浏览历史" aria-expanded={historyOpen} onClick={() => {
              setHistoryOpen((open) => !open);
              setHelpOpen(false);
              setFavoritesOpen(false);
            }}>
              <span className="app-topbar__tool-icon" aria-hidden><ClockCounterClockwise size={17} weight="duotone" /></span> 历史
            </button>
            {historyOpen && <div className="history-menu__popover">
              <strong>最近查看</strong>
              {recentCards.length ? <div className="history-menu__list">
                {recentCards.map((card) => <button key={card.id} className="history-menu__item" onClick={() => {
                  openCard(card.id);
                  setHistoryOpen(false);
                }}>
                  <span>{card.title}</span><small>{cardTypeLabel(card)}</small>
                </button>)}
              </div> : <p>打开知识卡片后，会在这里保留最近的阅读记录。</p>}
            </div>}
          </div>
          <div className="favorite-menu">
            <button className="favorite-menu__trigger app-topbar__tool" aria-expanded={favoritesOpen} onClick={() => {
              setFavoritesOpen((open) => !open);
              setHistoryOpen(false);
              setHelpOpen(false);
            }}>
              <span className="app-topbar__tool-icon" aria-hidden><Star size={17} weight="duotone" /></span> 收藏
            </button>
            {favoritesOpen && <div className="favorite-menu__popover">
              <strong>我的收藏</strong>
              {favoriteCards.length ? <div className="history-menu__list">
                {favoriteCards.map((card) => <button key={card.id} className="history-menu__item" onClick={() => {
                  openCard(card.id);
                  setFavoritesOpen(false);
                }}>
                  <span>{card.title}</span><small>{cardTypeLabel(card)}</small>
                </button>)}
              </div> : <p>在打开的知识卡片右上角点击收藏，它会出现在这里。</p>}
            </div>}
          </div>
          <div className="help-menu">
            <button className="help-menu__trigger app-topbar__tool" aria-expanded={helpOpen} onClick={() => {
              setHelpOpen((open) => !open);
              setHistoryOpen(false);
              setFavoritesOpen(false);
            }}>
              <span className="app-topbar__tool-icon" aria-hidden><Question size={17} weight="duotone" /></span> 帮助
            </button>
            {helpOpen && <HelpPopover />}
          </div>
        </div>
      </header>
      {promptInspectorOpen&&<Suspense fallback={null}><PromptInspector key={activeInstanceId} libraryName={knowledgeInstances.instances.find(instance=>instance.id===activeInstanceId)?.name??'当前知识库'} onClose={()=>setPromptInspectorOpen(false)}/></Suspense>}
      {!workConnected&&<div className="connection-notice" role="status">{workError??"正在连接后台并核对任务状态…"}</div>}
      <div className="app-workspace">
        {mobileNavigation&&<button className="mobile-navigation-backdrop" aria-label="关闭会话列表" onClick={()=>setMobileNavigation(false)}/>}
        <Sidebar
          conversations={conversations}
          currentConvId={conv?.id ?? null}
          username={username}
          onNewConversation={newConversation}
          onSelectConversation={selectConversation}
          onRenameConversation={renameConversation}
          onDeleteConversation={removeConversation}
          onDeleteConversations={removeConversations}
          onTogglePinned={toggleConversationPinned}
          onClearPipelineConversation={clearPipelineConversation}
          pipelineThreads={pipelineThreads}
          pipelineStatus={pipelineStatus}
          pipelineRun={sidebarPipeline}
          onRunPipeline={stage => { setMobileNavigation(false);void runPipeline(stage); }}
          onUploadFiles={upload}
          uploadBusy={importBusy}
          onOpenSettings={() => setSettingsOpen(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
        />
        <main className="graph-stage">
          <div className="graph-stage__canvas graph-vignette">
            {data.nodes.length === 0
              ? <EmptyKnowledgeState onStartConversation={() => void newConversation()} />
              : <GraphCanvas data={data} engine={engine} viewKey={knowledgeInstances.active_instance_id ?? "legacy"} onNodeClick={openCard} activityTick={activityTick} onNarrationChange={setGraphNarration}
                focusMode={graphFocusMode} onFocusModeChange={changeGraphFocusMode} />}
            <CardReader
              cardIds={openCardIds}
              onClose={closeCard}
              onViewed={recordViewedCard}
              onToggleFavorite={toggleFavorite}
              isFavorite={isFavorite}
            />
          </div>
          <AgentWorkDock
            work={currentWork}
            narration={graphNarration}
            sending={sending}
            pipelineRun={selectedPipeline}
            cognition={cognition}
            choiceRequests={choiceRequests}
            proposals={proposals}
            candidates={candidates}
            queuedCount={0}
            appliedChange={conv && appliedChange?.conversationId === conv.id ? appliedChange.change : null}
            cardTitles={cardTitles}
            steps={steps}
            onOpenCard={openCard}

          />
        </main>
        <aside className="conversation-rail" style={{ width: railWidth }} aria-label="对话记录">
          <div className="conversation-rail__resize-handle" role="separator" aria-label="调整对话栏宽度" aria-orientation="vertical" tabIndex={0}
            onPointerDown={startRailResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setRailWidth((width) => Math.min(Math.floor(window.innerWidth * 0.58), width + 24));
              if (event.key === "ArrowRight") setRailWidth((width) => Math.max(320, width - 24));
            }} />
          {conversationLoad && <ConversationLoadNotice state={conversationLoad} hasCurrentConversation={Boolean(conv)}
            onRetry={() => void selectConversation(conversationLoad.id)}
            onDismiss={() => { conversationLoadVersion.current++; setConversationLoad(null); }} />}
          {unoPanel ? <Suspense fallback={null}><UnoKnowledgePanel available={backendCompatible&&workConnected} key={activeInstanceId} mode={unoPanel.mode} jobId={unoPanel.id} initialNotes={unoPanel.notes} onClose={()=>{setUnoPanel(null);}} onOpenCard={openCard} onOpenUnassigned={()=>{setCardBrowserPool(true);setCardBrowserOpen(true);}} backgroundJob={backgroundPanelJob?{title:backgroundPanelJob.title}:undefined} onOpenBackgroundJob={backgroundPanelJob?()=>void selectConversation(backgroundPanelJob.id).then(()=>setUnoPanel({mode:backgroundPanelJob.stage==='construct'?'construct':'compile',id:backgroundPanelJob.uno_job_id!})):undefined} unassignedQueue={unassignedQueue.queue} onStopUnassignedQueue={unassignedQueue.stopAfterCurrent} onResumeUnassignedQueue={unassignedQueue.resume} onDeferUnassignedQueueItem={unassignedQueue.deferCurrent} onClearUnassignedQueue={unassignedQueue.clear} onChanged={job=>{
            setUnoPanel({mode:job.mode,id:job.id});refreshProjects();refreshPipelineStatus();void refreshWork();fetchGraph().then(setData).catch(()=>{});fetchKnowledgeInstances().then(setKnowledgeInstances).catch(()=>{});
            const sessionId=job.owner_session_id??job.session_id;
            if(convIdRef.current!==sessionId){convIdRef.current=sessionId;setConv({id:sessionId,project_id:projects[0]?.id??"",title:job.title,messages:[],created_at:new Date().toISOString(),updated_at:new Date().toISOString(),task_kind:job.mode,uno_job_id:job.id});setLocalMsgs([]);}
          }}/></Suspense> : <ChatPanel
            conversationId={conv?.id ?? null}
            title={conv?.title ?? null}
            messages={messages}
            hasOlderMessages={conv?.history?.has_older === true}
            loadingOlderMessages={olderMessagesLoading}
            onLoadOlderMessages={() => void loadOlderMessages()}
            sending={sending}
            choiceBusy={choiceBusy}
            work={currentWork}
            onNativeAnswer={async (q, answers) => { await answerNativeQuestion(q, answers); await refreshWork(); }}
            proposals={proposals}
            candidates={candidates}
            choiceRequests={choiceRequests}
            confirmingId={confirmingId}
            pipelineStage={currentWork?.discussing || conv?.task_kind === "construct" ? undefined : conv?.task_kind}
            pipelineHistory={conv?.pipeline_history}
            pipelineRun={selectedPipeline}
            onConfirmProposal={decideProposal}
            onPrepareCandidate={prepareEmergenceCandidate}
            onChoose={answerChoice}
            onOpenCard={openCard}
            cognition={cognition}
          />}
          <section className="conversation-composer" style={unoPanel ? { display: "none" } : undefined} aria-label="知识体对话输入">
            {currentWork?.stage && <ConversationControls work={currentWork} busy={transitioning||!backendCompatible||!workConnected}
              onPause={()=>void controlWork(currentWork.id,'pause',{expected_job_id:currentWork.uno_job_id,expected_run_id:currentWork.run_id}).then(refreshWork).catch(e=>setInputNotice(String(e)))}
              onDiscuss={()=>void discussWork()} onContinue={()=>void continueWork(currentWork).catch(e=>setInputNotice(String(e)))}
              onFinish={()=>{setTransitioning(true);void controlWork(currentWork.id,'finish',{expected_job_id:currentWork.uno_job_id,expected_run_id:currentWork.run_id}).then(refreshWork).catch(e=>setInputNotice(String(e))).finally(()=>setTransitioning(false));}}
              onDetails={()=>setUnoPanel({mode:currentWork.stage==='construct'?'construct':'compile',id:currentWork.uno_job_id})}/>}
            <ChatComposer conversationId={conv?.id} title={!conversationLoad&&backendCompatible&&workConnected?conv?.title??null:null}
              unavailableReason={conversationLoad?'请先完成对话读取，或返回当前对话。':!workConnected?'正在重新同步，后台任务不会因刷新而暂停。':!backendCompatible?'后台需要更新会话控制协议后才能执行。':undefined}
              sending={sending||currentWork?.executing===true} taskConversation={Boolean(currentWork?.stage&&!currentWork.discussing)}
              quickThinking={(!conv?.uno_job_id&&conv?.thinking_mode==='quick')||!!currentWork?.discussing}
              interrupting={interrupting||transitioning} inserting={inserting} notice={inputNotice||workError||undefined}
              onInterrupt={()=>void interruptConversation()}
              onSend={async text=>{
                if (/^\/(construct)\s*$/.test(text)){await runPipeline('construct');return true;}
                if(currentWork?.native_question){setInputNotice('请先回答当前会话中的待答问题。');return false;}
                return send(text);
              }}/>

          </section>
        </aside>
      </div>
      {overviewOpen && <GraphOverview onClose={() => setOverviewOpen(false)} />}
      {cardBrowserOpen && <Suspense fallback={null}><CardBrowser
        initialPoolMode={cardBrowserPool}
        unassignedQueue={unassignedQueue.queue}
        onStartUnassignedQueue={unassignedQueue.start}
        onStopUnassignedQueue={unassignedQueue.stopAfterCurrent}
        onResumeUnassignedQueue={unassignedQueue.resume}
        onDeferUnassignedQueueItem={unassignedQueue.deferCurrent}
        onClearUnassignedQueue={unassignedQueue.clear}
        onOpenFloating={(id) => { openCard(id); setCardBrowserOpen(false); }}
        onOpenJob={(id,mode='construct')=>{setCardBrowserOpen(false);setUnoPanel({mode,id});}}
        onClose={() => setCardBrowserOpen(false)}
        onViewed={recordViewedCard}
        onToggleFavorite={toggleFavorite}
        isFavorite={isFavorite}
      /></Suspense>}
      {settingsOpen&&<Suspense fallback={null}><SettingsModal projectId={conv?.project_id??projects[0]?.id} onClose={()=>setSettingsOpen(false)} onSaved={saved=>setUsername(saved.username)}/></Suspense>}

    </div>
  );
}
