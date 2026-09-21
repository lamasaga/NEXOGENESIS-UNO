import type {UnoJob} from '../api/client';

const relationLabels:Record<string,string>={specialization:'细分',supplement:'补充',contrast:'对照',challenge:'质疑',analogy:'类比',example:'例证',application:'应用'};

export function constructionSettlement(job:UnoJob) {
  const rounds=job.relation_weaving?.rounds??[];
  if(!job.relation_weaving)return null;
  const written=rounds.filter(round=>round.status==='published'||round.published.length>0).length;
  const independent=rounds.filter(round=>round.status==='reviewed-independent').length;
  const noSelection=rounds.filter(round=>round.status==='no-selection').length;
  const deferred=rounds.filter(round=>round.status==='deferred'||round.status==='deferred-exhausted').length;
  const current=job.batch_index;
  const currentSettled=typeof current==='number'&&rounds.some(round=>round.batch_index===current);
  const incomplete=typeof current==='number'&&current<job.batches.length&&!currentSettled&&['failed','paused','ended','partial'].includes(job.status);
  const nextRound=rounds.reduce((max,round)=>Math.max(max,round.round),0)+1;
  return {rounds,written,independent,noSelection,deferred,incomplete,incompleteRound:nextRound,
    incompleteFocus:incomplete?(job.batches[current]?.[0]??null):null,
    reason:job.last_error?.message??(job.status==='ended'?job.closed_from_detail??job.detail:job.detail)};
}

export function ConstructionResults({job,onOpenCard}:{job:UnoJob;onOpenCard:(id:string)=>void}) {
  const outcomes=[...new Map(job.receipts.filter(r=>!r.staged).flatMap(r=>r.construction_outcomes??[]).map(row=>[row.kind+':'+row.id,row])).values()];
  const groups=[{kind:'relation',label:'知识联系'},{kind:'domain',label:'领域归属'},{kind:'card',label:'卡片内容'}];
  const settlement=constructionSettlement(job);
  const workFor=(batch:number)=>job.direct_work?.[String(batch)];
  const decisionFor=(batch:number,id:string,includeUnstaged=false)=>{const work=workFor(batch),source=includeUnstaged?(work?.repair??work?.effective_author??work?.author):(work?.repair_staged?work.repair:work?.effective_author??work?.author);return source?.decisions.find(row=>row.id===id);};
  const incompleteDecision=settlement?.incomplete&&settlement.incompleteFocus?decisionFor(job.batch_index!,settlement.incompleteFocus,true):undefined;
  const incompleteRelations=incompleteDecision?.changes?.relations??[];
  return <section className="construction-results" aria-label="本次建构结算"><h3>{settlement?'本次建构结算':'本次成果'}</h3>
    {settlement&&<>
      <div className="construction-results__settlement" role="status"><strong>已结算 {settlement.rounds.length} 轮</strong><p>{settlement.written} 轮产生正式关系写入{settlement.independent?`；${settlement.independent} 轮比较后未建立关系`:''}{settlement.noSelection?`；${settlement.noSelection} 轮未召回候选且未调用模型`:''}{settlement.deferred?`；${settlement.deferred} 轮明确延期`:''}。</p>
        {settlement.incomplete&&<p className="construction-results__unfinished"><strong>第 {settlement.incompleteRound} 轮未结算，没有写入正式知识。</strong> 前 {settlement.rounds.length} 轮已保存成果不受影响。</p>}
      </div>
      <details className="construction-results__rounds" open={['failed','ended'].includes(job.status)}><summary>逐轮结果 · {settlement.rounds.length+(settlement.incomplete?1:0)} 轮</summary><ol>
        {settlement.rounds.map(round=>{const focus=round.focus_ids[0],result=job.construction_results?.[String(round.batch_index??round.round-1)]?.[focus];return <li key={round.round} className={`construction-results__round construction-results__round--${round.status}`}><div><strong>第 {round.round} 轮 · {round.status==='published'?'已写入关系':round.status==='reviewed-independent'?'比较后未建立关系':round.status==='no-selection'?'未召回候选 · 未调用模型':round.status==='deferred-exhausted'?'两组端点均未通过，保留待办':round.status==='deferred'?'更换端点后继续':'已结算'}</strong><button type="button" onClick={()=>onOpenCard(focus)}>{focus}</button></div>{round.attempt&&round.attempt>1&&<small>本焦点第 {round.attempt} 次有界尝试</small>}{result?.note&&<p>{result.note}</p>}</li>;})}
        {settlement.incomplete&&<li className="construction-results__round construction-results__round--unfinished"><div><strong>第 {settlement.incompleteRound} 轮 · 未写入</strong>{settlement.incompleteFocus&&<button type="button" onClick={()=>onOpenCard(settlement.incompleteFocus!)}>{settlement.incompleteFocus}</button>}</div>
          {!!incompleteRelations.length&&<div className="construction-results__candidate"><small>保留的未发布候选</small>{incompleteRelations.map((relation,index)=><p key={relation.target+index}>{settlement.incompleteFocus} —{relationLabels[relation.type]??relation.type}→ {relation.target}<br/><span>{relation.note}</span></p>)}</div>}
          <p>{settlement.reason}</p></li>}
      </ol></details>
    </>}
    {outcomes.length?<div className="construction-results__groups">{groups.map(group=>{const items=outcomes.filter(row=>row.kind===group.kind);return items.length?<div key={group.kind}><strong>{group.label} <small>涉及 {items.length} 张卡片</small></strong>{items.map(row=><button key={row.id} type="button" onClick={()=>onOpenCard(row.id)}>{row.title}{row.operation==='merge'&&<small> · 合并后的知识对象</small>}</button>)}</div>:null;})}</div>:<p className="uno-work__muted">尚无正式发布的修改。保留原样的检查结论与待办见本次范围记录。</p>}
  </section>;
}
