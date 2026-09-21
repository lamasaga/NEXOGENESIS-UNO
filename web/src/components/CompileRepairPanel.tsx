import {useRef,useState} from 'react';
import {repairUnoCandidate,type UnoRepairDetail} from '../api/client';
import {CardMarkdown} from './CardReader';

export function repairItemGuidance(item:UnoRepairDetail){
  const previous=item.last_repair?.reason??'';
  if(/新增或改变关系前须读回目标卡当前完整正文|修改旧卡前须读回当前完整正文/u.test(previous))return {
    title:'系统可以自动补齐最新依据',
    detail:'上次处理在写入前发现关联卡片已经变化，因此安全停止。再次处理时会先读取目标卡的最新完整正文，再重新核对当前候选；不需要你反复尝试或自行分析技术错误。',
    action:'读取最新依据并处理'
  };
  return {
    title:'建议先让系统重新诊断',
    detail:'系统会根据当前候选、旧问题和完整关系端点形成具体修改方案，再自动修复和复核。若仍不能通过，本项会继续保留，不会循环写入。',
    action:item.repair_kind==='relation'?'分析并修复关系':item.repair_kind==='card'?'分析并修复此卡':item.repair_kind==='coverage'?'核验本单元遗漏':!item.raw_response?'重新请求此单元候选':'恢复此响应并审核'
  };
}

export function CompileRepairPanel({item,libraryId,onOpenJob,onRefresh,onLater}:{item:UnoRepairDetail;libraryId:string;onOpenJob?:(id:string,mode?:'compile'|'construct')=>void;onRefresh:()=>Promise<unknown>;onLater?:()=>void}){
  const [notes,setNotes]=useState(''),[responseJson,setResponseJson]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const requestId=useRef<string|null>(null);
  const hasActive=item.active_repair_job&&['running','paused','review'].includes(item.repair_status??'');
  const guidance=repairItemGuidance(item);
  const start=async()=>{
    setBusy(true);setNotice('');requestId.current??=globalThis.crypto.randomUUID();
    try{const job=await repairUnoCandidate(item,libraryId,notes,responseJson,requestId.current);setNotice('修复任务已创建，候选通过审核后才会保存。');await onRefresh();onOpenJob?.(job.id,job.mode);}
    catch(error){setNotice(String(error));}finally{setBusy(false);}
  };
  return <section className="card-browser__repair" aria-label="待修复候选">
    <header className="card-browser__reader-head"><div><span>{item.repair_kind==='relation'?'关系待修复 · 正文已保存':'待修复 · 尚未发布'}</span><h3>{item.title}</h3></div></header>
    <div className="card-browser__repair-guidance"><strong>{guidance.title}</strong><p>{guidance.detail}</p><small>{item.repair_kind==='relation'?'卡片正文仍然可用；只有关系通过核验后才会更新。':'候选、原始响应和已保存成果都已保留。'}</small></div>
    <section className="card-browser__management" aria-label="候选问题与修复">
      <strong>选择处理方式</strong>
      <p>推荐直接交给系统处理。你也可以先保留本项，稍后再回来；不会影响已经完成的卡片和其他编译结果。</p>
      <details><summary>我想补充必须保留的边界（可选）</summary><label>补充说明<textarea aria-label="可选补充说明" maxLength={6000} rows={4} value={notes} disabled={busy||Boolean(hasActive)} onChange={event=>{setNotes(event.target.value);requestId.current=null;}} placeholder="例如必须保留的内容、不能改变的边界或简短证据；无需分析如何修复。"/></label></details>
      {item.repair_kind==='response'&&<details><summary>查看并校正候选 JSON</summary>
        <p>无法辨认卡片边界的响应保留在这里。可填写校正后的完整 JSON；提交后仍需审核，不会直接写入。</p>
        <textarea aria-label="校正候选 JSON" rows={10} maxLength={120000} value={responseJson} disabled={busy||Boolean(hasActive)} onChange={event=>{setResponseJson(event.target.value);requestId.current=null;}} placeholder='{"cards":[…],"note":"覆盖说明"}'/>
        <details><summary>原始响应</summary><pre>{item.raw_response||'原始响应为空，未生成可恢复内容。'}</pre></details>
      </details>}
      {notice&&<p role="status">{notice}</p>}
      <div className="card-browser__management-actions">
        {hasActive?<button type="button" className="is-primary" onClick={()=>onOpenJob?.(item.active_repair_job!,'compile')}>查看系统处理方案</button>
          :<button type="button" className="is-primary" disabled={busy} onClick={()=>void start()}>{busy?'正在创建处理任务…':!responseJson.trim()&&item.response_truncated?'续写此单元候选':guidance.action}</button>}
        {onLater&&<button type="button" disabled={busy} onClick={onLater}>稍后处理</button>}
      </div>
      <details><summary>查看问题记录与处理状态</summary><p>此前记录可能不完整或已经过期，系统会以当前版本重新诊断。</p><ul>{(item.issues?.length?item.issues:[item.reason]).map((issue,index)=><li key={index}>{issue}</li>)}</ul>{item.last_repair&&<p>上次处理：{item.last_repair.reason}</p>}<div className="card-browser__management-actions"><button type="button" disabled={busy} onClick={()=>void onRefresh().catch(error=>setNotice(String(error)))}>刷新状态</button>{item.job_id&&<button type="button" onClick={()=>onOpenJob?.(item.job_id!,'compile')}>查看原编译任务</button>}</div></details>
      <small>单项处理有明确请求上限；未通过的内容继续保留，不会重编已完成单元。</small>
    </section>
    {item.body?<div className="card-browser__body"><CardMarkdown body={item.body}/></div>:<p>本项尚无可独立阅读的完整候选正文。</p>}
    <details><summary>原文定位</summary>{item.sources.map(ref=><p key={ref}><code>{ref}</code></p>)}</details>
  </section>;
}
