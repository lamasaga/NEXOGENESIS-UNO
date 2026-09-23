import { readCompileJob, saveCompileJob } from './state.js';
import { inspectBookUnit } from './book-sources.js';
import { COMPILE_ISOLATION, candidateHash, findCompileIsolation, isolationOpen } from './compile-isolation.js';
import { unoCardRef, unoPath, unoRevision } from '../harness/uno-storage.js';
import { HarnessGateway } from '../harness/gateway.js';
import { loadCards, parseCardFile } from '../cards.js';
import { ensureDomainCheckpointState, readDomainGovernanceState } from './domain-governance.js';

const fail = message => { throw Object.assign(new Error(message),{code:'ISOLATION_CONFLICT'}); };
export const ISOLATED_REPAIR_DIAGNOSIS = 'isolated-repair-diagnosis-v1';

const currentFullReference = (root,catalog,id) => {
  const current=catalog.get(id);
  if(!current||['archived','superseded'].includes(current.meta.lifecycle))return null;
  const ref=unoCardRef(root,current),revision=unoRevision(root,ref);
  return {...current.meta,id,body:current.body,revision,delivery:'full'};
};

/**
 * A dedicated repair may outlive the card versions captured by its parent
 * compile. Refresh every previously complete reference and add the current
 * bodies of relation targets before any diagnosis, repair or Gateway commit.
 * This is evidence delivery, not permission to broaden the repair scope.
 */
export function refreshIsolationRepairReferences(root,job,work) {
  if(job?.operation!=='isolated-card-repair'||!work)return [];
  const catalog=loadCards(root),targets=new Set(),selected=work.cards?.find(card=>card.id===job.repair_origin?.card_id);
  for(const relation of selected?.relations??[])if(relation?.target)targets.add(relation.target);
  for(const records of Object.values(work.pending_issue_records??{}))for(const record of records??[])
    for(const id of record.related_card_ids??[])if(id)targets.add(id);
  const refreshed=[],references=new Map();
  for(const reference of work.references??[]){
    const current=reference.delivery!=='summary'?currentFullReference(root,catalog,reference.id):null;
    references.set(reference.id,current??reference);
    if(current&&current.revision!==reference.revision)refreshed.push(reference.id);
  }
  for(const id of targets){
    const current=currentFullReference(root,catalog,id);
    if(!current)continue;
    if(references.get(id)?.revision!==current.revision)refreshed.push(id);
    references.set(id,current);
  }
  work.references=[...references.values()];
  if(refreshed.length)work.reference_refresh={at:new Date().toISOString(),card_ids:[...new Set(refreshed)]};
  return [...new Set(refreshed)];
}

export function prepareIsolationRepair(root,{item_id,expected_revision,notes='',response_json=''}) {
  const item=findCompileIsolation(root,item_id);
  if(item.revision!==expected_revision)fail('待修复内容已变化，请刷新后重试。');
  const parent=readCompileJob(root,item.job_id),ref=item.unit_ref,original=parent.unit_work[ref];
  if(parent.status==='running')fail('请先暂停原编译任务，再单独修复候选。');
  if(item.active_repair_job){
    const active=readCompileJob(root,item.active_repair_job);
    if(!['completed','ended','partial','failed'].includes(active.status))fail('该候选已有修复任务，请打开原修复任务继续。');
  }
  const unit=inspectBookUnit(root,parent,ref);
  if(original.source_revision && unit.revision!==original.source_revision)fail('原文版本已变化，不能沿用旧候选修复。');
  if(typeof notes!=='string'||notes.length>6000||typeof response_json!=='string'||response_json.length>120000)fail('修复要求或候选响应超过上限。');
  const work=structuredClone(original);
  const origin={item_id,parent_job_id:parent.id,unit_ref:ref,item_key:item.item_key,card_id:item.card_id,kind:item.repair_kind,
    expected_revision,source_revision:unit.revision,notes,created_at:new Date().toISOString()};
  work.phase='check';work.recovery={attempts:{},events:[]};
  delete work.response;delete work.last_response;delete work.verifying;delete work.repair_response;delete work.repair_attempt;
  delete work.isolation.items[item.item_key];
  if(['card','relation'].includes(item.repair_kind)){
    const id=item.card_id;
    if(!work.cards?.some(card=>card.id===id))fail('候选正文不存在，需先恢复原响应。');
    if(item.repair_kind==='relation'&&work.published?.[id]){
      const publication=work.published[id];
      if(unoRevision(root,publication.ref)!==publication.revision)fail('已保存正文的版本发生变化，请先核对卡片。');
      const actual=parseCardFile(unoPath(root,publication.ref));
      work.references=[...work.references.filter(card=>card.id!==id),{...actual.meta,id,body:actual.body,revision:publication.revision,delivery:'full'}];
      delete work.published[id];
    }
    work.repairs={...work.repairs,[id]:0};work.repair_counts={...work.repair_counts,[id]:{}};
    work.repair_retries={};work.review_retries={};
    const records=(work.pending_issue_records?.[id]??(work.pending_issues?.[id]??item.issues??[]).map(message=>({kind:item.repair_kind,
      related_card_ids:[...(original.isolation.items[item.item_key].target_ids??[])],message})))
      .map(record=>({kind:record.kind,related_card_ids:[...(record.related_card_ids??[])],message:String(record.message??'').trim()}))
      .filter(record=>record.message);
    work.repair_diagnosis={contract:ISOLATED_REPAIR_DIAGNOSIS,status:'pending',card_id:id,kind:item.repair_kind,
      original_issues:records,user_notes:notes.trim()};
    refreshIsolationRepairReferences(root,{operation:'isolated-card-repair',repair_origin:origin},work);
    delete (work.checks??={})[id];
    work.initial_review_done=false;
    work.unit_issues=[];delete work.coverage_recovery;
  }else{
    if(item.repair_kind==='coverage'){
      work.coverage_recovery={phase:'generate',issues:[...(original.unit_issues??[])],existing_cards:(work.cards??[]).map(c=>({id:c.id,title:c.title}))};
    }else{
      origin.failed_response=response_json.trim() || item.raw_response;
      origin.source_retry=!response_json.trim()&&(Boolean(original.partial_generation)||!origin.failed_response);
      origin.manual_response=Boolean(response_json.trim());
      origin.original_card_ids=(original.cards??[]).map(card=>card.id);
      work.cards=undefined;work.phase='generate';work.references=original.references??[];
      work.isolation.items={};work.pending_issues={};work.pending_issue_records={};
      work.unit_issues=[];delete work.coverage_recovery;
    }
  }
  return {item,parent,fields:{operation:'isolated-card-repair',repair_origin:origin,compile_isolation:COMPILE_ISOLATION,
    title:`${['card','relation'].includes(item.repair_kind)?'单卡修复':item.repair_kind==='coverage'?'遗漏核验':'响应恢复'} · ${item.title}`,phase:'read',book_units:[parent.book_units.find(u=>u.ref===ref)],
    book_focus_refs:[ref],book_outcomes:{},book_reads:{},book_card_reads:{},unit_work:{[ref]:work},batches:[[ref]],
    sources:structuredClone(parent.sources),selected_sources:[],source_revisions:{...parent.source_revisions},
    domain_catalog:structuredClone(parent.domain_catalog??[]),card_classification:parent.card_classification,
    touched:[],budget:{calls:12},notes,continuous:false,book_advance_requested:false,stop_after_batch:false,domain_approval_mode:'manual'}};
}

export function bindIsolationRepair(root,job) {
  const origin=job.repair_origin;if(!origin)return;
  const parent=readCompileJob(root,origin.parent_job_id),entry=parent.unit_work?.[origin.unit_ref]?.isolation?.items?.[origin.item_key];
  if(!entry || entry.status!=='open')fail('待修复项已结算，不能重复启动。');
  if(entry.active_repair_job===job.id)return;
  entry.active_repair_job=job.id;saveCompileJob(root,parent);
}

export function reconcileIsolationRepair(root,job) {
  const origin=job.repair_origin;if(!origin)return false;
  const ref=origin.unit_ref,parent=readCompileJob(root,origin.parent_job_id),work=parent.unit_work?.[ref],result=job.unit_work?.[ref];
  const entry=work?.isolation?.items?.[origin.item_key];
  if(!entry)return false;
  const unit=parent.book_units?.find(row=>row.ref===ref),repairedOutcome=job.book_outcomes?.[ref];
  const verifiedDelivery=repairedOutcome?.status==='processed'&&repairedOutcome.revision===origin.source_revision
    &&Number.isInteger(repairedOutcome.delivered_chars)&&repairedOutcome.delivered_chars===unit?.chars?repairedOutcome:null;
  if(entry.resolved_by===job.id){
    const current=parent.book_outcomes?.[ref];
    if(!verifiedDelivery||current?.status!=='processed'||(current.revision===verifiedDelivery.revision&&current.delivered_chars===verifiedDelivery.delivered_chars))return false;
    parent.book_outcomes[ref]={...current,revision:verifiedDelivery.revision,delivered_chars:verifiedDelivery.delivered_chars};saveCompileJob(root,parent);return true;
  }
  if(entry.active_repair_job!==job.id||work.source_revision!==origin.source_revision)fail('原候选检查点已变化，修复结果与收据已保留，未覆盖原任务。');
  const isSuccess=job.book_outcomes?.[ref]?.status==='processed';
  const converted=origin.kind==='response'&&Array.isArray(result?.cards)&&job.status!=='running'
    &&isolationOpen(result).length>0&&isolationOpen(result).every(([,item])=>item.card_id);
  if(origin.card_id && result?.cards?.some(card=>card.id===origin.card_id) && !result.published?.[origin.card_id]){
    const index=work.cards.findIndex(card=>card.id===origin.card_id);
    if(index>=0)work.cards[index]=structuredClone(result.cards.find(card=>card.id===origin.card_id));
    for(const field of ['pending_issues','pending_issue_records','repair_counts','repairs'])if(result[field]?.[origin.card_id]!==undefined)
      (work[field]??={})[origin.card_id]=structuredClone(result[field][origin.card_id]);
  }
  const selectedIds=[...new Set((job.receipts??[]).flatMap(receipt=>receipt.card_ids??[]))];
  for(const id of selectedIds){
    const published=result?.published?.[id],candidate=result?.cards?.find(card=>card.id===id);
    if(!published||!candidate)continue;
    if(unoRevision(root,published.ref)!==published.revision)fail('修复结果的正式卡片版本已变化，不能确认原待办完成。');
    if(!job.receipts.some(receipt=>receipt.card_ids?.includes(id)))continue;
    const index=(work.cards??=[]).findIndex(c=>c.id===id);
    if(index<0)work.cards.push(candidate);else work.cards[index]=candidate;
    (work.published??={})[id]=published;(work.checks??={})[id]=candidateHash(candidate);
    delete work.pending_issues?.[id];delete work.pending_issue_records?.[id];
    parent.touched=[...new Set([...(parent.touched??[]),id])];
  }
  for(const receipt of job.receipts??[])if(!parent.receipts.some(r=>r.key===receipt.key))parent.receipts.push(receipt);
  if(isSuccess)work.reused={...work.reused,...result.reused};
  const organization=readDomainGovernanceState(root),domainState=ensureDomainCheckpointState(parent);
  domainState.unassigned_card_ids=[...new Set([...domainState.unassigned_card_ids,...selectedIds.filter(id=>organization.unassigned[id]?.status==='open')])];
  domainState.open_unassigned=Object.values(organization.unassigned).filter(row=>row.status==='open').length;
  for(const [key,pending] of isolationOpen(result).filter(([key])=>key.startsWith('link-')||origin.kind==='response')){
    work.isolation.items[key]=structuredClone(pending);
    const candidate=result.cards?.find(card=>card.id===pending.card_id);
    if(candidate&&!work.published?.[candidate.id]){
      const index=(work.cards??=[]).findIndex(card=>card.id===candidate.id);
      if(index<0)work.cards.push(structuredClone(candidate));else work.cards[index]=structuredClone(candidate);
    }
    for(const field of ['pending_issues','pending_issue_records'])if(result[field]?.[pending.card_id])
      (work[field]??={})[pending.card_id]=structuredClone(result[field][pending.card_id]);
    delete work.checks?.[pending.card_id];
  }
  parent.repair_receipts??=[];
  for(const receipt of job.receipts??[])if(!parent.repair_receipts.some(row=>row.key===receipt.key))parent.repair_receipts.push({job_id:job.id,key:receipt.key,unit_ref:ref,item_key:origin.item_key});
  entry.last_repair={job_id:job.id,status:job.status,at:new Date().toISOString(),reason:job.detail};
  if(isSuccess||converted){entry.status='resolved';entry.resolved_by=job.id;entry.resolved_at=new Date().toISOString();
    if(origin.kind==='coverage')work.unit_issues=[];
  }
  if(!isolationOpen(work).length && !(work.unit_issues??[]).length && (work.cards??[]).every(c=>work.published?.[c.id]||work.reused?.[c.id])){
    work.phase='done';parent.book_outcomes[ref]={...parent.book_outcomes[ref],status:'processed',card_ids:[...new Set([...Object.keys(work.published??{}),...Object.keys(work.reused??{})])],
      ...(verifiedDelivery?{revision:verifiedDelivery.revision,delivered_chars:verifiedDelivery.delivered_chars}:{}),note:'待修复项已分别通过审核并保存，来源与修复收据保留。'};
  }else if(parent.book_outcomes[ref])parent.book_outcomes[ref].card_ids=[...new Set([...Object.keys(work.published??{}),...Object.keys(work.reused??{})])];
  saveCompileJob(root,parent);
  if(isSuccess&&['done','ended','domain_review'].includes(parent.phase)&&!['running','paused'].includes(parent.status)){
    for(const source of parent.sources??[]){
      if(source.incomplete || !source.units?.length || source.units.some(unit=>parent.book_outcomes?.[unit.ref]?.status!=='processed'))continue;
      if((parent.archives??[]).some(receipt=>receipt.source===source.original_source))continue;
      try{
        const receipt=new HarnessGateway(root).archiveCompletedBook({job_id:parent.id,source:source.original_source,review:{
          note:'隔离待办均已通过独立修复与正式收据核验，核对不可变原件后归档。',job_revision:unoRevision(root,`.nexogenesis/uno-jobs/${parent.id}.json`),
          source_revision:source.source_revision,extraction_revision:source.extraction_revision}});
        (parent.archives??=[]).push(receipt);saveCompileJob(root,parent);
      }catch(error){parent.failures=[...(parent.failures??[]).filter(row=>!(row.kind==='archive'&&row.source===source.original_source)),{kind:'archive',source:source.original_source,detail:error.message}];saveCompileJob(root,parent);}
    }
  }
  return true;
}
