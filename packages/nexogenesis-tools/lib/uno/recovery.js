import { listDrafts, validateSource } from './drafts.js';
import { readUnoUnit, unoRevision, unoCardRef, unoPath, sha } from '../harness/uno-storage.js';
import { loadCards, parseCardFile } from '../cards.js';
import { inspectConstructScope } from './construct-consistency.js';
import { directedConstruction, constructionConclusion } from './construction-plan.js';

function currentFactualEvidence(root,card,review){
  const sources=card.meta.sources??[],bindings=review.source_bindings,checks=review.checks;
  if(!sources.length||!Array.isArray(bindings)||!bindings.length||!Array.isArray(checks)||!checks.length)return false;
  const snapshots=new Map();
  try{
    for(const source of sources){
      const {file:ref}=validateSource(root,source),binding=bindings.find(row=>row.ref===ref);
      if(!binding||binding.revision!==unoRevision(root,ref))return false;
      const current=ref.startsWith('05-Buffer/')?readUnoUnit(root,ref):parseCardFile(unoPath(root,ref));
      if(binding.content_revision!==sha(current.body))return false;
      snapshots.set(ref,binding);
    }
    return checks.every(check=>snapshots.get(check.ref)?.content_revision===check.source_revision);
  }catch{return false;}
}

export function constructReviewPending(root,job,index=job.batch_index,state=job){
  if(job.construct_contract!=='scoped-review-v1')return [];
  const scope=inspectConstructScope(root,job,index),resolved=new Set(scope.resolved.map(row=>row.id)),blocked=new Map(scope.blocked.map(row=>[row.id,row]));
  const drafts=listDrafts(root,`${job.id}-b${index}`),covered=new Set(drafts.flatMap(d=>[d.card.id,...(d.merges??[]).map(m=>m.id)])),cards=loadCards(root,{includeInactive:true});
  return (job.batches[index]??[]).filter(id=>!resolved.has(id)&&(!covered.has(id)||blocked.has(id))).flatMap(id=>{
    if(blocked.has(id)){const row=blocked.get(id);return [{id,reviewed:false,issues:[row.detail],code:row.code,blocked:true,redirect:row.redirect}];}
    const conclusion=constructionConclusion(root,job,id,index);
    if(directedConstruction(job)&&job.construction_plan?.kind!=='factual-audit'&&conclusion?.status==='unchanged')return [];
    if(conclusion?.status==='deferred')return [{id,reviewed:false,issues:[conclusion.note],deferred:true}];
    const card=cards.get(id),review=state.reviewed?.[id];
    const reviewed=Boolean(card&&review?.unchanged&&review.revision===unoRevision(root,unoCardRef(root,card)));
    if(reviewed&&!review.issues?.length&&directedConstruction(job)&&job.construction_plan?.kind==='factual-audit'&&!currentFactualEvidence(root,card,review))
      return [{id,reviewed:false,issues:['事实审核所依赖的来源版本已变化、缺失或没有完整版本记录，请重新核验。'],code:'SOURCE_REVIEW_STALE',needs_review:true}];
    return reviewed&&!review.issues?.length?[]:[{id,reviewed,issues:review?.issues??[]}];
  });
}

/** Reconstruct unfinished work from saved objects, not the last assistant summary. */
export function pendingBatches(root, job) {
  if(job?.mode!=='construct')return [];
  return (job.completed_batches??[]).map(row=>{
    const drafts=listDrafts(root,`${job.id}-b${row.index}`).filter(d=>d.state!=='published').map(d=>({id:d.card.id,state:d.state,revision:d.revision,errors:d.errors}));
    const state=job.batch_records?.[row.index]??{},domains=Array.isArray(state.domain_proposals)?state.domain_proposals:[],cards=constructReviewPending(root,job,row.index,state);
    return {index:row.index,drafts,domains,cards,pending:drafts.length+domains.length+cards.length};
  }).filter(row=>row.pending);
}

export function resumeUnfinishedBatch(root, job) {
  if(job?.mode!=='construct')return false;
  const pending=pendingBatches(root,job)[0];if(!pending)return false;
  job.recovery_return_index=job.batches.length;job.batch_index=pending.index;
  const state=job.batch_records?.[pending.index]??{};
  for(const key of ['reviewed','reading','card_reads','review_reads','review_evidence'])job[key]=state[key]??{};
  job.domain_proposals=state.domain_proposals??[];
  job.touched=listDrafts(root,`${job.id}-b${pending.index}`).filter(d=>d.state!=='published').map(d=>d.card.id);
  const repairIds=job.orchestration_profile==='bounded-workflow-v1'?[...new Set([
    ...pending.drafts.filter(d=>d.state==='rejected'||state.reviewed?.[d.id]?.issues?.length).map(d=>d.id),
    ...pending.cards.filter(c=>c.issues?.length&&!c.needs_review).map(c=>c.id)])]:[];
  const needsAuthor=repairIds.length>0;
  if(repairIds.length)job.repair_ids=repairIds;else delete job.repair_ids;
  job.role=needsAuthor?'author':'reviewer';job.phase=needsAuthor?'read':'organize';
  job.finish_requested=false;job.handoff_requested=false;job.needs_fresh_context=true;
  job.checkpoint='继续本批未完成对象；已发布卡片与成功收据保留，不重新生成。';
  return true;
}
