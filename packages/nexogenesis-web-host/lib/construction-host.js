import {assertConstructionDraft} from '../../nexogenesis-tools/lib/uno/construction-permissions.js';
import { updateRequestState } from './uno-request-state.js';
import { constructReviewPending } from '../../nexogenesis-tools/lib/uno/recovery.js';
import { suspendInbox } from "./resume-inbox.js";
import { readUnoReceipt, unoRevision } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';
import { readCompileJob, saveCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { listDrafts, readDraft } from '../../nexogenesis-tools/lib/uno/drafts.js';
import { CONSTRUCTION_WORKFLOW, batchTask } from '../../nexogenesis-tools/lib/uno/construction-workflow.js';
import { loadCards } from '../../nexogenesis-tools/lib/cards.js';
import { sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { rpcCall } from './rpc.js';
import { selectActiveModel } from './settings.js';
import { patchConversationExt } from './meta.js';
import { broadcastGraphEvent } from './events-bus.js';
import { buildEvidencePack, observeEvidencePackDelivery, EVIDENCE_PACK_PROFILE } from '../../nexogenesis-tools/lib/uno/evidence-pack.js';
import { getProviderBudget } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { isBounded, assertBoundedModel, bindWorkflowBudget, requestBoundedRepair, handoffAtAuthorBudget, budgetStopCode, nextPackageMinimum } from './uno-orchestration.js';
import { inspectConstructScope, reconcileConstructScope } from '../../nexogenesis-tools/lib/uno/construct-consistency.js';
import { directedConstruction, constructionConclusion, rememberConstructionCheck } from '../../nexogenesis-tools/lib/uno/construction-plan.js';
import { settleResumeGuard } from './resume-plan.js';
import { executeSingleCardDomainOrganization, executeSingleCardRecompile } from './single-card-recompile.js';

async function newContext(ctx,root,job,role){
  assertBoundedModel(job,job.model_selection,ctx);
  saveCompileJob(root,job);
  const previous=job.session_id,created=await rpcCall(ctx,'session.create',{cwd:root,agentPreset:'uno-compile'});
  job=readCompileJob(root,job.id);
  job.sessions=[...new Set([...(job.sessions??[]),previous,created.sessionId])];job.session_id=created.sessionId;job.role=role;
  if(job.execution_profile!==EVIDENCE_PACK_PROFILE&&!isBounded(job))job.checkpoint='';
  // A fresh author context cannot use old cumulative reads as current evidence.
  // Persisted outcomes, operation receipts, drafts and source versions survive.
  if(role==='author'){job.reading={};job.card_reads={};}
  job.review_reads={};job.review_evidence={};job.needs_fresh_context=false;
  saveCompileJob(root,job);
  bindWorkflowBudget(root,job);
  await rpcCall(ctx,'session.rename',{sessionId:job.session_id,title:job.title+` · 第 ${job.batch_index+1} 批 · ${role==='reviewer'?'审核':'建构'}`});
  patchConversationExt(job.session_id,{project_id:job.project_id,task_kind:job.mode,uno_job_id:job.id,title:job.title,parent_session_id:job.owner_session_id});
  return readCompileJob(root,job.id);
}
async function nativeTurn(ctx,root,job,signal){
  assertBoundedModel(job,job.model_selection,ctx);
  bindWorkflowBudget(root,job);
  if(job.model_selection)await rpcCall(ctx,'session.selectModel',{sessionId:job.session_id,...job.model_selection});else await selectActiveModel(ctx,job.session_id);
  signal.throwIfAborted();
  let packet=null;
  try {packet=buildEvidencePack(root,job,{signal});}
  catch(error){if(error.code!=='RESULT_TOO_LARGE')throw error;} // Oversize task metadata keeps the existing tool route intact.
  await new Promise((resolve,reject)=>{
    let settled=false,idleTimer,disposeEvidence=()=>{};
    const finish=error=>{if(settled)return;settled=true;clearTimeout(idleTimer);unsubscribe();disposeEvidence();signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
    const unsubscribe=ctx.on('session/event',(session,event)=>{
      if(session.id!==job.session_id)return;
      try{
        const current=readCompileJob(root,job.id);
        if(current.session_id!==job.session_id)return; // Late old-role events cannot mutate the new owner.
        if(['assistant/message','turn/end'].includes(event.type)||(event.type==='assistant/chunk'&&event.data?.chunk?.type==='finish')){updateRequestState(current.calls.at(-1),event);saveCompileJob(root,current);}
        if(event.type==='step/start'){current.calls.push({session_id:job.session_id,turn:event.data?.turn,phase:current.phase,role:current.role,batch:current.batch_index,status:'running',started_at:new Date().toISOString(),step:event.data?.step});saveCompileJob(root,current);}
        if(event.type==='assistant/message'){const visible=(event.data?.message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('');if(visible.trim())current.detail=visible.slice(-1200);saveCompileJob(root,current);}
        if(['step/start','assistant/message','tool/result','turn/end'].includes(event.type))broadcastGraphEvent(job.owner_session_id??job.session_id,{type:'work.updated',payload:{workflow:'construct',job_id:job.id,session_id:job.session_id,phase:current.phase,role:current.role,kind:event.type}});
        if(event.type==='turn/end'){const reason=event.data?.reason,kind=reason?.kind,detail=reason?.failure?.message??reason?.error?.message??reason?.message??'执行停止：'+kind;const code=budgetStopCode({message:detail})??reason?.failure?.code??reason?.error?.code;finish(signal.aborted?signal.reason:kind==='completed'?null:Object.assign(new Error(detail),{code}));}
      }catch(e){finish(e);}
    });
    // Some native cancellations reach idle without publishing turn/end. Verify
    // the actual session state; accepting session.cancel alone is insufficient.
    const checkCancelledIdle=async()=>{
      if(settled)return;
      try {const session=((await rpcCall(ctx,'session.list',{})).items??[]).find(s=>s.sessionId===job.session_id);if(session&&!session.running)finish(signal.reason);}
      finally {if(!settled){idleTimer=setTimeout(()=>void checkCancelledIdle().catch(()=>{}),500);idleTimer.unref?.();}}
    };
    const cancel=()=>{void (async()=>{await suspendInbox(ctx,job.session_id,job.id,'pause');await rpcCall(ctx,'session.cancel',{sessionId:job.session_id});await checkCancelledIdle();})().catch(e=>{const current=readCompileJob(root,job.id);current.detail='停止请求失败，等待当前回合退出：'+e.message;saveCompileJob(root,current);});};
    signal.addEventListener('abort',cancel,{once:true});
    const instruction=isBounded(job)
      ?'使用本阶段工作包中的目标和实际证据直接处理。遵守当前角色与卡片范围；仅缺少必要证据时补读。完成登记后程序交接，不需要反复查询任务或播报结束。'
      :job.role==='reviewer'
      ?'你处于新的独立审核上下文。先用 compile_task 查看本批原始要求与草稿。实际阅读当前草稿和来源，校对实质内容、作者归属、数字、边界，再整理单一主类型、既有领域归属与关系；使用 compile_review 登记对应版本，有问题明确记录。完成后 compile_finish complete 并结束回复。不要仅改标题，也不需要读取作者会话历史。'
      :'先用 compile_task 查看目标、本批卡片和 write_scope。检查正文、主类型、领域与联系，只修订有依据的问题，范围外只读。完成首轮后 compile_finish organize，交给独立审核；无修改也须审核人读回并记录保留依据。';
    // Observe the native provider boundary: accepting a queued prompt is not proof
    // that its exact evidence survived context preparation and reached the model.
    if(packet)disposeEvidence=ctx.on('llm/stream',(options,next)=>options.sessionId===job.session_id
      ?observeEvidencePackDelivery(root,packet,options,next(),{signal}):next(),{global:true});
    const content=packet
      ?[{type:'text',text:'下一段 JSON 已提供当前目录和有界正文，可直接开始本阶段工作；缺少的正文按 next_offset 和工具入口自主补读。'+instruction.replace(/先用 compile_task[^。]*。/u,'')}, {type:'text',text:packet.text}]
      :[{type:'text',text:instruction}];
    void rpcCall(ctx,'session.prompt',{sessionId:job.session_id,mode:'queue',content}).catch(finish);
    if(signal.aborted)cancel();
  });
}
export function publicationGroups(drafts,existingIds=new Set(),reviews={}){
  const byId=new Map(drafts.map(d=>[d.card.id,d]));
  // Only outgoing unpublished endpoints are dependencies. A bad incoming card
  // must not prevent its otherwise valid target from being published.
  return [...byId.keys()].map(id=>{
    const seen=new Set(),pending=[id];
    while(pending.length){const next=pending.pop();if(seen.has(next))continue;seen.add(next);
      for(const rel of byId.get(next)?.card.relations??[])if(byId.has(rel.target)&&(!existingIds.has(rel.target)||(reviews[next]?.dependencies??[]).some(d=>d.id===rel.target&&d.draft)))pending.push(rel.target);
    }
    return [...seen];
  });
}
export function finalizeConstructionBatch(root,job){
  assertConstruction(job);
  const gateway=new HarnessGateway(root),task=batchTask(job),drafts=listDrafts(root,task),published=new Set(drafts.filter(d=>d.state==='published').map(d=>d.card.id));
  const reviewsForPublication=job.reviewed;
  for(const group of publicationGroups(drafts.filter(d=>d.state!=='published'),new Set(loadCards(root).keys()),reviewsForPublication)){
    const ids=group.filter(id=>!published.has(id));if(!ids.length)continue;
    if(ids.some(id=>!reviewsForPublication?.[id]||reviewsForPublication[id].issues.length))continue;
    try{
      for(const id of ids)for(const dep of reviewsForPublication[id].dependencies??[]){
        if(dep.draft){const target=readDraft(root,task,dep.id);
          if(ids.includes(dep.id)){if(target?.revision!==dep.revision)throw Error('审核依赖的目标草稿已变化：'+dep.id);}
          else {const receipt=target?.publication_key?readUnoReceipt(root,target.publication_key):null;const formal=receipt?.publication?.cards?.find(c=>c.id===dep.id);if(target?.state!=='published'||!formal||formal.draft_revision!==dep.revision||unoRevision(root,formal.ref)!==formal.revision)throw Error('审核引用的目标草稿尚未可靠发布：'+dep.id);}
        }else if(unoRevision(root,dep.ref)!==dep.revision)throw Error('审核引用的正式关系目标已变化：'+dep.id);
      }
      const reviews=Object.fromEntries(ids.map(id=>[id,reviewsForPublication[id]]));
      const domainOnly=ids.every(id=>assertConstructionDraft(job,readDraft(root,task,id),loadCards(root).get(id))?.domainOnly);
      const receipt=gateway[domainOnly?'publishUnoDomainAssignments':'publishUnoKnowledge']({task,key:task+':publish:'+sha(JSON.stringify(reviews)).slice(0,24),ids,reviews});if(!job.receipts.some(r=>r.key===receipt.key))job.receipts.push(receipt);ids.forEach(id=>published.add(id));}
    catch(e){for(const id of ids)job.issues.push({id,detail:e.message,batch:job.batch_index,status:'open'});}
    saveCompileJob(root,job);
  }
  // Historical construction jobs could persist domain_proposals without a
  // complete proposal producer or an atomic membership transaction. Keep the
  // payload for audit, but never turn it into a formal domain. New domains are
  // created exclusively through the domain-review route.
  const legacyDomains=job.domain_proposals??[];
  if(legacyDomains.length){
    job.legacy_domain_proposals=[...(job.legacy_domain_proposals??[]),...legacyDomains.map(proposal=>({...proposal,deferred_at:new Date().toISOString(),reason:'LEGACY_DOMAIN_PROPOSAL_UNSUPPORTED'}))];
    for(const proposal of legacyDomains)job.issues.push({id:proposal.id,kind:'domain',code:'LEGACY_DOMAIN_PROPOSAL_UNSUPPORTED',detail:'旧建构领域提案没有完整边界与原子成员挂靠契约，已保留记录但不写入正式领域；请由领域治理检查点重新提案。',batch:job.batch_index,status:'deferred'});
  }
  job.domain_proposals=[];
  const pending=drafts.filter(d=>!published.has(d.card.id)).length+constructReviewPending(root,job).length;
  reconcileConstructScope(root,job);
  rememberConstructionCheck(root,job,pending);
  job.batch_records??={};job.batch_records[job.batch_index]=Object.fromEntries(['reviewed','reading','card_reads','review_reads','review_evidence'].map(key=>[key,job[key]??{}]));
  job.completed_batches??=[];job.completed_batches=job.completed_batches.filter(b=>b.index!==job.batch_index);job.completed_batches.push({index:job.batch_index,published:[...published],pending,at:new Date().toISOString()});job.completed_batches.sort((a,b)=>a.index-b.index);
  job.pending=null;job.phase='batch_done';job.detail=`第 ${job.batch_index+1} 批已结算：发布 ${published.size} 张卡片，${Object.values(job.reviewed??{}).filter(r=>r.unchanged&&!r.issues?.length).length} 张审核后保留原样，${pending} 项待处理。`;saveCompileJob(root,job);
  return job;
}
function assertConstruction(job) {
  if (job.mode !== 'construct' || job.workflow !== CONSTRUCTION_WORKFLOW || ['select','prepare'].includes(job.phase)) {
    throw Object.assign(new Error('此执行器仅处理当前建构任务；旧编译及未知版本只保留历史记录。'), {code:'LEGACY_WORKFLOW_READONLY'});
  }
}

export async function executeConstruction(ctx,root,initial,controller){
  assertConstruction(initial);
  if(initial.operation==='unassigned-card-recompile')return executeSingleCardRecompile(ctx,root,initial,controller);
  if(initial.operation==='unassigned-card-domain')return executeSingleCardDomainOrganization(ctx,root,initial,controller);
  const id=initial.id,signal=controller.signal;
  const timer=setTimeout(()=>controller.abort(new Error('本执行时段达到 30 分钟，已请求暂停，当前操作退出后可恢复')),30*60*1000);
  try{
    let job=readCompileJob(root,id);assertConstruction(job);job.status='running';delete job.error_code;saveCompileJob(root,job);
    if(!job.batches.length){
      job.status=directedConstruction(job)&&job.construction_plan.skipped.length?'completed':'partial';job.phase='done';
      job.detail=directedConstruction(job)?(job.construction_plan.skipped.length?'相同目标、卡片及依赖版本的已有检查已复用，本次无需模型请求。':'没有找到足够相关的建构候选，请补充主题或缩小范围；没有把未检查内容标为完成。'):'没有可检查的卡片，请重新选择建构范围。';
      saveCompileJob(root,job);return;
    }
    while(true){
      signal.throwIfAborted();job=readCompileJob(root,id);assertConstruction(job);
      if(job.handoff_requested){
        if(directedConstruction(job)&&job.construction_plan.kind!=='factual-audit'&&!listDrafts(root,batchTask(job)).length&&inspectConstructScope(root,job).active_ids.every(card=>constructionConclusion(root,job,card))){job.handoff_requested=false;finalizeConstructionBatch(root,job);continue;}
        job.phase='organize';job.handoff_requested=false;job.finish_requested=false;job=await newContext(ctx,root,job,'reviewer');continue;
      }
      if(job.finish_requested){if(requestBoundedRepair(root,job)){job=await newContext(ctx,root,job,'author');continue;}job.finish_requested=false;job.phase='settle';saveCompileJob(root,job);continue;}
      if(job.needs_fresh_context){
        if(['settle','batch_done','done'].includes(job.phase)){job.needs_fresh_context=false;saveCompileJob(root,job);}
        else job=await newContext(ctx,root,job,job.role??'author');
      }
      if(job.phase==='batch_done'&&job.recovery_return_index!==undefined){
        job.batch_index=job.recovery_return_index;delete job.recovery_return_index;
        job.status=(job.completed_batches??[]).some(b=>b.pending)?'partial':'completed';job.phase='done';
        // One recovery batch per explicit resume; never cycle on an unresolved objection.
        saveCompileJob(root,job);return;
      }
      if(job.phase==='batch_done'){
        const last=job.batch_index+1>=job.batches.length;
        if(!last&&!listDrafts(root,`${job.id}-b${job.batch_index+1}`).length){const next=inspectConstructScope(root,job,job.batch_index+1);if(next.resolved.length&&!next.active_ids.length&&!next.blocked.length){job.batch_index++;job.reviewed={};job.domain_proposals=[];finalizeConstructionBatch(root,job);continue;}}
        const remaining=job.batches.slice(job.batch_index+1).flat().length;
        if(remaining&&(!job.continuous||job.stop_after_batch)&&!job.resume_after_batch){job.status='paused';job.remaining_units=remaining;job.detail='本批已结束，剩余卡片范围保留；可以讨论或继续工作。';saveCompileJob(root,job);return;}
        job.resume_after_batch=false;
        if(last){job.status=((job.completed_batches??[]).some(b=>b.pending)||job.failures.length)?'partial':'completed';job.phase='done';job.remaining_units=0;saveCompileJob(root,job);return;}
        if(isBounded(job)?getProviderBudget(root,id).remaining<nextPackageMinimum(root,job):job.budget.calls-job.calls.length<20){job.status='paused';job.detail=isBounded(job)?'本批已结束，剩余额度不足以启动下一工作包，成果与未处理范围已保留。':'为下一批保留完整审核预算，当前剩余请求不足 20 次。可增加累计预算后继续。';saveCompileJob(root,job);return;}
        job.batch_index++;delete job.repair_ids;job.phase='read';job.finish_requested=false;job.handoff_requested=false;job.reviewed={};job.domain_proposals=[];job.touched=[];job.reading={};job.card_reads={};job=await newContext(ctx,root,job,'author');
      }
      if(job.phase==='read'&&!listDrafts(root,batchTask(job)).length){
        const scope=reconcileConstructScope(root,job);saveCompileJob(root,job);
        if(scope.blocked.length){job.status='paused';job.detail='本组有卡片退役或版本异常，不能按原清单继续。';job.scope_conflicts=scope.blocked;saveCompileJob(root,job);return;}
        if(!scope.active_ids.length&&scope.resolved.length){finalizeConstructionBatch(root,job);continue;}
      }
      if(job.phase==='settle'){
        if(job.requirements.preferences.delivery==='manual'){job.status='review';job.pending={cards:listDrafts(root,batchTask(job)).map(d=>({id:d.card.id,title:d.card.title,type:d.card.type,domains:d.card.domains??[],body:d.body,sources:d.card.sources??[]}))};job.detail='本批独立审核结束，等待确认发布；有问题的对象会继续保留待修。';saveCompileJob(root,job);return;}
        finalizeConstructionBatch(root,job);continue;
      }
      if(isBounded(job)&&getProviderBudget(root,id).remaining<=0)throw Object.assign(new Error('[UNO_PROVIDER_BUDGET] 达到累计模型请求预算，进度已保留。'),{code:'UNO_PROVIDER_BUDGET'});
      if(!isBounded(job)&&job.calls.length>=job.budget.calls)throw Error('UNO_BUDGET：达到累计模型请求预算，保存进度后可增加预算继续');
      try{await nativeTurn(ctx,root,job,signal);}catch(error){
        job=readCompileJob(root,id);if(signal.aborted||!handoffAtAuthorBudget(root,job,error))throw error;
      }
      signal.throwIfAborted();job=readCompileJob(root,id);
      if(job.handoff_requested||job.finish_requested)continue;
      job.status='paused';job.detail='模型回合已结束，本批仍有未完成事项，恢复时沿用当前阶段和成果。';saveCompileJob(root,job);return;
    }
  }catch(e){const job=readCompileJob(root,id),budgetCode=budgetStopCode(e),code=budgetCode??e.code??null,held=job.status==='paused';
    job.status=held||signal.aborted||budgetCode||/预算/.test(e.message)?'paused':'failed';
    if(code==='UNO_CONTEXT_BUDGET')job.needs_fresh_context=true;
    job.error_code=code;job.last_error={code,message:e.message,at:new Date().toISOString(),phase:job.phase,role:job.role,batch:job.batch_index};
    if(!held||budgetCode)job.detail=e.message;
    const call=job.calls.at(-1);if(call?.status==='running')call.status=signal.aborted?'cancelled':'failed';saveCompileJob(root,job);
  }finally{clearTimeout(timer);try{const current=readCompileJob(root,id);if(settleResumeGuard(current))saveCompileJob(root,current);}catch{}
    try{broadcastGraphEvent(initial.owner_session_id??initial.session_id,{type:'graph_changed',data:{}});}catch{}}
}
