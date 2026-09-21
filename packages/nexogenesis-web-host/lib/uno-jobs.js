import {CONSTRUCTION_CONTROLS,CONSTRUCTION_OPERATIONS,validateConstructionControls,constructionGoal} from '../../nexogenesis-tools/lib/construction-controls.js';
import { selectionSummary } from '../../nexogenesis-tools/lib/uno/history.js';
import { resumeUnfinishedBatch } from '../../nexogenesis-tools/lib/uno/recovery.js';
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadCards, listInbox } from "../../nexogenesis-tools/lib/cards.js";
import { displayType, safeId } from "../../nexogenesis-tools/lib/uno-contract.js";
import { CARD_CLASSIFICATION_CONTRACT, CARD_TYPES, CARD_TYPE_LABELS, domainCatalogRows } from '../../nexogenesis-tools/lib/uno/card-classification.js';
import { listDomainsV2 } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { sha, readUnoReceipt, readUnoUnit, unoPath, unoRevision } from "../../nexogenesis-tools/lib/harness/uno-storage.js";
import { ensureModelRoute, pipelineAuthorityOf, workflowModelSelectionFromSettings } from "./settings.js";
import { ensureDefaultProject, patchConversationExt, conversationExt } from "./meta.js";
import { isQuickThinkingRunning } from './quick-thinking.js';
import { HttpError, json, readJsonBody, rpcCall } from "./rpc.js";
import { COMPILE_HINTS } from '../../nexogenesis-tools/lib/compile-options.js';
import { CONSTRUCTION_WORKFLOW, scheduleBatches } from '../../nexogenesis-tools/lib/uno/construction-workflow.js';
import { readPreferences, savePreferences, freezePreferences, countPreferences, preferenceText, longTermPreferenceText } from '../../nexogenesis-tools/lib/uno/preferences.js';
import { executeConstruction, finalizeConstructionBatch } from './construction-host.js';
import { CONSTRUCTION_REPAIR_SCOPE_CONTRACT, executeStrategyConstruction, isStrategyConstruction } from './construction-service.js';
import { currentInstanceRegistry } from '../../nexogenesis-tools/lib/instances/registry.js';
import { EVIDENCE_PACK_PROFILE } from '../../nexogenesis-tools/lib/uno/evidence-pack.js';
import { initializeProviderBudget, getProviderBudget, raiseProviderBudget, replenishProviderBudget } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { assertBoundedModel, isBounded } from './uno-orchestration.js';
import { CONSTRUCTION_PROFILE, planConstruction } from '../../nexogenesis-tools/lib/uno/construction-plan.js';
import { STRATEGY_CONSTRUCTION_PROFILE, STRATEGY_CONSTRUCTION_WORKFLOW, CONSTRUCTION_STRATEGY_CONTRACT,
  CONSTRUCTION_REVIEW_POLICY } from '../../nexogenesis-tools/lib/uno/construction-strategy.js';
import { relationWeavingEnabled, RELATION_WEAVING_CONTRACT, RELATION_WEAVING_ENDPOINT_RETRIEVAL,
  RELATION_WEAVING_FOCUS_SELECTION, RELATION_WEAVING_MAX_FOCUS_ATTEMPTS } from '../../nexogenesis-tools/lib/uno/construction-weaving.js';
import { BOOK_WORKFLOW, BOOK_PROFILE, COMPILE_REVIEW_POLICY, COMPILE_QUALITY_MODES, COMPILE_QUALITY_STANDARD, COMPILE_QUALITY_REFINE_EACH_CARD, applyPendingDomainProposals, assertBookPauseDecision, completeBookState, executeBookCompile, prepareBookResume, resolveBookPause } from './book-compile.js';
import { armResumeGuard, computeResumePlan } from './resume-plan.js';
import { isBookWorkflow } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { readBookUnit } from '../../nexogenesis-tools/lib/uno/book-store.js';
import { readDomainGovernanceState } from '../../nexogenesis-tools/lib/uno/domain-governance.js';
import { listUnassignedCards } from '../../nexogenesis-tools/lib/uno/card-management.js';
import { COMPILE_ISOLATION, listCompileIsolation, findCompileIsolation, compileIsolationSummary } from '../../nexogenesis-tools/lib/uno/compile-isolation.js';
import { prepareIsolationRepair, bindIsolationRepair } from '../../nexogenesis-tools/lib/uno/compile-repair.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';
import { BOOK_ASSET_REF } from '../../nexogenesis-tools/lib/uno/book-paths.js';
import { bookEvidencePath } from '../../nexogenesis-tools/lib/uno/book-evidence.js';
import { saveCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { SINGLE_CARD_RECOMPILE_CONTRACT } from './single-card-recompile.js';
import { CONSTRUCTION_JSON_TAIL_RECOVERY, CONSTRUCTION_RESPONSE_RECOVERY_CONTRACT } from './construction-request.js';

const active = new Map();
const starting = new Set();
let shutdownPrepared = false;
const labels = { compile: "编译", construct: "建构" };
const FOCUSED_MAINTENANCE_OPERATIONS = new Set(['isolated-card-repair','unassigned-card-recompile','unassigned-card-domain']);
export const DEFAULT_COMPILE_PROFILE = BOOK_PROFILE;
export const DEFAULT_COMPILE_REVIEW_POLICY = COMPILE_REVIEW_POLICY;
export const isUnoFocusedMaintenanceJob = job => FOCUSED_MAINTENANCE_OPERATIONS.has(job?.operation);
export const isUnoJobRunning = sessionId => [...active.entries()].some(([id,a]) => {
  const job = readUnoJob(a.root,id);
  return job.owner_session_id === sessionId || job.session_id === sessionId || job.sessions?.includes(sessionId);
});
export const hasUnoJobRunning = root => [...active.values()].some(a => a.root === resolve(root));
export const hasAnyUnoJobRunning = () => active.size > 0;
export const unoShutdownPrepared = () => shutdownPrepared;
export function prepareUnoShutdown({ pendingMutations = 0 } = {}) {
  if (active.size || starting.size || pendingMutations) return { ready:false, active_jobs:active.size, starting_jobs:starting.size, pending_mutations:pendingMutations };
  shutdownPrepared = true;
  return { ready:true, active_jobs:0, starting_jobs:0, pending_mutations:0 };
}
export function cancelUnoShutdown() {
  shutdownPrepared = false;
  return { ready:false };
}
export function unoConversationJob(root, sessionId) {
  const id = conversationExt(sessionId).uno_job_id;
  if (!id) return null;
  const job = readUnoJob(root,id);
  if (![job.owner_session_id, job.session_id, ...(job.sessions ?? [])].includes(sessionId)) throw new HttpError(409,'任务与会话归属不一致。');
  return job;
}
export const unoJobEnded = job => ['completed','ended'].includes(job.status);
export const unoJobCanResume = (root,job) => isCurrentUnoJob(job) && computeResumePlan(root,job).kind === 'resume';
export function assertUnoVersion(job, body) {
  if (body.expected_job_id !== undefined && body.expected_job_id !== job.id) throw new HttpError(409,'任务已经变化，请刷新后重试。');
  if (body.version !== undefined && body.version !== job.version) throw new HttpError(409,'任务状态已变化，请刷新后重试。');
}
export function cancelUnoJob(root,id) {
  const job = readUnoJob(root,id), running = active.get(id);
  if (["completed","ended"].includes(job.status) || job.end_requested) return job;
  if (running) {job.pause_requested=true;save(root,job);running.controller.abort(new Error("用户暂停了任务。"));}
  else { job.status = "paused"; job.detail = "已暂停，尚未确认的内容保留。"; save(root,job); }
  return running ? { ...job, detail: "正在停止，已提交的成果保留。" } : job;
}
function finishEndedJob(root, job) {
  const closingDetail = String(job.detail ?? '').trim();
  if (closingDetail && !job.closed_from_detail && !closingDetail.startsWith('本次任务已结束。')) job.closed_from_detail = closingDetail;
  job.status = "ended"; job.phase = "ended"; job.ended_at ??= new Date().toISOString();
  job.detail = "本次任务已结束。已保存成果、草稿和原始材料保留，未处理内容不会计为完成；后续可新建任务继续整理。"
    + (job.closed_from_detail ? ` 关闭前状态：${job.closed_from_detail}` : '');
  save(root, job);
  for (const id of new Set([job.owner_session_id, job.session_id].filter(Boolean))) {
    const ext=conversationExt(id);
    if(ext.pin_source!=='user')patchConversationExt(id, {pinned: false, pin_source:null});
  }
  return job;
}
export function endUnoJob(root, id) {
  const job = readUnoJob(root, id), running = active.get(id);
  if (unoJobEnded(job)) return job;
  job.end_requested = true;
  if (!running) return finishEndedJob(root, job);
  running.endRequested = true;
  job.detail = "正在结束任务，等待当前执行退出；已有成果会保留。"; save(root, job);
  running.controller.abort(new Error("用户结束本次任务。"));
  return job;
}
const jobRef = id => {
  if (!safeId(id)) throw new HttpError(400, "任务标识无效。");
  return ".nexogenesis/uno-jobs/" + id + ".json";
};
function save(root, job) {
  try { return saveCompileJob(root,job,{expectedVersion:job.version}); }
  catch(error){if(error?.code==='UNO_JOB_VERSION_CONFLICT')throw new HttpError(409,error.message);throw error;}
}
export function readUnoJob(root, id) {
  const file = unoPath(root, jobRef(id));
  if (!existsSync(file)) throw new HttpError(404, "任务不存在。");
  const job = JSON.parse(readFileSync(file, "utf8"));
  if(job.orchestration_profile==='bounded-workflow-v1')try{job.provider_budget=getProviderBudget(root,id);}catch{job.provider_budget={available:false,message:'请求预算记录不可用；执行前需要恢复，不能按零消费继续。'};}
  if (isBookWorkflow(job.workflow) && job.phase === 'done' && ['partial','completed'].includes(job.status)) completeBookState(job);
  return job;
}
export function recoverInterruptedUnoJobs(root) {
  const dir=unoPath(root,'.nexogenesis/uno-jobs'),result={recovered:0,ended:0,errors:[]};
  if(!existsSync(dir))return result;
  for(const name of readdirSync(dir).filter(file=>file.endsWith('.json'))){
    try{
      const job=JSON.parse(readFileSync(unoPath(root,'.nexogenesis/uno-jobs/'+name),'utf8'));
      if(active.has(job.id))continue;
      if(job.end_requested&&job.status!=='ended'){finishEndedJob(root,job);result.ended++;continue;}
      if(job.status!=='running')continue;
      const interruptedAt=new Date().toISOString();
      for(const call of job.calls??[])if(call.status==='running'){
        call.status='interrupted';call.finished_at??=interruptedAt;
        call.error??='服务进程在模型响应完成前退出；未收到的响应不计入成果。';
      }
      job.status='paused';
      job.detail=isCurrentUnoJob(job)?'上次执行已中断；未完成请求不计入成果，继续时从当前检查点恢复。':'旧执行流程已退役，历史进度与已有成果保留；请从当前入口新建任务。';
      save(root,job);result.recovered++;
    }catch(error){
      result.errors.push({file:name,detail:error instanceof Error?error.message:String(error)});
    }
  }
  return result;
}
function inboxCompilationInventory(root, jobs) {
  const inbox = listInbox(root), ordered = [...jobs].sort((a,b) => String(b.updated_at??b.created_at??'').localeCompare(String(a.updated_at??a.created_at??'')));
  const archived_sources = [], sources = [];
  for (const row of inbox) {
    const source = row.path.startsWith('00-Inbox/') ? row.path : `00-Inbox/${row.path}`;
    let archived = null;
    for (const job of ordered) {
      const receipt = (job.archives??[]).find(item => item?.archived===true && item.source===source && typeof item.key==='string');
      if (!receipt) continue;
      const stored = readUnoReceipt(root,receipt.key);
      if (stored?.accepted===true && stored.archived===true && stored.job_id===job.id && stored.source===source
        && stored.source_revision===receipt.source_revision && stored.source_ref===receipt.source_ref
        && unoRevision(root,source)===receipt.source_revision && unoRevision(root,receipt.source_ref)===receipt.source_revision) {
        archived={path:row.path,job_id:job.id,title:job.title,source_ref:receipt.source_ref,source_revision:receipt.source_revision};
        break;
      }
    }
    if (archived) { archived_sources.push(archived); continue; }
    const latest = ordered.find(job => !job.repair_origin && ((job.sources??[]).some(book=>book.original_source===source)||(job.selected_sources??[]).includes(source)));
    if (!latest || !(latest.book_units??[]).length) { sources.push(row); continue; }
    const total_units=latest.book_units.length,processed_units=latest.book_units.filter(unit=>latest.book_outcomes?.[unit.ref]?.status==='processed').length;
    const open_items=compileIsolationSummary(latest).open;
    const book=(latest.sources??[]).find(item=>item.original_source===source),allProcessed=processed_units===total_units;
    const compile_state=allProcessed?(book?.incomplete===true?'archive_review':'archive_pending'):'unfinished';
    sources.push({...row,compile_state,job_id:latest.id,processed_units,total_units,open_items});
  }
  return {sources,archived_sources};
}
export function unoPreparation(ctx, root) {
  const cards = [...loadCards(root)].filter(([,c]) => c.meta.type !== "domain").map(([id,c]) => ({ id, title: c.meta.title ?? id,
    type: displayType(c.meta), domains: Array.isArray(c.meta.domains) ? c.meta.domains : [] }));
  const domains = domainCatalogRows(listDomainsV2(root));
  const domainState=readDomainGovernanceState(root),unassignedCount=listUnassignedCards(root).length;
  // The preparation contract describes every writable type. Library contents
  // are observations, not the authority that defines the classification set.
  const types = CARD_TYPES.map(id => ({id,label:CARD_TYPE_LABELS[id]}));
  const dir = unoPath(root, ".nexogenesis/uno-jobs");
  const jobRecords = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => readUnoJob(root, f.slice(0,-5))) : [];
  const jobs = [...jobRecords].sort((a,b) => String(b.updated_at??'').localeCompare(String(a.updated_at??''))).slice(0,20)
    .map(j => ({ id: j.id, mode: j.mode, title: j.title, status: j.status, updated_at: j.updated_at }));
  const inbox=inboxCompilationInventory(root,jobRecords);
  const library=currentLibrary(root);
  // Historical Buffer is not an input queue for the new compiler. Opening the
  // picker must not traverse thousands of old intermediary files.
  const pending_materials=[];
  let construction_model={available:true};try{assertBoundedModel({orchestration_profile:'bounded-workflow-v1'},workflowModelSelectionFromSettings(ctx.settings?.get('nexogenesis')??{},'construct').selection,ctx);}catch(e){construction_model={available:false,message:e.message};}
  return { cards, types, domains, card_classification:CARD_CLASSIFICATION_CONTRACT, domain_governance:{contract:'domain-governance-v1',unassigned_count:unassignedCount,pending_proposals:Object.values(domainState.proposals).filter(row=>row.status==='proposed').length}, sources:inbox.sources,archived_sources:inbox.archived_sources,pending_materials, library, preferences:readPreferences(root),authority: pipelineAuthorityOf(ctx), jobs, construct_contract:'scoped-review-v1', construct_scope:'type-and-domain-v1', construction_controls:{contract:CONSTRUCTION_CONTROLS,operations:CONSTRUCTION_OPERATIONS.map(o=>o.id)},construction_profiles:[STRATEGY_CONSTRUCTION_PROFILE,CONSTRUCTION_PROFILE],default_construction_profile:STRATEGY_CONSTRUCTION_PROFILE,construction_strategy_contract:CONSTRUCTION_STRATEGY_CONTRACT,construction_review_policy:CONSTRUCTION_REVIEW_POLICY,construction_repair_scope:CONSTRUCTION_REPAIR_SCOPE_CONTRACT,relation_weaving_contract:RELATION_WEAVING_CONTRACT,relation_weaving_focus_selection:RELATION_WEAVING_FOCUS_SELECTION,relation_weaving_endpoint_retrieval:RELATION_WEAVING_ENDPOINT_RETRIEVAL,relation_weaving_max_focus_attempts:RELATION_WEAVING_MAX_FOCUS_ATTEMPTS,construction_json_recovery:CONSTRUCTION_JSON_TAIL_RECOVERY,construction_response_recovery:CONSTRUCTION_RESPONSE_RECOVERY_CONTRACT,uno_construction_service:1,uno_relation_weaving:1,construction_model,compile_profile:DEFAULT_COMPILE_PROFILE,compile_review_policy:DEFAULT_COMPILE_REVIEW_POLICY,compile_review_policies:[DEFAULT_COMPILE_REVIEW_POLICY],compile_card_refinement:COMPILE_QUALITY_REFINE_EACH_CARD,compile_quality_modes:COMPILE_QUALITY_MODES,domain_approval_modes:['manual','automatic'],compile_model:{...construction_model},execution_profiles:[EVIDENCE_PACK_PROFILE], orchestration_profiles:['bounded-workflow-v1'], compile_version:BOOK_WORKFLOW, compile_hints:COMPILE_HINTS };
}
function currentLibrary(root){
  const registry=currentInstanceRegistry(root),library=registry.instances.find(instance=>resolve(instance.root)===resolve(root));
  return {id:library?.id??null,name:library?.name??'当前知识库'};
}
// Persisted historical jobs remain readable; only the two current execution
// contracts may create model requests or publish changes.
export const isCurrentUnoJob = job =>
  (job.mode === 'compile' && isBookWorkflow(job.workflow))
  || (job.mode === 'construct' && [CONSTRUCTION_WORKFLOW,STRATEGY_CONSTRUCTION_WORKFLOW].includes(job.workflow));
const historicalMessage = '旧知识任务只保留历史记录与已有成果；请从当前入口新建任务，不能恢复已退役的执行流程。';
export async function executeUnoJob(ctx, root, job, controller) {
  if (!isCurrentUnoJob(job)) throw new HttpError(409, historicalMessage);
  if (job.mode === 'compile') return executeBookCompile(ctx, root, job, controller);
  if (isStrategyConstruction(job)) return executeStrategyConstruction(ctx, root, job, controller);
  return executeConstruction(ctx, root, job, controller);
}
async function superviseUnoExecution(ctx,root,job,controller,execution) {
  try {
    await executeUnoJob(ctx,root,job,controller);
  } catch(error) {
    try {
      const current=readUnoJob(root,job.id);
      if(current.end_requested) return;
      if(current.pause_requested||controller.signal.aborted||error?.code==='UNO_JOB_VERSION_CONFLICT'){
        current.status='paused';
        current.detail=error?.code==='UNO_JOB_VERSION_CONFLICT'
          ?'任务状态在执行期间发生变化，当前执行已安全暂停；刷新后可从已保存检查点继续。'
          :(current.detail||'任务已暂停，尚未确认的内容保留。');
      } else {
        current.status='failed';current.detail=error instanceof Error?error.message:String(error);
      }
      save(root,current);
    } catch(persistError) {
      console.error('nexogenesis: UNO 后台任务失败状态无法保存',persistError);
    }
  } finally {
    try {
      const current=readUnoJob(root,job.id);
      if(execution.endRequested||current.end_requested)finishEndedJob(root,current);
    } catch(settleError) {
      console.error('nexogenesis: UNO 后台任务结束状态无法结算',settleError);
    } finally {
      active.delete(job.id);
    }
  }
}
export function launch(ctx, root, job) {
  if (!isCurrentUnoJob(job)) throw new HttpError(409, historicalMessage);
  if (unoJobEnded(job) || job.end_requested) throw new HttpError(409, "本次任务已经结束，请新建任务处理剩余材料。");
  if (shutdownPrepared) throw new HttpError(503, "服务正在准备停止或重启，不能启动新的编译或建构任务。");
  if (hasUnoJobRunning(root)) throw new HttpError(409, "当前知识体已有编译或建构正在处理，请先暂停。");
  if (isQuickThinkingRunning(job.owner_session_id ?? job.session_id)) throw new HttpError(409,'请先等待讨论结束或暂停回答，再恢复工作。');
  const controller = new AbortController(); active.set(job.id, { root: resolve(root), sessionId: job.session_id, controller });
  job.status = "running"; job.pause_requested=false; saveCompileJob(root,job,{expectedVersion:job.version,resetControls:true});
  patchConversationExt(job.owner_session_id ?? job.session_id,{uno_discussing:false});
  const execution = active.get(job.id);
  void superviseUnoExecution(ctx,root,job,controller,execution);
}
export async function startUnoJob(ctx, root, input, appRoot=root) {
  if (shutdownPrepared) throw new HttpError(503, "服务正在准备停止或重启，不能创建新的编译或建构任务。");
  const requestId=input?.request_id;
  if(requestId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw new HttpError(400,'开始请求标识无效。');
  const requestHash=sha(JSON.stringify(Object.fromEntries(Object.entries(input??{}).filter(([key])=>key!=='request_id').sort(([a],[b])=>a.localeCompare(b)))));
  if(requestId&&existsSync(unoPath(root,jobRef(requestId)))){
    const previous=readUnoJob(root,requestId);
    if(previous.start_request_hash!==requestHash)throw new HttpError(409,'同一开始请求不能更改范围或要求。');
    return previous; // Reconnect/retry only reads the existing task; never launches it.
  }
  const key=resolve(root);if(starting.has(key))throw new HttpError(409,'另一个任务正在创建，请稍后重试。');
  starting.add(key);try{return await createUnoJob(ctx,root,{...input},appRoot,requestId,requestHash);}finally{starting.delete(key);}
}
/** Resolve an explicit write scope before creating any native session or task. */
export function selectConstructCards(inventory, input) {
  if (typeof input.notes !== 'string' || (input.domain && !inventory.domains.some(domain => domain.id === input.domain))
    || (input.type && !inventory.types.some(type => type.id === input.type))) {
    throw new HttpError(400, '建构范围或补充说明无效。');
  }
  const matching = inventory.cards.filter(card => (!input.domain || card.domains.includes(input.domain)) && (!input.type || card.type === input.type));
  if (input.card_ids === undefined) {
    if (!matching.length) throw new HttpError(400, '当前范围没有知识卡片。');
    return matching;
  }
  const ids = input.card_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new HttpError(400, '请选择不重复的有效卡片 ID，范围为 1–10000 张。');
  }
  const available = new Map(matching.map(card => [card.id, card]));
  if (ids.some(id => !available.has(id))) {
    throw new HttpError(400, '选定卡片不存在、已退役或不属于所选类型与领域范围，请重新选择。');
  }
  return ids.map(id => available.get(id));
}
async function createUnoJob(ctx, root, input, appRoot=root,requestId,requestHash) {
  if (!["compile","construct"].includes(input?.mode)) throw new HttpError(400, "请选择编译或建构。");
  const isolatedRepair=input.operation==='isolated-card-repair'&&input.mode==='compile';
  if(input.operation!==undefined&&!isolatedRepair&&(!['unassigned-card-recompile','unassigned-card-domain'].includes(input.operation)||input.mode!=='construct'))throw new HttpError(400,'未组织池单卡操作无效。');
  // Only new tasks adopt the default. startUnoJob already checked the original
  // request hash, so retrying a saved pre-upgrade request returns its old task.
  if(input.mode==='compile'){
    if(input.material_kind!==undefined&&!['auto','book','article'].includes(input.material_kind))throw new HttpError(400,'材料类型无效。');
    if(input.domain_approval_mode!==undefined&&!['manual','automatic'].includes(input.domain_approval_mode))throw new HttpError(400,'领域建设授权方式无效。');
    if(input.compile_profile!==BOOK_PROFILE)throw new HttpError(409,'编译入口已更新，请刷新后从 Inbox 选择原书。旧请求不会自动迁移或重放。');
    if(input.review_policy!==undefined&&input.review_policy!==DEFAULT_COMPILE_REVIEW_POLICY)throw new HttpError(400,'旧编译审核策略不能用于新图书编译。');
    if(input.compile_quality_mode!==undefined&&!COMPILE_QUALITY_MODES.includes(input.compile_quality_mode))throw new HttpError(400,'编译质量模式无效。');
    input.orchestration_profile='bounded-workflow-v1';input.delivery='auto';
  }else if(input.review_policy!==undefined)throw new HttpError(400,'建构不使用编译审核策略。');
  if (input.execution_profile !== undefined && input.execution_profile !== EVIDENCE_PACK_PROFILE) throw new HttpError(400, '知识工作执行版本无效，请刷新后重试。');
  if (input.orchestration_profile !== undefined && input.orchestration_profile !== 'bounded-workflow-v1') throw new HttpError(400, '知识工作编排版本无效。');
  if(input.construction_profile!==undefined&&(![CONSTRUCTION_PROFILE,STRATEGY_CONSTRUCTION_PROFILE].includes(input.construction_profile)||input.mode!=='construct'||input.orchestration_profile!=='bounded-workflow-v1'))throw new HttpError(400,'建构版本与编排方式不匹配。');
  if(input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE&&!input.construction_controls)throw new HttpError(400,'策略建构必须明确本次侧重与允许操作。');
  if(input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE&&input.delivery!==undefined&&input.delivery!=='auto')throw new HttpError(400,'策略建构由独立审核通过后自动结算，不使用人工发布模式。');
  if(input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE&&Array.isArray(input.card_ids)&&input.card_ids.length>24)throw new HttpError(400,'策略建构最多指定 24 张锚点卡片。');
  if(input.construction_controls!==undefined){
    if(input.mode!=='construct'||![CONSTRUCTION_PROFILE,STRATEGY_CONSTRUCTION_PROFILE].includes(input.construction_profile))throw new HttpError(400,'建构控制只能用于当前建构任务。');
    try{input.construction_controls=validateConstructionControls(input.construction_controls);input.construction_query=String(input.notes??'').trim();input.notes=constructionGoal(input.construction_controls,input.notes);}catch(e){throw new HttpError(400,e.message);}
  }
  if(input.orchestration_profile==='bounded-workflow-v1'&&input.mode==='construct'&&((input.construction_profile!==STRATEGY_CONSTRUCTION_PROFILE&&(!Array.isArray(input.card_ids)||!input.card_ids.length))||typeof input.notes!=='string'||!input.notes.trim()))throw new HttpError(400,'新版自由建构只需说明改善方向；历史有界任务仍须明确选定卡片。');
  let modelSettings={};try{modelSettings=ctx.settings.get('nexogenesis')??{};}catch{}
  await ensureModelRoute(ctx,modelSettings);
  const workflowModel=workflowModelSelectionFromSettings(modelSettings,input.mode);
  const modelSelection=workflowModel.selection;assertBoundedModel(input,modelSelection,ctx);
  if (hasUnoJobRunning(root)) throw new HttpError(409, "请先暂停当前编译或建构。");
  if (((await rpcCall(ctx,"session.list",{})).items??[]).some(s=>s.running && conversationExt(s.sessionId).task_kind && !conversationExt(s.sessionId).uno_job_id)) throw new HttpError(409,"请先暂停正在执行的旧知识任务。");
  const inventory = unoPreparation(ctx, root), id = requestId??randomUUID();
  if(input.library_id!==undefined&&input.library_id!==inventory.library.id)throw new HttpError(409,'当前知识库已切换，请重新选择材料');
  const repair=isolatedRepair?prepareIsolationRepair(root,input):null;
  const requirements=await freezePreferences(root,input,modelSettings.model??'',appRoot).catch(e=>{throw new HttpError(400,e.message);});
  if(input.construction_controls){requirements.construction_controls=input.construction_controls;requirements.construction_query=input.construction_query;}
  const job = { ...(input.construction_controls?{construction_controls:input.construction_controls,construction_query:input.construction_query}:{}),id, mode: input.mode, title: labels[input.mode], authority: pipelineAuthorityOf(ctx), cursor: 0, batches: [], sources: [], failures: [], archives: [], receipts: [], calls: [], pending: null, status: "paused", created_at: new Date().toISOString(), version: 0 };
  if (input.execution_profile !== undefined) job.execution_profile = input.execution_profile;
  if (input.orchestration_profile !== undefined) job.orchestration_profile = input.orchestration_profile;
  if (input.review_policy !== undefined) job.review_policy = input.review_policy;
  if(requestId)job.start_request_hash=requestHash;
  if (isolatedRepair) {
    Object.assign(job,{workflow:BOOK_WORKFLOW,compile_profile:BOOK_PROFILE,review_policy:DEFAULT_COMPILE_REVIEW_POLICY,authority:'trusted'},repair.fields);
  } else if (job.mode === "compile") {
    const allowed=new Set(inventory.sources.map(s=>'00-Inbox/'+s.path));
    if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 10000 || new Set(input.sources).size !== input.sources.length
      || input.sources.some(p => !allowed.has(p))) throw new HttpError(400, "请选择有效的待编译材料；范围最多 10000 项，按小批次处理。");
    input.theme ??= '';input.notes ??= '';
    if (typeof input.theme !== "string" || input.theme.length > 100) throw new HttpError(400, "主题名称无效。");
    if(typeof input.notes!=='string')throw new HttpError(400,'编译要求必须是文本');
    const budget=requirements.preferences.budget_calls;
    job.theme = input.theme.trim(); job.title = "编译 · " + (job.theme || input.sources[0].split("/").at(-1));
    Object.assign(job,{workflow:BOOK_WORKFLOW,compile_profile:BOOK_PROFILE,compile_quality_mode:input.compile_quality_mode??requirements.preferences.compile_quality??COMPILE_QUALITY_STANDARD,compile_isolation:COMPILE_ISOLATION,review_policy:DEFAULT_COMPILE_REVIEW_POLICY,card_classification:CARD_CLASSIFICATION_CONTRACT,
      phase:'prepare',authority:'trusted',domain_approval_mode:input.domain_approval_mode==='automatic'?'automatic':'manual',material_kind:['auto','book','article'].includes(input.material_kind)?input.material_kind:'auto',notes:input.notes,selected_sources:[...input.sources],
      source_revisions:Object.fromEntries(input.sources.map(ref=>[ref,unoRevision(root,ref)])),
      budget:{calls:budget},domain_catalog:domainCatalogRows(listDomainsV2(root)),book_units:[],book_reads:{},book_card_reads:{},book_outcomes:{},book_focus_refs:[],touched:[],issues:[]});
  } else {
    const selected = selectConstructCards(inventory, input);
    if(['unassigned-card-recompile','unassigned-card-domain'].includes(input.operation)&&(selected.length!==1||selected[0].domains.length))throw new HttpError(409,'只能处理未组织池中的一张当前有效卡片。');
    job.construct_contract = 'scoped-review-v1';
    job.notes = input.notes.trim() || '检查所选卡片的内容、主类型、领域归属与联系；只修订有明确改善依据的部分，无需修改时说明保留理由。'; job.domain = input.domain ?? ""; job.type = input.type ?? ""; job.scope = selected.map(c => c.id);
    job.title = "建构 · " + (input.domain || input.type || "当前知识体");
    Object.assign(job,{workflow:input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE?STRATEGY_CONSTRUCTION_WORKFLOW:CONSTRUCTION_WORKFLOW,card_classification:CARD_CLASSIFICATION_CONTRACT,phase:input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE?'strategy_pending':'read',authority:requirements.preferences.delivery==='auto'?'trusted':'manual',budget:{calls:requirements.preferences.budget_calls},outcomes:{},touched:[],reviewed:{},issues:[]});
    if(input.construction_profile===STRATEGY_CONSTRUCTION_PROFILE){
      job.construction_profile=STRATEGY_CONSTRUCTION_PROFILE;
      job.strategy_contract=CONSTRUCTION_STRATEGY_CONTRACT;
      job.construction_review_policy=CONSTRUCTION_REVIEW_POLICY;
      job.requested_card_ids=Array.isArray(input.card_ids)?[...input.card_ids]:[];
      job.scope=[];job.batches=[];
      if(relationWeavingEnabled(job))job.relation_weaving={contract:RELATION_WEAVING_CONTRACT,rounds:[]};
      job.title='建构 · '+input.notes.trim().slice(0,32);
    }else if(input.construction_profile===CONSTRUCTION_PROFILE){
      job.construction_profile=CONSTRUCTION_PROFILE;
      job.construction_plan=planConstruction(root,{notes:input.notes,domain:input.domain,type:input.type,card_ids:input.card_ids,force_recheck:input.force_recheck,requirements});
      job.scope=job.construction_plan.packages.flatMap(p=>p.card_ids);
      job.batches=job.construction_plan.packages.filter(p=>p.status!=='reused').map(p=>p.card_ids);
      job.title='建构 · '+input.notes.trim().slice(0,32);
    }else job.batches=scheduleBatches(root,job.scope,'construct');
  }
  if(input.operation==='unassigned-card-recompile'){
    job.operation=input.operation;
    job.single_card_recompile_contract=SINGLE_CARD_RECOMPILE_CONTRACT;
    job.title='单卡重编译与领域整理 · '+inventory.cards.find(card=>card.id===job.scope[0]).title;
  }
  if(input.operation==='unassigned-card-domain'){
    job.operation=input.operation;
    job.single_card_domain_contract='single-card-domain-assignment-v1';
    job.title='单卡领域整理 · '+inventory.cards.find(card=>card.id===job.scope[0]).title;
  }
  Object.assign(job,{requirements,continuous:isBookWorkflow(job.workflow)||job.workflow===STRATEGY_CONSTRUCTION_WORKFLOW?input.continuous!==false:input.continuous===true,batch_index:0,role:job.workflow===STRATEGY_CONSTRUCTION_WORKFLOW?'select':'author',model_selection:modelSelection,
    ...(input.mode==='compile'?{workflow_reasoning:workflowModel.reasoning}:{}),workflow_limits:workflowModel.limits,
    project_id:ensureDefaultProject().id,library_id:inventory.library.id});
  const created = await rpcCall(ctx, "session.create", { cwd: root, agentPreset: 'uno-compile' }); job.session_id = created.sessionId;job.owner_session_id=job.session_id;job.sessions=[job.session_id];
  await rpcCall(ctx,'session.rename',{sessionId:job.session_id,title:job.title});
  const taskPinned=!isUnoFocusedMaintenanceJob(job);
  patchConversationExt(job.session_id, { project_id: job.project_id, task_kind: job.mode, uno_job_id: job.id, pinned: taskPinned,
    ...(taskPinned?{pin_source:'task'}:{}), title: job.title, created_at: job.created_at });
  save(root, job);
  if(job.orchestration_profile==='bounded-workflow-v1')initializeProviderBudget(root,job.id,{limit:job.budget.calls});
  if(isolatedRepair)bindIsolationRepair(root,job);
  launch(ctx, root, job); return job;
}
function publicUnoJob(root,job){
  const {selection_seen,unit_work,...visible}=job;
  if(isBookWorkflow(job.workflow)&&job.status==='partial'&&job.phase==='done'&&typeof visible.detail==='string')
    visible.detail=visible.detail.replace(/^(?:本轮编译已结束。|全书编译已完成。)/,'本轮执行已结束，整本编译未完成。');
  visible.calls=(job.calls??[]).map(({response,...call})=>call);
  const resumeBudgetCalls=job.resume_budget_calls??job.requirements?.preferences?.budget_calls??120;
  const resumePlan=isCurrentUnoJob(job)?computeResumePlan(root,job):null;
  if(visible.repair_origin){const {failed_response,...origin}=visible.repair_origin;visible.repair_origin=origin;}
  const archivedSources=new Set((job.archives??[]).filter(row=>row?.archived===true).map(row=>row.source));
  const reviewSources=isBookWorkflow(job.workflow)&&['done','ended'].includes(job.phase)&&['partial','completed','ended'].includes(job.status)
    ?(job.sources??[]).filter(book=>book?.incomplete===true&&!archivedSources.has(book.original_source)
      &&Array.isArray(book.units)&&book.units.length>0&&book.units.every(unit=>job.book_outcomes?.[unit.ref]?.status==='processed'))
      .map(book=>({source:book.original_source,title:book.title??book.original_source,warnings:book.warnings??[]})):[];
  return {...visible,isolation_summary:compileIsolationSummary(job),...(reviewSources.length?{archive_review:{contract:'book-archive-review-v1',sources:reviewSources}}:{}),...(resumePlan?{resume_plan:resumePlan,resume_available:resumePlan.kind==='resume',resume_blocked_reason:resumePlan.kind==='resume'?'':resumePlan.reason}:{}),resume_budget_calls:resumeBudgetCalls,readonly:!isCurrentUnoJob(job),...(!isCurrentUnoJob(job)?{readonly_reason:historicalMessage}:{}),...(job.selection_workflow?{selection_summary:selectionSummary(job)}:{})};
}
export async function handleUnoApi(ctx, req, res, root,appRoot=root) {
  const url = new URL(req.url, "http://local"), rest = url.pathname.slice("/api/uno".length);
  if(rest==='/preferences'&&req.method==='GET')return json(res,200,{...readPreferences(root),construction_controls_contract:CONSTRUCTION_CONTROLS,library:currentLibrary(root)});
  if(rest==='/preferences'&&req.method==='PUT'){
    const body=await readJsonBody(req),library=currentLibrary(root);
    if(body.library_id!==library.id)throw new HttpError(409,'当前知识库已经切换，请重新加载设置');
    let model='';try{model=ctx.settings.get('nexogenesis')?.model??'';}catch{}
    const usage=await countPreferences(longTermPreferenceText({...readPreferences(root),...body}),model,appRoot);if(usage.tokens>3000)throw new HttpError(400,`编译偏好${usage.exact?'':'估计'}超过 3000 tokens，请精简`);
    try{return json(res,200,{...savePreferences(root,body),construction_controls_contract:CONSTRUCTION_CONTROLS,library,usage});}catch(e){throw new HttpError(400,e.message);}
  }
  if(rest==='/preferences/count'&&req.method==='POST'){
    const body=await readJsonBody(req);let model='';try{model=ctx.settings.get('nexogenesis')?.model??'';}catch{}
    if(typeof body.notes!=='string'||Buffer.byteLength(body.notes)>128000)throw new HttpError(400,'要求文本无效或过长');
    return json(res,200,await countPreferences(preferenceText(body.inherit===false?'':longTermPreferenceText(readPreferences(root)),body.notes),model,appRoot));
  }
  if(rest==='/assets'&&req.method==='GET'){
    const libraryId=url.searchParams.get('library_id');if(libraryId){const library=currentInstanceRegistry(root).instances.find(i=>i.id===libraryId);if(!library)throw new HttpError(404,'知识库不可用');root=library.root;}
    const ref=url.searchParams.get('ref')??'';if(!/^(03-Archive\/assets|03-Archive\/sources|03-Archive\/books)\//.test(ref)&&!BOOK_ASSET_REF.test(ref))throw new HttpError(403,'只可查看本库原书或提取资源');
    const path=bookEvidencePath(root,ref);if(!existsSync(path))throw new HttpError(404,'资产未找到');
    const ext=ref.split('.').at(-1).toLowerCase(),mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf'}[ext]??'application/octet-stream';
    res.setHeader('Content-Type',mime);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");if(mime==='application/octet-stream')res.setHeader('Content-Disposition','attachment');res.statusCode=200;res.end(readFileSync(path));return;
  }
  if (rest === "/prepare" && req.method === "GET") return json(res,200,unoPreparation(ctx,root));
  if(rest==='/unassigned'&&req.method==='GET')return json(res,200,{items:[...listCompileIsolation(root),...listUnassignedCards(root).map(card=>({...card,kind:'unassigned'}))],library:currentLibrary(root),capabilities:{manual_seed_domain:true}});
  const repairMatch=/^\/repairs\/([a-zA-Z0-9_-]+)$/.exec(rest);
  if(repairMatch&&req.method==='GET')return json(res,200,findCompileIsolation(root,repairMatch[1]));
  if(repairMatch&&req.method==='POST'){
    const body=await readJsonBody(req);
    if(typeof body.request_id!=='string')throw new HttpError(400,'修复请求需要幂等标识，请刷新后重试。');
    if(body.library_id!==currentLibrary(root).id)throw new HttpError(409,'当前知识库已切换，请刷新待修复项。');
    try{return json(res,202,publicUnoJob(root,await startUnoJob(ctx,root,{mode:'compile',operation:'isolated-card-repair',compile_profile:BOOK_PROFILE,
      item_id:repairMatch[1],expected_revision:body.expected_revision,notes:body.notes??'',response_json:body.response_json??'',
      library_id:body.library_id,request_id:body.request_id,budget_calls:12,inherit_preferences:false},appRoot)));}
    catch(error){if(error.code?.startsWith('ISOLATION_'))throw new HttpError(409,error.message);throw error;}
  }
  const unassignedMatch=/^\/unassigned\/([a-zA-Z0-9_-]+)(?:\/(recompile|organize|create-domain))?$/.exec(rest);
  if(unassignedMatch&&req.method==='POST'&&unassignedMatch[2]==='recompile'){
    const card=listUnassignedCards(root).find(row=>row.id===unassignedMatch[1]);
    if(!card)throw new HttpError(404,'未组织池中没有这张卡片。');
    const body=await readJsonBody(req);
    return json(res,202,publicUnoJob(root,await startUnoJob(ctx,root,{mode:'construct',operation:'unassigned-card-recompile',card_ids:[card.id],notes:'依据当前卡片已绑定的来源片段完整重写并独立审核，再核对既有领域归属；可靠匹配时通过领域治理事务挂靠。',orchestration_profile:'bounded-workflow-v1',continuous:true,delivery:'auto',inherit_preferences:false,budget_calls:6,library_id:body.library_id,request_id:body.request_id},appRoot)));
  }
  if(unassignedMatch&&req.method==='POST'&&unassignedMatch[2]==='organize'){
    const card=listUnassignedCards(root).find(row=>row.id===unassignedMatch[1]);
    if(!card)throw new HttpError(404,'未组织池中没有这张卡片。');
    const body=await readJsonBody(req);
    return json(res,202,publicUnoJob(root,await startUnoJob(ctx,root,{mode:'construct',operation:'unassigned-card-domain',card_ids:[card.id],notes:'只核对当前正式卡与既有领域定义；可靠匹配时通过领域治理事务挂靠，不重写正文。',orchestration_profile:'bounded-workflow-v1',continuous:true,delivery:'auto',inherit_preferences:false,budget_calls:4,library_id:body.library_id,request_id:body.request_id},appRoot)));
  }
  if(unassignedMatch&&req.method==='POST'&&unassignedMatch[2]==='create-domain'){
    if(hasUnoJobRunning(root))throw new HttpError(409,'请先暂停当前编译或建构，再创建领域。');
    const body=await readJsonBody(req),library=currentLibrary(root);
    if(body.library_id!==library.id)throw new HttpError(409,'当前知识库已切换，请重新打开未组织池。');
    if(!safeId(body.request_id))throw new HttpError(400,'创建领域需要有效的幂等请求标识，请刷新后重试。');
    try{return json(res,200,new HarnessGateway(root).createDomainFromUnassignedCard({key:`domain-governance/manual/${unassignedMatch[1]}/${body.request_id}`,
      card_id:unassignedMatch[1],expected_revision:body.expected_revision,domain:body.domain}));}
    catch(error){throw new HttpError(['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(error.code)?409:400,error.message);}
  }
  if(unassignedMatch&&req.method==='DELETE'&&!unassignedMatch[2]){
    if(hasUnoJobRunning(root))throw new HttpError(409,'请先暂停当前编译或建构，再删除卡片。');
    const body=await readJsonBody(req),library=currentLibrary(root);
    if(body.library_id!==library.id)throw new HttpError(409,'当前知识库已切换，请重新打开未组织池。');
    try{return json(res,200,new HarnessGateway(root).deleteUnassignedCard({key:`unassigned-delete/${unassignedMatch[1]}/${body.expected_revision}`,card_id:unassignedMatch[1],expected_revision:body.expected_revision,confirm_id:body.confirm_id,reason:body.reason}));}
    catch(error){throw new HttpError(error.code==='REVISION_CONFLICT'?409:400,error.message);}
  }
  if (rest === "/jobs" && req.method === "POST") return json(res,202,publicUnoJob(root,await startUnoJob(ctx,root,await readJsonBody(req),appRoot)));
  const match = /^\/jobs\/([a-zA-Z0-9_-]+)(?:\/(resume|resolve|review|domain-review|archive-review|cancel|retry|stop-after-batch|end))?$/.exec(rest);
  if (!match) throw new HttpError(404, "任务接口不存在。");
  let job = readUnoJob(root, match[1]);
  if (!match[2] && req.method === "GET") {
    const source = url.searchParams.get("source");
    if (source) {
      if(job.workflow===BOOK_WORKFLOW||job.workflow==='uno-book-compile-v1'){ // v1 仅供历史原文回查，不能续跑
        const unit=job.book_units.find(u=>u.ref===source);if(!unit)throw new HttpError(403,'只能回查本任务原文。');
        const chunks=[];let offset=0;do{const part=readBookUnit(root,job,{ref:source,offset,limit:18000});chunks.push(part.text);offset=part.next_offset;}while(offset!==null);
        return json(res,200,{body:chunks.join(''),locator:unit.locator});
      }
      if (!(job.batches??[]).flat().includes(source) && !(job.sources??[]).some(s => s.units?.some(u => u.ref === source))) throw new HttpError(403, "只能回查本任务原文。");
      const unit = readUnoUnit(root,source); return json(res,200,{ body:unit.body, locator:unit.meta.locator });
    }
    return json(res,200,publicUnoJob(root,job));
  }
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  const action = match[2], body = await readJsonBody(req);
  job = readUnoJob(root, match[1]);
  if (!isCurrentUnoJob(job) && !['end','cancel'].includes(action)) throw new HttpError(409, historicalMessage);
  if (action !== 'end' || job.status !== 'ended') assertUnoVersion(job,body);
  if (action === 'end') return json(res, 202, publicUnoJob(root,endUnoJob(root, job.id)));
  if(action==='archive-review'){
    if(job.workflow!==BOOK_WORKFLOW||job.repair_origin)throw new HttpError(409,'只有当前整本编译任务可以复核原书归档。');
    if(hasUnoJobRunning(root))throw new HttpError(409,'请等待当前编译或建构停止后再复核归档。');
    const book=(job.sources??[]).find(row=>row.original_source===body.source);
    if(!book)throw new HttpError(404,'本任务没有这份 Inbox 原书。');
    if(book.incomplete!==true)throw new HttpError(409,'这份原书没有需要人工复核的提取缺口。');
    if(typeof body.note!=='string'||!body.note.trim()||body.note.length>500)throw new HttpError(400,'归档复核必须说明已核对提取警告。');
    const review={job_revision:unoRevision(root,jobRef(job.id)),source_revision:book.source_revision,extraction_revision:book.extraction_revision,
      note:body.note.trim(),reviewed_warnings:[...(book.warnings??[])]};
    try{new HarnessGateway(root).archiveCompletedBook({job_id:job.id,source:book.original_source,review});}
    catch(error){throw new HttpError(['REVISION_CONFLICT','TASK_STOPPED'].includes(error.code)?409:400,error.message);}
    return json(res,200,publicUnoJob(root,readUnoJob(root,job.id)));
  }
  if (job.status === 'ended' || job.end_requested) throw new HttpError(409, '本次任务已经结束或正在结束，请新建任务处理剩余材料。');
  if (isBookWorkflow(job.workflow) && ['resume','retry'].includes(action)) {
    const resume = computeResumePlan(root,job);
    if (resume.kind!=='resume') throw new HttpError(409, resume.reason);
  }
  if(action==='stop-after-batch'&&[CONSTRUCTION_WORKFLOW,STRATEGY_CONSTRUCTION_WORKFLOW,BOOK_WORKFLOW].includes(job.workflow)){job.stop_after_batch=true;save(root,job);return json(res,202,publicUnoJob(root,job));}
  if (action === "cancel") {
    return json(res,202,publicUnoJob(root,cancelUnoJob(root,job.id)));
  }
  if (hasUnoJobRunning(root)) throw new HttpError(409, "请等待当前执行停止后再处理。");
  if (isQuickThinkingRunning(job.owner_session_id??job.session_id)) throw new HttpError(409,'请等待讨论结束，再恢复工作。');
  if([CONSTRUCTION_WORKFLOW,STRATEGY_CONSTRUCTION_WORKFLOW].includes(job.workflow)&&['resume','retry'].includes(action))assertBoundedModel(job,job.model_selection,ctx);
  if (((await rpcCall(ctx,"session.list",{})).items??[]).some(s=>s.running && (job.sessions?.includes(s.sessionId) || (conversationExt(s.sessionId).task_kind && !conversationExt(s.sessionId).uno_job_id)))) throw new HttpError(409,"请先暂停正在执行的原任务。");
  job = readUnoJob(root, match[1]);
  if (body.version !== job.version) throw new HttpError(409, "任务状态已变化，请刷新后重试。");
  if(job.workflow===BOOK_WORKFLOW){
    if(action==='domain-review'){
      if(job.status!=='review'||job.phase!=='domain_review')throw new HttpError(409,'当前没有待确认的领域提案。');
      const approve=Array.isArray(body.approve_ids)?body.approve_ids:[],defer=Array.isArray(body.defer_ids)?body.defer_ids:[];
      let summary;try{summary=applyPendingDomainProposals(root,job,{approve_ids:approve,defer_ids:defer,key:`domain-governance/review/${job.id}/${sha(JSON.stringify([...approve].sort()))}`,
        applied_note:'用户确认后原子创建领域并挂靠成员。',deferred_note:'用户暂缓，本轮继续编译。'});}catch(error){throw new HttpError(error.code==='DOMAIN_REVIEW_INVALID'?400:409,error.message);}
      job.status='paused';job.phase='read';job.detail=`领域治理已处理：批准 ${summary.approved} 个，暂缓 ${summary.deferred} 个。继续处理剩余单元。`;
      delete job.error_code;save(root,job);launch(ctx,root,job);return json(res,202,publicUnoJob(root,job));
    }
    if(action==='resolve'){
      const plan=computeResumePlan(root,job),decision=String(body.decision??'');
      if(plan.kind!=='decision'||!plan.actions.some(row=>row.id===decision))throw new HttpError(409,plan.reason||'当前没有可执行的停点处理方式。');
      try{assertBookPauseDecision(job,decision);}catch(error){throw new HttpError(409,error.message);}
      assertBoundedModel(job,job.model_selection,ctx);
      const allowance=body.budget_calls??job.resume_budget_calls??job.requirements?.preferences?.budget_calls??120;
      if(!Number.isInteger(allowance)||allowance<4||allowance>2000)throw new HttpError(400,'每次继续的请求额度为4–2000次。');
      try{const budget=replenishProviderBudget(root,job.id,allowance);job.budget.calls=budget.limit;}catch(error){throw new HttpError(400,error.message);}
      job.resume_budget_calls=allowance;resolveBookPause(root,job,decision);job.resume_round=(job.resume_round??0)+1;job.needs_fresh_context=true;
      save(root,job);launch(ctx,root,job);return json(res,202,publicUnoJob(root,job));
    }
    if(!['resume','retry'].includes(action)||job.status==='completed')throw new HttpError(409,'当前任务没有可恢复的未完成范围。');
    const resumePlan=computeResumePlan(root,job);
    assertBoundedModel(job,job.model_selection,ctx);
    const allowance=body.budget_calls??job.resume_budget_calls??job.requirements?.preferences?.budget_calls??120;
    if(!Number.isInteger(allowance)||allowance<4||allowance>2000)throw new HttpError(400,'每次继续的请求额度为4–2000次。');
    try{const budget=replenishProviderBudget(root,job.id,allowance);job.budget.calls=budget.limit;}catch(error){throw new HttpError(400,error.message);}
    job.resume_budget_calls=allowance;
    if(job.workflow===BOOK_WORKFLOW&&!job.repair_origin)job.compile_isolation=COMPILE_ISOLATION;
    prepareBookResume(job);
    // Explicit resume may retry deferred work, never already processed sources.
    for(const [ref,outcome] of Object.entries(job.book_outcomes??{}))if(outcome.status==='deferred'){(job.book_defer_history??=[]).push({ref,...outcome});delete job.book_outcomes[ref];}
    if(job.failures.length)job.phase='prepare';else job.phase='read';
    armResumeGuard(job,resumePlan);
    delete job.error_code;
    delete job.last_failure;
    job.book_advance_requested=false;job.finish_requested=false;job.stop_after_batch=false;job.needs_fresh_context=true;
    job.resume_round=(job.resume_round??0)+1;save(root,job);launch(ctx,root,job);return json(res,202,publicUnoJob(root,job));
  }
  if([CONSTRUCTION_WORKFLOW,STRATEGY_CONSTRUCTION_WORKFLOW].includes(job.workflow)){
    const resumePlan=['resume','retry'].includes(action)?computeResumePlan(root,job):null;
    if(resumePlan&&resumePlan.kind!=='resume')throw new HttpError(409,resumePlan.reason);
    if(body.budget_calls!==undefined){const value=body.budget_calls,bounded=isBounded(job),min=bounded?4:10,used=bounded?getProviderBudget(root,job.id).used:job.calls.length;if(!Number.isInteger(value)||value<Math.max(min,used)||value>2000)throw new HttpError(400,`预算为 ${min}–2000 次且不低于累计请求`);if(bounded)try{raiseProviderBudget(root,job.id,value);}catch(error){throw new HttpError(400,error.message);}job.budget.calls=value;}
    if(action==='review'&&job.workflow===CONSTRUCTION_WORKFLOW){
      if(job.status!=='review'||job.phase!=='settle'||body.decision!=='save')throw new HttpError(409,'当前没有待确认批次');
      finalizeConstructionBatch(root,job);job=readUnoJob(root,job.id);
    }else if(!['resume','retry'].includes(action))throw new HttpError(400,'未知操作');
    if(job.phase==='done'){
      if (!(job.status==='partial' && resumeUnfinishedBatch(root,job))) throw new HttpError(409,'本轮已结束，请新建建构任务处理其他范围。');
    }
    if(job.phase==='batch_done'){
      if(job.workflow===STRATEGY_CONSTRUCTION_WORKFLOW){
        if(job.batch_index+1>=job.batches.length){
          if(job.relation_weaving?.needs_replan){job.phase='strategy_pending';job.role='select';job.relation_weaving.needs_replan=false;}
          else throw new HttpError(409,'本轮已结束，请新建建构任务处理其他范围。');
        }else {job.batch_index++;job.phase='authoring';job.role='author';}
      }
      else job.resume_after_batch=true;
    }
    if(job.orchestration_profile==='bounded-workflow-v1'&&['resume','retry'].includes(action)){job.resume_round=(job.resume_round??0)+1;job.needs_fresh_context=true;}
    job.stop_after_batch=false;if(resumePlan)armResumeGuard(job,resumePlan);save(root,job);launch(ctx,root,job);return json(res,202,publicUnoJob(root,job));
  }
  throw new HttpError(409, historicalMessage);
}
