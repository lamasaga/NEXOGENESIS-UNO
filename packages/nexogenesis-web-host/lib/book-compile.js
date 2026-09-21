import { loadCards, parseCardFile, invalidateKnowledgeSnapshot } from '../../nexogenesis-tools/lib/cards.js';
import { unoCardRef, unoPath } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readUnoReceipt } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { bookOperationKey } from '../../nexogenesis-tools/lib/uno/book-store.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';
import { reconcileBookReceipts } from '../../nexogenesis-tools/lib/uno/book-store.js';
import { inspectBookUnit, isBookWorkflow } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { sameBookUnitSource } from '../../nexogenesis-tools/lib/uno/book-paths.js';
import { unoRevision, sha } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { readCompileJob, saveCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { preprocessSource } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { archiveExternalImages } from '../../nexogenesis-tools/lib/uno/assets.js';
import { BOOK_WORKFLOW, bookProgress } from '../../nexogenesis-tools/lib/uno/book-agent.js';
import { bindProviderBudgetSession, getProviderBudget } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { broadcastGraphEvent } from './events-bus.js';
import { assertBoundedModel, budgetStopCode } from './uno-orchestration.js';
import { buildUnitRequest, unitReferences, parseUnitJSON, validateGeneratedCards, normalizeGeneratedEnvelope, validateRepairedCard, recoverGeneratedCardPrefix,
  recoverUnitJSONTrailingClosers, UNIT_JSON_TRAILING_CLOSERS_RECOVERY, chars } from './unit-card-request.js';
import { CARD_CLASSIFICATION_CONTRACT, domainCatalogRows } from '../../nexogenesis-tools/lib/uno/card-classification.js';
import { listDomainsV2 } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { buildDomainGovernanceRequest } from './domain-governance-request.js';
import { buildCompileRecoveryRequest, classifyCompileFailure, COMPILE_RECOVERY_CONTRACT, COMPILE_RECOVERY_JOB_LIMIT,
  compileRecoveryFingerprint, normalizeReviewEnvelope, validateCompileRecovery, buildGenerationRecoveryRequest } from './compile-recovery.js';
import { bindCurrentUnitSources, governRoutineReviewIssues, ROUTINE_REVIEW_GOVERNANCE } from './compile-review-governance.js';
import { RESUME_PLAN_CONTRACT, settleResumeGuard } from './resume-plan.js';
import { COMPILE_ISOLATION, isolationEnabled, isolationOpen, isolatedCardIds, isolateCompileItem, canIsolateFailure, quarantineUnit, settleQuarantinedUnit, compileIsolationSummary } from '../../nexogenesis-tools/lib/uno/compile-isolation.js';
import { safeCardId } from '../../nexogenesis-tools/lib/uno-contract.js';
import { reconcileIsolationRepair, refreshIsolationRepairReferences, ISOLATED_REPAIR_DIAGNOSIS } from '../../nexogenesis-tools/lib/uno/compile-repair.js';
import { SINGLE_CARD_RECOMPILE_CONTRACT } from './single-card-recompile.js';
import { bootstrapDomainGovernanceJob, buildDomainGovernancePackage, domainCheckpointDue, persistDomainProposals, recordDomainCheckpoint, recordDomainUnit,
  settleDomainProposals, synchronizeUnassignedPool, validateDomainGovernanceResult } from '../../nexogenesis-tools/lib/uno/domain-governance.js';
export { BOOK_WORKFLOW };
export const BOOK_PROFILE = 'unit-cards-v3';
export const LEGACY_BOOK_PROFILE = 'unit-cards-v2';
export const COMPILE_REVIEW_POLICY = 'review-publish-repair-v2';
export const COMPILE_QUALITY_STANDARD = 'standard';
export const COMPILE_QUALITY_REFINE_EACH_CARD = 'refine-each-card-v1';
export const COMPILE_QUALITY_MODES = Object.freeze([COMPILE_QUALITY_STANDARD,COMPILE_QUALITY_REFINE_EACH_CARD]);
export const EMPTY_GENERATION_RETRY_CONTRACT = 'compile-empty-generation-retry-v1';
export const RELATION_SCOPE_PROJECTION = 'relation-scope-projection-v1';
export const BOOK_PAUSE_RESOLUTION = 'book-pause-resolution-v2';
export const COMPILE_HEALTH = {
  compile_profile: BOOK_PROFILE,
  compile_version: BOOK_WORKFLOW,
  compile_review_policy: COMPILE_REVIEW_POLICY,
  uno_compile_entry: 4,
  uno_book_compile: 3,
  uno_unit_compile: 3,
  compile_review_context: 'typed-card-and-relation-repair-v2',
  uno_relation_repair: 1,
  uno_relation_scope_projection: RELATION_SCOPE_PROJECTION,
  uno_unit_card_contract: 2,
  card_classification: CARD_CLASSIFICATION_CONTRACT,
  uno_unit_coverage_recovery: 1,
  uno_unit_truncation_checkpoint: 1,
  uno_generation_note_recovery: 1,
  uno_generation_json_tail_recovery: UNIT_JSON_TRAILING_CLOSERS_RECOVERY,
  uno_compile_isolation: COMPILE_ISOLATION,
  uno_isolated_repair_diagnosis: ISOLATED_REPAIR_DIAGNOSIS,
  uno_reference_delivery: '3-full-5-compact-v1',
  uno_workflow_reasoning: 1,
  uno_compile_card_refinement: COMPILE_QUALITY_REFINE_EACH_CARD,
  compile_quality_modes: COMPILE_QUALITY_MODES,
  uno_same_source_reuse: 1,
  uno_card_id_collision: 'local-identity-review-v1',
  uno_domain_governance: 1,
  uno_domain_auto_approval: 1,
  uno_unassigned_card_management: 1,
  uno_manual_seed_domain: 1,
  uno_single_card_recompile: SINGLE_CARD_RECOMPILE_CONTRACT,
  uno_domain_checkpoint: '10-units-20-cards-book-end-v1',
  uno_compile_recovery: COMPILE_RECOVERY_CONTRACT,
  uno_empty_generation_retry: EMPTY_GENERATION_RETRY_CONTRACT,
  uno_resume_plan: RESUME_PLAN_CONTRACT,
  uno_book_pause_resolution: BOOK_PAUSE_RESOLUTION,
  uno_book_archive_review: 'book-archive-review-v1',
  uno_review_resume_binding: 1,
  uno_review_contract_retry: 1,
  uno_review_governance: ROUTINE_REVIEW_GOVERNANCE,
  uno_legacy_compile_retired: 1,
  uno_compile_completion: 1
};

export function applyPendingDomainProposals(root, job, {approve_ids=[],defer_ids=[],key,applied_note='领域提案已批准并原子挂靠成员。',deferred_note='领域提案已暂缓。'}={}) {
  const pending=job.domain_governance?.pending_proposals??[],approve=new Set(approve_ids),defer=new Set(defer_ids),ids=new Set(pending.map(row=>row.proposal_id));
  if([...approve,...defer].some(id=>!ids.has(id))||[...ids].some(id=>!approve.has(id)&&!defer.has(id))||[...approve].some(id=>defer.has(id)))
    throw Object.assign(new Error('每个领域提案必须明确批准或暂缓，且不能重复选择。'),{code:'DOMAIN_REVIEW_INVALID'});
  const selected=pending.filter(row=>approve.has(row.proposal_id));let assigned=0;
  if(selected.length){
    const assignments=selected.flatMap(row=>row.member_card_ids.map(card_id=>({card_id,domains:[row.id]})));
    if(new Set(assignments.map(row=>row.card_id)).size!==assignments.length)
      throw Object.assign(new Error('同一张卡不能在一次确认中加入多个新领域；请暂缓重叠提案。'),{code:'DOMAIN_REVIEW_INVALID'});
    const receipt=new HarnessGateway(root).applyDomainGovernance({key,assignments,create_domains:selected,
      expected_cards:Object.assign({},...selected.map(row=>row.card_revisions)),expected_domains:Object.assign({},...selected.map(row=>row.domain_revisions))});
    if(!job.receipts.some(row=>row.key===receipt.key))job.receipts.push(receipt);
    const cardIds=receipt.card_ids??[];assigned=cardIds.length;job.touched=[...new Set([...job.touched,...cardIds])];
    const pool=synchronizeUnassignedPool(root,{card_ids:cardIds,job_id:job.id});job.domain_governance.open_unassigned=Object.values(pool.unassigned).filter(row=>row.status==='open').length;
    settleDomainProposals(root,[...approve],'applied',applied_note);
  }
  if(defer.size)settleDomainProposals(root,[...defer],'deferred',deferred_note);
  job.domain_governance.pending_proposals=[];job.domain_governance.status='collecting';job.domain_catalog=domainCatalogRows(listDomainsV2(root));
  return {approved:approve.size,deferred:defer.size,assigned};
}

const RELATION_ISSUE = /关系|连边|specialization|supplement|contrast|challenge|analogy|example|application/iu;
const reviewContractError = (message,code) => Object.assign(new Error(message),{code});
const REVIEW_SEMANTIC_ERRORS = new Set(['INVALID_REVIEW_RELATION_SCOPE','INVALID_REVIEW_CARD_SCOPE','INVALID_REVIEW_ISSUE_KIND']);
const normalizeIssue = (issue, allowedIds, sourceId = null) => {
  const message=String(issue?.message??'').trim();
  const explicit=issue?.kind;
  const declared=Array.isArray(issue?.related_card_ids)?issue.related_card_ids.filter(id=>typeof id==='string'&&id!==sourceId):[];
  const mentioned=[...allowedIds].filter(id=>id!==sourceId&&message.includes(id));
  const related=[...new Set([...declared,...mentioned])].filter(id=>allowedIds.has(id));
  const kind=explicit==='relation'||(!explicit&&related.length&&RELATION_ISSUE.test(message))?'relation':'card';
  if(explicit&&!['card','relation'].includes(explicit))throw reviewContractError('审查问题 kind 必须为 card 或 relation。','INVALID_REVIEW_ISSUE_KIND');
  if(kind==='relation'&&!related.length)throw reviewContractError('关系问题必须列出本次已完整核对的 related_card_ids。','INVALID_REVIEW_RELATION_SCOPE');
  if(kind==='card'&&declared.length)throw reviewContractError('单卡问题不能携带关系目标。','INVALID_REVIEW_CARD_SCOPE');
  return {id:issue?.id,kind,related_card_ids:kind==='relation'?related:[],message};
};
const withoutRelations = card => { const {relations,revision,...rest}=card;return rest; };
const textWithoutSpacingOrPunctuation = value => typeof value === 'string'
  ? value.normalize('NFC').replace(/[\p{P}\p{Z}\s]/gu,'') : value;
function relationScopeDifference(original,repaired) {
  const before=withoutRelations(original),after=withoutRelations(repaired);
  if(isDeepStrictEqual(before,after))return {equivalent:true,changed:[]};
  const keys=[...new Set([...Object.keys(before),...Object.keys(after)])];
  const changed=keys.filter(key=>!isDeepStrictEqual(before[key],after[key]));
  const punctuationOnly=changed.length===1&&changed[0]==='summary'
    &&textWithoutSpacingOrPunctuation(before.summary)===textWithoutSpacingOrPunctuation(after.summary);
  return {equivalent:punctuationOnly,changed,punctuationOnly};
}

export async function prepareBookJob(root, initial, signal, preprocess = preprocessSource) {
  let job = readCompileJob(root, initial.id);
  const gateway = new HarnessGateway(root);
  for (const source of job.selected_sources) {
    signal.throwIfAborted();
    if (job.sources.some(s => s.original_source === source)) continue;
    job.detail = '正在提取原文与章节定位：' + source.split('/').at(-1); saveCompileJob(root, job);
    try {
      if (unoRevision(root, source) !== job.source_revisions[source]) throw new Error('选定后原书已变化，请新建任务处理新版本。');
      const raw = await preprocess(root, source, signal, true, job.material_kind ?? 'auto');
      const prepared = await archiveExternalImages(raw, job.requirements?.preferences?.external_images === true, signal);
      signal.throwIfAborted();
      if (prepared.fingerprint !== job.source_revisions[source]) throw new Error('提取期间原书已变化，未接收新版本。');
      const result = gateway.prepareBookSource({ source, prepared });
      job = readCompileJob(root, job.id);
      job.sources.push({ ...result, original_source: source });
      job.book_units.push(...result.units);
      job.failures = job.failures.filter(f => f.source !== source);
    } catch (error) {
      if (signal.aborted) throw error;
      job = readCompileJob(root, job.id);
      job.failures = [...job.failures.filter(f => f.source !== source), { source, detail: error.message }];
    }
    saveCompileJob(root, job);
  }
  job.book_overview = { sources: job.sources.map(s => ({ title: s.title, source: s.source_ref ?? s.source,
    warnings: s.warnings ?? [], chapters: s.units.map(u => ({ ref: u.ref, title: u.title, locator: u.locator, chars: u.chars })) })),
    scope: '用户选定的全部正文单元；延期必须单独说明，不能悄悄改为选读。' };
  job.batches = job.book_units.map(u => [u.ref]); job.phase = 'read'; saveCompileJob(root, job);
  return job;
}

export function nextBookFocus(job) {
  const unit = job.book_units.find(u => !job.book_outcomes?.[u.ref]);
  return unit ? [unit.ref] : [];
}

// Retry authority is limited to an empty transport envelope for the current unit.
export function prepareBookResume(job) {
  const ref=job.book_focus_refs?.[0]??nextBookFocus(job)[0],work=job.unit_work?.[ref];
  if(!work||work.cards||work.last_response?.phase!=='generate'||String(work.last_response.text??'').trim())return false;
  if(work.response?.phase==='generate'&&!String(work.response.text??'').trim())delete work.response;
  delete work.last_response;
  const event={contract:EMPTY_GENERATION_RETRY_CONTRACT,unit_ref:ref,at:new Date().toISOString(),method:'explicit-resume'};
  work.empty_generation_retries=[...(work.empty_generation_retries??[]),event].slice(-10);
  const recoveryAt=Date.parse(job.last_recovery?.at??''),failureAt=Date.parse(job.last_failure?.at??'');
  if(job.last_recovery&&job.last_failure&&Number.isFinite(recoveryAt)&&Number.isFinite(failureAt)&&recoveryAt<failureAt)delete job.last_recovery;
  job.detail='正在重新请求当前未完成单元；此前已处理单元与已保存卡片保持不变。';
  return true;
}

export function assertBookPauseDecision(job,decision) {
  const focused=job.book_focus_refs?.find(ref=>job.unit_work?.[ref]&&job.book_outcomes?.[ref]?.status!=='processed');
  const deferred=(job.book_units??[]).find(unit=>job.book_outcomes?.[unit.ref]?.status==='deferred'&&job.unit_work?.[unit.ref])?.ref;
  const ref=focused??deferred,work=job.unit_work?.[ref],unit=(job.book_units??[]).find(row=>row.ref===ref);
  if(!ref||!work||!unit)throw Object.assign(new Error('当前没有可处理的编译停点。'),{code:'RESUME_DECISION_UNAVAILABLE'});
  const code=job.last_failure?.code??job.error_code,alreadyDeferred=job.book_outcomes?.[ref]?.status==='deferred';
  if(decision==='discard-candidates'){
    const ids=Object.keys(work.pending_issues??{});
    if(code!=='UNIT_CARD_REPAIR_EXHAUSTED'&&!alreadyDeferred)throw Object.assign(new Error('当前停点不允许放弃候选。'),{code:'RESUME_DECISION_INVALID'});
    if(!ids.length)throw Object.assign(new Error('当前没有未通过候选可放弃。'),{code:'RESUME_DECISION_INVALID'});
    return {ref,work,unit,ids,alreadyDeferred};
  }
  if(decision==='quarantine-candidates'){
    const ids=Object.keys(work.pending_issues??{});
    if(!isolationEnabled(job))throw Object.assign(new Error('当前任务没有启用未组织池隔离，不能保留候选后继续。'),{code:'RESUME_DECISION_INVALID'});
    if(code!=='UNIT_CARD_REPAIR_EXHAUSTED'&&!alreadyDeferred)throw Object.assign(new Error('当前停点不允许转入未组织池。'),{code:'RESUME_DECISION_INVALID'});
    if(!ids.length)throw Object.assign(new Error('当前没有待修复候选可转入未组织池。'),{code:'RESUME_DECISION_INVALID'});
    return {ref,work,unit,ids,alreadyDeferred};
  }
  if(decision==='defer-unit'){
    if(alreadyDeferred)throw Object.assign(new Error('当前单元已经延期。'),{code:'RESUME_DECISION_INVALID'});
    return {ref,work,unit,ids:Object.keys(work.pending_issues??{}),alreadyDeferred};
  }
  throw Object.assign(new Error('未知的编译停点处理方式。'),{code:'RESUME_DECISION_INVALID'});
}

export function resolveBookPause(root,job,decision) {
  const {ref,work,unit,ids,alreadyDeferred}=assertBookPauseDecision(job,decision);
  const at=new Date().toISOString();
  if(decision==='discard-candidates'){
    const rejected=new Set(ids);
    work.rejected_candidates=[...(work.rejected_candidates??[]),...ids.map(id=>{
      const card=(work.cards??[]).find(row=>row.id===id);
      return {id,title:card?.title??id,type:card?.type??null,issues:[...(work.pending_issues[id]??[])],at,decision:'discard'};
    })];
    work.cards=(work.cards??[]).filter(card=>!rejected.has(card.id)).map(card=>{
      if(work.published?.[card.id])return card;
      const relations=(card.relations??[]).filter(relation=>!rejected.has(relation.target));
      if(relations.length!==(card.relations??[]).length){delete work.checks[card.id];return {...card,relations};}
      return card;
    });
    for(const id of ids){delete work.pending_issues[id];delete work.pending_issue_records?.[id];delete work.repairs?.[id];delete work.repair_counts?.[id];delete work.checks?.[id];}
    delete work.verifying;delete work.repair_response;delete work.repair_attempt;delete work.response;delete work.last_response;
    if(!work.cards.length)work.empty_checked=true;
    work.note=[work.note,`审核结算：放弃 ${ids.length} 张未通过候选；审核意见保留在任务记录中。`].filter(Boolean).join('\n');
    work.resolutions=[...(work.resolutions??[]),{contract:BOOK_PAUSE_RESOLUTION,decision,ids,at}];
    if(alreadyDeferred){(job.book_defer_history??=[]).push({ref,...job.book_outcomes[ref]});delete job.book_outcomes[ref];work.phase='reviewed';}
    job.detail=`已放弃 ${ids.length} 张未通过候选，正在按实际通过成果结算当前单元。`;
  }else if(decision==='quarantine-candidates'){
    const error=Object.assign(new Error('自动修订已到上限，候选与审核问题已保留到未组织池。'),{code:'UNIT_CARD_REPAIR_EXHAUSTED'});
    for(const id of ids){
      const records=work.pending_issue_records?.[id]??[];
      const kind=records.length&&records.every(issue=>issue.kind==='relation')?'relation':'card';
      const candidate=(work.cards??[]).find(card=>card.id===id);
      isolateCompileItem(work,{key:`${kind==='relation'?'link':'card'}-${id}`,card_id:id,kind,error,candidate});
    }
    if(alreadyDeferred)(job.book_defer_history??=[]).push({ref,...job.book_outcomes[ref]});
    settleQuarantinedUnit(job,ref);
    const cardIds=job.book_outcomes[ref].card_ids;
    const governance=synchronizeUnassignedPool(root,{card_ids:cardIds,job_id:job.id,unit_ref:ref});
    const domainState=recordDomainUnit(job,{unit_ref:ref,card_ids:cardIds,unassigned_card_ids:cardIds.filter(id=>governance.unassigned[id])});
    domainState.open_unassigned=Object.values(governance.unassigned).filter(row=>row.status==='open').length;
    work.resolutions=[...(work.resolutions??[]),{contract:BOOK_PAUSE_RESOLUTION,decision,ids,at}];
    job.detail=`${unit.title}：${ids.length} 项问题已保留到未组织池，正在继续处理主线。`;
  }else if(decision==='defer-unit'){
    const cardIds=[...new Set([...Object.keys(work.published??{}),...Object.keys(work.reused??{})])];
    job.book_outcomes[ref]={status:'deferred',note:`用户选择延期：${job.last_failure?.message??job.detail??'当前单元尚未通过。'}`,card_ids:cardIds,revision:unit.revision,delivered_chars:unit.chars};
    if(cardIds.length){const governance=synchronizeUnassignedPool(root,{card_ids:cardIds,job_id:job.id,unit_ref:ref});if(job.domain_governance)job.domain_governance.open_unassigned=Object.values(governance.unassigned).filter(row=>row.status==='open').length;}
    work.phase='deferred';work.resolutions=[...(work.resolutions??[]),{contract:BOOK_PAUSE_RESOLUTION,decision,ids:Object.keys(work.pending_issues??{}),at}];
    job.book_advance_requested=true;job.detail=`${unit.title}：已延期，原文、审核记录和已保存成果保留；继续处理后续单元。`;
  }
  job.last_resolution={contract:BOOK_PAUSE_RESOLUTION,decision,unit_ref:ref,at};
  delete job.error_code;delete job.last_failure;delete job.last_recovery;delete job.last_resume;
  job.status='paused';job.phase='read';
  return job;
}
export function completeBookState(job) {
  if(job.repair_origin){
    const success=job.book_outcomes?.[job.repair_origin.unit_ref]?.status==='processed';
    job.status=success?'completed':'partial';job.phase='done';
    job.detail=success?'选定待办已通过审核并保存，修复收据已保留。':'选定待办仍有未解决问题，候选和本次响应已保留。';
    return job;
  }
  const progress = bookProgress(job);
  const incomplete = job.sources.filter(s => s.incomplete === true);
  const complete = progress.total_units > 0 && !progress.pending && !progress.deferred && !progress.quarantined && !job.failures.length && !incomplete.length && !(job.book_receipt_issues??[]).length;
  job.status = complete ? 'completed' : 'partial'; job.phase = 'done';
  delete job.error_code;
  delete job.last_failure;
  job.detail = `${complete?'全书编译已完成。':'本轮执行已结束，整本编译未完成。'}已处理 ${progress.processed}/${progress.total_units} 个可读原文单元，延期 ${progress.deferred} 个，保存或丰富 ${job.touched?.length ?? 0} 张卡片。`
    + (progress.quarantined ? `另有 ${progress.quarantined} 个单元的 ${compileIsolationSummary(job).open} 项问题保留在未组织池，可逐项修复；已保存成果保持可用。` : '')
    + (job.failures.length ? `另有 ${job.failures.length} 项提取或归档失败，详情保留在待办中。` : '')
    + (incomplete.length ? `另有 ${incomplete.length} 份原文含未提取正文的页面，需核对封面、图像页或缺失正文，尚不计为全书完成。` : '')
    + ((job.book_receipt_issues??[]).length ? '部分成果收据需要核对，尚不能确认全部保存。' : '')
    + ((job.domain_governance?.open_unassigned??0) ? `领域组织另有 ${job.domain_governance.open_unassigned} 张卡片留待后续整理，已保存的知识可以使用。` : '')
    + (complete ? '本次授权范围处理结束；语义质量仍以卡片与来源核验为准。' : '未处理内容保留，不计作完成。');
  return job;
}

function archiveFinishedBooks(root, initial) {
  if(initial.repair_origin)return initial;
  let job = readCompileJob(root, initial.id);
  for (const book of job.sources) {
    if (book.incomplete || !book.units.length || book.units.some(u => job.book_outcomes[u.ref]?.status !== 'processed')) continue;
    try {
      const receipt = new HarnessGateway(root).archiveCompletedBook({ job_id: job.id, source: book.original_source });
      job = readCompileJob(root, job.id);
      job.archives ??= [];
      if (!job.archives.some(r => r.key === receipt.key)) job.archives.push(receipt);
      job.failures = job.failures.filter(f => !(f.kind === 'archive' && f.source === book.original_source));
    } catch (error) {
      job = readCompileJob(root, job.id);
      if (job.end_requested || job.pause_requested) return job;
      job.failures = [...job.failures.filter(f => !(f.kind === 'archive' && f.source === book.original_source)),
        { kind: 'archive', source: book.original_source, detail: error.message }];
    }
    saveCompileJob(root, job);
  }
  return job;
}

function activeJob(root, id, signal) {
  signal.throwIfAborted();
  const job = readCompileJob(root, id);
  if (!isBookWorkflow(job.workflow) || job.status !== 'running' || job.pause_requested || job.end_requested)
    throw new Error('任务已停止或不属于单元编译协议。');
  return job;
}

/** Direct provider call: no native agent loop, tools, replay history or compaction. */
export async function generateUnitResponse(ctx, root, job, request, signal) {
  activeJob(root, job.id, signal); assertBoundedModel(job, job.model_selection, ctx);
  bindProviderBudgetSession(root, { jobId: job.id, sessionId: job.session_id, packageId: 'units', role: 'author',
    stageId: 'units-direct', stageLimit: 100000, reviewReserve: 0 });
  const call = { id: randomUUID(), phase: request.nexoPrompt.phase, role: 'author', batch: job.batch_index,
    status: 'running', started_at: new Date().toISOString(), context: request.unit_context };
  let current = readCompileJob(root, job.id); current.calls.push(call); saveCompileJob(root, current);
  broadcastGraphEvent(job.owner_session_id, { type: 'work.updated', payload: { workflow: 'compile', job_id: job.id, phase: request.nexoPrompt.phase, role: 'author' } });
  let text = '', finish;
  try {
    for await (const chunk of ctx.get('llm').stream({ ...request, sessionId: job.session_id, signal,
      nexoPrompt: { ...request.nexoPrompt, root } })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'usage') call.usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    activeJob(root, job.id, signal);
    if (finish?.kind !== 'stop') {
      const error = new Error(`模型响应未完整结束：${finish?.failure?.message ?? finish?.kind ?? '连接中断'}。已保留响应，不自动重发正文。`);
      if (['max-tokens','length'].includes(finish?.kind)) error.code='MODEL_OUTPUT_TRUNCATED';
      error.partialResponse=text;error.finish=finish;error.usage=call.usage;
      throw error;
    }
    if (!text.trim()) {
      const error = new Error('模型本次没有返回可解析正文；当前单元未保存，继续后只重试这个单元。');
      error.code='MODEL_EMPTY_RESPONSE';error.finish=finish;error.usage=call.usage;
      throw error;
    }
    call.status = 'completed'; return text;
  } catch (error) { call.status = signal.aborted ? 'cancelled' : 'failed'; call.error = error.message; throw error; }
  finally {
    call.finished_at = new Date().toISOString(); call.response = text;
    current = readCompileJob(root, job.id);
    const index = current.calls.findIndex(row => row.id === call.id);
    if (index >= 0) current.calls[index] = call;
    saveCompileJob(root, current);
    broadcastGraphEvent(job.owner_session_id, { type: 'work.updated', payload: { workflow: 'compile', job_id: job.id, phase: request.nexoPrompt.phase, role: 'author' } });
  }
}

// Bind transport metadata from the frozen delivered snapshot, never from model text.
export function bindCardVersions(cards, references) {
 const revisions = new Map(references.filter(card=>card.delivery!=='summary').map(card=>[card.id,card.revision]));
 return cards.map(card=>{const bound={...card};delete bound.revision;
  if(revisions.has(card.id)) bound.revision=revisions.get(card.id);
  return bound;
 });
}

// Native message IDs are freshly randomized on every build; they are not request content.
export function unitRequestKey(request) {
  return sha(JSON.stringify({...request,messages:request.messages.map(({id,...message})=>message)}));
}

export async function runBookTurn(ctx, root, initial, signal, generate = generateUnitResponse) {
  let job = activeJob(root, initial.id, signal);
  const ref = job.book_focus_refs[0], unit = { ...inspectBookUnit(root, job, ref), ref };
  const gateway = new HarnessGateway(root);
  const hashCard = card => { const {revision,...semantic}=card; return sha(JSON.stringify(semantic)); };
  const work = job.unit_work?.[ref] ?? { source_revision:unit.revision, references:unitReferences(root,unit,job),repairs:{},checks:{},phase:'generate' };
  refreshIsolationRepairReferences(root,job,work);
  const selected = card => !job.repair_origin?.card_id || card.id===job.repair_origin.card_id;
  const eligible = card => selected(card) && !isolatedCardIds(work).has(card.id);
  if(work.source_revision!==unit.revision) throw new Error('原文版本变化，不能复用已生成卡片。');
  if(work.phase==='done') return;
  work.published ??= {}; work.reused ??= {}; work.pending_issues ??= {}; work.pending_issue_records ??= {}; work.repairs ??= {}; work.repair_counts ??= {}; work.checks ??= {};
  work.recovery ??= {attempts:{},events:[]};work.recovery.attempts??={};work.recovery.events??=[];
  work.repair_retries??={};
  work.rejected_repair_responses??={};
  work.card_collisions??={};
  const authorityReferences = () => [...work.references,...Object.values(work.card_collisions)
    .filter(row=>row.applied&&['reuse','revise'].includes(row.action)).map(row=>row.existing)];
  const knownCardIds = () => new Set((work.cards??[]).map(card=>card.id));
  const issueRecords = id => {
    const stored=work.pending_issue_records[id];
    if(Array.isArray(stored)&&stored.length)return stored.map(issue=>normalizeIssue({...issue,id},knownCardIds(),id));
    return (work.pending_issues[id]??[]).map(message=>normalizeIssue({id,message},knownCardIds(),id));
  };
  const setIssueRecords = (id,records) => {
    const unique=[];
    for(const record of records){const normalized=normalizeIssue({...record,id},knownCardIds(),id);
      if(!unique.some(row=>row.kind===normalized.kind&&row.message===normalized.message&&JSON.stringify(row.related_card_ids)===JSON.stringify(normalized.related_card_ids)))unique.push(normalized);
    }
    if(!unique.length){delete work.pending_issue_records[id];delete work.pending_issues[id];return;}
    work.pending_issue_records[id]=unique.map(({id:ignored,...record})=>record);
    work.pending_issues[id]=unique.map(record=>record.message);
  };
  const addIssueRecords = (id,records) => setIssueRecords(id,[...issueRecords(id),...records]);
  const issueScope = id => {
    const records=issueRecords(id);if(!records.length)return null;
    const kind=records.some(record=>record.kind==='card')?'card':'relation';
    const selected=records.filter(record=>record.kind===kind);
    return {kind,records:selected,issues:selected.map(record=>record.message),related_card_ids:[...new Set(selected.flatMap(record=>record.related_card_ids))]};
  };
  const fullContextCards = () => [...new Map([...(work.cards??[]),...authorityReferences().filter(card=>card.delivery!=='summary')].map(card=>[card.id,card])).values()];
  const relatedCards = scope => fullContextCards().filter(card=>scope.related_card_ids.includes(card.id));
  const relationDeletionResolved = (card,verifying) => {
    if(verifying?.kind!=='relation'||!(verifying.related_card_ids??[]).length)return false;
    if(!(verifying.issues??[]).every(message=>/删除|移除|取消/u.test(message)))return false;
    const targets=new Set(verifying.related_card_ids),before=verifying.original_relations??[];
    return [...targets].every(target=>before.some(relation=>relation.target===target))
      && !(card.relations??[]).some(relation=>targets.has(relation.target));
  };
  const persist = detail => {
    job=activeJob(root,job.id,signal); (job.unit_work??={})[ref]=work;
    job.review_policy=COMPILE_REVIEW_POLICY;
    if(detail) job.detail=detail;
    saveCompileJob(root,job);
  };
  const persistRecovery = (summary,detail,fields={}) => {
    job=activeJob(root,job.id,signal);(job.unit_work??={})[ref]=work;job.review_policy=COMPILE_REVIEW_POLICY;
    job.last_recovery=summary;Object.assign(job,fields);if(detail)job.detail=detail;saveCompileJob(root,job);
  };
  const parseRetained = text => {
    try{return parseUnitJSON(text);}catch(error){
      // Recover an already paid-for legacy envelope without another model call.
      const blocks=[...text.matchAll(/```json\s*([\s\S]*?)```/g)];
      if(blocks.length!==1)throw error;
      return parseUnitJSON(blocks[0][1]);
    }
  };
  const compactCandidate = card => ({id:card.id,title:card.title,type:card.type,summary:card.summary??'',relations:card.relations??[]});
  const sourceRef = value => String(value?.ref ?? value ?? '').split('#')[0];
  const reuseSameSourceCards = cards => {
    const catalog=loadCards(root),full=new Set(authorityReferences().filter(card=>card.delivery!=='summary').map(card=>card.id)),kept=[];
    for(const candidate of cards){
      if(full.has(candidate.id)||work.published[candidate.id]){kept.push(candidate);continue;}
      const current=catalog.get(candidate.id);
      if(!current||(current.meta.sources??[]).every(source=>!sameBookUnitSource(sourceRef(source),unit.ref))){kept.push(candidate);continue;}
      const cardRef=unoCardRef(root,current);
      work.reused[candidate.id]={ref:cardRef,revision:unoRevision(root,cardRef),reason:'same-source-existing-card'};
      delete work.pending_issues[candidate.id];delete work.pending_issue_records[candidate.id];delete work.checks[candidate.id];delete work.repairs[candidate.id];delete work.repair_counts[candidate.id];
    }
    return kept;
  };
  const assertReferenceAuthority = cards => {
    const full=new Map(authorityReferences().filter(card=>card.delivery!=='summary').map(card=>[card.id,card]));
    const compact=new Set(work.references.filter(card=>card.delivery==='summary'&&!full.has(card.id)).map(card=>card.id));
    for(const card of cards){
      const original=full.get(card.id),oldRelations=new Set((original?.relations??[]).map(relation=>JSON.stringify(relation)));
      if((card.relations??[]).some(relation=>compact.has(relation.target)&&!oldRelations.has(JSON.stringify(relation))))
        throw Object.assign(new Error('摘要参考只能用于避重与导航，不能成为新关系依据。'),{code:'UNDELIVERED_EVIDENCE'});
    }
  };
  const invoke = async(phase,data) => {
    const request=buildUnitRequest(job,unit,work.references,phase,data), key=unitRequestKey(request);
    persist(`${unit.meta.title}：${{generate:'生成卡片',collision:'核对同名新旧卡片',refine:'逐张精修卡片',check:'审查卡片',repair:'修改问题卡片',verify:'核对单卡修改','relation-repair':'修复卡片关系','relation-verify':'核对关系修改',supplement:'补全已识别遗漏'}[phase]}`);
    if(work.response?.key===key) return parseRetained(work.response.recovered?.text??work.response.text);
    let text;
    try{text=await generate(ctx,root,job,request,signal);}catch(error){
      if(isolationEnabled(job)&&phase==='generate'&&error.code==='MODEL_EMPTY_RESPONSE'){
        work.empty_generation_attempts??={};
        if(!work.empty_generation_attempts[key]){work.empty_generation_attempts[key]=1;persist();return invoke(phase,data);}
      }
      if(phase==='generate'&&error?.code==='MODEL_OUTPUT_TRUNCATED'){
        work.generation_response={key,phase,text:String(error.partialResponse??''),truncated:true};
        const recovered=recoverGeneratedCardPrefix(error.partialResponse),base=work.partial_generation?.cards??[];
        const ids=new Set(base.map(card=>card.id));
        if(recovered.some(card=>ids.has(card.id)))throw Object.assign(new Error('续写响应重复了已保留卡片，未覆盖已有候选。'),{code:'UNIT_CONTINUATION_DUPLICATE'});
        const cards=reuseSameSourceCards([...base,...recovered]);assertReferenceAuthority(cards);
        work.partial_generation={cards,truncations:(work.partial_generation?.truncations??0)+1,
          last_call_id:job.calls?.at(-1)?.id??null,response_chars:chars(error.partialResponse)};
        error.message=cards.length
          ? `${unit.meta.title}：输出达到上限，已保留 ${cards.length} 张完整候选；继续时只请求剩余卡片。`
          : `${unit.meta.title}：输出达到上限，但截断位置前没有可独立解析的完整卡片；继续时按续写契约重新请求本单元。`;
        persist(error.message);
      }
      throw error;
    }
    work.response={key,phase,text};work.last_response={phase,text};
    if(['generate','supplement'].includes(phase))work.generation_response={key,phase,text};
    if(phase.endsWith('repair')&&work.repair_attempt)work.repair_attempt.response_key=key;persist();
    return parseRetained(text);
  };
  const recoverGeneration = async(text,error) => {
    const fingerprint=compileRecoveryFingerprint({phase:'generate',responseText:text});
    const previous=work.recovery.attempts[fingerprint];
    if(previous?.recovered)return parseRetained(previous.recovered);
    const deterministic=recoverUnitJSONTrailingClosers(text);
    if(deterministic){
      const at=new Date().toISOString(),changes=['remove-trailing-unmatched-closers'];
      work.recovery.attempts[fingerprint]={...(previous??{}),deterministic_contract:deterministic.contract,
        recovered:deterministic.recoveredText,removed:deterministic.removed,at};
      const event={fingerprint,phase:'generate',method:'deterministic',changes,at,
        contract:deterministic.contract,removed:deterministic.removed};
      work.recovery.events=[...work.recovery.events.filter(row=>row.fingerprint!==fingerprint),event].slice(-20);
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'recovered',phase:'generate',method:'deterministic',changes,
        unit_ref:ref,at,model_calls:0},`${unit.meta.title}：已确定性移除响应末尾 ${[...deterministic.removed].length} 个多余闭合符号，未调用模型。`);
      return deterministic.value;
    }
    if(previous?.model_attempts)throw Object.assign(new Error('此制卡响应已经尝试局部恢复，原内容保留待处理。'),{code:'COMPILE_RECOVERY_EXHAUSTED'});
    if((job.recovery_model_calls??0)>=COMPILE_RECOVERY_JOB_LIMIT)throw Object.assign(new Error('本轮额外格式恢复额度已用完，原候选保留待处理。'),{code:'COMPILE_RECOVERY_JOB_LIMIT'});
    const request=buildGenerationRecoveryRequest(job,{responseText:text,errorMessage:error.message});
    work.recovery.attempts[fingerprint]={model_attempts:1,at:new Date().toISOString()};
    persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'checking',phase:'generate',method:'model',changes:[],unit_ref:ref,at:new Date().toISOString(),model_calls:1},
      '正在局部恢复制卡响应格式，原文不会重发。',{recovery_model_calls:(job.recovery_model_calls??0)+1});
    let parsed;try{parsed=parseRetained(text);}catch{}
    try{
      const result=validateCompileRecovery(parseRetained(await generate(ctx,root,job,request,signal)),{responseText:text,parsedOriginal:parsed});
      const originalCards=[];
      const collect=value=>{if(!value||typeof value!=='object')return;if(!Array.isArray(value)&&typeof value.id==='string'&&Object.hasOwn(value,'body'))originalCards.push(value);else for(const child of Object.values(value))collect(child);};
      collect(parsed);
      const original=Array.isArray(parsed?.cards)?parsed.cards:originalCards.length?originalCards:null;
      if(original&&!isDeepStrictEqual(original,result.cards))throw Object.assign(new Error('格式恢复改变了原候选内容，原响应已保留。'),{code:'COMPILE_RECOVERY_SCOPE_VIOLATION'});
      work.recovery.attempts[fingerprint].recovered=JSON.stringify(result);
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'recovered',phase:'generate',method:'model',changes:['generation-envelope'],unit_ref:ref,at:new Date().toISOString(),model_calls:1});
      return result;
    }catch(error){
      if(signal.aborted)throw error;
      const notSent=Boolean(budgetStopCode(error));
      if(notSent)delete work.recovery.attempts[fingerprint];
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'failed',phase:'generate',method:'model',changes:[],unit_ref:ref,at:new Date().toISOString(),model_calls:notSent?0:1,error:error.message},undefined,
        notSent?{recovery_model_calls:Math.max(0,(job.recovery_model_calls??1)-1)}:{});throw error;
    }
  };
  const recoverReview = async({phase,data,expectedIds,allowedIds,scope='cards',expectedKind=null,result,error}) => {
    const request=buildUnitRequest(job,unit,work.references,phase,data),requestKey=unitRequestKey(request);
    if(work.response?.key!==requestKey||!work.response?.text)throw error;
    const originalText=work.response.text,fingerprint=compileRecoveryFingerprint({phase,requestKey,responseText:originalText});
    const accept = (candidate,method,changes=[]) => {
      const reviewed=validateReview(candidate,expectedIds,allowedIds,expectedKind);
      if(scope!=='gap'&&candidate.unit_issues.length)throw Object.assign(new Error('候选卡检查没有原文，不能返回整章遗漏；已保留响应。'),{code:'INVALID_REVIEW_SCOPE'});
      work.response.recovered={contract:COMPILE_RECOVERY_CONTRACT,fingerprint,method,text:JSON.stringify(candidate),changes,at:new Date().toISOString()};
      const event={fingerprint,phase,method,changes,at:work.response.recovered.at};
      work.recovery.events=[...work.recovery.events.filter(row=>row.fingerprint!==fingerprint),event].slice(-20);
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'recovered',phase,method,changes,unit_ref:ref,at:event.at,model_calls:method==='model'?1:0},
        `${unit.meta.title}：已恢复模型检查响应，继续使用原检查结果。`);
      return {result:candidate,reviewed};
    };
    const normalized=normalizeReviewEnvelope(result,{scope});
    if(normalized.changes.length){try{return accept(normalized.value,'deterministic',normalized.changes);}catch{/* Continue only when deterministic normalization is insufficient. */}}
    const attempt=work.recovery.attempts[fingerprint]??{model_attempts:0};
    if(attempt.model_attempts>=1)throw Object.assign(new Error('同一检查响应的局部恢复已经尝试过，已停止以避免循环调用。'),{code:'COMPILE_RECOVERY_EXHAUSTED'});
    if((job.recovery_model_calls??0)>=COMPILE_RECOVERY_JOB_LIMIT)throw Object.assign(new Error('本任务的模型响应恢复次数已达到上限，已停止以避免掩盖持续性契约错误。'),{code:'COMPILE_RECOVERY_JOB_LIMIT'});
    attempt.model_attempts+=1;attempt.at=new Date().toISOString();work.recovery.attempts[fingerprint]=attempt;
    const recoveryModelCalls=(job.recovery_model_calls??0)+1;
    persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'checking',phase,method:'model',changes:[],unit_ref:ref,at:attempt.at,model_calls:1},
      `${unit.meta.title}：正在局部修复检查响应格式。`,{recovery_model_calls:recoveryModelCalls});
    let transportError;
    try{
      const recoveryRequest=buildCompileRecoveryRequest(job,{phase,responseText:originalText,errorMessage:error?.message??'响应不符合检查契约',expectedIds,allowedIds,scope});
      let response;
      try{response=await generate(ctx,root,job,recoveryRequest,signal);}catch(error){transportError=error;throw error;}
      const repaired=validateCompileRecovery(parseRetained(response),{responseText:originalText,parsedOriginal:result});
      return accept(repaired,'model',['schema-only-repair']);
    }catch(recoveryError){attempt.error=recoveryError.message;attempt.failed_at=new Date().toISOString();work.recovery.attempts[fingerprint]=attempt;
      const notSent=Boolean(budgetStopCode(recoveryError));
      if(notSent)delete work.recovery.attempts[fingerprint];
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'failed',phase,method:'model',changes:[],unit_ref:ref,at:attempt.failed_at,model_calls:notSent?0:1,error:recoveryError.message},undefined,
        notSent?{recovery_model_calls:Math.max(0,(job.recovery_model_calls??1)-1)}:{});
      if(recoveryError===transportError)throw recoveryError;
      if(String(recoveryError.code??'').startsWith('COMPILE_RECOVERY_'))throw recoveryError;
      throw Object.assign(new Error(`检查响应局部恢复失败：${recoveryError.message}`),{code:'COMPILE_RECOVERY_FAILED',cause:recoveryError});
    }
  };
  const invokeReview = async(phase,data,expectedIds,allowedIds,scope='cards',expectedKind=null) => {
    const originalRequestKey=unitRequestKey(buildUnitRequest(job,unit,work.references,phase,data));
    work.review_retries??={};
    const retry=work.review_retries[originalRequestKey];
    const requestData=retry?{...data,review_retry:retry.instruction}:data;
    let result;
    try{result=await invoke(phase,requestData);}catch(error){return recoverReview({phase,data:requestData,expectedIds,allowedIds,scope,expectedKind,result:null,error});}
    try{
      let reviewed=validateReview(result,expectedIds,allowedIds,expectedKind);
      if(scope!=='gap'&&['check','verify','relation-verify'].includes(phase)){
        const governed=governRoutineReviewIssues(reviewed,work.cards);
        reviewed=governed.issues;
        if(governed.changes.length){
          work.review_governance_events=[...(work.review_governance_events??[]),{at:new Date().toISOString(),changes:governed.changes}].slice(-20);
          persistRecovery({contract:ROUTINE_REVIEW_GOVERNANCE,status:'recovered',phase,method:'deterministic',changes:governed.changes,unit_ref:ref,at:new Date().toISOString(),model_calls:0},
            `${unit.meta.title}：已按正式契约剔除 ${governed.changes.length} 条越权或客观错误的审核意见。`);
        }
      }
      if(retry){delete work.review_retries[originalRequestKey];persist();}
      return {result,reviewed};
    }catch(error){
      if(REVIEW_SEMANTIC_ERRORS.has(error?.code)){
        if(retry)throw Object.assign(new Error(`复核响应再次超出本轮问题范围：${error.message}`),{code:'UNIT_REVIEW_SCOPE_VIOLATION'});
        work.review_retries[originalRequestKey]={attempts:1,at:new Date().toISOString(),instruction:{
          reason:error.message,expected_checked_ids:[...expectedIds],allowed_related_card_ids:[...allowedIds].filter(id=>!expectedIds.has(id)),expected_issue_kind:expectedKind
        }};
        persist(`${unit.meta.title}：复核响应超出本轮范围，正在按原卡、原问题和允许端点纠偏一次。`);
        return invokeReview(phase,data,expectedIds,allowedIds,scope,expectedKind);
      }
      return recoverReview({phase,data:requestData,expectedIds,allowedIds,scope,expectedKind,result,error});
    }
  };
  const acceptGenerated = (value,phase) => {
    if(isolationEnabled(job) && Array.isArray(value?.cards) && value.cards.length<=100 && value.cards.length){
      const counts=new Map();for(const card of value.cards)if(card?.id)counts.set(card.id,(counts.get(card.id)??0)+1);
      const valid=[];
      value.cards.forEach((card,index)=>{
        if(card && safeCardId(card.id) && counts.get(card.id)===1)valid.push(card);
        else isolateCompileItem(work,{key:`invalid-${phase}-${index}`,kind:'response',candidate:{raw:card},error:{code:'INVALID_GENERATION_RESPONSE',message:'候选 ID 无效或重复；原候选保留，不能猜测身份或覆盖同名单元内容。'}});
      });
      if(valid.length!==value.cards.length){value={...value,cards:valid,note:typeof value.note==='string'&&value.note.trim()?value.note:'部分候选身份无效，原响应保留待处理；覆盖情况未作声明。'};persist();}
      if(valid.length && (value.note==null || typeof value.note==='string'&&!value.note.trim())){
        for(const card of valid)if(typeof card.body!=='string'||!card.body.trim()||typeof card.title!=='string'||!card.title.trim())
          isolateCompileItem(work,{key:'card-'+card.id,card_id:card.id,error:{code:'INVALID_GENERATION_RESPONSE',message:'候选标题或正文不完整，原候选保留待单卡修复。'}});
        if(isolatedCardIds(work).size)value={...value,note:'模型未提供覆盖说明；部分候选结构不完整，覆盖情况未作声明。'};
      }
    }
    const normalized=job.workflow===BOOK_WORKFLOW?normalizeGeneratedEnvelope(value):{value,changes:[]};
    const generated=validateGeneratedCards(normalized.value);
    if(normalized.changes.length){
      const raw=work.last_response?.phase===phase?work.last_response:work.response;
      const fingerprint=compileRecoveryFingerprint({phase,requestKey:work.response?.key,responseText:raw?.text});
      const event={fingerprint,phase,method:'deterministic',changes:normalized.changes,at:new Date().toISOString(),original_response:raw?.text};
      work.recovery.events=[...work.recovery.events.filter(row=>row.fingerprint!==fingerprint),event].slice(-20);
      persistRecovery({contract:COMPILE_RECOVERY_CONTRACT,status:'recovered',phase,method:'deterministic',changes:normalized.changes,unit_ref:ref,at:event.at,model_calls:0});
    }
    return generated;
  };
  if(!work.cards){
    const partial=work.partial_generation?.cards??[];
    let generated;
    try {
      const value=job.repair_origin?.kind==='response'
        ? job.repair_origin.source_retry?await invoke('generate',partial.length||work.partial_generation?{previous_truncated:true,completed_cards:partial.map(compactCandidate)}:{}):job.repair_origin.manual_response?parseRetained(job.repair_origin.failed_response):await recoverGeneration(job.repair_origin.failed_response,new Error('原制卡响应格式不符合契约'))
        : work.last_response?.phase==='generate'?parseRetained(work.last_response.text):await invoke('generate',partial.length||work.partial_generation?{previous_truncated:true,completed_cards:partial.map(compactCandidate)}:{});
      generated=acceptGenerated(value,'generate');
    }catch(error){
      if(!isolationEnabled(job)||error.code!=='INVALID_GENERATION_RESPONSE'||job.repair_origin)throw error;
      const text=work.last_response?.phase==='generate'?work.last_response.text:null;
      if(!text)throw error;
      generated=acceptGenerated(await recoverGeneration(text,error),'generate');
    }
    const duplicate=new Set(partial.map(card=>card.id));
    if(generated.cards.some(card=>duplicate.has(card.id)))throw Object.assign(new Error('续写响应重复了已保留卡片，未覆盖已有候选。'),{code:'UNIT_CONTINUATION_DUPLICATE'});
    work.cards=reuseSameSourceCards([...partial,...generated.cards]);
    work.note=(partial.length?`输出截断前已保留 ${partial.length} 张完整候选；`:'')+generated.note;
    if(Object.keys(work.reused).length)work.note+=`；复用同一原文单元已有卡 ${Object.keys(work.reused).length} 张，未覆盖旧卡`;
    delete work.partial_generation;work.phase='check';persist();
  }
  work.cards=reuseSameSourceCards(work.cards);
  invalidateKnowledgeSnapshot(root);
  const catalog=loadCards(root,{includeInactive:true});
  for(const candidateId of work.cards.map(card=>card.id)){
    if(job.workflow!==BOOK_WORKFLOW)break;
    const candidate=work.cards.find(card=>card.id===candidateId);
    if(!eligible(candidate))continue;
    try {
    if(work.published[candidate.id]||authorityReferences().some(row=>row.id===candidate.id&&row.delivery!=='summary'))continue;
    const old=catalog.get(candidate.id);if(!old)continue;
    if(['archived','superseded'].includes(old.meta.lifecycle))throw Object.assign(new Error('已退役卡片不能通过普通编译复活：'+candidate.id),{code:'CARD_RETIRED'});
    const id=candidate.id,oldRef=unoCardRef(root,old),revision=unoRevision(root,oldRef);
    const collision=work.card_collisions[id]??={input_hash:hashCard(candidate),existing:{id,ref:oldRef,revision,delivery:'full',
      title:old.meta.title,type:old.meta.type,body:old.body,summary:old.meta.summary??'',domains:old.meta.domains??[],
      tags:old.meta.tags??[],sources:old.meta.sources??[],relations:old.meta.relations??[]}};
    if(collision.input_hash!==hashCard(candidate)||collision.existing.revision!==revision)
      throw Object.assign(new Error('同名卡核对期间候选或旧卡版本发生变化：'+id),{code:'REVISION_CONFLICT'});
    persist();
    const decision=await invoke('collision',{candidate,existing_card:collision.existing});
    activeJob(root,job.id,signal);
    if(unoRevision(root,oldRef)!==collision.existing.revision)throw Object.assign(new Error('同名卡核对期间旧卡版本发生变化：'+id),{code:'REVISION_CONFLICT'});
    if(!['reuse','revise','separate'].includes(decision?.action)||typeof decision.reason!=='string'||!decision.reason.trim())
      throw Object.assign(new Error('同名卡核对须给出 reuse、revise 或 separate 及具体依据。'),{code:'INVALID_COLLISION_DECISION'});
    if(decision.action==='revise'){
      const merged=validateRepairedCard(decision,id);
      const relations = card => (card.relations??[]).map(relation=>({...relation,basis:relation.basis??'source'}));
      if(!isDeepStrictEqual(merged.sources,candidate.sources)||!isDeepStrictEqual(relations(merged),relations(candidate))
        ||collision.existing.domains.some(domain=>!merged.domains?.includes(domain)))
        throw Object.assign(new Error('同名卡合并不能改写候选来源、扩张关系或移除旧卡领域。'),{code:'INVALID_COLLISION_DECISION'});
      merged.sources=candidate.sources;merged.relations=candidate.relations??[];
      work.cards[work.cards.findIndex(card=>card.id===id)]=merged;
    }else{
      if(decision.card!=null)throw Object.assign(new Error('复用或另建决策不能附带改写卡片。'),{code:'INVALID_COLLISION_DECISION'});
      if(decision.action==='reuse'){
        work.reused[id]={ref:oldRef,revision,reason:decision.reason};
        work.cards=work.cards.filter(card=>card.id!==id);
      }else{
        const base=id.slice(0,70)+'-'+sha(ref+id).slice(0,12);let next=base,n=1;
        while(catalog.has(next)||work.cards.some(card=>card.id===next))next=base+'-'+n++;
        collision.new_id=next;
        work.cards=work.cards.map(card=>({...card,...(card.id===id?{id:next}:{}),relations:(card.relations??[]).map(relation=>relation.target===id?{...relation,target:next}:relation)}));
      }
    }
    collision.action=decision.action;collision.reason=decision.reason;collision.applied=true;
    for(const cardId of [id,...work.cards.filter(card=>(card.relations??[]).some(relation=>relation.target===(collision.new_id??id))).map(card=>card.id)]){
      delete work.checks[cardId];delete work.pending_issues[cardId];delete work.pending_issue_records[cardId];
    }
    work.initial_review_done=false;persist();
    } catch(error) {
      if(!isolationEnabled(job)||!canIsolateFailure(error))throw error;
      isolateCompileItem(work,{key:'card-'+candidateId,card_id:candidateId,error});persist();
    }
  }
  assertReferenceAuthority(work.cards);
  if(!work.cards.length&&Object.keys(work.reused).length)work.empty_checked=true;
  work.cards=bindCardVersions(work.cards,authorityReferences());
  const sourceBinding=bindCurrentUnitSources(work.cards,unit.ref,authorityReferences().filter(card=>card.delivery!=='summary').map(card=>card.id));
  work.cards=sourceBinding.cards;
  if(sourceBinding.changes.length)work.source_binding_events=[...(work.source_binding_events??[]),{at:new Date().toISOString(),changes:sourceBinding.changes}].slice(-20);
  if(job.compile_quality_mode===COMPILE_QUALITY_REFINE_EACH_CARD){
    work.refinements??={};
    for(const cardId of work.cards.map(card=>card.id)){
      const index=work.cards.findIndex(card=>card.id===cardId),original=work.cards[index];
      if(index<0||!eligible(original)||work.published[cardId])continue;
      const inputHash=hashCard(original),previous=work.refinements[cardId];
      if(previous?.output_hash===inputHash&&previous?.status==='applied')continue;
      const targetIds=new Set((original.relations??[]).map(relation=>relation.target));
      const targets=[...new Map([...work.cards,...authorityReferences().filter(card=>card.delivery!=='summary')]
        .filter(card=>card.id!==cardId&&targetIds.has(card.id)).map(card=>[card.id,card])).values()];
      try{
        const refined=validateRepairedCard(await invoke('refine',{supplied_card:original,relation_targets:targets}),cardId);
        const relationTargets=new Set((original.relations??[]).map(relation=>relation.target));
        if(!isDeepStrictEqual(refined.sources,original.sources))throw Object.assign(new Error('逐卡精修不得改写已绑定来源。'),{code:'UNIT_REPAIR_SCOPE_VIOLATION'});
        if((refined.relations??[]).some(relation=>!relationTargets.has(relation.target)))throw Object.assign(new Error('逐卡精修不得新增未经本次完整提供的关系目标。'),{code:'UNIT_REPAIR_SCOPE_VIOLATION'});
        const bound=bindCardVersions([refined],authorityReferences())[0];
        work.cards[index]=bound;
        work.refinements[cardId]={contract:COMPILE_QUALITY_REFINE_EACH_CARD,input_hash:inputHash,output_hash:hashCard(bound),status:'applied',at:new Date().toISOString()};
        delete work.checks[cardId];delete work.pending_issues[cardId];delete work.pending_issue_records[cardId];
        work.initial_review_done=false;persist();
      }catch(error){
        if(!isolationEnabled(job)||!canIsolateFailure(error))throw error;
        isolateCompileItem(work,{key:'card-'+cardId,card_id:cardId,error});persist();
      }
    }
  }
  // Adopt previous successful per-card checks only for the exact candidate reviewed.
  if(!work.publish_first_version){
    for(const card of work.cards)if(work.checks[card.id]===sha(JSON.stringify(card)))work.checks[card.id]=hashCard(card);
    const ids=Object.keys(work.pending_issues);
    if(work.last_response?.phase==='repair'&&ids.length===1){
      try{const card=validateRepairedCard(parseRetained(work.last_response.text),ids[0]);
        if(card.id===ids[0])work.repair_response={id:card.id,card,input_hash:hashCard(work.cards.find(c=>c.id===card.id))};
      }catch{/* Keep malformed legacy output for inspection, without claiming it was applied. */}
    }
    work.publish_first_version=1;
  }
  if(work.review_governance_version!==ROUTINE_REVIEW_GOVERNANCE){
    const cardsById=new Map(work.cards.map(card=>[card.id,card])),changes=[];
    for(const id of Object.keys(work.pending_issues)){
      const before=issueRecords(id),governed=governRoutineReviewIssues(before,cardsById);
      if(governed.changes.length){
        setIssueRecords(id,governed.issues);changes.push(...governed.changes);
        if(work.repair_counts?.[id])work.repair_counts[id]={};
        if(work.repairs)delete work.repairs[id];
        if(work.verifying?.id===id)delete work.verifying;
        if(work.repair_response?.id===id)delete work.repair_response;
        if(work.repair_attempt?.id===id)delete work.repair_attempt;
      }
    }
    work.review_governance_version=ROUTINE_REVIEW_GOVERNANCE;
    if(changes.length){
      const at=new Date().toISOString();work.review_governance_events=[...(work.review_governance_events??[]),{at,changes}].slice(-20);
      persistRecovery({contract:ROUTINE_REVIEW_GOVERNANCE,status:'recovered',phase:'resume-reconcile',method:'deterministic',changes,unit_ref:ref,at,model_calls:0},
        `${unit.meta.title}：继续前已对账旧审核意见，并仅重新开放发生变化的问题卡。`);
    }
  }
  persist();
  const recordRead = (id,published) => {
    if(unoRevision(root,published.ref)!==published.revision)throw Object.assign(new Error('已保存卡片被其他操作修改：'+id),{code:'REVISION_CONFLICT'});
    const actual=parseCardFile(unoPath(root,published.ref));
    job.book_card_reads[id]={revision:published.revision,session_id:job.session_id,intervals:[[0,chars(actual.body)]]};
  };
  job=activeJob(root,job.id,signal);
  job.book_reads={ [ref]:{revision:unit.revision,session_id:job.session_id,intervals:[[0,chars(unit.body)]]} };
  job.book_card_reads=Object.fromEntries(authorityReferences().filter(card=>card.delivery!=='summary').map(card=>[card.id,{revision:card.revision,session_id:job.session_id,intervals:[[0,chars(card.body)]]}]));
  for(const row of Object.values(work.card_collisions).filter(row=>row.applied&&row.action==='reuse'))recordRead(row.existing.id,row.existing);
  for(const [id,p]of Object.entries(work.published))recordRead(id,p);
  saveCompileJob(root,job);
  const finishCommit = () => {
    if(!work.pending_commit)return;
    const pending=work.pending_commit;
    const receipt=gateway.saveBookCards({job_id:job.id,session_id:job.session_id,...pending.input});
    job=activeJob(root,job.id,signal);
    if(!job.receipts.some(r=>r.key===receipt.key))job.receipts.push(receipt);
    job.touched=[...new Set([...job.touched,...receipt.card_ids])];
    for(const row of receipt.publication.cards){
      work.published[row.id]={ref:row.ref,revision:row.revision,saved_card:pending.input.cards.find(c=>c.id===row.id),candidate_hash:pending.hashes[row.id]};
      recordRead(row.id,work.published[row.id]);
    }
    delete work.pending_commit;job.unit_work[ref]=work;saveCompileJob(root,job);
  };
  finishCommit(); // Receipts recover a crash after commit, before the job checkpoint.
  const args = cards => ({job_id:job.id,session_id:job.session_id,operation_id:'check-'+sha(ref).slice(0,32),cards});
  const mechanical = () => {
    const pending=work.cards.filter(c=>!work.published[c.id]);
    if(!pending.length)return;
    const result=gateway.checkBookCards({...args(pending),collect_errors:true});
    for(const error of result.errors){
      if(!eligible({id:error.card_id}))continue;
      if(['REVISION_CONFLICT','STALE_EVIDENCE','TASK_STOPPED','CARD_RETIRED','UNDELIVERED_EVIDENCE'].includes(error.code))throw Object.assign(new Error(error.message),error);
      addIssueRecords(error.card_id,[{kind:'card',related_card_ids:[],message:error.message}]);delete work.checks[error.card_id];
    }
    persist();
  };
  const publishPassed = () => {
    const approved=work.cards.filter(c=>(eligible(c)||work.published[c.id])&&work.checks[c.id]===hashCard(c)&&!work.pending_issues[c.id]);
    const available=new Set([...approved.map(c=>c.id),...Object.keys(work.published),...authorityReferences().map(c=>c.id)]);
    const cards=[];
    for(const candidate of approved){
      const old=work.published[candidate.id];
      const card={...candidate,relations:(candidate.relations??[]).filter(r=>available.has(r.target)
        && (!old || !job.repair_origin || (old.saved_card?.relations??[]).some(saved=>isDeepStrictEqual(saved,r))
          || work.deferred_link_checks?.[candidate.id]===sha(JSON.stringify([candidate,work.cards.filter(c=>(candidate.relations??[]).some(r=>r.target===c.id))]))))};
      if(old){
        if(old.candidate_hash!==hashCard(candidate))throw new Error('已通过并保存的卡片不能在问题卡修复中被重写。');
        if(hashCard(old.saved_card)===hashCard(card))continue;
        card.revision=old.revision; // Only deferred, already-reviewed links are added here.
      }
      cards.push(card);
    }
    if(!cards.length)return;
    const operation_id='pass-'+sha(ref+JSON.stringify(cards)).slice(0,48);
    work.pending_commit={input:{operation_id,cards},hashes:Object.fromEntries(approved.map(c=>[c.id,hashCard(c)]))};persist();finishCommit();
    persist(`${unit.meta.title}：已保存 ${Object.keys(work.published).length} 张卡片，问题卡单独处理。`);
  };
  mechanical();
  // Routine review sees only candidate cards and their relation targets. The
  // complete source is reserved for resuming an already-persisted gap review.
  const unreviewed=work.cards.filter(c=>eligible(c)&&work.checks[c.id]!==hashCard(c)&&!work.pending_issues[c.id]);
  // Structurally invalid candidates still receive semantic review once, so repair receives all concrete issues together.
  const reviewCards=work.initial_review_done?unreviewed:work.cards.filter(c=>eligible(c)&&work.checks[c.id]!==hashCard(c)&&!work.repair_response);
  const gapReview=work.coverage_recovery?.phase==='check'&&!work.coverage_recovery.reviewed;
  for(let offset=0;offset<reviewCards.length || (!work.cards.length&&!work.empty_checked);){
    let group=[];
    for(const candidate of reviewCards.slice(offset)){
      const next=[...group,candidate],ids=new Set(next.map(c=>c.id));
      const diagnosis=job.repair_origin&&work.repair_diagnosis?.status==='pending'&&ids.has(work.repair_diagnosis.card_id)?work.repair_diagnosis:null;
      const diagnosisTargets=new Set((diagnosis?.original_issues??[]).flatMap(issue=>issue.related_card_ids??[]));
      const targets=fullContextCards().filter(c=>!ids.has(c.id)&&(diagnosisTargets.has(c.id)||next.some(n=>(n.relations??[]).some(r=>r.target===c.id))));
      try{buildUnitRequest(job,unit,work.references,'check',{supplied_cards:next,relation_targets:targets,...(diagnosis?{repair_diagnosis:diagnosis}:{})});}catch(error){if(!group.length)throw error;break;}
      group=next;
    }
    if(gapReview&&group.length!==reviewCards.length)throw Object.assign(new Error('遗漏补充卡超出单次核验范围，候选已保留。'),{code:'UNIT_CONTEXT_LIMIT'});
    const ids=new Set(group.map(c=>c.id)),full=!work.coverage_checked&&group.length===work.cards.length;
    const repairDiagnosis=job.repair_origin&&work.repair_diagnosis?.status==='pending'&&ids.has(work.repair_diagnosis.card_id)?work.repair_diagnosis:null;
    const diagnosisTargets=new Set((repairDiagnosis?.original_issues??[]).flatMap(issue=>issue.related_card_ids??[]));
    const targets=fullContextCards().filter(c=>!ids.has(c.id)&&(diagnosisTargets.has(c.id)||group.some(n=>(n.relations??[]).some(r=>r.target===c.id))));
    const reviewData={supplied_cards:group,relation_targets:targets,review_scope:{kind:gapReview?'gap':'cards',card_ids:[...ids]},
      ...(gapReview?{coverage_issues:work.coverage_recovery.issues}:{}),...(repairDiagnosis?{repair_diagnosis:repairDiagnosis}:{})};
    let review;
    try { review=await invokeReview('check',reviewData,ids,new Set([...ids,...targets.map(card=>card.id)]),gapReview?'gap':'cards',repairDiagnosis?.kind??null); }
    catch(error){
      if(!isolationEnabled(job)||!group.length||!canIsolateFailure(error))throw error;
      for(const card of group)isolateCompileItem(work,{key:'card-'+card.id,card_id:card.id,error});
      offset+=group.length;persist();continue;
    }
    const {result,reviewed}=review;
    if(!gapReview&&result.unit_issues.length)throw new Error('候选卡检查没有原文，不能返回整章遗漏；已保留响应。');
    if(full){work.coverage_checked=true;work.unit_issues=[];}
    if(gapReview){work.coverage_recovery.reviewed=true;work.unit_issues=result.unit_issues;}
    if(repairDiagnosis){
      const diagnosed=reviewed.filter(issue=>issue.id===repairDiagnosis.card_id);
      setIssueRecords(repairDiagnosis.card_id,diagnosed);
      work.repair_diagnosis={...repairDiagnosis,status:'completed',diagnosed_at:new Date().toISOString(),issues:diagnosed.map(({id:ignored,...issue})=>issue)};
      mechanical();
    }else for(const issue of reviewed)addIssueRecords(issue.id,[issue]);
    for(const card of group)if(!work.pending_issues[card.id])work.checks[card.id]=hashCard(card);
    if(!work.cards.length)work.empty_checked=true;
    offset+=group.length;persist();publishPassed();
    if(!group.length)break;
  }
  work.initial_review_done=true;persist();publishPassed();
  const pendingIds=Object.keys(work.pending_issues).filter(id=>eligible({id}));
  const checkpointId=work.verifying?.id??work.repair_response?.id??work.repair_attempt?.id??null;
  if(checkpointId&&pendingIds.includes(checkpointId))pendingIds.splice(0,pendingIds.length,checkpointId,...pendingIds.filter(id=>id!==checkpointId));
  for(const id of pendingIds){
    try {
    for(;;){
      const scope=issueScope(id);if(!scope)break;
      if(work.verifying&&work.verifying.id!==id)throw Object.assign(new Error(`复核检查点属于 ${work.verifying.id}，不能用于 ${id}。`),{code:'UNIT_REVIEW_STATE_MISMATCH'});
      const index=work.cards.findIndex(c=>c.id===id);
      if(index<0)throw new Error('修复引用未知卡片：'+id);
      const original=work.cards[index],related=relatedCards(scope);
      if(scope.kind==='relation'&&related.length!==scope.related_card_ids.length)throw new Error('关系修复引用了当前单元中不存在的卡片。');
      work.repair_counts[id]??={};
      const legacyCount=scope.kind==='card'?(work.repairs[id]??0):0;
      const count=work.repair_counts[id][scope.kind]??legacyCount;
      const repairPhase=scope.kind==='relation'?'relation-repair':'repair';
      const verifyPhase=scope.kind==='relation'?'relation-verify':'verify';
      if(work.repair_response?.id===id&&(work.repair_response.kind??'card')!==scope.kind){delete work.repair_response;delete work.repair_attempt;persist();}
      if(work.verifying?.id===id&&(work.verifying.kind??'card')!==scope.kind){delete work.verifying;persist();}
      if(!work.verifying&&!work.repair_response&&count>=2)break;
      if(!work.verifying){
        let returned=work.repair_response;
        // Older code checkpointed a missing .card despite retaining a valid bare-card response.
        // Recover only when the paid response is bound to these exact inputs and attempt.
        const inputHash=hashCard(original),scopeHash=sha(JSON.stringify({kind:scope.kind,input:inputHash,related:related.map(card=>[card.id,hashCard(card)])}));
        const legacyAttemptKey=inputHash+sha(JSON.stringify(scope.issues)),attemptKey=scopeHash+sha(JSON.stringify(scope.issues));
        if(returned && !returned.card && scope.kind==='card' && returned.id===id && returned.input_hash===inputHash
          && work.repair_attempt?.id===id && [attemptKey,legacyAttemptKey].includes(work.repair_attempt.key)
          && work.repair_attempt.response_key===work.response?.key && work.response?.phase===repairPhase){
          returned={...returned,kind:scope.kind,scope_hash:scopeHash,card:validateRepairedCard(parseRetained(work.response.text),id)};
          work.repair_response=returned;persist();
        }
        if(!returned){
          const repairRetry=work.repair_retries[attemptKey];
          const repairData={supplied_card:original,related_cards:related,issues:scope.issues,
            ...(repairRetry?{repair_retry:repairRetry.instruction}:{})};
          const activeRequestKey=unitRequestKey(buildUnitRequest(job,unit,work.references,repairPhase,repairData));
          const cached=work.response?.key===activeRequestKey&&work.response?.phase===repairPhase
            && !work.rejected_repair_responses[activeRequestKey];
          if(!cached){if(count>=2)break;work.repairs[id]=(work.repairs[id]??0)+1;work.repair_counts[id][scope.kind]=count+1;work.repair_attempt={id,key:attemptKey,kind:scope.kind};persist();}
          const value=cached?parseRetained(work.response.text):await invoke(repairPhase,repairData);
          let repairedCard;
          try{repairedCard=validateRepairedCard(value,id);}
          catch(error){
            if(repairRetry)throw error;
            work.repair_retries[attemptKey]={at:new Date().toISOString(),instruction:{
              reason:error.message,expected_card_id:id,required_envelope:{card:'完整卡片对象，不能为 null'}
            }};
            delete work.repair_attempt;persist(`${unit.meta.title}：单卡修复返回空对象或错误卡，正在用同一张卡和原问题纠偏一次。`);continue;
          }
          delete work.repair_retries[attemptKey];
          returned={id,kind:scope.kind,input_hash:inputHash,scope_hash:scopeHash,card:repairedCard};work.repair_response=returned;persist();
        }
        if(returned.input_hash!==inputHash||returned.scope_hash&&returned.scope_hash!==scopeHash||returned.card?.id!==id)throw new Error('修复响应与当前问题卡或关系端点版本不匹配，未写入。');
        const permitted=new Set([...(original.relations??[]).map(r=>r.target),...(scope.kind==='relation'?scope.related_card_ids:[])]);
        if((returned.card.relations??[]).some(r=>!permitted.has(r.target)))throw Object.assign(new Error(scope.kind==='relation'?'关系修复新增了未经本轮完整核对的目标。':'单卡修复不得新增关系目标。'),{code:'UNIT_REPAIR_SCOPE_VIOLATION'});
        if(scope.kind==='relation'){
          const difference=relationScopeDifference(original,returned.card);
          if(!difference.equivalent)throw Object.assign(new Error('关系修复只能修改 relations，不能改写卡片其他内容。'),{code:'UNIT_REPAIR_SCOPE_VIOLATION'});
          if(difference.punctuationOnly){
            returned.card={...original,relations:returned.card.relations??[]};work.repair_response=returned;
            const event={contract:RELATION_SCOPE_PROJECTION,card_id:id,restored_fields:difference.changed,
              method:'restore-original-nonrelation-fields',at:new Date().toISOString()};
            work.relation_scope_events=[...(work.relation_scope_events??[]),event].slice(-20);
            persist(`${unit.meta.title}：关系修复只采用 relations；摘要中的空白或标点漂移已恢复为原值。`);
          }
        }
        work.cards[index]=bindCardVersions([returned.card],authorityReferences())[0];
        work.verifying={id,kind:scope.kind,issues:scope.issues,related_card_ids:scope.related_card_ids,
          original_relations:(original.relations??[]).map(relation=>({...relation})),scope_hash:scopeHash,
          response_key:work.response?.key};
        delete work.repair_response;delete work.repair_attempt;delete work.checks[id];persist();
      }
      const fixed=work.cards[index];
      const structural=gateway.checkBookCards({...args(work.cards.filter(c=>!work.published[c.id])),collect_errors:true}).errors.filter(e=>e.card_id===id);
      if(structural.length){
        const rejectedKey=work.verifying?.response_key;
        if(rejectedKey)work.rejected_repair_responses[rejectedKey]={card_id:id,at:new Date().toISOString(),
          code:structural[0].code,message:structural[0].message};
        addIssueRecords(id,structural.map(error=>({kind:'card',related_card_ids:[],message:error.message})));
        delete work.verifying;persist();continue;
      }
      const verifying=work.verifying,verifyRelated=fullContextCards().filter(card=>(verifying.related_card_ids??[]).includes(card.id));
      const verifyData={supplied_card:fixed,related_cards:verifyRelated,issues:verifying.issues};
      const verification=relationDeletionResolved(fixed,verifying)
        ? {result:{checked_ids:[id],issues:[],unit_issues:[]},reviewed:[]}
        : await invokeReview(verifyPhase,verifyData,new Set([id]),new Set([id,...verifyRelated.map(card=>card.id)]),'card',verifying.kind);
      const {result:verified,reviewed}=verification;
      if(verified.unit_issues.length)throw new Error('单卡核对不能返回整章问题。');
      if(reviewed.some(issue=>issue.kind!==verifying.kind))throw new Error('复核不能把原问题改成另一类问题；应回到候选卡检查阶段。');
      const untouched=issueRecords(id).filter(record=>record.kind!==verifying.kind);
      setIssueRecords(id,[...untouched,...reviewed]);
      if(!work.pending_issues[id])work.checks[id]=hashCard(fixed);
      delete work.verifying;persist();publishPassed();
    }
    } catch(error){
      if(!isolationEnabled(job)||!canIsolateFailure(error))throw error;
      const records=work.pending_issue_records?.[id]??[];
      const repairKind=(work.verifying?.id===id?work.verifying.kind:work.repair_response?.id===id?work.repair_response.kind:null)
        ??(records.length&&records.every(issue=>issue.kind==='relation')?'relation':'card');
      isolateCompileItem(work,{key:`${repairKind==='relation'?'link':'card'}-${id}`,card_id:id,kind:repairKind,error,candidate:work.cards.find(card=>card.id===id)});
      if(work.verifying?.id===id)delete work.verifying;
      if(work.repair_response?.id===id)delete work.repair_response;
      if(work.repair_attempt?.id===id)delete work.repair_attempt;
      persist();
    }
  }
  publishPassed();
  if(job.repair_origin){
    for(const candidate of work.cards){
      const old=work.published[candidate.id];if(!old||candidate.id===job.repair_origin.card_id)continue;
      const pending=(candidate.relations??[]).filter(relation=>work.published[relation.target]&&!(old.saved_card?.relations??[]).some(saved=>isDeepStrictEqual(saved,relation)));
      if(!pending.length)continue;
      const related=work.cards.filter(card=>pending.some(relation=>relation.target===card.id));
      const messages=pending.map(relation=>`核验待补写关系 ${candidate.id} → ${relation.target}（${relation.type}）：${relation.note}。仅判断当前两端内容是否仍支持这条关系，不新增关系或改写正文。`);
      try{
        const verification=await invokeReview('relation-verify',{supplied_card:candidate,related_cards:related,issues:messages},new Set([candidate.id]),new Set([candidate.id,...related.map(card=>card.id)]),'card','relation');
        if(verification.reviewed.length){
          setIssueRecords(candidate.id,verification.reviewed);delete work.checks[candidate.id];
          isolateCompileItem(work,{key:'link-'+candidate.id,kind:'relation',card_id:candidate.id,error:{code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'待补写关系在当前两端内容下尚未通过核验，原正文已保存。'}});
        }else (work.deferred_link_checks??={})[candidate.id]=sha(JSON.stringify([candidate,work.cards.filter(c=>(candidate.relations??[]).some(r=>r.target===c.id))]));
      }catch(error){
        if(!canIsolateFailure(error))throw error;
        isolateCompileItem(work,{key:'link-'+candidate.id,kind:'relation',card_id:candidate.id,error});
      }
      persist();
    }
    publishPassed();
  }
  const remaining=work.cards.filter(c=>selected(c)&&!work.published[c.id]);
  if(!remaining.length && work.unit_issues?.length && !work.coverage_recovery?.reviewed){
    // Persist this one bounded attempt. Resume reuses its exact response and candidates.
    work.coverage_recovery??={phase:'generate',issues:[...work.unit_issues],existing_cards:work.cards.map(c=>({id:c.id,title:c.title}))};
    persist();
    if(work.coverage_recovery.phase==='generate'){
      const extra=acceptGenerated(await invoke('supplement',{coverage_issues:work.coverage_recovery.issues,existing_cards:work.coverage_recovery.existing_cards}),'supplement');
      const forbidden=new Set([...work.cards.map(c=>c.id),...work.references.map(c=>c.id)]);
      if(extra.cards.length>3||extra.cards.some(c=>forbidden.has(c.id)))throw Object.assign(new Error('遗漏补全只能提交最多 3 张新卡，不能重写已保存卡。响应已保留。'),{code:'UNIT_COVERAGE_BLOCKED'});
      if(!extra.cards.length){work.coverage_recovery.reviewed=true;work.coverage_recovery.note=extra.note;persist();}
      else{
        work.cards.push(...extra.cards);work.coverage_recovery.card_ids=extra.cards.map(c=>c.id);work.coverage_recovery.phase='check';work.initial_review_done=false;
        work.note+='\n补全范围：'+extra.note;persist();
        return runBookTurn(ctx,root,job,signal,generate);
      }
    }
  }
  if(remaining.length || work.unit_issues?.length){
    const error=Object.assign(new Error(`已保存 ${Object.keys(work.published).length} 张卡片；${remaining.length} 张问题卡尚未通过。`+(work.unit_issues?.length?'本单元遗漏仍未解决，定点补全不会反复重做：'+work.unit_issues.join('；'):'')),{code:work.unit_issues?.length?'UNIT_COVERAGE_BLOCKED':'UNIT_CARD_REPAIR_EXHAUSTED'});
    if(!isolationEnabled(job))throw error;
    for(const card of remaining)if(!isolatedCardIds(work).has(card.id))isolateCompileItem(work,{key:'card-'+card.id,card_id:card.id,error});
    if(work.unit_issues?.length)isolateCompileItem(work,{key:'coverage',kind:'coverage',error});
  }
  if(isolationEnabled(job)&&isolationOpen(work).some(([,item])=>!job.repair_origin?.card_id||item.card_id===job.repair_origin.card_id)){
    persist();job=activeJob(root,job.id,signal);settleQuarantinedUnit(job,ref);
    const ids=job.book_outcomes[ref].card_ids;
    const governance=synchronizeUnassignedPool(root,{card_ids:ids,job_id:job.id,unit_ref:ref});
    recordDomainUnit(job,{unit_ref:ref,card_ids:ids,unassigned_card_ids:ids.filter(id=>governance.unassigned[id])});
    saveCompileJob(root,job);return;
  }
  job=activeJob(root,job.id,signal);
  job.book_outcomes[ref]={status:'processed',note:work.note,card_ids:[...new Set([...Object.keys(work.published),...Object.keys(work.reused)])],revision:unit.revision,delivered_chars:chars(unit.body)};
  const outcomeCards=job.book_outcomes[ref].card_ids;
  const governance=synchronizeUnassignedPool(root,{card_ids:outcomeCards,job_id:job.id,unit_ref:ref});
  const domainState=recordDomainUnit(job,{unit_ref:ref,card_ids:outcomeCards,unassigned_card_ids:outcomeCards.filter(id=>governance.unassigned[id])});
  domainState.open_unassigned=Object.values(governance.unassigned).filter(row=>row.status==='open').length;
  work.phase='done';job.unit_work[ref]=work;job.book_advance_requested=true;
  job.detail=`${unit.meta.title}：已审查并保存 ${work.cards.length} 张卡片`+(Object.keys(work.reused).length?`，复用 ${Object.keys(work.reused).length} 张同源旧卡。`:'。');saveCompileJob(root,job);
}

export async function runDomainGovernanceCheckpoint(ctx, root, initial, signal, reason, generate = generateUnitResponse) {
  let job=activeJob(root,initial.id,signal),state=job.domain_governance;
  const cardIds=[...new Set(state?.unassigned_card_ids??[])];
  if(!cardIds.length)return false;
  const pack=buildDomainGovernancePackage(root,cardIds);
  if(!pack.cards.length){recordDomainCheckpoint(job,{reason,card_ids:cardIds});saveCompileJob(root,job);return false;}
  if(!pack.domains.length&&pack.cards.length<3){recordDomainCheckpoint(job,{reason,card_ids:pack.cards.map(card=>card.id)});job.detail=`领域治理检查点：仅 ${pack.cards.length} 张未组织卡，尚不足以形成稳定新领域，已留待后续批次。`;saveCompileJob(root,job);return false;}
  job.detail=`领域治理检查点：核对 ${pack.cards.length} 张未组织卡片。`;saveCompileJob(root,job);
  const request=buildDomainGovernanceRequest(job,pack),result=validateDomainGovernanceResult(parseUnitJSON(await generate(ctx,root,job,request,signal)),pack);
  if(result.assignments.length){
    const assignedIds=result.assignments.map(row=>row.card_id),domainIds=[...new Set(result.assignments.flatMap(row=>row.domains))];
    const receipt=new HarnessGateway(root).applyDomainGovernance({key:`domain-governance/${job.id}/${job.domain_governance.checkpoints.length}/assign`,assignments:result.assignments,
      create_domains:[],expected_cards:Object.fromEntries(assignedIds.map(id=>[id,pack.card_revisions[id]])),
      expected_domains:Object.fromEntries(domainIds.map(id=>[id,pack.domain_revisions[id]]))});
    job=activeJob(root,job.id,signal);if(!job.receipts.some(row=>row.key===receipt.key))job.receipts.push(receipt);
    job.touched=[...new Set([...job.touched,...assignedIds])];const pool=synchronizeUnassignedPool(root,{card_ids:assignedIds,job_id:job.id});
    job.domain_governance.open_unassigned=Object.values(pool.unassigned).filter(row=>row.status==='open').length;
  }
  const pending=result.proposals.map(proposal=>({...proposal,
    card_revisions:Object.fromEntries(proposal.member_card_ids.map(id=>[id,pack.card_revisions[id]])),
    domain_revisions:Object.fromEntries([...new Set([...proposal.parents,...proposal.closest_domains])].map(id=>[id,pack.domain_revisions[id]]))}));
  if(pending.length)persistDomainProposals(root,pending,pack,{job_id:job.id,checkpoint_reason:reason});
  job=activeJob(root,job.id,signal);job.domain_catalog=domainCatalogRows(listDomainsV2(root));
  job.domain_governance.pending_proposals=pending;
  job.domain_governance.last_unassigned=result.unassigned;
  recordDomainCheckpoint(job,{reason,card_ids:pack.cards.map(card=>card.id),proposal_ids:pending.map(row=>row.proposal_id),assigned:result.assignments.map(row=>row.card_id)});
  if(pending.length&&job.domain_approval_mode==='automatic'){
    const approveIds=pending.map(row=>row.proposal_id),checkpoint=job.domain_governance.checkpoints.length-1;
    const summary=applyPendingDomainProposals(root,job,{approve_ids:approveIds,key:`domain-governance/automatic/${job.id}/${checkpoint}/${sha(JSON.stringify([...approveIds].sort()))}`,
      applied_note:'本次编译已获授权；提案通过确定性校验后自动创建领域并挂靠成员。'});
    job.status='running';job.phase='read';job.detail=`领域治理检查点完成：自动创建 ${summary.approved} 个领域并挂靠 ${summary.assigned} 张卡；另有 ${result.unassigned.length} 张继续留在未组织池。`;
    saveCompileJob(root,job);return false;
  }
  if(pending.length){job.status='review';job.phase='domain_review';job.detail=`领域治理检查点提出 ${pending.length} 个新领域，需确认后再继续；已自动挂靠 ${result.assignments.length} 张到既有领域。`;saveCompileJob(root,job);return true;}
  job.phase='read';job.detail=`领域治理检查点完成：挂靠 ${result.assignments.length} 张，${result.unassigned.length} 张继续留在未组织池。`;saveCompileJob(root,job);return false;
}
function validateReview(result,ids,allowedIds=ids,expectedKind=null){
  if(!Array.isArray(result.checked_ids)||new Set(result.checked_ids).size!==ids.size||result.checked_ids.length!==ids.size||result.checked_ids.some(id=>!ids.has(id))
    ||!Array.isArray(result.issues)||!Array.isArray(result.unit_issues)||result.unit_issues.some(i=>typeof i!=='string'||!i.trim())||result.issues.some(i=>!ids.has(i.id)||typeof i.message!=='string'||!i.message.trim()))
    throw Object.assign(new Error('审查响应未覆盖指定卡片或问题无效，原响应已保留。'),{code:'INVALID_REVIEW_RESPONSE'});
  const reviewed=result.issues.map(issue=>normalizeIssue(issue,allowedIds,issue.id));
  if(expectedKind&&reviewed.some(issue=>issue.kind!==expectedKind))
    throw reviewContractError(`本轮只允许返回 ${expectedKind} 问题。`,'INVALID_REVIEW_ISSUE_KIND');
  return reviewed;
}

export async function executeBookCompile(ctx, root, initial, controller, dependencies = {}) {
  const signal = controller.signal, id = initial.id;
  const timer = setTimeout(() => controller.abort(new Error('本次执行达到 30 分钟，进度保留。')), 30 * 60 * 1000);
  try {
    let job = activeJob(root, id, signal);
    reconcileBookReceipts(root, job);bootstrapDomainGovernanceJob(root,job);saveCompileJob(root, job);
    if (job.phase === 'prepare') job = await prepareBookJob(root, job, signal, dependencies.preprocess);
    for (;;) {
      job = activeJob(root, id, signal);
      const next = nextBookFocus(job);
      if (!next.length) {
        if(job.repair_origin){
          const outcome=job.book_outcomes[job.repair_origin.unit_ref];
          job.status=outcome?.status==='processed'?'completed':'partial';job.phase='done';
          job.detail=job.status==='completed'?'选定待办已通过审核并保存，修复收据已保留。':'选定待办仍有未解决问题，候选和本次响应已保留。';
          saveCompileJob(root,job);reconcileIsolationRepair(root,job);return;
        }
        job = archiveFinishedBooks(root, job); activeJob(root, id, signal);
        const reason=domainCheckpointDue(job,{book_end:true});
        if(reason&&await (dependencies.domainCheckpoint??runDomainGovernanceCheckpoint)(ctx,root,job,signal,reason,dependencies.generate))return;
        completeBookState(job); saveCompileJob(root, job); return;
      }
      if (job.book_advance_requested && (!job.continuous || job.stop_after_batch)) {
        job.status = 'paused'; job.detail = '当前单元已保存，可继续剩余单元。'; saveCompileJob(root, job); return;
      }
      job.book_advance_requested = false; job.book_focus_refs = next;
      job.batch_index = job.book_units.findIndex(u => u.ref === next[0]); saveCompileJob(root, job);
      try { await (dependencies.turn ?? runBookTurn)(ctx, root, job, signal, dependencies.generate); }
      catch(error){
        if(!isolationEnabled(job)||!canIsolateFailure(error))throw error;
        job=activeJob(root,id,signal);quarantineUnit(job,next[0],error);saveCompileJob(root,job);
      }
      job=readCompileJob(root,id);
      const responseOnly=job.book_outcomes[next[0]]?.status==='quarantined'&&!job.unit_work[next[0]].cards?.length;
      job.isolation_failure_streak=responseOnly?(job.isolation_failure_streak??0)+1:0;saveCompileJob(root,job);
      if(job.isolation_failure_streak>=3)throw Object.assign(new Error('连续三个单元未获得可用候选，已保留响应并暂停；请检查模型连接或响应格式后再继续。'),{code:'COMPILE_FAILURE_CIRCUIT'});
      if (!job.book_outcomes[next[0]]) throw new Error('单元没有完成，已停止以避免重复提交。');
      job = archiveFinishedBooks(root, job); activeJob(root, id, signal);
      const reason=job.repair_origin?null:domainCheckpointDue(job,{book_end:!nextBookFocus(job).length});
      if(reason&&await (dependencies.domainCheckpoint??runDomainGovernanceCheckpoint)(ctx,root,job,signal,reason,dependencies.generate))return;
    }
  } catch (error) {
    const job = readCompileJob(root, id); job.status = job.end_requested ? 'ended' : 'paused';
    job.error_code = budgetStopCode(error) ?? error.code ?? 'UNIT_COMPILE_STOPPED';
    job.last_failure={code:job.error_code,message:(signal.aborted ? signal.reason?.message : error.message)||'执行中断，进度已保留。',
      ...classifyCompileFailure({...error,code:job.error_code},signal.aborted),at:new Date().toISOString()};
    job.detail = (signal.aborted ? signal.reason?.message : error.message) || '执行中断，进度已保留。'; saveCompileJob(root, job);
  } finally {
    clearTimeout(timer);
    const current=readCompileJob(root,id);
    if(current.repair_origin && current.status!=='running'){
      try{reconcileIsolationRepair(root,current);}catch(error){current.repair_reconciliation_error=error.message;saveCompileJob(root,current);}
    }
    if(settleResumeGuard(current))saveCompileJob(root,current);
  }
}
