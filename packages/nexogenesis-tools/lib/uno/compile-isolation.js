import { existsSync, readdirSync } from 'node:fs';
import { readCompileJob } from './state.js';
import { sha, unoPath } from '../harness/uno-storage.js';
import { BOOK_WORKFLOW } from './book-sources.js';

export const COMPILE_ISOLATION = 'compile-isolation-v1';
export const isolationEnabled = job => job.workflow === BOOK_WORKFLOW && job.compile_isolation === COMPILE_ISOLATION;
export const isolationOpen = work => Object.entries(work?.isolation?.items ?? {}).filter(([, item]) => item.status === 'open');
export const isolatedCardIds = work => new Set(isolationOpen(work).map(([, item]) => item.card_id).filter(Boolean));
export const candidateHash = card => { const {revision, ...content} = card; return sha(JSON.stringify(content)); };
const localCodes = new Set(['INVALID_GENERATION_RESPONSE','INVALID_REVIEW_RESPONSE','INVALID_REPAIR_RESPONSE','INVALID_COLLISION_DECISION',
  'UNIT_CARD_REPAIR_EXHAUSTED','UNIT_COVERAGE_BLOCKED','UNIT_REVIEW_SCOPE_VIOLATION','UNIT_REPAIR_SCOPE_VIOLATION','UNIT_CONTINUATION_DUPLICATE',
  'UNIT_CONTEXT_LIMIT','MODEL_EMPTY_RESPONSE','MODEL_OUTPUT_TRUNCATED','COMPILE_RECOVERY_CONTEXT_LIMIT','COMPILE_RECOVERY_EXHAUSTED',
  'COMPILE_RECOVERY_JOB_LIMIT','COMPILE_RECOVERY_FAILED','COMPILE_RECOVERY_DECLINED','COMPILE_RECOVERY_INVALID','COMPILE_RECOVERY_SCOPE_VIOLATION']);
export const canIsolateFailure = error => localCodes.has(error?.code);

export function isolateCompileItem(work, {key, card_id, kind='card', error, candidate}) {
  work.isolation ??= {contract:COMPILE_ISOLATION,items:{}};
  const at=new Date().toISOString(),previous=work.isolation.items[key];
  work.isolation.items[key]={...previous,kind,card_id:card_id??null,status:'open',code:error.code,reason:error.message,
    created_at:previous?.created_at??at,updated_at:at,...(candidate?{candidate}: {})};
  return work.isolation.items[key];
}

export function quarantineUnit(job, ref, error) {
  const work=(job.unit_work??={})[ref]??={phase:'generate',references:[]};
  work.source_revision??=job.book_units.find(unit=>unit.ref===ref)?.revision;
  for(const card of work.cards??[])if(!work.published?.[card.id]&&!work.reused?.[card.id]&&!isolatedCardIds(work).has(card.id)){
    const records=work.pending_issue_records?.[card.id]??[],kind=records.length&&records.every(issue=>issue.kind==='relation')?'relation':'card';
    isolateCompileItem(work,{key:`${kind==='relation'?'link':'card'}-${card.id}`,card_id:card.id,kind,error,candidate:card});
  }
  if(!work.cards || work.unit_issues?.length || work.partial_generation)
    isolateCompileItem(work,{key:work.unit_issues?.length?'coverage':'response',kind:work.unit_issues?.length?'coverage':'response',error});
  if(!isolationOpen(work).length)isolateCompileItem(work,{key:'response',kind:'response',error});
  return settleQuarantinedUnit(job,ref);
}

export function settleQuarantinedUnit(job,ref) {
  const work=job.unit_work[ref],items=isolationOpen(work),unit=job.book_units.find(u=>u.ref===ref);
  const cardIds=[...new Set([...Object.keys(work.published??{}),...Object.keys(work.reused??{})])];
  job.book_outcomes[ref]={status:'quarantined',card_ids:cardIds,revision:work.source_revision??unit?.revision,
    delivered_chars:job.book_reads?.[ref]?unit?.chars:0,note:`已保存或复用 ${cardIds.length} 张卡片；${items.length} 项问题保留在未组织池，尚未计为完成。`};
  work.phase='quarantined';job.book_advance_requested=true;
  job.detail=`${unit?.title??'当前单元'}：问题已保留到未组织池，继续后续单元。`;
  return job;
}

export function compileIsolationSummary(job) {
  const entries=Object.values(job.unit_work??{}).flatMap(work=>isolationOpen(work).map(([,entry])=>entry))
    .filter(entry=>!job.repair_origin?.card_id||entry.card_id===job.repair_origin.card_id);
  return {contract:COMPILE_ISOLATION,open:entries.length,cards:entries.filter(e=>['card','relation'].includes(e.kind)).length,
    responses:entries.filter(e=>!['card','relation'].includes(e.kind)).length};
}

function isolationRows(job) {
  if(job.workflow!==BOOK_WORKFLOW||job.repair_origin)return [];
  return Object.entries(job.unit_work??{}).flatMap(([ref,work])=>isolationOpen(work).map(([key,item])=>{
    const candidate=item.candidate??work.cards?.find(c=>c.id===item.card_id)??null;
    const unit=job.book_units?.find(u=>u.ref===ref);
    const revision=sha(JSON.stringify({item,candidate,source_revision:work.source_revision,issues:work.pending_issue_records?.[item.card_id]??work.pending_issues?.[item.card_id]}));
    return {id:'repair-'+sha(job.id+'\n'+ref+'\n'+key).slice(0,40),kind:'repair',repair_kind:item.kind,
      job_id:job.id,unit_ref:ref,item_key:key,card_id:item.card_id,revision,title:candidate?.title??`${unit?.title??'单元'} · ${item.kind==='coverage'?'覆盖待核验':'响应待恢复'}`,
      type:candidate?.type??'undetermined',summary:candidate?.summary??item.reason,excerpt:String(candidate?.body??item.reason).slice(0,220),
      sources:[ref],source_groups:[ref],reason:item.reason,issues:work.pending_issues?.[item.card_id]??[item.reason],
      candidate_domains:[],organization_signals:[],created_at:item.created_at,last_evaluated_at:item.updated_at,updated:item.updated_at,
      inbound_relation_count:0,outbound_relation_count:candidate?.relations?.length??0,active_repair_job:item.active_repair_job??null,
      response_truncated:Boolean(work.partial_generation),body:candidate?.body??'',candidate,raw_response:item.kind==='response'?(item.candidate?.raw!==undefined
        ?JSON.stringify({cards:[item.candidate.raw],note:'此候选来自保留的原始响应；覆盖情况未作声明。'})
        :work.generation_response?.text??work.last_response?.text??work.response?.text??''):null};
  }));
}

export function listCompileIsolation(root,{details=false}={}) {
  const dir=unoPath(root,'.nexogenesis/uno-jobs');if(!existsSync(dir))return [];
  const jobs=readdirSync(dir).filter(n=>n.endsWith('.json')).map(name=>readCompileJob(root,name.slice(0,-5)));
  const byId=new Map(jobs.map(job=>[job.id,job]));
  const rows=jobs.flatMap(job=>isolationRows(job)).map(row=>({...row,repair_status:byId.get(row.active_repair_job)?.status??null,
    last_repair:byId.get(row.job_id)?.unit_work?.[row.unit_ref]?.isolation?.items?.[row.item_key]?.last_repair??null}));
  return rows.map(row=>{if(details)return row;const {body,candidate,raw_response,...summary}=row;return summary;})
    .sort((a,b)=>b.updated.localeCompare(a.updated)||a.id.localeCompare(b.id));
}

export function findCompileIsolation(root,id) {
  const row=listCompileIsolation(root,{details:true}).find(item=>item.id===id);
  if(!row)throw Object.assign(new Error('该待修复项已解决或不存在，请刷新未组织池。'),{code:'ISOLATION_NOT_FOUND'});
  return row;
}
