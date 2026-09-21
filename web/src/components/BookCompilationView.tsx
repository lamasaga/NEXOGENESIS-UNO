import type { ReactNode } from 'react';
import type { UnoJob } from '../api/client';

export function bookCompilationProgress(job:UnoJob) {
  const units=job.book_units??[],outcomes=job.book_outcomes??{};
  const processed=units.filter(unit=>outcomes[unit.ref]?.status==='processed').length;
  const deferred=units.filter(unit=>outcomes[unit.ref]?.status==='deferred').length;
  const quarantined=units.filter(unit=>outcomes[unit.ref]?.status==='quarantined').length;
  return {total:units.length,processed,deferred,quarantined,remaining:units.length-processed-deferred-quarantined};
}

export function bookCanContinue(job:UnoJob) {
  if(job.resume_plan)return ['resume','decision','review'].includes(job.resume_plan.kind);
  if (job.resume_available !== undefined) return job.resume_available;
  const {remaining,deferred}=bookCompilationProgress(job);
  return !['completed','ended'].includes(job.status) && (job.phase!=='done'||remaining>0||deferred>0||!!job.failures?.length);
}

export function bookActiveStatus(job:UnoJob) {
  if(job.status!=='running')return null;
  const active=[...(job.calls??[])].reverse().find(call=>call.status==='running');
  return {
    message:active?`任务仍在继续：${job.detail}。模型请求已发送，正在等待返回。`:`任务仍在继续：${job.detail}`,
    startedAt:active?.started_at??null
  };
}

const cleanBookTitle=(value:string)=>value
  .replace(/^(?:(?:编译|单卡修复|响应恢复)\s*·\s*)+/,'')
  .replace(/\s*\([^()]*(?:z-library|1lib|z-lib)[^()]*\)\.(?:epub|pdf|mobi|azw3?)\s*$/i,'')
  .replace(/\.(?:epub|pdf|mobi|azw3?)\s*$/i,'')
  .trim();

export function bookPanelTitle(job:UnoJob) {
  const raw=job.operation==='isolated-card-repair'?job.title:(job.sources?.length===1&&job.sources[0].title?job.sources[0].title:job.title);
  const title=cleanBookTitle(raw)||'当前材料';
  return `${job.operation==='isolated-card-repair'?'修复结算':'编译结算'} · ${title}`;
}

export function bookWorkingTitle(job:UnoJob) {
  const raw=job.operation==='isolated-card-repair'?job.title:(job.sources?.length===1&&job.sources[0].title?job.sources[0].title:job.title);
  const title=cleanBookTitle(raw)||'当前材料';
  return `${job.operation==='isolated-card-repair'?'单卡修复':'编译'} · ${title}`;
}

export function bookSettlementSummary(job:UnoJob) {
  const progress=bookCompilationProgress(job);
  const repairItems=job.isolation_summary?.open??0;
  const unfinishedUnits=Math.max(0,progress.total-progress.processed);
  const unassignedCards=job.domain_governance?.open_unassigned??job.domain_governance?.unassigned_card_ids?.length??0;
  const pendingProposals=job.domain_governance?.pending_proposals?.length??0;
  const archiveReviews=job.archive_review?.sources.length??0;
  const settled=['done','ended'].includes(job.phase??'')||['completed','ended'].includes(job.status);
  const hasPending=job.status==='partial'||repairItems>0||unfinishedUnits>0||unassignedCards>0||pendingProposals>0||archiveReviews>0;
  const complete=job.status==='completed';
  const headline=complete?'编译完成':hasPending?'已停止，等待处理':job.status==='ended'?'任务已关闭':'本轮已结束';
  let detail='本轮成果已保存。';
  if(repairItems>0)detail=`剩余 ${unfinishedUnits} 个单元，共 ${repairItems} 项待修复。已保存成果安全可用。`;
  else if(unfinishedUnits>0)detail=`剩余 ${unfinishedUnits} 个单元待处理。已保存成果安全可用。`;
  else if(archiveReviews>0)detail='正文单元已经处理，原书仍需完成归档复核。已保存成果安全可用。';
  else if(unassignedCards>0)detail=`知识卡已经保存，仍有 ${unassignedCards} 张卡片待整理领域。`;
  return {...progress,repairItems,unfinishedUnits,unassignedCards,pendingProposals,archiveReviews,settled,hasPending,complete,headline,detail};
}

export function BookCompilationView({job,onOpenCard,actions,onOpenUnassigned,onReviewArchive,archiveReviewBusy=false,compactActive=false}:{job:UnoJob;onOpenCard:(id:string)=>void;actions?:ReactNode;onOpenUnassigned?:()=>void;onReviewArchive?:(source:string)=>void;archiveReviewBusy?:boolean;compactActive?:boolean}) {
  const settlement=bookSettlementSummary(job);
  const {total,processed,deferred,quarantined,remaining,repairItems,unassignedCards,settled}=settlement;
  const savedIds=[...new Set([...(job.touched??[]),...job.receipts.filter(r=>!r.staged).flatMap(r=>r.card_ids??[])])];
  const summary=typeof job.book_overview==='string'?job.book_overview:job.book_overview?.summary;
  const recoveryAt=Date.parse(job.last_recovery?.at??''),failureAt=Date.parse(job.last_failure?.at??'');
  const activeStatus=bookActiveStatus(job),activeAt=Date.parse(activeStatus?.startedAt??'');
  const newerWorkRunning=Boolean(activeStatus?.startedAt&&Number.isFinite(activeAt)&&(!Number.isFinite(recoveryAt)||activeAt>recoveryAt));
  const currentRecovery=!newerWorkRunning&&job.last_recovery&&(!job.last_failure||(Number.isFinite(recoveryAt)&&Number.isFinite(failureAt)&&recoveryAt>=failureAt))?job.last_recovery:null;
  const currentFailure=!newerWorkRunning?job.last_failure:null;
  const scopeLabel=job.operation==='isolated-card-repair'?'本次修复新增':'本次编译已保存';
  const stopReason=currentFailure?.message??currentRecovery?.error??job.resume_blocked_reason??job.closed_from_detail??job.detail;
  const unitRecords=(job.book_units??[]).map(unit=>{
    const outcome=job.book_outcomes?.[unit.ref];
    const current=job.status==='running'&&(job.book_focus_refs??[]).includes(unit.ref);
    return <article key={unit.ref}><strong>{outcome?.status==='processed'?'已处理':outcome?.status==='deferred'?'延期':outcome?.status==='quarantined'?'待修复':current?'正在阅读':'待处理'} · {unit.title}</strong>
      {unit.locator&&<p className="uno-work__muted">{unit.locator}</p>}
      {outcome?.note&&<p>{outcome.note}</p>}
    </article>;
  });
  const activeProgress=<>
    <h3>{job.operation==='isolated-card-repair'?'单项修复进度':'全书阅读进度'}</h3>
    <p>阅读单元：已完成 {processed} 个 · 延期 {deferred} 个 · 隔离待修复 {quarantined} 个 · 未开始 {remaining} 个（共 {total} 个）</p>
    {repairItems>0&&<div className="uno-work__review" role="status"><strong>{repairItems} 项待修复已保留{quarantined>0?` · ${quarantined} 个阅读单元`:''}</strong><p>已保存卡片可以直接使用。你可以现在修复，也可以关闭任务后再从编译修复队列继续。</p>{onOpenUnassigned&&<button type="button" className="uno-work__primary" onClick={onOpenUnassigned}>打开编译修复队列</button>}<details><summary>查看计数说明</summary><p>编译修复队列：{repairItems} 项待修复{quarantined>0?`，来自 ${quarantined} 个隔离阅读单元`:''}。“项”是候选卡片、关系或响应问题数量，不是阅读单元数量；待修复候选不进入普通知识检索，也不计为单元完成。</p></details></div>}
    {!!total&&<progress className="uno-work__progress" aria-label="已处理阅读单元" value={processed} max={total}/>}
    <p className="uno-work__muted">领域组织：正式领域目录 {job.domain_catalog?.length??0} 个 · 未归属领域卡片 {unassignedCards} 张 · 待确认提案 {job.domain_governance?.pending_proposals.length??0} 个 · {job.domain_approval_mode==='automatic'?'本任务允许自动建设领域':'新领域需逐项确认'}。知识卡完成与领域组织分别结算。</p>
    {activeStatus&&<p className="uno-work__live" role="status" aria-live="polite">{activeStatus.message}</p>}
    {currentRecovery?.status==='checking'&&<p className="uno-work__muted">正在检查上一条模型响应的格式；不会重新发送原文。</p>}
    {job.phase!=='done'&&currentRecovery?.status==='recovered'&&<p className="uno-work__muted">已恢复上一条模型响应并通过原检查契约；{currentRecovery.method==='deterministic'?'未增加模型请求':'只发送失败响应与局部契约'}。</p>}
    {currentRecovery?.status==='failed'&&<p className="uno-work__error">上一条模型响应无法安全恢复，任务已保留进度并停止循环重试。</p>}
    {currentFailure&&<p role="alert" className="uno-work__error">{currentFailure.code==='MODEL_EMPTY_RESPONSE'?`模型本次没有返回可解析正文。已处理的 ${processed} 个单元保持不变；继续后只重试当前待处理单元。`:currentFailure.message}</p>}
    {!total&&<p className="uno-work__muted">正在整理全书结构；阅读单元生成后会显示实际进度。</p>}
    {(deferred>0||remaining>0||quarantined>0)&&job.status!=='running'&&<p className="uno-work__error">本次仅完成部分内容。已保存的卡片可以使用，延期、待修复与未处理单元不计为全书完成。</p>}
    {job.status==='partial'&&!bookCanContinue(job)&&<p role="status" className="uno-work__muted">{job.resume_blocked_reason||'本轮可读单元已处理完毕。剩余事项请查看原文提取记录与领域组织待办，不需要重复编译已处理单元。'}</p>}
  </>;
  return <section className={`uno-work__selection${settled?' uno-book-settlement':''}${compactActive&&!settled?' uno-book-active-details':''}`} aria-label={settled?'编译结算':'全书阅读进度'}>
    {settled?<>
      <div className="uno-book-settlement__hero" role="status" aria-live="polite">
        <p className="uno-book-settlement__eyeline">{job.operation==='isolated-card-repair'?'修复任务已停止':'编译任务已停止'}</p>
        <h3>{settlement.headline}</h3>
        {!!total&&<p className="uno-book-settlement__progress-copy"><strong>{processed} / {total}</strong> 个阅读单元已完成</p>}
        <p className="uno-book-settlement__detail">{settlement.detail}</p>
        {!!total&&<div className="uno-book-settlement__meter"><progress aria-label={`已完成 ${processed} 个阅读单元，共 ${total} 个`} value={processed} max={total}/><div><span>已完成 {processed}</span><span>待处理 {settlement.unfinishedUnits}</span></div></div>}
        {actions}
        <dl className="uno-book-settlement__facts" aria-label="结算范围">
          <div><dt>编译修复队列</dt><dd>{repairItems} 项</dd></div>
          <div><dt>未归属领域卡片</dt><dd>{unassignedCards} 张</dd></div>
          <div><dt>{scopeLabel}</dt><dd>{job.operation==='isolated-card-repair'?savedIds.length:processed} {job.operation==='isolated-card-repair'?'张卡片':'个单元'}</dd></div>
        </dl>
      </div>
      {settlement.hasPending&&<details className="uno-book-settlement__disclosure"><summary>为什么停止</summary><div className="uno-book-settlement__disclosure-body"><p>{stopReason||'主线处理已经结束，剩余事项已转入独立待办，不会继续循环重试。'}</p>{currentRecovery?.status==='failed'&&<p>上一条模型响应无法安全恢复，系统已停止自动重试。</p>}<p className="uno-work__muted">已保存成果、原件与检查点保持不变；省略或待修复内容不计为已经核验。</p></div></details>}
    </>:compactActive?<details className="uno-book-settlement__disclosure uno-work__active-details"><summary>进度与记录</summary><div className="uno-book-settlement__disclosure-body">{activeProgress}
      {summary&&<><h4>全书概览</h4><p>{summary}</p></>}
      {!!total&&<><h4>阅读单元与处理记录 · {total} 个</h4><div className="uno-book-settlement__records">{unitRecords}</div></>}
      <h4>{scopeLabel}卡片 · {savedIds.length}</h4>{savedIds.length?<div className="uno-work__saved-cards">{savedIds.map(id=><button type="button" key={id} onClick={()=>onOpenCard(id)}>查看卡片 · {id}</button>)}</div>:<p className="uno-work__muted">目前尚无已保存卡片；阅读进度不等于知识已经保存。</p>}
    </div></details>:activeProgress}
    {!!job.archive_review?.sources.length&&<section className="uno-work__review" aria-label="原书归档复核">
      <h3>原书仍在 Inbox · 等待复核</h3>
      <p>所有可读正文单元已经处理，但提取记录仍有缺口，因此系统没有自动移除 Inbox 原书。请核对下列警告；只有确认未提取内容不需要继续制卡时，才执行归档。</p>
      {job.archive_review.sources.map(source=><article key={source.source}><strong>{source.title}</strong>{source.warnings.length?<ul>{source.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>:<p className="uno-work__muted">没有可展示的提取警告，不能直接复核归档。</p>}
        {onReviewArchive&&source.warnings.length>0&&<button type="button" className="uno-work__primary" disabled={archiveReviewBusy} onClick={()=>onReviewArchive(source.source)}>我已核对缺口，归档原书</button>}
      </article>)}
    </section>}
    {!settled&&actions}
    {settled?<details className="uno-book-settlement__disclosure"><summary>进度与记录</summary><div className="uno-book-settlement__disclosure-body">
      <p className="uno-work__muted">阅读单元：已完成 {processed} 个 · 延期 {deferred} 个 · 待修复 {quarantined} 个 · 未开始 {remaining} 个（共 {total} 个）</p>
      <p className="uno-work__muted">领域组织：正式领域目录 {job.domain_catalog?.length??0} 个 · 未归属领域卡片 {unassignedCards} 张 · 待确认提案 {job.domain_governance?.pending_proposals.length??0} 个。</p>
      {summary&&<><h4>全书概览</h4><p>{summary}</p></>}
      {!!total&&<><h4>阅读单元与处理记录 · {total} 个</h4><div className="uno-book-settlement__records">{unitRecords}</div></>}
      <h4>{scopeLabel}卡片 · {savedIds.length}</h4>{savedIds.length?<div className="uno-work__saved-cards">{savedIds.map(id=><button type="button" key={id} onClick={()=>onOpenCard(id)}>查看卡片 · {id}</button>)}</div>:<p className="uno-work__muted">当前范围没有新增卡片；这不影响原任务中已保存成果继续使用。</p>}
    </div></details>:compactActive?null:<>
      {summary&&<details><summary>全书概览</summary><p>{summary}</p></details>}
      {!!total&&<details open={job.status!=='running'}><summary>阅读单元与处理记录 · {total} 个</summary>{unitRecords}</details>}
      {savedIds.length?<details open={savedIds.length<=12}><summary>已保存卡片 · {savedIds.length}</summary><div className="uno-work__saved-cards">{savedIds.map(id=><button type="button" key={id} onClick={()=>onOpenCard(id)}>查看卡片 · {id}</button>)}</div></details>:<><h3>已保存卡片 · 0</h3><p className="uno-work__muted">目前尚无已保存卡片；阅读进度不等于知识已经保存。</p></>}
    </>}
  </section>;
}
