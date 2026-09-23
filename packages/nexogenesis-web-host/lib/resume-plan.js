import { sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { CONTENT_SAFETY_MESSAGE, isContentSafetyRejection } from '../../nexogenesis-tools/lib/content-safety.js';
import { bookProgress, bookResumeState } from '../../nexogenesis-tools/lib/uno/book-agent.js';
import { isBookWorkflow } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { pendingBatches } from '../../nexogenesis-tools/lib/uno/recovery.js';
import { normalizeGeneratedEnvelope, parseUnitJSON } from './unit-card-request.js';
import { isolationEnabled, canIsolateFailure } from '../../nexogenesis-tools/lib/uno/compile-isolation.js';
import { workRelationEvidenceIssues } from '../../nexogenesis-tools/lib/uno/compile-reference-scope.js';
import { parseConstructionJSON, validateConstructionAuthorResponse } from './construction-request.js';

export const RESUME_PLAN_CONTRACT='uno-resume-plan-v1';

const digest = value => sha(JSON.stringify(value));
const action = (id,label,effect) => ({id,label,effect});
const failureOf = job => job.last_failure??job.last_error??null;

export function resumeStateFingerprint(job) {
  const ref=job.book_focus_refs?.[0],work=ref?job.unit_work?.[ref]:null;
  const response = value => value?{phase:value.phase,key:value.key??null,text_hash:digest(String(value.text??'')),recovered:value.recovered?.fingerprint??null}:null;
  const bookWork=work?{
    source_revision:work.source_revision,phase:work.phase,cards_hash:digest(work.cards??null),published:work.published??{},reused:work.reused??{},
    pending_issues:work.pending_issues??{},repair_counts:work.repair_counts??{},checks:work.checks??{},verifying:work.verifying??null,
    coverage_recovery:work.coverage_recovery??null,response:response(work.response),last_response:response(work.last_response)
  }:null;
  return digest({mode:job.mode,workflow:job.workflow,phase:job.phase,batch_index:job.batch_index,
    book_focus_refs:job.book_focus_refs??[],book_outcomes:job.book_outcomes??{},failures:job.failures??[],book_work:bookWork,
    role:job.role,checkpoint:job.checkpoint,completed_batches:job.completed_batches??[],repair_ids:job.repair_ids??[],
    reviewed:job.reviewed??{},domain_proposals:job.domain_proposals??[],pending:job.pending??null,scope_conflicts:job.scope_conflicts??[],
    relation_weaving:job.relation_weaving?{contract:job.relation_weaving.contract,needs_replan:job.relation_weaving.needs_replan??false,
      rounds:job.relation_weaving.rounds??[],topology:job.relation_weaving.last_diagnosis?.topology_fingerprint??null}:null});
}

const finish = (job,plan) => ({contract:RESUME_PLAN_CONTRACT,...plan,
  fingerprint:digest({kind:plan.kind,reason:plan.reason,actions:(plan.actions??[]).map(row=>row.id),state:resumeStateFingerprint(job),error:failureOf(job)?.code??job.error_code??null})});

function repeatedNoProgress(job) {
  const last=job.last_resume;
  return last?.contract===RESUME_PLAN_CONTRACT&&last.status==='no_progress'
    &&last.state_fingerprint===resumeStateFingerprint(job)
    &&last.error_code===(failureOf(job)?.code??job.error_code??null);
}

function bookPlan(job) {
  if(['completed','ended'].includes(job.status)||job.end_requested)return finish(job,{kind:'complete',reason:'本次编译已结束。',actions:[]});
  if(job.status==='review'&&job.phase==='domain_review')return finish(job,{kind:'review',reason:'请先处理领域治理提案；确认或暂缓后才会继续。',actions:[]});
  const progress=bookProgress(job),range=bookResumeState(job),failure=failureOf(job);
  const focusedRef=job.book_focus_refs?.find(candidate=>job.unit_work?.[candidate]&&![ 'processed','quarantined' ].includes(job.book_outcomes?.[candidate]?.status));
  const deferredRef=(job.book_units??[]).find(unit=>job.book_outcomes?.[unit.ref]?.status==='deferred'&&job.unit_work?.[unit.ref])?.ref;
  const ref=focusedRef??deferredRef??progress.focus?.[0]?.ref,work=ref?job.unit_work?.[ref]:null;
  const rejectedIds=Object.keys(work?.pending_issues??{}),alreadyDeferred=job.book_outcomes?.[ref]?.status==='deferred';
  if(job.phase==='done'&&!range.available)return finish(job,{kind:'blocked',reason:range.reason,actions:[]});
  if(job.workflow==='uno-unit-compile-v3'&&alreadyDeferred&&!progress.pending&&!rejectedIds.length)return finish(job,{kind:'decision',
    reason:'主线已处理完毕；延期内容仍未完成。可以单独重试一个延期单元，其他延期项保持不变。',
    actions:[action('retry-deferred-unit',`重试延期单元：${job.book_units.find(unit=>unit.ref===ref)?.title??'当前单元'}`,'只重新打开这个延期单元；不重跑已完成或其他延期内容，仍需通过原审核。')]});
  if(failure?.code==='UNDELIVERED_EVIDENCE'&&isolationEnabled(job)&&workRelationEvidenceIssues(work).length)return finish(job,{kind:'resume',
    reason:'缺少完整关系依据的候选将保留到未组织池；合规卡片继续审核保存，旧延期项保持不变。',
    primary:action('resume','保留问题并继续编译','复用已生成候选，隔离依据不完整的关系问题，不重新生成整个单元。'),actions:[]});
  if(job.operation==='isolated-card-repair'&&failure?.code==='UNDELIVERED_EVIDENCE')return finish(job,{kind:'resume',
    reason:'关系目标卡在修复期间发生了变化。系统会读取它的最新完整正文，再重新核对当前卡；写入前的安全检查已经阻止旧依据落库。',
    primary:action('resume','读取最新目标卡并继续','刷新当前关系目标的正文与版本，只重新执行当前检查点；通过复核后才会保存。'),actions:[]});
  if(isContentSafetyRejection(failure))return finish(job,{kind:ref?'decision':'blocked',reason:CONTENT_SAFETY_MESSAGE,
    actions:ref?[action('defer-unit','延期当前单元并继续','保留当前单元及失败记录，继续处理后续单元；延期内容仍算未完成。')]:[]});
  if(repeatedNoProgress(job))return finish(job,{kind:'decision',reason:'上一次继续没有改变当前检查点，再次点击同一动作仍会回到相同停点。',
    actions:ref?[action('defer-unit','延期当前单元并继续','保留原文、失败记录和已保存成果，把当前单元列为延期后处理下一单元。')]:[]});
  if(isolationEnabled(job)&&failure&&canIsolateFailure(failure)&&range.available)return finish(job,{kind:'resume',
    reason:'保留已保存成果；无法局部恢复的问题进入未组织池，继续后续单元。',
    primary:action('resume','保留问题并继续编译','问题候选与原响应保留，可在未组织池逐项修复。'),actions:[]});
  if(failure?.code==='UNIT_CARD_REPAIR_EXHAUSTED'||(alreadyDeferred&&work?.phase==='deferred'&&rejectedIds.length)){
    const actions=[];
    if(rejectedIds.length&&isolationEnabled(job))actions.push(action('quarantine-candidates','保留到未组织池并继续','不删除候选；当前单元按待修复结算，主线继续，之后可从未组织池逐项修复。'));
    if(rejectedIds.length)actions.push(action('discard-candidates','放弃未通过候选并继续','记录审核意见，不保存未通过候选；当前单元按实际通过成果结算。'));
    if(!alreadyDeferred)actions.push(action('defer-unit','延期当前单元并继续','保留候选、审核意见和已保存成果，暂不结算当前单元。'));
    return finish(job,{kind:actions.length?'decision':'blocked',reason:alreadyDeferred
      ?(isolationEnabled(job)?'自动修订已到上限。建议保留到未组织池，让主线继续；以后可逐项修复。':'延期单元中的候选仍处于修订上限，普通继续只会回到相同停点。可以放弃未通过候选，或结束任务并保留延期记录。')
      :(isolationEnabled(job)?'自动修订已到上限。建议保留问题并继续主线；不会删除候选。':'候选卡已经达到修订上限，普通继续不会重新开放修订。'),actions});
  }
  if(failure?.code==='UNIT_COVERAGE_BLOCKED')return finish(job,{kind:'decision',reason:'本单元仍有未解决的覆盖问题，普通继续不会绕过原审核结论。',
    actions:[action('defer-unit','延期当前单元并继续','保留候选、遗漏记录和已保存成果，继续后续单元。')]});
  if(job.workflow==='uno-unit-compile-v3' && !alreadyDeferred && work?.phase==='generate' && !work.cards
    && ['UNIT_COMPILE_STOPPED','INVALID_GENERATION_RESPONSE'].includes(failure?.code)){
    const retained=work.last_response?.phase==='generate'?work.last_response:null;
    try{
      if(retained && normalizeGeneratedEnvelope(parseUnitJSON(retained.text)).changes.length)return finish(job,{kind:'resume',
        reason:'已保留完整候选，仅缺覆盖说明；可以直接进入正常审核，无需重新制卡。',
        primary:action('resume','审核已保留候选并继续','复用原响应中的候选；覆盖说明标记为未提供，仍须通过审核与写入校验。'),actions:[]});
    }catch{}
  }
  if(failure&&!failure.retryable)return finish(job,{kind:ref?'decision':'blocked',reason:failure.message||'当前失败没有安全的普通重试路径。',
    actions:ref?[action('defer-unit','延期当前单元并继续','保留当前检查点和已保存成果，继续后续单元。')]:[]});
  if((job.failures??[]).length)return finish(job,{kind:'resume',reason:'存在提取或归档失败项。',
    primary:action('resume','重试失败材料并继续','只重试失败材料；已处理单元和已保存成果不会重复生成。'),actions:[]});
  if(failure?.code==='MODEL_EMPTY_RESPONSE')return finish(job,{kind:'resume',reason:failure.message,
    primary:action('resume','重新请求当前单元','丢弃当前单元的空传输响应，保留其他单元和已保存成果。'),actions:[]});
  if(failure?.code==='MODEL_OUTPUT_TRUNCATED')return finish(job,{kind:'resume',reason:failure.message,
    primary:action('resume','续写当前单元','从已保存的完整候选后继续，不重新生成已保留候选。'),actions:[]});
  if(failure?.code==='UNDELIVERED_EVIDENCE')return finish(job,{kind:ref?'decision':'blocked',reason:'关系依据尚未完整交付，普通重试不能解决；请核对依据或延期当前单元。',
    actions:ref&&!alreadyDeferred?[action('defer-unit','延期当前单元并继续','保留候选和失败记录，不绕过关系依据与版本检查。')]:[]});
  if(failure?.retryable)return finish(job,{kind:'resume',reason:failure.message,
    primary:action('resume','重试当前检查点','保留已保存成果，只重新执行失败的当前检查点。'),actions:[]});
  if(range.available)return finish(job,{kind:'resume',reason:'任务仍有明确的未完成范围。',
    primary:action('resume','从当前检查点继续','沿用已保存检查点，处理下一项未完成工作。'),actions:[]});
  return finish(job,{kind:'blocked',reason:range.reason||'当前没有可执行的恢复路径。',actions:[]});
}

function constructionPlan(root,job) {
  if(['completed','ended'].includes(job.status)||job.end_requested)return finish(job,{kind:'complete',reason:'本次建构已结束。',actions:[]});
  if(job.status==='review')return finish(job,{kind:'review',reason:'请先确认本批待发布内容。',actions:[]});
  if(repeatedNoProgress(job))return finish(job,{kind:'blocked',reason:'上一次继续没有改变建构检查点；请查看当前问题或结束本次任务，不能重复空转。',actions:[]});
  if((job.scope_conflicts??[]).length)return finish(job,{kind:'blocked',reason:'当前范围存在卡片退役或版本冲突，需要重新建立建构范围。',actions:[]});
  if(job.workflow==='uno-construction-v1'&&job.status==='failed'&&job.phase==='strategy_pending'
    &&job.last_error?.code==='INVALID_GENERATION_RESPONSE'){
    const retained=[...(job.calls??[])].reverse().find(row=>row.phase==='construction-strategy'&&row.status==='completed'&&row.response?.trim());
    try{
      if(retained&&parseConstructionJSON(retained.response))return finish(job,{kind:'resume',
        reason:'策略响应内容完整，仅缺少可确定补齐的尾部 JSON 闭合符；可以复用原响应继续，不重新请求策略。',
        primary:action('resume','恢复已保留策略并继续','确定性补齐尾部闭合符，重新通过策略契约校验后进入建构工作包。'),actions:[]});
    }catch{}
  }
  if(job.workflow==='uno-construction-v1'&&job.status==='failed'&&job.phase==='strategy_pending'
    &&job.last_error?.code==='MODEL_OUTPUT_TRUNCATED')return finish(job,{kind:'resume',reason:'策略请求在完整 JSON 返回前达到输出上限；失败响应已保留，且尚未产生知识写入。',
      primary:action('resume','重新请求策略与选卡','使用当前策略输入重新请求一次；不会重放知识写入或把截断响应当作完成。'),actions:[]});
  if(job.workflow==='uno-construction-v1'&&job.status==='failed'
    &&['MODEL_OUTPUT_TRUNCATED','MODEL_RESPONSE_INCOMPLETE','MODEL_EMPTY_RESPONSE'].includes(job.last_error?.code))return finish(job,{kind:'resume',reason:job.last_error.message,
      primary:action('resume',job.phase==='reviewing'||job.phase==='verifying'?'重试当前审核':'重试当前建构步骤','复用已经完成并保存的前置步骤，只重新请求失败的当前阶段；不会自动循环。'),actions:[]});
  if(job.workflow==='uno-construction-v1'&&job.status==='failed'
    &&['CONSTRUCTION_AUTHOR_CONTRACT','CONSTRUCTION_REVIEW_CONTRACT'].includes(job.last_error?.code))return finish(job,{kind:'resume',
      reason:'当前模型响应已完整保留，但局部 JSON 契约仍不合规；作者结果、审核前检查点和已保存成果均未丢失。',
      primary:action('resume',job.last_error.code==='CONSTRUCTION_REVIEW_CONTRACT'?'修复审核格式并继续':'修复执行格式并继续',
        '只把失败响应、校验错误和局部 Schema 交给一次格式恢复；不重新发送卡片正文、不重做已经完成的作者或审核步骤。'),actions:[]});
  if(job.workflow==='uno-construction-v1'&&job.status==='failed'&&job.phase==='repairing'
    &&job.last_error?.code==='CONSTRUCTION_DECISION_PREFLIGHT'){
    const pack=job.construction_plan?.packages?.[job.batch_index],work=job.direct_work?.[job.batch_index];
    const rejected=work?.review?.reviews?.filter(row=>row.decision==='reject').map(row=>row.id)??[];
    try{
      const repaired=validateConstructionAuthorResponse(work?.repair,rejected);
      const allowed=new Set(pack?.card_ids??[]),ids=new Set(rejected);
      const safe=Boolean(pack&&rejected.length&&!work.repair_staged&&!work.repair_used
        &&repaired.decisions.every(row=>ids.has(row.id)&&(!row.changes.relations
          ||row.changes.relations.every(relation=>allowed.has(relation?.target)))));
      if(safe)return finish(job,{kind:'resume',reason:'审核后的局部修复已经完整保留；更新后的宿主可按原工作包的完整端点范围重新预检。',
        primary:action('resume','应用已保存修复并复核','不重新调用作者、首次审核或修复；宿主重新校验已保存修复，通过后只为当前轮发出一次独立复核，再按原连续处理设置继续。'),actions:[]});
    }catch{}
  }
  if(job.status==='failed'&&job.last_error&&!['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE','UNO_BUDGET','UNO_CONTEXT_BUDGET','CONSTRUCTION_CONTEXT_LIMIT'].includes(job.last_error.code))
    return finish(job,{kind:'blocked',reason:job.last_error.message||'当前建构失败没有安全的普通重试路径。',actions:[]});
  if(job.phase==='done'){
    const pending=root?pendingBatches(root,job):[];
    if(job.status==='partial'&&pending.length)return finish(job,{kind:'resume',reason:'已有批次仍有未发布草稿或未解决审核项。',
      primary:action('resume','继续未完成批次','恢复最早的未完成批次，不重做已发布成果。'),actions:[]});
    return finish(job,{kind:'blocked',reason:'本轮没有可恢复的未完成批次；如需处理其他范围，请新建建构任务。',actions:[]});
  }
  const budget=['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE','UNO_BUDGET'].includes(job.last_error?.code);
  const compact=job.last_error?.code==='CONSTRUCTION_CONTEXT_LIMIT';
  return finish(job,{kind:'resume',reason:budget?'当前检查点因请求额度停止。':compact?'模型请求尚未发送；可以按当前版本重新生成精简的局部上下文。':'当前建构保留了可恢复检查点。',
    primary:action('resume',budget?'补充额度并继续':compact?'精简当前上下文并继续':'从当前检查点继续',budget?'增加本轮可用额度，保留已有草稿与审核记录。':compact?'保留作者结果、草稿和请求账本，只重新建立尚未发送的当前阶段请求。':'沿用当前阶段、草稿、审核和收据继续。'),actions:[]});
}

export function computeResumePlan(root,job) {
  return isBookWorkflow(job.workflow)?bookPlan(job):constructionPlan(root,job);
}

export function armResumeGuard(job,plan) {
  job.resume_guard={contract:RESUME_PLAN_CONTRACT,plan_fingerprint:plan.fingerprint,state_fingerprint:resumeStateFingerprint(job),
    error_code:failureOf(job)?.code??job.error_code??null,at:new Date().toISOString()};
}

export function settleResumeGuard(job) {
  const guard=job.resume_guard;if(guard?.contract!==RESUME_PLAN_CONTRACT)return false;
  const state=resumeStateFingerprint(job),error=failureOf(job)?.code??job.error_code??null;
  const noProgress=state===guard.state_fingerprint&&error===guard.error_code&&['paused','failed','partial'].includes(job.status);
  job.last_resume={contract:RESUME_PLAN_CONTRACT,status:noProgress?'no_progress':'progressed',plan_fingerprint:guard.plan_fingerprint,
    state_fingerprint:state,error_code:error,at:new Date().toISOString()};
  delete job.resume_guard;
  return true;
}
