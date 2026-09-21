import { listDrafts } from '../../nexogenesis-tools/lib/uno/drafts.js';
import { batchTask } from '../../nexogenesis-tools/lib/uno/construction-workflow.js';
import { saveCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { getProviderBudget, bindProviderBudgetSession } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { MODEL_PROVIDERS } from '../../nexogenesis-tools/lib/model-providers.js';
import { HttpError } from './rpc.js';
import { NATIVE_KIMI_ROUTE, nativeKimiBudgetReady } from './native-kimi-budget.js';

export const isBounded = job => job.orchestration_profile === 'bounded-workflow-v1';
// Compatible adapters meter their fetch directly; native Code Plan additionally
// requires this host's active transport bridge before any task may start/resume.
const budgetedRoutes = new Set(Object.values(MODEL_PROVIDERS).filter(p=>p.id!=='kimi_code_plan').map(p=>p.route));
export function assertBoundedModel(job,selection=job.model_selection,ctx) {
  const metered=budgetedRoutes.has(selection?.provider)||(selection?.provider===NATIVE_KIMI_ROUTE&&nativeKimiBudgetReady(ctx));
  if(isBounded(job)&&(!metered||typeof selection?.model!=='string'||!selection.model.trim())) {
    throw Object.assign(new HttpError(400,'[UNO_BUDGET_MODEL_UNSUPPORTED] 当前模型路由未接入请求预算计数，不能执行有界知识工作；请选择已接入的 API 模型后新建任务。'),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
  }
  return selection;
}
const budgetStopCodes=new Set(['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE','UNO_BUDGET','UNO_CONTEXT_BUDGET','UNO_CONTEXT_ADAPTER']);
export function budgetStopCode(error) {
  if(budgetStopCodes.has(error?.code))return error.code;
  return String(error?.message??'').match(/\bUNO_(?:PROVIDER_BUDGET|STAGE_BUDGET|REVIEW_RESERVE|CONTEXT_BUDGET|CONTEXT_ADAPTER|BUDGET)\b/)?.[0]??null;
}
function budgetPolicy(root,job,budget=getProviderBudget(root,job.id)) {
  if(!job.provider_budget_policy){
    const reviewReserve=Math.min(3,Math.max(1,Math.floor(budget.limit/3)));
    job.provider_budget_policy={initial_limit:budget.limit,review_reserve:reviewReserve};
    saveCompileJob(root,job);
  }
  // Raising the total limit never rewrites already chosen stage allowances.
  return job.provider_budget_policy;
}
export function nextPackageMinimum(root,job) {
  return isBounded(job)?budgetPolicy(root,job).review_reserve+1:20;
}
export function bindWorkflowBudget(root,job) {
  if(!isBounded(job))return null;
  const budget=getProviderBudget(root,job.id),policy=budgetPolicy(root,job,budget);
  const role=job.role??'author',round=job.repair_rounds?.[job.batch_index]??0,
    packageId=`batch-${job.batch_index}-repair-${round}`,
    stageId=`batch-${job.batch_index}-${role}-repair-${round}-resume-${job.resume_round??0}`;
  // The ledger owns existing stage/package values, including pre-policy jobs.
  // Construction keeps author and independent reviewer allowances separate.
  let stageLimit;
  if(budget.current?.stageId!==stageId){
    stageLimit={author:6,reviewer:4}[role];
    if(!stageLimit)throw new Error('建构执行角色无效。');
  }
  return bindProviderBudgetSession(root,{jobId:job.id,sessionId:job.session_id,
    packageId,role,stageId,stageLimit,
    reviewReserve:budget.current?.packageId===packageId?undefined:policy.review_reserve});
}

/** One automatic revision of explicit objections, never an unbounded review loop. */
export function requestBoundedRepair(root,job) {
  if(!isBounded(job)||job.role!=='reviewer'||!job.finish_requested)return false;
  const drafts=listDrafts(root,batchTask(job)).filter(d=>d.state!=='published');
  const ids=[...new Set([...drafts.filter(d=>d.state==='rejected'||job.reviewed?.[d.card.id]?.issues?.length).map(d=>d.card.id),
    ...Object.entries(job.reviewed??{}).filter(([,r])=>r.unchanged&&r.issues?.length).map(([id])=>id)])];
  if(!ids.length||(job.repair_rounds?.[job.batch_index]??0)>=1||getProviderBudget(root,job.id).remaining<nextPackageMinimum(root,job))return false;
  (job.repair_rounds??={})[job.batch_index]=1;
  job.repair_ids=ids;job.finish_requested=false;job.handoff_requested=false;job.phase='read';job.role='author';
  job.checkpoint='仅修订独立审核明确指出的对象：'+ids.join('、')+'。已通过对象保持不变；仍无法解决的问题留待修。';
  job.detail='独立审核发现具体问题，进入一次有界修订。';saveCompileJob(root,job);return true;
}

/** Exhaustion may hand existing construction drafts to the reserved review stage. */
export function handoffAtAuthorBudget(root,job,error) {
  if(!isBounded(job)||job.mode!=='construct'||job.role!=='author'||job.end_requested||job.pause_requested
    || !['UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE'].includes(error?.code))return false;
  const drafts=listDrafts(root,batchTask(job)).filter(d=>d.state!=='published');
  if(!drafts.length||getProviderBudget(root,job.id).remaining<1)return false;
  job.handoff_requested=true;job.finish_requested=false;
  job.detail='作者额度已用尽，保留真实缺口，使用预留额度核验已有草稿。';saveCompileJob(root,job);return true;
}
