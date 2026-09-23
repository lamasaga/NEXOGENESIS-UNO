import type {ConstructionControls,ConstructionOperation} from '../../../packages/nexogenesis-tools/lib/construction-controls.js';
import type { GraphData, SimEvent } from "../graph/types";
import { prepareStart, completeStart, rejectStart } from '../conversations/recovery';
import type { ConstructRequest, ConstructPreparation } from "../../../packages/nexogenesis-tools/lib/construct-options.js";
export type { ConstructRequest, ConstructPreparation } from "../../../packages/nexogenesis-tools/lib/construct-options.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export interface UnoTokenUsage {tokens:number;limit:number;exact:boolean;method:string;warning?:string}
export interface UnoPreferences {construction_controls_contract?:string;purpose?:string;construction?:ConstructionControls;organization?:{cards:'independent'|'integrated';domains:'broad'|'focused';cross_domain:'normal'|'priority'};prompt:string;cleaning:'clear'|'retain';compile_quality?:'standard'|'refine-each-card-v1';external_images:boolean;delivery:'auto'|'manual';budget_calls:number;revision:string|null;library?:{id:string;name:string}}
export const fetchUnoPreferences=async(signal?:AbortSignal):Promise<UnoPreferences>=>jsonOrThrow(await fetch('/api/uno/preferences',{signal}));
export const saveUnoPreferences=async(value:UnoPreferences):Promise<UnoPreferences>=>{if(value.construction_controls_contract!=='focus-and-permissions-v1')throw Error('当前服务尚未加载新版知识处理设置，请更新服务后保存。');return jsonOrThrow(await fetch('/api/uno/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,library_id:value.library?.id})}));};
export const countUnoPreferences=async(notes:string,inherit=true,signal?:AbortSignal):Promise<UnoTokenUsage>=>jsonOrThrow(await fetch('/api/uno/preferences/count',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes,inherit}),signal}));
export interface UnoCardDraft { id: string; title: string; type: string; domains: string[]; body: string; sources: string[] }
export interface UnoLink { source: string; target: string; type: string; note: string }
export interface UnoConstructionPlan {
  goal:string;kind:string;scope_count:number;notice:string;unselected:string[];
  candidate_count?:number;fingerprint?:string;
  strategy?:{goal:string;expected_improvement:string;operations:string[];decision_rules:string[];evidence_requirements:string[];stop_conditions:string[]};
  selection?:{anchors:string[];selected:Array<{id:string;role:string;reason:string;required_evidence:string[]}>;excluded:Array<{id:string;reason:string}>;packages:Array<{card_ids:string[];purpose:string;reason:string}>};
  packages:Array<{id:string;goal:string;card_ids:string[];purpose?:string;reason:string;status:string;note?:string}>;
  skipped:Array<{id:string;card_ids:string[];previous_job?:string;note?:string}>;
}
export interface UnoRelationWeaving {
  contract:string;needs_replan?:boolean;
  rounds:Array<{round:number;batch_index?:number;phase:'isolated'|'island'|'random';attempt?:number;candidate_ids?:string[];focus_ids:string[];relation_endpoint_ids?:string[];status:string;published:string[]}>;
  last_diagnosis?:{phase:'isolated'|'island'|'random'|'done';counts:{cards:number;eligible?:number;reviewed?:number;unreviewed?:number;isolated:number;unreviewed_isolated?:number;components:number;islands:number;unreviewed_islands?:number;main_component_cards:number}};
}
export interface UnoConstructionResult {id:string;status:string;note:string;kind?:string;source_verified?:boolean}
export interface UnoConstructionDecision {id:string;status:string;note:string;changes?:{relations?:Array<{target:string;type:string;note:string;basis?:string;origin?:string}>}}
export interface UnoConstructionWork {author?:{decisions:UnoConstructionDecision[]};effective_author?:{decisions:UnoConstructionDecision[]};repair?:{decisions:UnoConstructionDecision[]};repair_staged?:boolean}
export interface UnoResumeAction {id:'resume'|'quarantine-candidates'|'discard-candidates'|'defer-unit'|'retry-deferred-unit';label:string;effect:string}
export interface UnoResumePlan {contract:string;kind:'resume'|'decision'|'review'|'blocked'|'complete';reason:string;primary?:UnoResumeAction;actions:UnoResumeAction[];fingerprint:string}
export interface UnoDomainProposal {proposal_id:string;kind:'create';id:string;title:string;summary:string;core_questions:string[];includes:string[];excludes:string[];parents:string[];representative_card_ids:string[];member_card_ids:string[];closest_domains:string[];why_new:string;alternative:string}
export interface UnoBookSource {source:string;original_source?:string;source_ref?:string;source_revision?:string;extraction_revision?:string;title?:string;warnings:string[];units:Array<{ref:string}>;incomplete?:boolean}
export interface UnoJob {
  id: string; session_id: string; mode: "compile" | "construct"; title: string; authority: "manual" | "trusted";
  status: "running" | "review" | "paused" | "failed" | "partial" | "completed" | "ended"; version: number;
  readonly?:boolean;readonly_reason?:string;
  construct_contract?: string;
  card_classification?: 'single-type-and-domains-v1'|'ordered-single-type-and-domains-v2';
  construct_scope?: 'explicit-card-ids-v1'|'type-and-domain-v1'; execution_profiles?: string[];
  orchestration_profile?: 'bounded-workflow-v1';
  compile_profile?: 'unit-cards-v2'|'unit-cards-v3'; compile_review_policy?: 'review-publish-repair-v2';compile_quality_mode?:'standard'|'refine-each-card-v1';
  domain_approval_mode?:'manual'|'automatic';
  review_policy?: 'harness-first-v1' | 'review-publish-repair-v1' | 'review-publish-repair-v2';
  book_units?:Array<{ref:string;title:string;locator?:string;chars:number}>;
  book_outcomes?:Record<string,{status:'processed'|'deferred'|'quarantined';note:string;card_ids:string[]}>;
  isolation_summary?:{contract:string;open:number;cards:number;responses:number};
  book_focus_refs?:string[];book_overview?:string|{summary?:string};touched?:string[];
  domain_catalog?:Array<{id:string;title:string;summary?:string;parents:string[];revision?:string|null}>;
  domain_governance?:{contract:string;status:string;effective_units_since_checkpoint:number;unassigned_card_ids:string[];open_unassigned?:number;last_unassigned?:Array<{card_id:string;reason:string}>;pending_proposals:UnoDomainProposal[];checkpoints:Array<{at:string;reason:string;card_ids:string[];proposal_ids:string[];assigned:string[]}>};
  last_recovery?:{contract:string;status:'checking'|'recovered'|'failed';phase:string;method:'deterministic'|'model';changes:string[];unit_ref:string;at:string;model_calls:number;error?:string};
  last_failure?:{code:string;message:string;provider_message?:string;category:string;automatic_recovery:boolean;retryable:boolean;at:string};
  construction_controls?:ConstructionControls;
  construction_profile?: 'direction-driven-v1'|'strategy-driven-v2';construction_plan?:UnoConstructionPlan;
  relation_weaving?:UnoRelationWeaving;
  construction_results?:Record<string,Record<string,UnoConstructionResult>>;
  direct_work?:Record<string,UnoConstructionWork>;
  provider_budget?: {used?:number;limit?:number;remaining?:number;available?:boolean;current?:{role:string;allowance:number;reviewReserve:number}|null};
  resume_budget_calls?:number;
  resume_available?:boolean;resume_blocked_reason?:string;
  resume_plan?:UnoResumePlan;
  batch_records?: Record<string,{reviewed?:Record<string,{unchanged?:boolean;note:string;issues?:string[]}>}>;
  selection_workflow?: string;
  selection_summary?: {total:number;unseen:number;digest:number;exclude:number;defer:number;admitted:number;restored:number};
  selection?: Record<string,{status:string;reason:string;evidence?:{basis:string;quote:string};screening?:{archive?:string;record:string}}>;
  owner_session_id?: string; end_requested?: boolean; ended_at?: string;
  batch_index?:number; role?:string; remaining_units?:number; completed_batches?:Array<{index:number;published:string[];pending:number}>;
  detail: string; cursor: number; batches: string[][]; theme?: string;
  error_code?:string|null;last_error?:{code?:string;message:string;phase?:string;role?:string;batch?:number};closed_from_detail?:string;
  workflow?: string; phase?: string; notes?: string; budget?: {calls:number};
  operation?:'unassigned-card-recompile'|'unassigned-card-domain'|'isolated-card-repair';
  issues?: Array<{id:string;detail:string;status:string}>;
  pending?: { cards: Array<UnoCardDraft | {id:string;title:string}>; links?: UnoLink[];
    duplicates?: Record<string, Array<{id:string;title:string}>>; skipped?: Array<{ref:string;reason:string}> } | null;
  calls: Array<{ id?:string; phase: string; role?:string; batch?:number; status?: string; started_at?:string; finished_at?:string; elapsed_ms?: number; usage?: {inputTokens?:number;outputTokens?:number} }>;
  receipts: Array<{construction_outcomes?:Array<{id:string;title:string;kind:'relation'|'domain'|'card';operation?:'merge'|'edit'}>;key:string; summary:string; card_ids:string[];link_count:number;staged?:boolean}>;
  sources: UnoBookSource[];
  archives?:Array<{key:string;source:string;source_ref:string;archived:boolean;inbox_removed:boolean}>;
  archive_review?:{contract:'book-archive-review-v1';sources:Array<{source:string;title:string;warnings:string[]}>};
  failures: Array<{source:string;detail:string}>;
}
export interface UnoUnassignedCard {
  kind?:'unassigned'|'repair';repair_kind?:'card'|'relation'|'response'|'coverage';
  job_id?:string;unit_ref?:string;card_id?:string|null;issues?:string[];active_repair_job?:string|null;
  repair_status?:string|null;last_repair?:{job_id:string;status:string;reason:string};response_truncated?:boolean;
  id:string;title:string;type:string;summary:string;excerpt:string;sources:string[];source_groups:string[];
  reason:string;candidate_domains:string[];organization_signals:string[];created_at:string|null;last_evaluated_at:string|null;
  revision:string;inbound_relation_count:number;outbound_relation_count:number;updated:string;
}
export interface UnoRepairDetail extends UnoUnassignedCard {body:string;raw_response:string|null;candidate:Record<string,unknown>|null}
export interface UnoUnassignedPool {items:UnoUnassignedCard[];library:{id:string;name:string};capabilities?:{manual_seed_domain?:boolean}}
export interface UnoPreparation {
  orchestration_profiles?: string[];
  compile_review_policy?:'harness-first-v1'|'review-publish-repair-v1'|'review-publish-repair-v2';compile_review_policies?:string[];
  compile_profile?:'bounded-workflow-v1'|'unit-cards-v2'|'unit-cards-v3';compile_model?:{available:boolean;message?:string};compile_card_refinement?:'refine-each-card-v1';compile_quality_modes?:Array<'standard'|'refine-each-card-v1'>;
  domain_approval_modes?:Array<'manual'|'automatic'>;
  construction_controls?:{contract:string;operations:ConstructionOperation[]};
  construction_profiles?:string[];default_construction_profile?:string;construction_strategy_contract?:string;construction_review_policy?:string;construction_repair_scope?:string;relation_weaving_contract?:string;relation_weaving_focus_selection?:string;relation_weaving_endpoint_retrieval?:string;relation_weaving_max_focus_attempts?:number;construction_json_recovery?:string;construction_response_recovery?:string;uno_construction_service?:number;uno_relation_weaving?:number;construction_model?:{available:boolean;message?:string};
  preferences?:UnoPreferences; library?:{id:string;name:string}; pending_materials?:Array<{ref:string;title:string}>;
  construct_contract?: string;
  card_classification?:'ordered-single-type-and-domains-v2';
  compile_version?:string; compile_hints?:Array<{id:string;label:string;prompt:string}>;
  authority: "manual" | "trusted"; types: Array<{id:string;label:string}>; domains:Array<{id:string;title:string;summary?:string;parents:string[]}>;domain_governance?:{contract:string;unassigned_count:number;pending_proposals:number};
  sources: Array<{path:string;compile_available?:boolean;compile_unavailable_reason?:string;compile_max_bytes?:number;upload_max_bytes?:number;compile_state?:'unfinished'|'archive_review'|'archive_pending';job_id?:string;processed_units?:number;total_units?:number;open_items?:number}>;
  archived_sources?:Array<{path:string;job_id:string;title:string;source_ref:string;source_revision:string}>;
  cards: Array<{id:string;title:string;type:string;domains:string[]}>;
  jobs: Array<{id:string;mode:"compile"|"construct";title:string;status:string}>;
}
export async function fetchUnoPreparation(signal?: AbortSignal): Promise<UnoPreparation> {
  return jsonOrThrow(await fetch("/api/uno/prepare", {signal}));
}
export async function fetchUnoUnassignedPool(signal?:AbortSignal):Promise<UnoUnassignedPool>{
  const pool:UnoUnassignedPool=await jsonOrThrow(await fetch('/api/uno/unassigned',{signal}));
  return {...pool,items:pool.items.filter(item=>Boolean(item.created_at||item.last_evaluated_at))};
}
export async function recompileUnoUnassignedCard(id:string,libraryId:string,requestId:string=globalThis.crypto.randomUUID()):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/unassigned/'+encodeURIComponent(id)+'/recompile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({library_id:libraryId,request_id:requestId,budget_calls:6})}));
}
export async function organizeUnoUnassignedCard(id:string,libraryId:string,requestId:string=globalThis.crypto.randomUUID()):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/unassigned/'+encodeURIComponent(id)+'/organize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({library_id:libraryId,request_id:requestId,budget_calls:4})}));
}
export async function fetchUnoRepair(id:string,signal?:AbortSignal):Promise<UnoRepairDetail>{
  return jsonOrThrow(await fetch('/api/uno/repairs/'+encodeURIComponent(id),{signal}));
}
export async function repairUnoCandidate(item:UnoRepairDetail,libraryId:string,notes:string,responseJson:string,requestId:string):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/repairs/'+encodeURIComponent(item.id),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({library_id:libraryId,expected_revision:item.revision,notes,response_json:responseJson,request_id:requestId})}));
}
export interface UnoCardDeletionReceipt {accepted:true;summary:string;card_id:string;archived_ref:string;changed_card_ids:string[];changed_domain_ids:string[]}
export interface UnoManualDomainInput {id?:string;title:string;summary:string;core_questions:string[];includes:string[];excludes:string[]}
export interface UnoDomainCreationReceipt {accepted:true;summary:string;card_ids:string[];domain_ids:string[];publication:{cards:string[];domains:string[]}}
export async function createUnoDomainFromCard(card:Pick<UnoUnassignedCard,'id'|'revision'>,libraryId:string,domain:UnoManualDomainInput,requestId:string=globalThis.crypto.randomUUID()):Promise<UnoDomainCreationReceipt>{
  return jsonOrThrow(await fetch('/api/uno/unassigned/'+encodeURIComponent(card.id)+'/create-domain',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({library_id:libraryId,expected_revision:card.revision,request_id:requestId,domain})}));
}
export async function deleteUnoUnassignedCard(card:Pick<UnoUnassignedCard,'id'|'revision'>,libraryId:string,reason=''):Promise<UnoCardDeletionReceipt>{
  return jsonOrThrow(await fetch('/api/uno/unassigned/'+encodeURIComponent(card.id),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({library_id:libraryId,confirm_id:card.id,expected_revision:card.revision,reason})}));
}
export async function fetchUnoJob(id: string, signal?: AbortSignal): Promise<UnoJob> {
  return jsonOrThrow(await fetch("/api/uno/jobs/" + encodeURIComponent(id), {signal}));
}
export interface UnoStartInput {construction_controls?:ConstructionControls;request_id?:string;mode:"compile"|"construct";sources?:string[];material_kind?:'auto'|'book'|'article';card_ids?:string[];compile_profile?:'unit-cards-v2'|'unit-cards-v3';compile_quality_mode?:'standard'|'refine-each-card-v1';domain_approval_mode?:'manual'|'automatic';execution_profile?:'evidence-pack-v1';orchestration_profile?:'bounded-workflow-v1';review_policy?:'harness-first-v1';construction_profile?:'direction-driven-v1'|'strategy-driven-v2';force_recheck?:boolean;theme?:string;domain?:string;type?:string;notes?:string;budget_calls?:number;library_id?:string;inherit_preferences?:boolean;continuous?:boolean;delivery?:'auto'|'manual';external_images?:boolean}
export const isLegacyCompileJob=(job:Pick<UnoJob,'mode'|'workflow'>)=>job.mode==='compile'&&!['uno-unit-compile-v2','uno-unit-compile-v3'].includes(job.workflow??'');
export async function startUnoJob(input: UnoStartInput): Promise<UnoJob> {
  if(input.mode==='compile'&&input.compile_profile!=='unit-cards-v3')throw Error('此开始请求属于历史编译，不能重新执行。请查看原记录，再从 Inbox 重新选书。');
  const pending=prepareStart(input),library=input.library_id??'legacy';
  const response=await fetch("/api/uno/jobs", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,request_id:pending.id}),signal:AbortSignal.timeout(20000)});
  if([400,403,413].includes(response.status))rejectStart(library,pending.id);
  const job:UnoJob=await jsonOrThrow(response);completeStart(library,pending.id,job.owner_session_id??job.session_id);return job;
}
export async function updateUnoJob(job: UnoJob, action:"review"|"resume"|"cancel"|"end"|"retry"|"stop-after-batch", allowTitles: string[] = [], skipTitles: string[] = [], budgetCalls?:number): Promise<UnoJob> {
  if((job.readonly||isLegacyCompileJob(job))&&['resume','retry','review','stop-after-batch'].includes(action))throw Error('历史编译仅供查看，不能继续执行。请从 Inbox 重新选书，开始新编译。');
  return jsonOrThrow(await fetch("/api/uno/jobs/" + encodeURIComponent(job.id) + "/" + action,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:job.version,decision:"save",allow_titles:allowTitles,skip_titles:skipTitles,budget_calls:budgetCalls})}));
}
export async function resolveUnoJob(job:UnoJob,decision:Exclude<UnoResumeAction['id'],'resume'>,budgetCalls?:number):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/jobs/'+encodeURIComponent(job.id)+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:job.version,decision,budget_calls:budgetCalls})}));
}
export async function reviewUnoDomains(job:UnoJob, approveIds:string[], deferIds:string[]):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/jobs/'+encodeURIComponent(job.id)+'/domain-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:job.version,approve_ids:approveIds,defer_ids:deferIds})}));
}
export async function reviewUnoBookArchive(job:UnoJob,source:string):Promise<UnoJob>{
  return jsonOrThrow(await fetch('/api/uno/jobs/'+encodeURIComponent(job.id)+'/archive-review',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({version:job.version,source,note:'已核对任务列出的提取警告，确认未提取内容不属于需要继续编译的正文。'})}));
}
export async function fetchUnoSource(jobId: string, ref: string): Promise<{body:string;locator:string}> {
  return jsonOrThrow(await fetch("/api/uno/jobs/" + encodeURIComponent(jobId) + "?source=" + encodeURIComponent(ref)));
}
import { waitForSignal } from './abort';
let localRequestToken: string | null = null;
let localTokenEpoch = 0;
let requestInstance: string | null = null;
let requestEpoch = 0;
let requestIdentityUncertain = false;
export function suspendInstanceWrites() { requestIdentityUncertain=true;requestEpoch++; }
export function setRequestInstance(id: string | null) { requestInstance=id;requestIdentityUncertain=false;requestEpoch++; }
let localRequestTokenPromise: Promise<string> | null = null;
const GRAPH_OVERVIEW_CACHE_KEY = "nexogenesis.graph-overview.v3";
const GRAPH_OVERVIEW_CACHE_TTL_MS = 60_000;
let graphOverviewMemoryCache: GraphOverviewCacheEntry | null = null;
let graphOverviewCacheEpoch = 0;
let graphOverviewRequest: { epoch: number; promise: Promise<GraphOverviewStats> } | null = null;

/** Test isolation hook; production code never needs to clear the process token. */
export function __resetLocalRequestTokenForTests(): void {
  localTokenEpoch++;
  localRequestToken = null;
  localRequestTokenPromise = null;
}

/** Test isolation hook for the graph-overview cache. */
export function __resetGraphOverviewCacheForTests(): void {
  graphOverviewMemoryCache = null;
  graphOverviewCacheEpoch = 0;
  graphOverviewRequest = null;
}

async function getLocalRequestToken(force = false): Promise<string> {
  if (force) {
    localTokenEpoch++;
    localRequestToken = null;
    localRequestTokenPromise = null;
  }
  if (localRequestToken) return localRequestToken;
  if (!localRequestTokenPromise) {
    const epoch = localTokenEpoch;
    const signal = AbortSignal.timeout(10000);
    const request = waitForSignal(globalThis.fetch("/api/security/session", {signal})
      .then(async (response) => {
        if (!response.ok) throw new Error(`本地安全会话初始化失败: ${response.status}`);
        const body = await response.json();
        if (typeof body?.token !== "string" || !body.token) throw new Error("本地安全会话没有返回令牌");
        if (epoch === localTokenEpoch) localRequestToken = body.token;
        return body.token;
      }), signal).catch(error=>{if(epoch===localTokenEpoch){localTokenEpoch++;localRequestToken=null;}throw error;}).finally(() => { if (localRequestTokenPromise === request) localRequestTokenPromise = null; });
    localRequestTokenPromise = request;
  }
  return localRequestTokenPromise;
}

/** Same-origin API wrapper: unsafe requests carry a per-process local token. */
async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const independent = String(input).startsWith('/api/instances') || String(input) === '/api/security/session';
  const epoch = requestEpoch;
  const identity = requestInstance;
  const headers = new Headers(init?.headers);
  const method = String(init?.method ?? "GET").toUpperCase();
  const signal = SAFE_METHODS.has(method) ? (init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)) : init?.signal;
  if (!independent && identity && !headers.has('X-Nexogenesis-Instance')) headers.set('X-Nexogenesis-Instance',identity);
  init = {...init,headers,signal};
  const deliver = (response:Response) => {
    if (!independent && epoch !== requestEpoch) throw new Error('知识库已切换，已忽略旧请求结果。');
    if (response.status === 409 && typeof window !== 'undefined') void response.clone().json().then(body=>{if(body?.code==='INSTANCE_CHANGED')window.dispatchEvent(new Event('uno-instance-changed'));}).catch(()=>{});
    for (const name of ['json','text'] as const) {
      if(typeof response[name]!=='function')continue;
      const read=response[name].bind(response);
      response[name]=async()=>{
        const value=await waitForSignal(read(),signal);
        if(!independent&&epoch!==requestEpoch)throw new Error('知识库已切换，已忽略旧请求结果。');
        return value;
      };
    }
    return response;
  };
  if (SAFE_METHODS.has(method)) {
    return deliver(await waitForSignal(globalThis.fetch(input, {...init,signal}),signal));
  }
  const request = async (forceToken: boolean) => {
    init?.signal?.throwIfAborted();
    if (!independent && requestIdentityUncertain) throw new Error('当前知识库身份待核对，暂不提交写操作。');
    if (!independent && epoch !== requestEpoch) throw new Error('知识库已切换，未提交旧请求。');
    const token = await waitForSignal(getLocalRequestToken(forceToken), init?.signal);
    init?.signal?.throwIfAborted();
    if (!independent && epoch !== requestEpoch) throw new Error('知识库已切换，未提交旧请求。');
    const headers = new Headers(init?.headers);
    headers.set("X-Nexogenesis-CSRF", token);
    return waitForSignal(globalThis.fetch(input, { ...init, headers }),init?.signal);
  };
  const first = await request(false);
  if (first.status === 403) {
    const error = await waitForSignal(first.clone().json(),init?.signal).catch(error=>{init?.signal?.throwIfAborted();return null;});
    if (error?.code === 'LOCAL_TOKEN_INVALID') return deliver(await request(true));
  }
  return deliver(first);
}

export async function fetchGraph(): Promise<GraphData> {
  const r = await fetch("/api/graph");
  if (!r.ok) throw new Error(`/api/graph ${r.status}`);
  return r.json();
}

export interface CardDetail {
  revision?:string; edit_id?:string|null; user_notes?:ReaderNote[]; user_edited_at?:string;
  domain_content?: DomainContentDetail;
  assets?:Array<{ref:string;url:string;caption:string;locator:string}>;library_id?:string|null;
  summary?:string; quality_notes?:string[]; superseded_by?:string;
  id: string; title: string; type: string; maturity: string;
  domains: string[]; domain_titles?: Record<string, string>;
  relations?: CardRelation[]; sources?: string[];
  updated: string; body: string;
}

export interface ReaderAnchor { block:string; block_start:number; quote:string; start:number; end:number; before?:string; after?:string; }
export interface ReaderNote { id:string; text:string; anchor:ReaderAnchor|null; created_at:string; updated_at:string; author:'user'; revision:string; }
export interface ReaderWrite { operation:'body'|'note'; text:string; expected_revision:string; request_id:string; note_id?:string; expected_note_revision?:string|null; anchor?:ReaderAnchor|null; }
export async function saveReaderEntry(id:string, input:ReaderWrite):Promise<{accepted:boolean;revision:string}> {
  return jsonOrThrow(await fetch(`/api/cards/${encodeURIComponent(id)}/reader`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}));
}

export interface KnowledgeInstanceSummary { id: string; name: string; legacy: boolean; active: boolean; card_count: number | null; status?: 'available'|'unavailable'|'invalid_manifest'; reason?:string; warnings?:string[]; }
export interface KnowledgeInstanceList { active_instance_id: string | null; instances: KnowledgeInstanceSummary[]; }
export interface ProjectKnowledge { project_id: string; project_name: string; knowledge_instance_ids: string[]; instances: KnowledgeInstanceSummary[]; }
export async function fetchProjectKnowledge(projectId: string): Promise<ProjectKnowledge> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, { cache: 'no-store' }));
}
export async function saveProjectKnowledge(projectId: string, ids: string[]): Promise<ProjectKnowledge> {
  return jsonOrThrow(await fetch(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ knowledge_instance_ids: ids }) }));
}

export async function fetchKnowledgeInstances(): Promise<KnowledgeInstanceList> { return jsonOrThrow(await fetch("/api/instances", { cache: "no-store" })); }
export async function switchKnowledgeInstance(instanceId: string): Promise<{active_instance_id:string;instance:KnowledgeInstanceSummary}> { return jsonOrThrow(await fetch("/api/instances/switch", { method: "POST", signal:AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance_id: instanceId }) })); }
export async function createKnowledgeInstance(name: string): Promise<void> { await jsonOrThrow(await fetch("/api/instances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })); }
export async function registerKnowledgeInstance(path: string, name: string): Promise<void> { await jsonOrThrow(await fetch("/api/instances/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name }) })); }
export async function renameKnowledgeInstance(instanceId: string, name: string): Promise<void> { await jsonOrThrow(await fetch(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })); }
export async function unregisterKnowledgeInstance(instanceId: string): Promise<void> { await jsonOrThrow(await fetch(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" })); }

export interface CardRelation {
  direction: "incoming" | "outgoing";
  target: string;
  target_title: string;
  type: string;
  note?: string;
  basis?: 'source' | 'navigation';
  use_when?: string;
  limits?: string;
  anchors?: Array<{ id: string; title: string }>;
}

export interface DomainContentDetail {
  core_questions: string[]; includes: string[]; excludes: string[];
  parents: Array<{ id: string; title: string }>;
  representative_cards: Array<{ id: string; title: string }>;
  member_count: number; missing_fields: string[];
}

export interface CardCatalogItem {
  id: string; title: string; type: string; maturity: string;
  domains: string[]; domain_titles: Record<string, string>;
  updated: string; excerpt: string; relation_count: number; source_count: number;
}

export interface CardCatalogFacet { value: string; label: string; count: number; }
export interface CardCatalogResponse {
  items: CardCatalogItem[];
  total: number;
  all_total: number;
  facets: {
    types: CardCatalogFacet[];
    domains: CardCatalogFacet[];
    relations: CardCatalogFacet[];
  };
}

export interface CardCatalogQuery {
  query?: string;
  type?: string;
  domain?: string;
  relation?: string;
  sort?: "relevance" | "updated" | "title" | "relations";
}

export async function fetchCard(id: string): Promise<CardDetail> {
  const r = await fetch(`/api/cards/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`卡片不存在: ${id}`);
  return r.json();
}

export async function fetchCardCatalog(query: CardCatalogQuery = {}, signal?: AbortSignal): Promise<CardCatalogResponse> {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set("q", query.query.trim());
  if (query.type) params.set("type", query.type);
  if (query.domain) params.set("domain", query.domain);
  if (query.relation) params.set("relation", query.relation);
  if (query.sort) params.set("sort", query.sort);
  const suffix = params.size ? `?${params.toString()}` : "";
  const r = await fetch(`/api/cards${suffix}`, { signal });
  if (!r.ok) throw new Error(`知识卡片列表读取失败: ${r.status}`);
  return r.json();
}

export async function simulate(scenario: string, batch = false): Promise<void> {
  const r = await fetch(
    `/api/simulate/${encodeURIComponent(scenario)}${batch ? "?batch=1" : ""}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
  );
  if (!r.ok) throw new Error(`未知剧本: ${scenario}`);
}

export interface ReplayEvent {
  t: number;
  type: string;
  payload: Record<string, unknown>;
}

export async function fetchReplay(scenario: string): Promise<ReplayEvent[]> {
  const r = await fetch(`/api/replay/${encodeURIComponent(scenario)}`);
  if (!r.ok) throw new Error(`未知剧本: ${scenario}`);
  return (await r.json()).events;
}

export function subscribeEvents(conversationId: string | null, onEvent: (ev: SimEvent) => void, onOpen?:()=>void): () => void {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : "";
  const es = new EventSource(`/api/events${query}`);
  let closed=false;
  let lastEpoch:string|undefined,lastSeq=0;
  es.onopen=()=>{if(!closed)onOpen?.();};
  es.onmessage = (msg) => {
    if(closed)return;
    try {
      const frame=JSON.parse(msg.data) as SimEvent & {epoch?:string;seq?:number};
      if(frame.epoch&&typeof frame.seq==='number') {
        if(frame.epoch===lastEpoch&&frame.seq<=lastSeq)return;
        if(lastEpoch&&lastEpoch!==frame.epoch)onOpen?.();
        lastEpoch=frame.epoch;lastSeq=frame.seq;
      }
      onEvent(frame);
    } catch {
      /* 忽略坏帧 */
    }
  };
  return () => {closed=true;es.close();};
}

// ---------- 设置 ----------

import type { ModelConnection, ModelProvider, ModelProviderOption, VisionMode } from "../../../packages/nexogenesis-tools/lib/model-providers.js";
export type { ModelConnection, ModelProvider, ModelProviderOption, VisionMode };

export interface Settings {
  provider: ModelProvider;
  base_url: string;
  model: string;
  api_key_masked: string;
  has_key: boolean;
  credential_status: Partial<Record<ModelProvider, { api_key_masked: string; has_key: boolean }>>;
  provider_options: ModelProviderOption[];
  provider_configs?: Partial<Record<ModelProvider, ModelConnection>>;
  thinking_mode?: ModelConnection["thinking_mode"];
  reasoning_effort?: string;
  model_type?: ModelConnection["model_type"];
  thinking_protocol?: ModelConnection["thinking_protocol"];
  vision_mode?: VisionMode;
  model_settings_version?: number;
  connection_test_version?: number;
  vision_base_url: string;
  vision_model: string;
  vision_api_key_masked: string;
  has_vision_key: boolean;
  vision_configured: boolean;
  username: string;
  style_prompt: string;
  default_style_prompt: string;
  digest_two_stage: boolean;
  pipeline_authority: "manual" | "trusted";
}

async function jsonOrThrow(r: Response) {
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* 保留 status */ }
    throw Object.assign(new Error(detail),{status:r.status});
  }
  return r.json();
}

export async function fetchSettings(): Promise<Settings> {
  return jsonOrThrow(await fetch("/api/settings"));
}

export interface ConnectionTestResult {
  provider: ModelProvider; base_url: string; model: string; model_listed: boolean;
  models: string[]; truncated: boolean; elapsed_ms: number; message: string;
}
export async function testModelConnection(connection: ModelConnection, apiKey: string, signal?: AbortSignal): Promise<ConnectionTestResult> {
  return jsonOrThrow(await fetch("/api/settings/test", {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...connection, api_key: apiKey }),
  }));
}

export async function saveSettings(s: {
  provider: ModelProvider; base_url: string; model: string; api_key?: string; username?: string; style_prompt?: string;
  vision_base_url?: string; vision_model?: string; vision_api_key?: string;
  thinking_mode?: ModelConnection["thinking_mode"]; reasoning_effort?: string;
  model_type?: ModelConnection["model_type"]; thinking_protocol?: ModelConnection["thinking_protocol"]; vision_mode?: VisionMode;
  digest_two_stage?: boolean;
  pipeline_authority?: "manual" | "trusted";
}): Promise<Settings> {
  return jsonOrThrow(await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: "", ...s }),
  }));
}

// ---------- 项目与会话 ----------

export interface ConversationSummary {
  id: string; title: string; updated_at: string;
  pinned?: boolean; task_kind?: PipelineStage; uno_job_id?: string;
}

export interface Project {
  id: string; name: string; created_at: string;
  conversations: ConversationSummary[];
}

export interface ChatMessage {
  id?: string;
  seq?: number;
  role: "user" | "assistant" | "system";
  content: string;
  ts?: string;
  sources?: SourceCard[];
  status?: "completed" | "aborted" | "failed";
  detail?: string;
  thinking_route?: ThinkingRoute;
  intent?: ThinkingIntent;
  tool_trace?: AgentStep[];
}

export interface Conversation {
  id: string; project_id: string; title: string;
  created_at: string; updated_at: string;
  pinned?: boolean; task_kind?: PipelineStage; uno_job_id?: string;
  thinking_mode?: "quick";
  thinking_route?: ThinkingRoute;
  pipeline_history?: PipelineHistory;
  messages: ChatMessage[];
  history?: ConversationHistoryState;
}

export interface ConversationHistoryState {
  oldest_seq: number | null;
  newest_seq: number | null;
  has_older: boolean;
  reset_required: boolean;
}

export interface ConversationWindow extends Conversation {
  history: ConversationHistoryState;
}

export type PipelineStage = "compile" | "theme_compile" | "digest" | "construct";
export interface PipelineHistoryRecord {
  stage: PipelineStage;
  ts: string;
  status: "completed" | "failed" | "paused";
  summary: string;
  buffers: number;
  cards_created: number;
  cards_enriched: number;
  cards_adjusted: number;
}
export interface PipelineHistory {
  archived_runs: number;
  completed_runs: number;
  failed_runs: number;
  paused_runs: number;
  buffers: number;
  cards_created: number;
  cards_enriched: number;
  cards_adjusted: number;
  recent: PipelineHistoryRecord[];
}
export interface PipelineStatus { inbox: number; scratch: number; }
export interface InboxDocument {
  path: string;
  doc_type: "text" | "pdf" | "epub" | "other";
  size: number;
  modified_at: number;
}
export interface InboxDocumentList { documents: InboxDocument[]; }
export interface PipelineJobRecord {
  id: string; stage: PipelineStage; state: PipelineRunPhase; label: string;
  detail?: string; wave?: number; total_processed?: number; updated_at?: string; pause_requested?: boolean;
}
export type PipelineRunPhase = "starting" | "running" | "waiting_user" | "completed" | "failed" | "blocked" | "paused" | "cancelled";
export interface PipelineRunState {
  stage: PipelineStage;
  phase: PipelineRunPhase;
  label: string;
  steps: string[];
  startedAt: number;
  jobId?: string;
  detail?: string;
  pauseRequested?: boolean;
}

export async function fetchProjects(): Promise<Project[]> {
  return (await jsonOrThrow(await fetch("/api/projects", { cache: "no-store" }))).projects;
}

export async function createProject(name: string): Promise<Project> {
  return jsonOrThrow(await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
}

export async function createConversation(projectId: string, thinkingMode?: "quick"): Promise<Conversation> {
  if (thinkingMode === "quick") {
    const health = await jsonOrThrow(await fetch("/api/health"));
    if (health.capabilities?.uno_intent_routing !== 1) throw new Error("当前后台尚未加载自动意图识别。请启动更新后的 UNO 服务再试。");
  }
  return jsonOrThrow(await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, ...(thinkingMode ? { thinking_mode: thinkingMode } : {}) }),
  }));
}

export async function fetchConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  return jsonOrThrow(await fetch(`/api/conversations/${encodeURIComponent(id)}`, {signal}));
}

export async function fetchConversationWindow(id: string, options: {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<ConversationWindow> {
  const query = new URLSearchParams();
  if (options.beforeSeq !== undefined) query.set("before_seq", String(options.beforeSeq));
  if (options.afterSeq !== undefined) query.set("after_seq", String(options.afterSeq));
  query.set("limit", String(options.limit ?? 30));
  return jsonOrThrow(await fetch(`/api/conversations/${encodeURIComponent(id)}/history?${query}`, { signal: options.signal }));
}

export async function updateConversation(id: string, update: {
  title?: string; pinned?: boolean;
}): Promise<Conversation> {
  return jsonOrThrow(await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  }));
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) await jsonOrThrow(response);
}

export interface ConversationBatchDeleteResult {
  deletedIds: string[];
  failures: Array<{ id: string; message: string }>;
}

export async function deleteConversations(ids: string[]): Promise<ConversationBatchDeleteResult> {
  const deletedIds: string[] = [];
  const failures: ConversationBatchDeleteResult["failures"] = [];
  for (const id of [...new Set(ids)]) {
    try {
      await deleteConversation(id);
      deletedIds.push(id);
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deletedIds, failures };
}

export async function sendChat(conversationId: string, message: string):
  Promise<{ answer: string; conversation_id: string }> {
  return jsonOrThrow(await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, message }),
  }));
}

// ---------- 流式对话 ----------

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (detail: string) => void;
  onFrameError?: (detail: string) => void;
  onStep?: (step: AgentStep) => void;
  onSources?: (cards: SourceCard[]) => void;
  onIntent?: (intent: ThinkingIntent) => void;
  onConfirmRequest?: (proposal: WriteProposal) => void;
  onCandidateRequest?: (candidates: EmergenceCandidate[]) => void;
  onChoiceRequest?: (request: CognitiveInteraction) => void;
  onPipelineStatus?: (status: { state: PipelineRunPhase; label: string; detail?: string; jobId?: string }) => void;
}

export interface OverviewCount { type: string; count: number; }
export interface GraphOverviewStats {
  node_count: number;
  edge_count: number;
  domain_count: number;
  entity_count: number;
  node_types: OverviewCount[];
  classification_scope: "ordered-single-type-and-domains-v2";
  relation_types: OverviewCount[];
  relation_highlight: { types: string[]; note: string } | null;
  judgment: { tone: "info" | "ok" | "warning"; text: string };
}

interface GraphOverviewCacheEntry {
  savedAt: number;
  value: GraphOverviewStats;
}

function graphOverviewStorage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === "undefined" ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function isGraphOverviewStats(value: unknown): value is GraphOverviewStats {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GraphOverviewStats>;
  return typeof candidate.node_count === "number"
    && typeof candidate.edge_count === "number"
    && Array.isArray(candidate.node_types)
    && candidate.classification_scope === "ordered-single-type-and-domains-v2"
    && Array.isArray(candidate.relation_types)
    && typeof candidate.judgment?.text === "string";
}

function readGraphOverviewEntry(): GraphOverviewCacheEntry | null {
  if (graphOverviewMemoryCache) return graphOverviewMemoryCache;
  const storage = graphOverviewStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(GRAPH_OVERVIEW_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GraphOverviewCacheEntry>;
    if (typeof parsed.savedAt !== "number" || !isGraphOverviewStats(parsed.value)) {
      storage.removeItem(GRAPH_OVERVIEW_CACHE_KEY);
      return null;
    }
    graphOverviewMemoryCache = { savedAt: parsed.savedAt, value: parsed.value };
    return graphOverviewMemoryCache;
  } catch {
    try { storage.removeItem(GRAPH_OVERVIEW_CACHE_KEY); } catch { /* 忽略不可用的存储。 */ }
    return null;
  }
}

export function readCachedGraphOverview(options: { allowStale?: boolean } = {}): GraphOverviewStats | null {
  const entry = readGraphOverviewEntry();
  if (!entry) return null;
  if (!options.allowStale && Date.now() - entry.savedAt > GRAPH_OVERVIEW_CACHE_TTL_MS) return null;
  return entry.value;
}

function cacheGraphOverview(value: GraphOverviewStats): GraphOverviewStats {
  const entry = { savedAt: Date.now(), value };
  graphOverviewMemoryCache = entry;
  try {
    graphOverviewStorage()?.setItem(GRAPH_OVERVIEW_CACHE_KEY, JSON.stringify(entry));
  } catch { /* 内存缓存仍然有效。 */ }
  return value;
}

export function invalidateGraphOverviewCache(): void {
  graphOverviewMemoryCache = null;
  graphOverviewCacheEpoch += 1;
  try {
    graphOverviewStorage()?.removeItem(GRAPH_OVERVIEW_CACHE_KEY);
  } catch { /* 无持久缓存时无需处理。 */ }
}

export async function fetchGraphOverview(options: { forceRefresh?: boolean } = {}): Promise<GraphOverviewStats> {
  if (!options.forceRefresh) {
    const cached = readCachedGraphOverview();
    if (cached) return cached;
  }
  const requestEpoch = graphOverviewCacheEpoch;
  if (graphOverviewRequest?.epoch === requestEpoch) return graphOverviewRequest.promise;
  const promise = fetch("/api/graph/overview")
    .then((response) => jsonOrThrow(response))
    .then((value:GraphOverviewStats) => requestEpoch === graphOverviewCacheEpoch && value.classification_scope === "ordered-single-type-and-domains-v2"
      ? cacheGraphOverview(value as GraphOverviewStats)
      : value as GraphOverviewStats)
    .finally(() => {
      if (graphOverviewRequest?.promise === promise) graphOverviewRequest = null;
    });
  graphOverviewRequest = { epoch: requestEpoch, promise };
  return promise;
}

export interface UserChoiceOption { id: string; label: string; description: string; }
export interface NativeQuestion {
  rpc_id: string; session_id: string; live: boolean;
  questions: Array<{ id: string; question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
}
export interface NativeAnswer { id: string; selected: string[]; custom?: string; }
export interface WorkItem {
  job_version?: number; task_status?: string; control_pending?: string|null; can_finish?: boolean; held_inputs?: Array<{id:string;text:string}>;
  uno_job_id?: string;
	 delivery?: AnalysisDelivery | null;
	 run_id?: string | null; task_run_id?: string | null; discussing?: boolean; discussion_requested?: boolean; can_discuss?: boolean;
  id: string; title: string; stage: PipelineStage | null;
  phase: string; executing: boolean; outcome: string | null; goal: string | null; detail: string;
  updated_at: string; can_continue: boolean; native_question: NativeQuestion | null;
  interaction: CognitiveInteraction | null; proposals: WriteProposal[];
}
export async function fetchWork(signal?:AbortSignal): Promise<{ items: WorkItem[]; native_ready: boolean; controls_version?: number; start_request_version?:number }> {
  return jsonOrThrow(await fetch("/api/work",{signal}));
}
export async function answerNativeQuestion(question: NativeQuestion, answers: NativeAnswer[]): Promise<void> {
  await jsonOrThrow(await fetch(`/api/work/${encodeURIComponent(question.session_id)}/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rpc_id: question.rpc_id, answers }),
  }));
}
export async function controlWork(id: string, action: "pause" | "stop" | "finish", expected?: {expected_job_id?:string;version?:number;expected_run_id?:string|null}): Promise<void> {
  await jsonOrThrow(await fetch(`/api/work/${encodeURIComponent(id)}/stop`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...expected }),
  }));
}
export async function answerCognitiveChoice(id: string, response: { option_id?: string; answer?: string }): Promise<void> {
  await jsonOrThrow(await fetch(`/api/cognition/interactions/${encodeURIComponent(id)}/respond`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(response),
  }));
}
export interface CognitiveInteraction {
  interaction_id: string; run_id: string; session_id: string; type: "choice";
  status: "pending" | "answered" | "cancelled";
  request_key: string; question: string; options: UserChoiceOption[];
}

export type CognitiveEventKind = "run.started" | "tm.selected" | "op.started" | "op.observed"
  | "workspace.updated" | "interaction.waiting" | "interaction.resumed" | "proposal.created"
  | "harness.receipt" | "governance.signal" | "run.completed" | "run.failed" | "run.cancelled" | "write.applied";

export interface CognitiveTargetSet {
  node_ids?: string[]; edge_ids?: string[]; source_ids?: string[]; domain_ids?: string[];
  created?: string[]; enriched?: string[];
  walk_layers?: Array<{
    depth: number; node_ids: string[]; edge_ids: string[]; ready_edge_ids?: string[]; legacy_edge_ids?: string[];
    source_ids: string[]; truncated?: boolean;
  }>;
  walk_requested_depth?: number; walk_reached_depth?: number;
  graph_plane?: "argument" | "context";
  insight_tension_node_ids?: string[]; insight_tension_edge_ids?: string[]; insight_anchor_ids?: string[];
  insight_candidate_ids?: string[]; insight_stop_reason?: string;
  evidence_role_node_ids?: Partial<Record<"support" | "counter" | "boundary" | "background" | "inference", string[]>>;
  evidence_valid_node_ids?: string[]; evidence_invalid_node_ids?: string[]; evidence_claim_count?: number; evidence_all_valid?: boolean;
  sufficiency_node_ids?: string[]; sufficiency_ready?: boolean; sufficiency_missing?: string[];
  relation_decision?: string; relation_source_id?: string; relation_target_id?: string; relation_type?: string; relation_preflight_passed?: boolean;
}
export interface CognitiveObservation {
  status: string; channel?: string | null; summary: string; reason_code?: string | null;
  on_topic_new?: number | null; truncated?: boolean;
}
export interface WorkspaceDelta {
  revision_before: number; revision_after: number;
  added: Record<string, unknown[]>; changed: Record<string, unknown[]>; removed: Record<string, string[]>;
}
export interface CognitiveEvent {
  schema_version: string; event_id: string; session_id: string; run_id?: string | null; episode_id?: string | null;
  seq?: number; at: string; kind: CognitiveEventKind; tool_call_id?: string | null;
  operator?: { name: string; mode?: string | null };
  targets?: CognitiveTargetSet; observation?: CognitiveObservation; workspace_delta?: WorkspaceDelta;
  governance?: { usage: { steps: number; reads: number; writes: number }; limits: { steps: number; reads: number; writes: number }; loop_signal?: string | null };
  presentation: { title: string; detail?: string; tone: "neutral" | "active" | "evidence" | "conflict" | "warning" | "success" };
}

export interface CognitiveEpisodeStep {
  step: number; at: string; action: { operator?: string; mode?: string };
  observation: CognitiveObservation & { data?: Record<string, unknown>; evidence?: unknown[]; next_actions?: unknown[] };
  rationale?: string; evidence_anchors?: unknown[]; workspace_delta?: WorkspaceDelta;
}
export interface CognitiveWorkspace {
  goal: string; scope: Record<string, unknown>; hypotheses: unknown[]; evidence: unknown[];
  counter_evidence: unknown[]; open_questions: unknown[]; conflicts: unknown[];
  candidate_actions: unknown[]; observed_nodes: unknown[]; deferred_items: unknown[];
  budget: { max_steps?: number; max_reads?: number; max_writes?: number }; stop_reason?: string | null;
  extension?: Record<string, unknown>;
}
export interface CognitiveRunSnapshot {
  run: { run_id: string; mode: string; status: string; step_count: number; thinking_model?: ThinkingModelSnapshot | null; checkpoint_revision?: number; analysis_policy_version?: string; delivery?: AnalysisDelivery };
  delivery_review?: { fingerprint: string; cautions: Array<{ detail?: string; reason?: string }>; relation_findings: RelationFinding[] } | null;
  workspace: CognitiveWorkspace;
  episode: { episode_id: string; steps: CognitiveEpisodeStep[] };
  interaction: CognitiveInteraction | null;
  pending_proposals?: WriteProposal[];
  projection?: {
    attention: string;
    finding: string;
    next: string;
    progress: { steps: number; evidence: number; counter_evidence: number; open_questions: number };
    why_not_write?: string | null;
    continuation_pending?: number;
    result?: unknown;
  } | null;
}
export interface ThinkingModelSnapshot {
  id: string; version?: string; purpose?: string; required_capabilities?: string[]; stop_conditions?: string[]; operators?: Record<string, string[]>; selected_at?: string;
}

export async function ensurePipelineConversation(stage: PipelineStage): Promise<Conversation> {
  return jsonOrThrow(await fetch(`/api/pipeline/${stage}/conversation`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }));
}

export async function resetPipelineConversation(stage: PipelineStage): Promise<Conversation> {
  const response = await fetch(`/api/pipeline/${stage}/conversation/reset`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (response.status === 404) {
    throw new Error("当前服务尚未加载“清理对话”功能。请在启动窗口停止旧服务后重新启动项目，再重试。");
  }
  return jsonOrThrow(response);
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  return jsonOrThrow(await fetch("/api/pipeline/status"));
}

export async function stopPipelineJob(jobId: string, afterWave = false): Promise<{
  accepted: boolean; mode: "after_wave" | "immediate"; state: PipelineRunPhase | "idle"; detail: string;
}> {
  return jsonOrThrow(await fetch(
    `/api/pipeline/jobs/${encodeURIComponent(jobId)}/stop?after_wave=${afterWave ? "true" : "false"}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ));
}

export async function fetchPipelineJob(): Promise<PipelineJobRecord | null> {
  return (await jsonOrThrow(await fetch("/api/pipeline/job"))).job ?? null;
}

export type SourceKind = "evidence" | "read" | "retrieved" | "legacy";
export interface SourceCard { id: string; title: string; kind?: SourceKind; }
export interface AgentStep { kind: "retrieve" | "read_card" | "propose_write" | string; label: string; }
export interface WriteProposal {
  proposal_id: string;
  summary: string;
  operations: Record<string, unknown>[];
  warnings?: string[];
  presentation?: {
    title: string;
    explanation: string;
    reason?: string;
    changes: string[];
    confirm_label: string;
    cancel_label: string;
  } | null;
}
export interface EmergenceCandidate { candidate_id: string; title: string; type: string; summary: string; }

export async function sendChatStream(
  conversationId: string,
  message: string,
  h: ChatStreamHandlers,
  signal?: AbortSignal,
  options: { pipelineSources?: string[]; resumeTask?: boolean; constructRequest?: ConstructRequest; thinkingRequest?: ThinkingRequest; expectedRunId?: string | null } = {},
): Promise<void> {
  return sendStreamPayload({
    conversation_id: conversationId,
    message,
    ...(options.pipelineSources ? { pipeline_sources: options.pipelineSources } : {}),
    ...(options.resumeTask ? { resume_task: true } : {}),
    ...(options.constructRequest ? { construct_request: options.constructRequest } : {}),
    ...(options.thinkingRequest ? { thinking_request: options.thinkingRequest } : {}),
    ...(options.expectedRunId !== undefined ? { expected_run_id: options.expectedRunId } : {}),
  }, h, signal);
}

export async function sendInteractionResponseStream(
  conversationId: string,
  interactionId: string,
  response: { option_id?: string; answer?: string },
  h: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return sendStreamPayload({ conversation_id: conversationId, interaction_id: interactionId, ...response }, h, signal);
}

async function sendStreamPayload(payload: Record<string, unknown>, h: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const r = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) {
    // 流开始前的校验错误（400/404）仍是普通 JSON 响应
    let detail = `${r.status}`;
    try {
      const body = await r.json();
      if (body?.detail) detail = String(body.detail);
    } catch { /* 保留 status */ }
    throw new Error(detail);
  }
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatchFrame = (frame: string) => {
    const dataLines = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data);
    } catch {
      h.onFrameError?.("收到一条损坏的流式数据，已跳过；此前内容仍然保留。");
      return;
    }
    if (ev.type === "delta") h.onDelta(String(ev.text ?? ""));
    else if (ev.type === "done") h.onDone();
    else if (ev.type === "error") h.onError(String(ev.detail ?? "流式任务失败"));
    else if (ev.type === "step") h.onStep?.(ev as unknown as AgentStep);
    else if (ev.type === "sources") h.onSources?.(ev.cards as SourceCard[]);
    else if (ev.type === "intent") h.onIntent?.(ev.intent as ThinkingIntent);
    else if (ev.type === "confirm_request") h.onConfirmRequest?.(ev as unknown as WriteProposal);
    else if (ev.type === "candidate_request") h.onCandidateRequest?.(ev.candidates as EmergenceCandidate[]);
    else if (ev.type === "pipeline_status") h.onPipelineStatus?.({
      state: (["starting", "running", "waiting_user", "completed", "failed", "blocked", "paused", "cancelled"].includes(String(ev.state))
        ? ev.state : "completed") as PipelineRunPhase,
      label: String(ev.label ?? "任务已结束"),
      detail: ev.detail ? String(ev.detail) : undefined,
      jobId: ev.job_id ? String(ev.job_id) : undefined,
    });
    else if (ev.type === "choice_request") h.onChoiceRequest?.(ev as unknown as CognitiveInteraction);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      dispatchFrame(frame.trim());
    }
  }
  buf += decoder.decode();
  if (buf.trim()) dispatchFrame(buf.trim());
}

export async function cancelChat(conversationId: string): Promise<void> {
  await jsonOrThrow(await fetch("/api/chat/cancel", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
  }));
}

export async function savePipelineAuthority(pipelineAuthority: "manual" | "trusted"): Promise<Settings> {
  return jsonOrThrow(await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pipeline_authority: pipelineAuthority }),
    keepalive: true,
  }));
}

export async function steerCognitiveSession(sessionId: string, message: string, requestId: string, expectedRunId: string | null): Promise<{ accepted: boolean; run_id: string | null }> {
  return jsonOrThrow(await fetch(`/api/cognition/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, request_id: requestId, expected_run_id: expectedRunId }),
  }));
}

export type ThinkingRoute = "auto" | "explain" | "compare" | "challenge" | "analogize" | "trace" | "synthesize";
export interface ThinkingIntent { action: "answer" | "retrieve"; judgment: string; route?: ThinkingRoute; }
export type ThinkingRequest = { mode: "quick" }
  | { mode?: "research"; goal: "understand" | "compare" | "assess" | "report"; depth: "auto" | "standard" | "deep"; trial?: boolean };
export interface AnalysisDelivery {
  state: "none" | "prepared" | "delivered" | "interrupted"; coverage: "answered" | "partial" | "unanswered" | "unknown";
  message_ref?: string | null; review_ref?: string | null; limitations: Array<{ claim_id?: string | null; code: string; detail: string }>;
}
export interface RelationFinding {
  claim_id: string; path: string[]; anchors: string[]; finding: string; conditions: string; outcome: string;
  provenance: "observed_and_read" | "unverified"; observation_step: number | null;
  edges: Array<{ from: string; to: string; type: string; note: string }>;
}
export async function controlConversation(sessionId: string, action: "discuss" | "restore", runId: string): Promise<{ ready: boolean; waiting?: boolean }> {
  return jsonOrThrow(await fetch(`/api/cognition/sessions/${encodeURIComponent(sessionId)}/control`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, run_id: runId }),
  }));
}

const cognitiveRequests=new Map<string,Promise<CognitiveRunSnapshot|null>>();
export function fetchCognitiveSession(sessionId: string): Promise<CognitiveRunSnapshot | null> {
  const key=`${requestEpoch}:${sessionId}`,existing=cognitiveRequests.get(key);if(existing)return existing;
  const request=fetch(`/api/cognition/sessions/${encodeURIComponent(sessionId)}`).then(jsonOrThrow).then(result=>result?.active===false?null:result as CognitiveRunSnapshot).finally(()=>{if(cognitiveRequests.get(key)===request)cognitiveRequests.delete(key);});
  cognitiveRequests.set(key,request);return request;
}


export async function prepareCandidate(candidateId: string): Promise<{
  prepared: boolean; detail?: string; proposal_id?: string; summary?: string;
  operations?: Record<string, unknown>[]; warnings?: string[];
}> {
  return jsonOrThrow(await fetch("/api/candidates/prepare", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: candidateId }),
  }));
}

export async function confirmWrite(proposalId: string, decision: "confirm" | "cancel"): Promise<{
  applied: boolean; detail?: string; created?: string[]; enriched?: string[]; warnings?: string[];
  outbox_count?: number;
}> {
  return jsonOrThrow(await fetch("/api/write/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proposal_id: proposalId, decision }),
  }));
}

// ---------- Inbox 材料 ----------

export interface InboxUploadItem { index: number; name: string; status: "saved" | "existing" | "failed"; path?: string; detail?: string }
export interface InboxUploadProgress { total: number; completed: number; saved: number; existing: number; failed: Array<{file: File; detail: string}> }
export const MAX_INBOX_FILE_BYTES = 256 * 1024 * 1024;
export async function uploadInbox(files: FileList | readonly File[], libraryId?: string, signal?:AbortSignal): Promise<{ saved: string[]; items?: InboxUploadItem[] }> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append("files", f);
  return jsonOrThrow(await fetch("/api/inbox", { method: "POST", body: fd, signal, headers: libraryId ? {"X-Nexogenesis-Instance": libraryId} : undefined }));
}

/** Keep total selection unbounded, but bound every HTTP request and account for every file. */
export async function uploadInboxInBatches(files: readonly File[], libraryId: string, onProgress: (value: InboxUploadProgress) => void, signal?:AbortSignal): Promise<InboxUploadProgress> {
  let state: InboxUploadProgress = {total: files.length, completed: 0, saved: 0, existing: 0, failed: []};
  const batches: File[][] = [];
  let batch: File[] = [], bytes = 0;
  for (const file of files) {
    if (file.size > MAX_INBOX_FILE_BYTES) {
      state.failed.push({file, detail: "单个文件超过 256 MiB，请拆分后导入"});
      state.completed++;
      continue;
    }
    if (batch.length && (batch.length >= 24 || bytes + file.size > 8 * 1024 * 1024)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(file); bytes += file.size;
  }
  if (batch.length) batches.push(batch);
  onProgress({...state, failed: [...state.failed]});
  for (const [batchIndex,group] of batches.entries()) {
    if(signal?.aborted){state={...state,failed:[...state.failed,...batches.slice(batchIndex).flat().map(file=>({file,detail:'已停止，尚未发送此文件。'}))]};onProgress(state);break;}
    try {
      const timeout=AbortSignal.timeout(120000);
      const result = await uploadInbox(group, libraryId, signal?AbortSignal.any([signal,timeout]):timeout);
      const items = result.items;
      if (!items || items.length !== group.length || new Set(items.map(item => item.index)).size !== group.length ||
          items.some(item => !Number.isInteger(item.index) || item.index < 0 || item.index >= group.length || !["saved", "existing", "failed"].includes(item.status))) {
        throw new Error("服务未返回完整的逐文件结果；请刷新服务后重试核对");
      }
      const failed = [...state.failed];
      let saved = 0, existing = 0;
      for (const item of items) {
        if (item.status === "saved") saved++;
        else if (item.status === "existing") existing++;
        else failed.push({file: group[item.index], detail: item.detail || "保存失败，请重试"});
      }
      state = {...state, completed: state.completed + group.length, saved: state.saved + saved, existing: state.existing + existing, failed};
    } catch (error) {
      state = {...state, completed: state.completed + group.length, failed: [...state.failed, ...group.map(file => ({file, detail: `未确认保存：${error instanceof Error ? error.message : String(error)}。重试会核对同名内容，避免重复写入。`}))]};
    }
    onProgress(state);
  }
  return state;
}

export async function fetchInboxDocuments(): Promise<InboxDocumentList> {
  return jsonOrThrow(await fetch("/api/inbox"));
}
export async function fetchConstructPreparation(signal?: AbortSignal): Promise<ConstructPreparation> {
  const response = await fetch("/api/pipeline/construct/prepare", { signal });
  if (!response.ok) throw new Error(`无法准备建构 (${response.status})，请检查服务是否已更新并重试。`);
  return response.json();
}

export interface SpeechStatus { ready: boolean; engine: string; maxSeconds: number; detail: string }
export interface SpeechTranscript { text: string; duration_seconds: number; processing_ms: number; engine: string }
export async function fetchSpeechStatus(signal?: AbortSignal): Promise<SpeechStatus> {
  return jsonOrThrow(await fetch('/api/speech/status', { signal, cache: 'no-store' }));
}
export async function transcribeSpeech(audio: Blob, signal?: AbortSignal): Promise<SpeechTranscript> {
  signal?.throwIfAborted();
  const pending = fetch('/api/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal }).then(jsonOrThrow);
  if (!signal) return pending;
  // The shared CSRF-token lookup can precede the audio request. Cancellation must
  // release this input immediately even while that shared lookup is still pending.
  return new Promise<SpeechTranscript>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('录音已取消', 'AbortError'));
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { cleanup(); aborted(); }
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
