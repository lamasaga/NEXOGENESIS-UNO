import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NativeAnswer, NativeQuestion, PipelineStage, WorkItem } from "../api/client";
import { presentWorkItem } from "./workPresentation";

const names: Record<string, string> = { running: "执行中", waiting_user: "等待你处理", paused: "已暂停", failed: "执行失败", blocked: "需要处理", cancelled: "已停止", completed: "已完成", idle: "尚未开始", history: "历史记录" };
const stages = { compile: "编译", theme_compile: "主题编译", digest: "消化", construct: "建构" };
export function workPhaseLabel(phase: string) { return phase === "closed" ? "本轮已结束" : names[phase] ?? "状态待核对"; }

export function NativeQuestionForm({ question, onAnswer }: { question: NativeQuestion; onAnswer: (q: NativeQuestion, answers: NativeAnswer[]) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, NativeAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="native-question" aria-label="等待你的选择" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    try { await onAnswer(question, question.questions.map(q => answers[q.id] ?? { id: q.id, selected: [] })); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }}>
    <div className="native-question__heading">等待你的选择</div>
    {!question.live && <p>原执行已中断，问题仍保留。提交回答后会从原对话继续。</p>}
    {question.questions.map(q => {
      const answer = answers[q.id] ?? { id: q.id, selected: [] };
      return <fieldset key={q.id} disabled={busy}>
        <legend>{q.question}</legend>
        {q.options?.map(option => <label key={option.label} className="native-question__option">
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`${question.rpc_id}-${q.id}`} checked={answer.selected.includes(option.label)} onChange={() => setAnswers(old => ({ ...old, [q.id]: { ...answer, selected: q.multiSelect ? answer.selected.includes(option.label) ? answer.selected.filter(v => v !== option.label) : [...answer.selected, option.label] : [option.label] } }))} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
        <label className="native-question__custom">补充或直接填写回答<textarea value={answer.custom ?? ""} rows={2} onChange={e => setAnswers(old => ({ ...old, [q.id]: { ...answer, custom: e.target.value } }))} /></label>
      </fieldset>;
    })}
    {error && <p role="alert">{error}</p>}
    <button className="proposal-button proposal-button--confirm" disabled={busy || question.questions.some(q => !answers[q.id]?.selected.length && !answers[q.id]?.custom?.trim())}>{busy ? "正在提交…" : "提交回答并继续"}</button>
  </form>;
}

export function WorkCenter({ items, stage, error, onClose, onOpen, onContinue, onNew, onControl }: {
  items: WorkItem[]; stage: PipelineStage | null; error: string | null;
  onClose: () => void; onOpen: (id: string) => void; onContinue: (item: WorkItem) => Promise<void>;
  onNew: (stage: PipelineStage) => void; onControl: (id: string, action: "pause" | "stop") => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prior?.focus();
  }, []);
  const rows = stage ? items.filter(i => i.stage === stage) : items;
  const act = async (id: string, fn: () => Promise<void>) => { setBusy(id); setActionError(""); try { await fn(); } catch (e) { setActionError(String(e)); } finally { setBusy(null); } };
  return createPortal(<div className="work-center-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={stage ? `${stages[stage]}任务` : "任务与待办"} tabIndex={-1} className="work-center" onKeyDown={e => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
        const first = nodes[0], last = nodes.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><h2>{stage ? `${stages[stage]}任务` : "任务与待办"}</h2><p>新任务独立开始；继续会保留原任务范围与进度。</p></div><button onClick={onClose} aria-label="关闭任务与待办">关闭</button></header>
      {stage && <button className="work-center__new" onClick={() => onNew(stage)}>＋ 新建{stages[stage]}任务</button>}
      {(error || actionError) && <p role="alert">{actionError || error}</p>}
      <div className="work-center__list">
        {!rows.length && <p>当前没有{stage ? stages[stage] : ""}任务记录。</p>}
        {rows.map(item => {
          const presentation = presentWorkItem(item);
          return <article key={item.id} className={`work-center__item is-${presentation.kind}`}>
            <div className="work-center__row"><strong>{item.title}</strong><span>{presentation.label}</span></div>
            {item.goal && <p>{item.goal}</p>}
            <p className="work-center__detail">{presentation.detail}</p>
            {presentation.technicalDetail && <details className="work-center__technical">
              <summary>查看停止记录</summary><p>{presentation.technicalDetail}</p>
            </details>}
            <div className="work-center__actions">
              <button onClick={() => onOpen(item.id)}>{presentation.openLabel}</button>
              {item.can_continue && <button disabled={busy !== null} onClick={() => void act(item.id, () => onContinue(item))}>继续此任务</button>}
              {item.executing && <button disabled={busy !== null} onClick={() => void act(item.id, () => onControl(item.id, "pause"))}>暂停并保留</button>}
              {(item.executing || item.phase === "waiting_user" || item.can_continue) && <button disabled={busy !== null} onClick={() => void act(item.id, () => onControl(item.id, "stop"))}>停止此任务</button>}
              {busy === item.id && <span role="status">正在处理…</span>}
            </div>
          </article>;
        })}
      </div>
    </div>
  </div>, document.body);
}
