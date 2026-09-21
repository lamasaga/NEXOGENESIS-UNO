import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretLeft, CaretRight, GearSix, Plus, UploadSimple } from "@phosphor-icons/react";
import type { ConversationSummary, PipelineRunState, PipelineStage, PipelineStatus } from "../api/client";

const WORKFLOWS: Array<{ stage: PipelineStage; label: string; description: string }> = [
  { stage: "compile", label: "编译", description: "原文 → 结构化知识卡片" },
  { stage: "construct", label: "建构", description: "修订知识与联系" },
];

interface Props {
  conversations: ConversationSummary[];
  currentConvId: string | null;
  username: string;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (thread: ConversationSummary, title: string) => Promise<boolean>;
  onDeleteConversation: (thread: ConversationSummary) => Promise<boolean>;
  onTogglePinned: (thread: ConversationSummary) => Promise<boolean>;
  onClearPipelineConversation: (stage: PipelineStage) => Promise<boolean>;
  pipelineThreads: Partial<Record<PipelineStage, ConversationSummary>>;
  pipelineStatus: PipelineStatus;
  pipelineRun: PipelineRunState | null;
  onRunPipeline: (stage: PipelineStage) => void;
  onUploadFiles: (files: FileList) => void;
  uploadBusy?: boolean;
  onOpenSettings: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const [ingestionCollapsed, setIngestionCollapsed] = useState(
    () => window.localStorage.getItem("nexo.sidebar.ingestionCollapsed") === "true"
  );
  const normal = p.conversations.filter((thread) => !thread.task_kind || thread.task_kind === "construct" || thread.uno_job_id);
  const pinned = normal.filter((thread) => thread.pinned);
  const regular = normal.filter((thread) => !thread.pinned);
  const pipelineBusy = p.pipelineRun?.phase === "starting" || p.pipelineRun?.phase === "running";
  const btn = "sidebar-primary-action";
  const toggleIngestion = () => setIngestionCollapsed((collapsed) => {
    const next = !collapsed;
    window.localStorage.setItem("nexo.sidebar.ingestionCollapsed", String(next));
    return next;
  });
  useEffect(() => {
    if (!menuId) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-conversation-menu-root]")) setMenuId(null);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuId(null);
    };
    const closeFromViewportChange = () => setMenuId(null);
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [menuId]);

  const renderConversation = (thread: ConversationSummary) => (
    <div key={thread.id} className="group relative" data-conversation-menu-root={menuId === thread.id ? "" : undefined}>
      <button
        className={`block w-full truncate rounded-md px-2.5 py-1.5 pr-8 text-left text-[12px] transition-[background-color,color] duration-150 ${
          thread.id === p.currentConvId
            ? "bg-sky-400/15 text-sky-100"
            : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
        }`}
        onClick={() => { setMenuId(null); p.onSelectConversation(thread.id); }}
      >
        {thread.pinned && <span className="mr-1.5 text-[9px] text-amber-200/80">◆</span>}
        {thread.title}
      </button>
      <button
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[14px] leading-none transition-[background-color,color,transform,opacity] duration-150 active:scale-95 ${
          menuId === thread.id || thread.id === p.currentConvId
            ? "text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100"
            : "text-zinc-700 opacity-0 group-hover:opacity-100 hover:bg-white/[0.08] hover:text-zinc-100"
        }`}
        title="管理对话"
        aria-label={`管理对话：${thread.title}`}
        aria-haspopup="menu"
        aria-expanded={menuId === thread.id}
        onClick={(event) => {
          event.stopPropagation();
          if (menuId === thread.id) {
            setMenuId(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const menuWidth = 224;
          const menuHeight = 204;
          setMenuAnchor({
            left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
            top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8)),
          });
          setMenuId(thread.id);
        }}
      >
        ⋯
      </button>
      {menuId === thread.id && <ConversationMenu
        thread={thread}
        anchor={menuAnchor}
        onClose={() => setMenuId(null)}
        onRename={p.onRenameConversation}
        onTogglePinned={p.onTogglePinned}
        onDelete={p.onDeleteConversation}
      />}
    </div>
  );

  return (
    <aside className={`sidebar-surface flex w-64 shrink-0 flex-col border-r border-white/[0.06] bg-zinc-950/60${p.collapsed ? " sidebar-surface--collapsed" : ""}`} aria-label={p.collapsed ? "主导航（已收起）" : "主导航"}>
      <div className="sidebar-surface__compact" aria-label="侧栏快捷操作">
        <button type="button" className="sidebar-compact-button sidebar-compact-button--toggle" title="展开左侧面板" aria-label="展开左侧面板" aria-expanded="false" onClick={p.onToggleCollapsed}>
          <CaretRight size={17} weight="bold" aria-hidden />
        </button>
        <div className="sidebar-compact-divider" aria-hidden />
        <button type="button" className="sidebar-compact-button" title="新对话" aria-label="新对话" onClick={p.onNewConversation}>
          <Plus size={18} weight="bold" aria-hidden />
        </button>
        <button type="button" className="sidebar-compact-button" title={p.uploadBusy ? "正在导入材料" : "导入材料"} aria-label={p.uploadBusy ? "正在导入材料" : "导入材料"} disabled={p.uploadBusy} onClick={() => fileRef.current?.click()}>
          <UploadSimple size={18} weight="duotone" aria-hidden />
        </button>
        <div className="sidebar-compact-divider" aria-hidden />
        {WORKFLOWS.map((workflow) => {
          const count=workflow.stage === "compile" ? p.pipelineStatus.inbox : 0;
          const run=p.pipelineRun?.stage === workflow.stage ? p.pipelineRun : null;
          const active=Boolean(run && pipelineBusy);
          return <button type="button" key={workflow.stage} className={`sidebar-compact-button${active ? " is-active" : ""}`} title={`${workflow.label} · ${workflow.description}`} aria-label={count > 0 ? `${workflow.label}，${count} 条材料待编译` : workflow.label} aria-busy={active} onClick={() => p.onRunPipeline(workflow.stage)}>
            <span className="sidebar-compact-glyph" aria-hidden>{workflow.stage === "compile" ? "编" : "构"}</span>
            {active ? <span className="sidebar-compact-live" aria-hidden /> : count > 0 ? <span className="sidebar-compact-badge" aria-label={`${count} 条材料待编译`}>{count > 9 ? "9+" : count}</span> : null}
          </button>;
        })}
        <div className="sidebar-compact-spacer" />
        <button type="button" className="sidebar-compact-button" title="设置" aria-label="设置" onClick={p.onOpenSettings}>
          <GearSix size={18} weight="duotone" aria-hidden />
        </button>
      </div>

      <div className="sidebar-surface__expanded">
      <div className="sidebar-surface__quick-actions">
        <button className={btn} onClick={p.onNewConversation}>
          <span className="sidebar-primary-action__icon" aria-hidden><Plus size={17} weight="bold" /></span> 新对话
        </button>
        <button type="button" className="sidebar-collapse-toggle" title="收起左侧面板" aria-label="收起左侧面板" aria-expanded="true" onClick={p.onToggleCollapsed}>
          <CaretLeft size={15} weight="bold" aria-hidden />
        </button>
        <button className={`${btn} sidebar-primary-action--secondary`} disabled={p.uploadBusy} onClick={() => fileRef.current?.click()}>
          <span className="sidebar-primary-action__icon" aria-hidden><UploadSimple size={17} weight="duotone" /></span> {p.uploadBusy ? "正在导入…" : "导入材料"}
        </button>
      </div>

      <section className="sidebar-surface__section px-3 pb-2">
        <div className="sidebar-surface__section-heading flex items-center justify-between pb-1.5">
          <div className="micro-label">知识工作</div>
          <button
            className="sidebar-surface__section-toggle"
            aria-expanded={!ingestionCollapsed}
            title={ingestionCollapsed ? "展开知识工作" : "收起知识工作"}
            onClick={toggleIngestion}
          >
            {ingestionCollapsed ? <><span>展开</span><CaretRight size={12} weight="bold" aria-hidden /></> : <><span>收起</span><CaretDown size={12} weight="bold" aria-hidden /></>}
          </button>
        </div>
        {ingestionCollapsed ? <div className="sidebar-ingestion-collapsed flex items-center gap-1.5 rounded-md bg-white/[0.025] px-2 py-1.5 text-[10px] text-zinc-600">
          <span className={`h-1.5 w-1.5 rounded-full ${p.pipelineStatus.inbox > 0 ? "bg-amber-200/80" : "bg-zinc-700"}`} />
          {p.pipelineStatus.inbox > 0 ? `${p.pipelineStatus.inbox} 条材料待编译` : "工作流已收起"}
        </div> : <>
          <div className="space-y-1">
            {WORKFLOWS.map((workflow) => {
              const count = workflow.stage === "compile" ? p.pipelineStatus.inbox : null;
              const run = p.pipelineRun?.stage === workflow.stage ? p.pipelineRun : null;
              const waiting = pipelineBusy && !run;
              return <button key={workflow.stage}
                className={`sidebar-workflow group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-[background-color,border-color,transform,opacity] duration-150 active:scale-[0.98] ${run && pipelineBusy ? "border-sky-300/45 bg-sky-300/[0.09] shadow-[0_0_0_1px_rgba(56,189,248,0.08)]" : "border-white/[0.06] bg-zinc-900/55 hover:border-sky-300/25 hover:bg-sky-300/[0.045]"} ${waiting ? "cursor-wait opacity-55" : ""}`}
                aria-busy={Boolean(run && pipelineBusy)}
                onClick={() => p.onRunPipeline(workflow.stage)}>
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] text-sky-200 transition-[background-color,transform] duration-150 ${run && pipelineBusy ? "bg-sky-300/20" : "bg-sky-300/[0.08] group-hover:bg-sky-300/[0.14]"}`}>
                  {run && pipelineBusy ? <span className="pipeline-spinner" aria-label="任务正在运行" /> : "›"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] text-zinc-200">
                    {workflow.label}
                    {run && pipelineBusy && <span className="text-[9px] font-medium text-sky-200">运行中</span>}
                    {run && !pipelineBusy && run.phase !== "failed" && <span className="text-[9px] font-medium text-zinc-400">{run.label}</span>}
                    {run?.phase === "failed" && <span className="text-[9px] font-medium text-amber-100">待处理</span>}
                  </span>
                  <span className={`block truncate text-[10px] ${run && pipelineBusy ? "text-sky-100/70" : run?.phase === "failed" ? "text-amber-100/65" : "text-zinc-600"}`}>
                    {run && pipelineBusy ? run.label : run?.phase === "failed" ? "任务未完成，可重新执行" : workflow.description}
                  </span>
                </span>
                {run && pipelineBusy ? <span className="pipeline-live-dot" aria-hidden /> : count !== null && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${count > 0 ? "bg-amber-200/10 text-amber-100/80" : "bg-white/[0.04] text-zinc-600"}`}>{count}</span>}
              </button>;
            })}
          </div>
        </>}
      </section>

      <div className="sidebar-surface__conversations min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {pinned.length > 0 && <section className="pb-2">
          <div className="micro-label py-1.5">置顶对话</div>
          <div className="space-y-0.5">{pinned.map(renderConversation)}</div>
        </section>}
        <section>
          <div className="micro-label py-1.5">对话</div>
          {regular.length > 0 ? <div className="space-y-0.5">{regular.map(renderConversation)}</div> : (
            <p className="sidebar-empty-conversations px-2.5 py-2 text-[11px] leading-5 text-zinc-600">新建对话，开始围绕知识体思考。</p>
          )}
        </section>
      </div>

      <div className="sidebar-surface__footer flex items-center gap-2 border-t border-white/[0.06] px-3 py-2.5">
        <span className="sidebar-user-avatar flex h-6 w-6 items-center justify-center rounded-full bg-sky-400/15 text-[11px] text-sky-200">{p.username.slice(0, 1).toUpperCase() || "?"}</span>
        <span className="sidebar-user-name min-w-0 flex-1 truncate text-[12px] text-zinc-400">{p.username}</span>
        <button className="sidebar-settings-button text-zinc-500 transition-colors duration-150 hover:text-zinc-200" title="设置" aria-label="设置" onClick={p.onOpenSettings}><GearSix size={18} weight="duotone" aria-hidden /></button>
      </div>
      </div>
      <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => {
        if (event.target.files?.length) p.onUploadFiles(event.target.files);
        event.target.value = "";
      }} />
    </aside>
  );
}

type ConversationMenuMode = "actions" | "rename" | "delete";

function ConversationMenu({ thread, anchor, onClose, onRename, onTogglePinned, onDelete }: {
  thread: ConversationSummary;
  anchor: { left: number; top: number } | null;
  onClose: () => void;
  onRename: (thread: ConversationSummary, title: string) => Promise<boolean>;
  onTogglePinned: (thread: ConversationSummary) => Promise<boolean>;
  onDelete: (thread: ConversationSummary) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<ConversationMenuMode>("actions");
  const [draft, setDraft] = useState(thread.title);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode !== "rename") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [mode]);

  const begin = (nextMode: ConversationMenuMode) => {
    setFailed(false);
    setMode(nextMode);
  };

  const submitRename = async () => {
    const title = draft.trim();
    if (!title || submitting) return;
    setSubmitting(true);
    const succeeded = await onRename(thread, title);
    if (succeeded) onClose();
    else {
      setSubmitting(false);
      setFailed(true);
    }
  };

  const submitPin = async () => {
    if (submitting) return;
    setSubmitting(true);
    const succeeded = await onTogglePinned(thread);
    if (succeeded) onClose();
    else {
      setSubmitting(false);
      setFailed(true);
    }
  };

  const submitDelete = async () => {
    if (submitting) return;
    setSubmitting(true);
    const succeeded = await onDelete(thread);
    if (succeeded) onClose();
    else {
      setSubmitting(false);
      setFailed(true);
    }
  };

  if (!anchor) return null;

  return createPortal(<div
    data-conversation-menu-root=""
    className="fixed z-[80] w-[224px] origin-top-right overflow-hidden rounded-xl border border-white/[0.12] bg-[#303239]/[0.98] shadow-[0_18px_44px_rgba(0,0,0,0.42),0_1px_0_rgba(255,255,255,0.05)_inset] backdrop-blur-xl"
    style={anchor}
    role={mode === "actions" ? "menu" : "dialog"}
    aria-label={mode === "actions" ? `管理对话：${thread.title}` : mode === "rename" ? `重命名对话：${thread.title}` : `删除对话：${thread.title}`}
    onClick={(event) => event.stopPropagation()}
  >
    <div className="border-b border-white/[0.07] px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        {mode !== "actions" && <button
          className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[15px] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100"
          aria-label="返回对话操作"
          onClick={() => begin("actions")}
        >‹</button>}
        <div className="min-w-0">
          <span className="block text-[10px] font-medium tracking-[0.08em] text-zinc-500">{mode === "actions" ? "对话管理" : mode === "rename" ? "修改名称" : "确认删除"}</span>
          <strong className="mt-0.5 block truncate text-[12px] font-medium text-zinc-200">{thread.title}</strong>
        </div>
      </div>
    </div>

    {mode === "actions" ? <div className="p-1.5">
      <ConversationMenuAction icon="rename" label="重命名" onClick={() => begin("rename")} />
      <ConversationMenuAction icon="pin" label={thread.pinned ? "取消置顶" : "置顶对话"} onClick={() => void submitPin()} />
      <div className="mx-2 my-1 h-px bg-white/[0.07]" />
      <ConversationMenuAction icon="delete" label="删除对话" danger onClick={() => begin("delete")} />
      {failed && <p className="px-2.5 pb-1 pt-1 text-[10px] leading-4 text-rose-200">操作没有完成，请稍后重试。</p>}
    </div> : mode === "rename" ? <form className="space-y-2.5 p-3" onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
      <label className="block text-[10px] text-zinc-400" htmlFor={`rename-conversation-${thread.id}`}>新的对话名称</label>
      <input
        ref={inputRef}
        id={`rename-conversation-${thread.id}`}
        className="w-full rounded-lg border border-white/[0.12] bg-black/20 px-2.5 py-2 text-[12px] text-zinc-100 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-600 focus:border-sky-300/45 focus:shadow-[0_0_0_3px_rgba(125,211,252,0.08)]"
        value={draft}
        maxLength={80}
        onChange={(event) => { setDraft(event.target.value); setFailed(false); }}
      />
      {failed && <p className="text-[10px] leading-4 text-rose-200">没有保存成功，请稍后重试。</p>}
      <div className="flex justify-end gap-1.5">
        <button type="button" className="rounded-md px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200" onClick={onClose}>取消</button>
        <button type="submit" disabled={!draft.trim() || submitting} className="rounded-md bg-sky-300/15 px-2.5 py-1.5 text-[11px] font-medium text-sky-100 transition-[background-color,opacity] hover:bg-sky-300/22 disabled:cursor-not-allowed disabled:opacity-40">{submitting ? "保存中…" : "保存"}</button>
      </div>
    </form> : <div className="p-3">
      <p className="text-[11px] leading-5 text-zinc-300">这段对话及其中的全部记录将被永久删除。</p>
      <p className="mt-1 text-[10px] leading-4 text-zinc-500">此操作无法撤销，知识卡片不会受到影响。</p>
      {failed && <p className="mt-2 text-[10px] leading-4 text-rose-200">没有删除成功，对话仍然保留。</p>}
      <div className="mt-3 flex justify-end gap-1.5">
        <button type="button" className="rounded-md px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200" onClick={onClose}>取消</button>
        <button type="button" disabled={submitting} className="rounded-md bg-rose-400/14 px-2.5 py-1.5 text-[11px] font-medium text-rose-100 transition-[background-color,opacity] hover:bg-rose-400/22 disabled:cursor-wait disabled:opacity-55" onClick={() => void submitDelete()}>{submitting ? "删除中…" : "确认删除"}</button>
      </div>
    </div>}
  </div>, document.body);
}

function ConversationMenuAction({ icon, label, danger = false, onClick }: {
  icon: "rename" | "pin" | "delete";
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return <button
    type="button"
    role="menuitem"
    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-[background-color,color,transform] duration-150 active:scale-[0.985] ${danger ? "text-rose-200/90 hover:bg-rose-400/10 hover:text-rose-100" : "text-zinc-200 hover:bg-white/[0.065] hover:text-white"}`}
    onClick={onClick}
  >
    <ConversationActionIcon kind={icon} />
    <span className="min-w-0 text-[12px] font-medium leading-5">{label}</span>
  </button>;
}

function ConversationActionIcon({ kind }: { kind: "rename" | "pin" | "delete" }) {
  if (kind === "rename") return <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.5"><path d="m4 14.5-.5 2 2-.5 9-9-1.5-1.5-9 9Z"/><path d="m11.8 6.7 1.5 1.5"/></svg>;
  if (kind === "pin") return <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.5"><path d="m7 3 6 6-2 1 2 3-1 1-3-2-1 2-6-6 5-5Z"/><path d="m7 13-4 4"/></svg>;
  return <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.5"><path d="M4 6h12M8 3h4l1 3H7l1-3ZM6 6l.7 10h6.6L14 6M8.5 9v4M11.5 9v4"/></svg>;
}
