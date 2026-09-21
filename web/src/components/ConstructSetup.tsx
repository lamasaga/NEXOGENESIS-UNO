import { useEffect, useRef, useState } from "react";
import { fetchConstructPreparation, type ConstructPreparation, type ConstructRequest } from "../api/client";
import { CONSTRUCT_GOALS, CONSTRUCT_WORKLOADS } from "../../../packages/nexogenesis-tools/lib/construct-options.js";
import "./ConstructSetup.css";

interface Props { initialCardId?: string; onCancel: () => void; onStart: (request: ConstructRequest) => Promise<void>; }

const GOAL_HINTS: Record<ConstructRequest["goal"], string> = {
  connect: "寻找有依据的联系，保留合理独立。",
  decentralize: "减少不必要的枢纽依赖，保留真实聚合。",
  organize: "比较重复与混杂，判断精修、合并或拆分。",
  relations: "核对关系依据、方向、分歧与适用条件。",
  domains: "调整领域归属与入口，让知识更易发现。",
  recommend: "结合结构与正文，选择最值得改善的问题。",
};

/** Two short choices, with preparation isolated from conversation and knowledge writes. */
export function ConstructSetup({ initialCardId, onCancel, onStart }: Props) {
  const [preparation, setPreparation] = useState<ConstructPreparation | null>(null);
  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState<ConstructRequest["goal"]>("recommend");
  const [scopeKind, setScopeKind] = useState<ConstructRequest["scope"]["kind"]>(initialCardId ? "neighborhood" : "instance");
  const [scopeId, setScopeId] = useState(initialCardId ?? "");
  const [workload, setWorkload] = useState<ConstructRequest["workload"]>("group");
  const [changes, setChanges] = useState<ConstructRequest["changes"]>("organization");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const startLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => { if (error) errorNotice.current?.focus(); }, [error]);
  useEffect(() => {
    const controller = new AbortController();
    setError(""); setPreparation(null);
    fetchConstructPreparation(controller.signal).then(result => {
      if (!controller.signal.aborted) setPreparation(result);
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, [attempt]);
  const options = scopeKind === "domain" ? preparation?.domains ?? [] : preparation?.cards ?? [];
  const selected = preparation?.cards.find(card => card.id === scopeId);
  const count = scopeKind === "instance" ? preparation?.cards.length ?? 0 : scopeKind === "domain"
    ? preparation?.cards.filter(card => card.id === scopeId || card.domains.includes(scopeId)).length ?? 0
    : selected ? selected.neighbors.length + 1 : 0;
  const valid = Boolean(preparation && count && (scopeKind === "instance" || options.some(option => option.id === scopeId)));
  const scopeLabel = scopeKind === "instance" ? "当前知识体" : options.find(option => option.id === scopeId)?.title ?? "尚未选择范围";

  return <section className="construct-setup" aria-label="准备建构" aria-busy={busy}>
    <header>
      <h2 ref={heading} tabIndex={-1}>建构 <span className="construct-setup__progress">{step}/2 · {step === 1 ? "选择目标" : "范围与工作量"}</span></h2>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </header>
    {step === 1 && <><p className="construct-setup__muted">准备阶段仅预检，不运行模型或修改知识。</p>
    <div className="construct-setup__diagnosis" role="status">
      {preparation ? <details><summary>预检：{preparation.summary.cards} 张卡 · {preparation.summary.isolated} 张孤立 · {preparation.summary.concentrated} 处集中</summary><small>这里只统计知识卡；领域目录单独维护。孤立指没有卡间关系，集中指超过 50 张卡只连接同一枢纽。计数只是线索，是否修改需阅读内容判断。</small></details> : error ? "结构预检未完成。" : "正在预检知识结构…"}
    </div></>}
    {error && <div ref={errorNotice} tabIndex={-1} role="alert" className="construct-setup__error">{error}<button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新预检</button></div>}
    <form onSubmit={async event => {
      event.preventDefault();
      if (step === 1) { setStep(2); return; }
      if (!valid || !preparation || startLock.current) return;
      startLock.current = true; setBusy(true); setError("");
      try {
        await onStart({ snapshot: preparation.snapshot, goal, workload, changes, notes, scope: { kind: scopeKind, ...(scopeKind !== "instance" ? { id: scopeId } : {}) } });
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { startLock.current = false; setBusy(false); }
    }}>
      <fieldset disabled={busy}>
        {step === 1 ? <>
          <legend className="construct-setup__sr">建构目标</legend>
          <div className="construct-setup__options">{CONSTRUCT_GOALS.map(option => <label key={option.id} className="construct-setup__option" title={option.description}>
            <input type="radio" name="construct-goal" checked={goal === option.id} onChange={() => setGoal(option.id)} />
            <span><strong>{option.label}</strong><small>{GOAL_HINTS[option.id]}</small></span>
          </label>)}</div>
          <details className="construct-setup__notes"><summary>补充想法{notes ? "（已填写）" : ""}</summary>
            <label className="construct-setup__field"><span className="construct-setup__sr">补充想法</span><textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} placeholder="从联系、结构与理解出发：哪里缺少联系或难以理解？希望改善什么、保留什么？" /></label>
          </details>
        </> : <>
          <legend className="construct-setup__sr">范围与工作量</legend>
          <label className="construct-setup__field">本轮范围<select value={scopeKind} onChange={event => {
            const kind = event.target.value as typeof scopeKind;
            setScopeKind(kind); setScopeId(kind === "domain" ? preparation?.domains[0]?.id ?? "" : initialCardId ?? preparation?.cards[0]?.id ?? "");
          }}><option value="instance">当前知识体</option><option value="domain" disabled={!preparation?.domains.length}>一个领域</option><option value="neighborhood" disabled={!preparation?.cards.length}>一张卡片及一跳邻域</option></select></label>
          {scopeKind !== "instance" && <label className="construct-setup__field">{scopeKind === "domain" ? "选择领域" : "选择起点卡片"}<select value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="" disabled>请选择</option>{options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}</select></label>}
          <p className="construct-setup__muted">包含 {count} 张卡；启动时固定范围，范围外只读。</p>
          <div className="construct-setup__options" role="group" aria-label="工作量">{CONSTRUCT_WORKLOADS.map(option => <label key={option.id} className="construct-setup__option">
            <input type="radio" name="construct-workload" checked={workload === option.id} onChange={() => setWorkload(option.id)} /><span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}</div>
          {workload !== "advice" && <label className="construct-setup__field">允许的调整<select value={changes} onChange={event => setChanges(event.target.value as typeof changes)}><option value="organization">内容、关系与领域组织</option><option value="relations">仅调整关系</option></select></label>}
          <div className="construct-setup__summary"><strong>{CONSTRUCT_GOALS.find(option => option.id === goal)?.label}</strong><p>{scopeLabel} · {count} 张卡 · {CONSTRUCT_WORKLOADS.find(option => option.id === workload)?.label}</p><small>{workload === "advice" ? "后台强制不写知识；完成后给出可执行建议。" : preparation?.authority === "trusted" ? "沿用设置中的完全信任授权，在以上范围内执行。每组修改仍须校验和复核。" : "沿用当前授权设置；需要确认的修改会在对话中等你批准。"}</small></div>
        </>}
      </fieldset>
      <footer>{step === 2 && <button type="button" disabled={busy} onClick={() => setStep(1)}>返回修改目标</button>}<button className="construct-setup__primary" disabled={busy || (step === 1 ? !preparation?.cards.length : !valid)} type="submit">{busy ? "正在创建任务…" : step === 1 ? "下一步" : workload === "advice" ? "开始诊断" : "开始建构"}</button></footer>
    </form>
  </section>;
}
