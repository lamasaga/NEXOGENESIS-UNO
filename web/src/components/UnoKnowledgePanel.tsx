import {ConstructionResults} from './ConstructionResults';
import {ConstructionControls} from './ConstructionControls';
import {CONSTRUCTION_CONTROLS,CONSTRUCTION_OPERATIONS,defaultConstructionControls,constructionGoal,constructionSummary,type ConstructionControls as Controls} from '../../../packages/nexogenesis-tools/lib/construction-controls.js';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isLegacyCompileJob, countUnoPreferences, type UnoTokenUsage, fetchUnoPreparation, fetchUnoJob, fetchUnoSource, reviewUnoBookArchive, reviewUnoDomains, resolveUnoJob, startUnoJob, updateUnoJob, type UnoPreparation, type UnoJob, type UnoCardDraft, type UnoStartInput } from "../api/client";
import { BookCompilationView, bookActiveStatus, bookCanContinue, bookCompilationProgress, bookPanelTitle, bookWorkingTitle } from './BookCompilationView';
import { CardMarkdown } from "./CardReader";
import "./UnoKnowledgePanel.css";
import { COMPILE_HINTS } from '../../../packages/nexogenesis-tools/lib/compile-options.js';
import { pendingStart, completeStart, rejectStart } from '../conversations/recovery';
import {queueProgress,type UnoUnassignedQueueState} from '../uno/unassignedQueue';

const usesRelationWeaving=(controls:Controls)=>controls.allowed.includes('relation_add')
  &&(controls.primary==='connections'||controls.primary==='comprehensive'||controls.focuses.includes('connections'));

const linkLabels: Record<string,string> = { related:"相关",contrast:"对照",analogy:"类比",boundary:"边界",background:"背景" };
const states: Record<string,string> = {running:"处理中",review:"待确认",paused:"已暂停",failed:"未完成",partial:"部分完成",completed:"已完成",ended:"已结束"};

export function compileAvailability(preparation:UnoPreparation|null) {
  if(!preparation)return {ready:false,message:'正在读取编译能力…'};
  if(preparation.compile_profile!=='unit-cards-v3')return {ready:false,message:'当前服务尚未加载 type＋domains 统一编译契约，请更新 UNO 服务后重试。历史编译仅供查看。'};
  if(preparation.compile_review_policy!=='review-publish-repair-v2')return {ready:false,message:'当前服务尚未加载区分单卡与关系修复的新版编译，请更新 UNO 服务后重试。历史编译仅供查看。'};
  if(preparation.compile_card_refinement!=='refine-each-card-v1'||!preparation.compile_quality_modes?.includes('standard')||!preparation.compile_quality_modes.includes('refine-each-card-v1'))return {ready:false,message:'当前服务尚未加载逐卡精修质量模式，请更新 UNO 服务后重试。'};
  if(!preparation.domain_approval_modes?.includes('manual')||!preparation.domain_approval_modes.includes('automatic'))return {ready:false,message:'当前服务尚未加载本次任务的领域建设授权，请更新 UNO 服务后重试。'};
  if(preparation.compile_model?.available!==true)return {ready:false,message:preparation.compile_model?.message??'尚未确认当前模型支持编译请求预算计数，请检查模型设置后刷新。'};
  return {ready:true,message:''};
}
export function constructionAvailability(preparation:UnoPreparation|null) {
  if(!preparation)return {ready:false,message:'正在读取建构能力…'};
  if(preparation.uno_construction_service!==1||preparation.uno_relation_weaving!==1||preparation.relation_weaving_contract!=='random-focus-semantic-retrieval-v2'||preparation.relation_weaving_focus_selection!=='job-seeded-random-without-replacement-v1'||preparation.relation_weaving_endpoint_retrieval!=='all-cards-integration-candidates-v1'||preparation.relation_weaving_max_focus_attempts!==2||preparation.construction_response_recovery!=='construction-response-recovery-v1'||preparation.construction_repair_scope!=='construction-repair-endpoint-scope-v1'||preparation.default_construction_profile!=='strategy-driven-v2'||!preparation.construction_profiles?.includes('strategy-driven-v2')||!preparation.orchestration_profiles?.includes('bounded-workflow-v1'))return {ready:false,message:'当前服务尚未加载随机焦点抽样与全库关系候选检索，请更新 UNO 服务后重试。已有任务仍沿用原流程。'};
  if(preparation.construction_model?.available!==true)return {ready:false,message:preparation.construction_model?.message??'尚未确认当前模型支持请求预算计数，请检查模型设置后刷新。'};
  return {ready:true,message:''};
}
export function inboxSourceProgress(source:UnoPreparation['sources'][number]) {
  if(source.compile_state==='unfinished')return `未完成 · ${source.processed_units??0}/${source.total_units??0} 个单元${source.open_items?` · 待修复 ${source.open_items} 项`:''}`;
  if(source.compile_state==='archive_review')return '正文单元已处理 · 等待原件缺口复核';
  if(source.compile_state==='archive_pending')return '正文单元已处理 · 归档尚未结算';
  return '';
}
export function bookCompilePhaseLabel(job:UnoJob) {
  if(job.phase==='done')return job.status==='completed'?'全书编译完成':'主线执行已结束';
  return ({prepare:'整理全书结构',overview:'理解全书结构',read:'阅读与保存知识',domain_review:'领域治理检查点',ended:'任务已结束'} as Record<string,string>)[job.phase??'read']??'编译处理中';
}
export function bookStatusDetail(job:UnoJob,bookCompile=true) {
  if(bookCompile&&job.status==='ended')return '任务已关闭。已保存成果和待修复项均保留。';
  if(bookCompile&&job.phase==='done')return '主线已结束。请查看下方结算；已保存成果可用，待办可稍后继续处理。';
  return job.detail;
}
export function unoWorkProgress(job:UnoJob,bookCompile=false) {
  if(bookCompile)return null;
  if(job.mode==='construct'&&job.relation_weaving)return {
    label:`关系编织第 ${Math.max(1,(job.batch_index??0)+1)} 轮`,
    detail:job.status==='running'?'正在处理当前关系编织小组。完成后会重新扫描知识图，再决定是否开始下一轮。':job.detail,
  };
  return {label:`第 ${Math.min((job.batch_index??0)+1,job.batches.length)} / ${job.batches.length} 组`,detail:job.detail};
}

const constructionPhaseLabel=(job:UnoJob)=>({prepare:'准备建构范围',read:'检查与修订',organize:'独立审核',settle:'审核后发布',batch_done:'本组结算',done:'建构结束',ended:'任务已结束'} as Record<string,string>)[job.phase??'read']??'建构处理中';

export function repairRecoveryGuidance(job:UnoJob){
  if(job.operation!=='isolated-card-repair'||!['paused','failed','partial'].includes(job.status))return null;
  const failure=job.last_failure?.message??job.last_error?.message??job.detail??'';
  if(job.last_failure?.code==='UNDELIVERED_EVIDENCE'||/须读回.*完整正文/u.test(failure))return {
    headline:'需要更新依据后继续',
    detail:'目标卡在本次修复期间发生了变化，写入前的安全检查已经停止旧版本操作。当前候选和已保存成果都没有被覆盖。',
    next:'让系统读取目标卡的最新完整正文，再重新核对当前卡。只有通过复核才会保存；仍不成立时，本项会保留而不会循环重试。',
    primaryLabel:'读取最新目标卡并继续',
    closeLabel:'保留待办并关闭'
  };
  return {
    headline:'这项修复需要重新核对',
    detail:'当前候选没有通过检查，但候选、问题记录和已保存成果都已保留。',
    next:'建议让系统从当前停点重新诊断并处理；如果仍不能通过，本项会继续留在编译修复队列，不会反复自动写入。',
    primaryLabel:job.resume_plan?.primary?.label??'重新诊断并继续',
    closeLabel:'保留待办并关闭'
  };
}

export function activeJobPresentation(job:UnoJob,queue?:UnoUnassignedQueueState|null,ending=false) {
  const bookCompile=['uno-unit-compile-v2','uno-unit-compile-v3'].includes(job.workflow??'');
  const repair=job.operation==='isolated-card-repair';
  const recovery=repairRecoveryGuidance(job);
  const queueMatches=Boolean(queue&&(queue.currentJobId===job.id||queue.results.at(-1)?.jobId===job.id));
  const queueValue=queueMatches&&queue?queueProgress(queue):null;
  const phase=bookCompile?bookCompilePhaseLabel(job):constructionPhaseLabel(job);
  const savedCards=new Set([...(job.touched??[]),...job.receipts.filter(receipt=>!receipt.staged).flatMap(receipt=>receipt.card_ids??[])]).size;
  const activeRequest=bookActiveStatus(job)?.startedAt;
  const baseKind=repair?'修复':bookCompile?'编译':'建构';
  let eyeline=`${baseKind}任务进行中`,headline=phase,detail=job.detail||'任务正在继续。';
  if(ending){eyeline=`${baseKind}任务正在结束`;headline='正在安全结束当前步骤';detail='系统会先结算正在处理的步骤，再停止后续工作。';}
  else if(job.status==='review'){eyeline=`${baseKind}任务等待确认`;headline='等待确认后继续';}
  else if(job.status==='paused'){eyeline=`${baseKind}任务已暂停`;headline='已暂停，进度已保存';}
  else if(job.status==='failed'){eyeline=`${baseKind}任务遇到问题`;headline='需要处理后继续';}
  else if(job.status==='partial'){eyeline=`${baseKind}任务部分完成`;headline='已有成果，仍有待办';}
  else if(job.status==='completed'){eyeline=`${baseKind}任务已完成`;headline=`${baseKind}完成`;}
  else if(job.status==='ended'){eyeline=`${baseKind}任务已关闭`;headline='任务已关闭';}
  else if(repair){
    const current=job.detail?.replace(/^第\s*\d+\s*节[：:]\s*/,'').replace(/[。；].*$/,'').trim();
    headline=current?(/^正在/.test(current)?current:`正在${current}`):'正在修复当前项目';
  }
  if(recovery&&!ending){headline=recovery.headline;detail=recovery.detail;}
  if(queueValue&&queue&&['running','stopping'].includes(queue.status)&&queue.currentJobId===job.id){
    detail=`正在处理第 ${Math.min(queue.index+1,queueValue.total)} / ${queueValue.total} 项；已完成项目不会重跑。`;
  }else if(activeRequest){
    detail='模型请求已发送，系统正在等待返回；已保存成果不会重复处理。';
  }

  let progressValue=0,progressMax=0,progressLead='',progressTail='',progressLabel='';
  let facts:Array<{label:string;value:string}>=[];
  if(queueValue&&queue){
    progressValue=queueValue.completed;progressMax=queueValue.total;progressLead=`${queueValue.completed} / ${queueValue.total}`;progressTail='项已完成';progressLabel=`修复队列已完成 ${queueValue.completed} 项，共 ${queueValue.total} 项`;
    facts=[{label:'当前阶段',value:phase},{label:'队列剩余',value:`${queueValue.remaining} 项`},{label:'已保存成果',value:`${savedCards} 张卡片`}];
  }else if(bookCompile){
    const progress=bookCompilationProgress(job),unfinished=Math.max(0,progress.total-progress.processed);
    progressValue=progress.processed;progressMax=progress.total;progressLead=progress.total?`${progress.processed} / ${progress.total}`:'准备中';progressTail=progress.total?'个阅读单元已完成':'正在建立阅读单元';progressLabel=progress.total?`已完成 ${progress.processed} 个阅读单元，共 ${progress.total} 个`:'正在建立阅读单元';
    facts=[{label:'当前阶段',value:phase},{label:'待处理单元',value:`${unfinished} 个`},{label:'已保存成果',value:`${savedCards} 张卡片`}];
  }else{
    const total=job.batches?.length??0,current=total?Math.min((job.batch_index??0)+1,total):0,completed=Math.min(job.completed_batches?.length??Math.max(0,current-1),total);
    const terminal=['partial','failed','completed','ended'].includes(job.status);
    progressValue=completed;progressMax=total;progressLead=total?`${terminal?completed:current} / ${total}`:'准备中';progressTail=total?(terminal?'个工作组已结算':'当前工作组'):'正在准备建构范围';progressLabel=total?`已结算 ${completed} 个工作组，共 ${total} 个`:'正在准备建构范围';
    facts=[{label:'当前阶段',value:phase},{label:'已结算工作组',value:`${completed} 组`},{label:'已保存成果',value:`${savedCards} 张卡片`}];
  }
  return {bookCompile,repair,recovery,queueMatches,eyeline,headline,detail,phase,progressValue,progressMax,progressLead,progressTail,progressLabel,facts};
}

export function ActiveJobOverview({job,queue,connected=true,ending=false,actions}:{job:UnoJob;queue?:UnoUnassignedQueueState|null;connected?:boolean;ending?:boolean;actions?:ReactNode}) {
  const view=activeJobPresentation(job,queue,ending);
  return <section className="uno-work__active-overview" aria-label={`${view.repair?'修复':view.bookCompile?'编译':'建构'}任务概览`}>
    <div className="uno-work__active-hero" role="status" aria-live="polite">
      <p className="uno-work__active-eyeline">{view.eyeline}</p>
      <h3>{view.headline}</h3>
      <p className="uno-work__active-progress"><strong>{view.progressLead}</strong> {view.progressTail}</p>
      <p className="uno-work__active-detail">{view.detail}</p>
      {view.progressMax>0&&<div className="uno-work__active-meter"><progress aria-label={view.progressLabel} value={view.progressValue} max={view.progressMax}/><div><span>已完成 {view.progressValue}</span><span>共 {view.progressMax}</span></div></div>}
      {view.recovery&&<div className="uno-work__recovery-guidance"><strong>建议下一步</strong><p>{view.recovery.next}</p></div>}
      {actions}
      <dl className="uno-work__active-facts" aria-label="当前任务范围">{view.facts.map(fact=><div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    </div>
    {!connected&&<div className="uno-work__sync-note" role="status"><strong>正在重新同步进度</strong><span>当前显示上次确认的状态；网页会自动重试，刷新不会暂停任务。</span></div>}
    <details className="uno-book-settlement__disclosure uno-work__active-details"><summary>当前任务详情</summary><div className="uno-book-settlement__disclosure-body"><p>{job.detail}</p>{queue&&view.queueMatches&&<p className="uno-work__muted">修复队列：{queue.message}</p>}<p className="uno-work__muted">技术标识与模型请求记录保留在下方记录中，不影响当前操作。</p></div></details>
  </section>;
}
export function uniqueSourceWarnings(job:UnoJob) {
  return [...new Map(job.sources.flatMap(source=>(source.warnings??[]).map(warning=>({source:source.source,warning})))
    .map(row=>[row.source+'\n'+row.warning,row])).values()];
}
export function UnoRequestUsage({job}:{job:UnoJob}) {
  const usage=job.calls.reduce((sum,c)=>({input:sum.input+(c.usage?.inputTokens??0),output:sum.output+(c.usage?.outputTokens??0)}),{input:0,output:0});
  const bounded=['uno-unit-compile-v2','uno-unit-compile-v3'].includes(job.workflow??'')||job.orchestration_profile==='bounded-workflow-v1',used=bounded?job.provider_budget?.used:job.calls.length;
  return <p className="uno-work__muted">{typeof used==='number'?`模型请求 ${used} 次`:'模型请求计数暂不可用'}{bounded&&typeof job.provider_budget?.remaining==='number'?` · 剩余 ${job.provider_budget.remaining} 次`:''}{usage.input||usage.output?` · 已报告输入 ${usage.input} / 输出 ${usage.output} tokens`:''}。{bounded?'按实际外发请求计数，未发出的步骤不计入。':'失败调用也记录。'}缺失用量不代表零消耗。</p>;
}
export function ConstructionPlanView({job,onOpenCard}:{job:UnoJob;onOpenCard:(id:string)=>void}) {
  const plan=job.construction_plan;if(!['direction-driven-v1','strategy-driven-v2'].includes(job.construction_profile??'')||!plan)return null;
  const results=Object.entries(job.construction_results??{}).flatMap(([batch,rows])=>Object.values(rows).map(row=>({...row,batch})));
  const openCard=(id:string)=><button key={id} type="button" style={{maxWidth:'100%',overflowWrap:'anywhere',textAlign:'left'}} onClick={()=>onOpenCard(id)}>{id}</button>;
  const weaving=job.relation_weaving,diagnosis=weaving?.last_diagnosis;
  return <section className="uno-work__selection" aria-label="建构范围与结果">
    <h3>{job.construction_profile==='strategy-driven-v2'?'模型制定的建构策略':'本次建构方向'}</h3>{job.construction_controls&&<p>{constructionSummary(job.construction_controls)}</p>}<p>{plan.goal}</p>
    {weaving&&diagnosis&&<div className="uno-work__muted" role="status"><strong>持续关系发现 · {weaving.rounds.length} 轮</strong>{weaving.contract==='random-focus-semantic-retrieval-v2'
      ?<p>当前范围 {diagnosis.counts.cards} 张卡 · 尚未随机检查 {diagnosis.counts.unreviewed??0} 张。每轮随机冻结一张焦点卡，再从全部有效卡片中检索最可能的关系端点；图结构只作统计，不决定先后。</p>
      :<p>当前 {diagnosis.counts.isolated} 张完全孤立卡 · {diagnosis.counts.islands} 个非主图知识岛 · 主图 {diagnosis.counts.main_component_cards} 张。此历史任务仍按原拓扑顺序执行。</p>}</div>}
    {plan.strategy&&<><p>{plan.strategy.expected_improvement}</p><details><summary>判断规则、证据要求与停止条件</summary><p><strong>判断规则：</strong>{plan.strategy.decision_rules.join('；')}</p><p><strong>证据要求：</strong>{plan.strategy.evidence_requirements.join('；')}</p><p><strong>停止条件：</strong>{plan.strategy.stop_conditions.join('；')}</p></details></>}
    <p className="uno-work__muted">可选范围 {plan.scope_count} 张 · 提供策略候选 {plan.candidate_count??'—'} 张 · 模型选择 {new Set(plan.packages.flatMap(pack=>pack.card_ids)).size} 张。候选与选卡都不是质量结论。</p>
    <p className="uno-work__muted">{plan.notice}</p>
    {plan.selection?.selected?.length?<details open><summary>选卡理由 · {plan.selection.selected.length} 张</summary>{plan.selection.selected.map(row=><article key={row.id}><div>{openCard(row.id)}</div><p>{row.reason}</p><p className="uno-work__muted">角色：{row.role}{row.required_evidence.length?` · 需要证据：${row.required_evidence.join('；')}`:''}</p></article>)}</details>:null}
    {plan.packages.map(pack=><article key={pack.id}><strong>{pack.id} · {({pending:'已安排',running:'执行中',completed:'本组已处理',deferred:'仍待处理',reused:'复用此前检查'} as Record<string,string>)[pack.status]??'工作包'}</strong><p>{pack.purpose??pack.reason}</p><div>{pack.card_ids.map(openCard)}</div>{pack.status==='reused'&&<p className="uno-work__muted">{pack.note??'当前版本与同一方向的既往检查一致。'} 本次未重新核验原始来源。</p>}</article>)}
    {!!plan.skipped.length&&<p className="uno-work__muted">复用已有检查 {plan.skipped.length} 组；这不表示本次重新阅读或完成事实核验。</p>}
    {!!plan.unselected.length&&<details><summary>未入选 {plan.unselected.length} 张 · 尚未检查</summary><p className="uno-work__muted">未入选不代表没有问题，可调整方向后另行处理。</p><div>{plan.unselected.slice(0,24).map(openCard)}</div>{plan.unselected.length>24&&<p className="uno-work__muted">此处显示前 24 张。</p>}</details>}
    {results.length>0&&<><h3>已登记的检查结果</h3>{results.map(row=><article key={row.batch+':'+row.id}><strong>{row.status==='unchanged'?'已读后保留原样':row.status==='deferred'?'暂缓处理':'已登记结果'}</strong><div>{openCard(row.id)}</div><p>{row.note}</p><p className="uno-work__muted">{row.source_verified?'已核验本结论所用来源。':'这是内容检查记录，未重新核验原始来源。'}</p></article>)}</>}
  </section>;
}
export function HistoricalKnowledgeView({job,onOpenCard}:{job:UnoJob;onOpenCard:(id:string)=>void}) {
  const saved=[...new Set((job.receipts??[]).filter(receipt=>!receipt.staged).flatMap(receipt=>receipt.card_ids??[]))];
  return <section aria-label="历史任务记录" className="uno-work__selection">
    <h3>历史记录 · 只读</h3>
    <p>{job.readonly_reason??'此任务使用已退役的流程，执行器已移除。已有材料、卡片及原始任务记录保留。'}</p>
    <p className="uno-work__muted">最后记录状态：{states[job.status]??job.status}。这是历史状态，不表示任务仍在执行。</p>
    {job.detail&&<p>{job.detail}</p>}
    {!!saved.length&&<><h3>已有成果 · {saved.length} 张卡片</h3><div className="uno-work__actions">{saved.map(id=><button key={id} onClick={()=>onOpenCard(id)}>查看卡片 · {id}</button>)}</div></>}
    {(job.failures??[]).length>0&&<details><summary>历史未处理记录 · {job.failures.length}</summary>{job.failures.map((failure,index)=><p key={index}>{failure.source}：{failure.detail}</p>)}</details>}
    <p className="uno-work__muted">需要继续整理时，请收起此记录，重新选择{job.mode==='compile'?' Inbox 中的原书开始编译':'建构范围和方向开始建构'}。</p>
    <UnoRequestUsage job={job}/>
  </section>;
}
interface Props { mode:"compile"|"construct"; jobId?:string; initialNotes?:string; available?:boolean; onClose:()=>void; onChanged:(job:UnoJob)=>void; onOpenCard:(id:string)=>void;onOpenUnassigned?:()=>void;
  backgroundJob?:{title:string};onOpenBackgroundJob?:()=>void;
  unassignedQueue?:UnoUnassignedQueueState|null;onStopUnassignedQueue?:()=>void;onResumeUnassignedQueue?:()=>void;onDeferUnassignedQueueItem?:()=>void;onClearUnassignedQueue?:()=>void }
export function UnoKnowledgePanel({mode,jobId,initialNotes='',available=true,onClose,onChanged,onOpenCard,onOpenUnassigned,
  backgroundJob,onOpenBackgroundJob,unassignedQueue,onStopUnassignedQueue,onResumeUnassignedQueue,onDeferUnassignedQueueItem,onClearUnassignedQueue}:Props) {
  const [preparation,setPreparation]=useState<UnoPreparation|null>(null), [job,setJob]=useState<UnoJob|null>(null);
  const [unconfirmedStart,setUnconfirmedStart]=useState<UnoStartInput|null>(null);
  const [sources,setSources]=useState<string[]>([]), [theme,setTheme]=useState(""), [domain,setDomain]=useState(""), [type,setType]=useState(""), [notes,setNotes]=useState("");
  const [error,setError]=useState(""), [busy,setBusy]=useState(false), [allow,setAllow]=useState<string[]>([]);
  const [online,setConnected]=useState(true),connected=online&&available;
  const [source,setSource]=useState<{body:string;locator:string}|null>(null);
  const [skip,setSkip]=useState<string[]>([]);
  const [selectionLimit,setSelectionLimit]=useState(20);
  const [forceRecheck,setForceRecheck]=useState(false);
  const [controls,setControls]=useState<Controls>(()=>defaultConstructionControls());
  const [scopeMode,setScopeMode]=useState<'library'|'domain'|'cards'>('library');
  const [selectedCards,setSelectedCards]=useState<string[]>([]),[cardQuery,setCardQuery]=useState('');
  const [materialKind,setMaterialKind]=useState<'auto'|'book'|'article'>('auto');
  const [compileQuality,setCompileQuality]=useState<'standard'|'refine-each-card-v1'>('standard');
  const [budget,setBudget]=useState(120),[continuous,setContinuous]=useState(true),[inherit,setInherit]=useState(true),[delivery,setDelivery]=useState<'auto'|'manual'>('auto'),[externalImages,setExternalImages]=useState(false),[tokenUsage,setTokenUsage]=useState<UnoTokenUsage|null>(null);
  const [missingLegacyStart,setMissingLegacyStart]=useState(false);
  const [approvedDomains,setApprovedDomains]=useState<string[]>([]);
  const [automaticDomains,setAutomaticDomains]=useState(false);
  const domainReviewRef=useRef<HTMLElement>(null);
  useEffect(()=>{if(job||!preparation)return;const c=new AbortController();const t=setTimeout(()=>void countUnoPreferences(mode==='construct'?constructionGoal(controls,notes):notes,inherit,c.signal).then(setTokenUsage).catch(e=>{if(!c.signal.aborted)setError(String(e));}),350);return()=>{clearTimeout(t);c.abort();};},[notes,inherit,job,preparation,controls,mode]);
  const lock=useRef(false), changed=useRef(onChanged), input=useRef<HTMLInputElement>(null);
  useEffect(()=>{ changed.current=onChanged; },[onChanged]);
  useEffect(()=>{
    const controller=new AbortController();
    let retryTimer:ReturnType<typeof setTimeout>;
    setError(""); setJob(null); setAllow([]); setSkip([]); setSource(null);setUnconfirmedStart(null);setMissingLegacyStart(false);setContinuous(mode==='compile');
    setSources([]);setTheme("");setDomain("");setType("");setNotes(initialNotes);setPreparation(null);setBudget(120);setForceRecheck(false);setAutomaticDomains(false);setCompileQuality('standard');setControls(defaultConstructionControls());setScopeMode('library');setSelectedCards([]);setCardQuery('');
    const load=()=>{
    if(jobId)return; // Existing jobs are read by the retrying status poll below.
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]);
    const pending=fetchUnoPreparation(signal).then(async p=>{
      if(controller.signal.aborted)return;setError('');
      const preparedControls=p.preferences?.construction??defaultConstructionControls();setControls(preparedControls);
      if(mode==='construct'&&usesRelationWeaving(preparedControls))setContinuous(true);
      setPreparation(p);setBudget(p.preferences?.budget_calls??120);setDelivery(mode==='compile'?'auto':p.preferences?.delivery??'auto');setExternalImages(p.preferences?.external_images??false);setCompileQuality(p.preferences?.compile_quality??'standard');
      const saved=pendingStart(p.library?.id??'legacy');if(!saved||saved.input.mode!==mode)return;
      setUnconfirmedStart(saved.input);
      const v=saved.input;setSources(v.sources??[]);setTheme(v.theme??'');setDomain(v.domain??'');setType(v.type??'');setNotes(v.notes??'');setBudget(v.budget_calls??120);setContinuous(v.continuous===true);setInherit(v.inherit_preferences!==false);setDelivery(v.delivery??'auto');setExternalImages(v.external_images===true);setCompileQuality(v.compile_quality_mode??'standard');setForceRecheck(v.force_recheck===true);setAutomaticDomains(v.domain_approval_mode==='automatic');if(v.construction_controls)setControls(v.construction_controls);setSelectedCards(v.card_ids??[]);setScopeMode(v.card_ids?'cards':v.domain?'domain':'library');
      try{const recovered=await fetchUnoJob(saved.id,signal);if(controller.signal.aborted)return;completeStart(p.library?.id??'legacy',saved.id,recovered.owner_session_id??recovered.session_id);setJob(recovered);changed.current(recovered);}
      catch(error){if(!controller.signal.aborted){setMissingLegacyStart(Number((error as {status?:number}).status)===404);setError(saved.input.mode==='compile'&&saved.input.compile_profile!=='unit-cards-v3'?'这是历史编译开始请求；仅查询原记录，不会重新执行。':'上次开始请求尚未确认。要求已保留，再次开始会核对同一请求，不会重复启动已创建的任务。');}}
    });
    pending.catch(e=>{if(!controller.signal.aborted){setError(String(e));retryTimer=setTimeout(load,1500);}});
    };load();
    input.current?.focus();
    return()=>{clearTimeout(retryTimer);controller.abort();};
  },[mode,jobId,initialNotes]);
  useEffect(()=>{
    const id=job?.id??jobId;if(!id)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const sync=async()=>{
      try{const next=await fetchUnoJob(id,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));if(controller.signal.aborted)return;
        setConnected(true);setJob(current=>current&&current.id===next.id&&current.version>next.version?current:next);
        if(!job)setBudget(next.resume_budget_calls??120);
        if(!job||next.status!==job.status||next.cursor!==job.cursor)changed.current(next);
      }catch{if(!controller.signal.aborted)setConnected(false);}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>void sync(),1500);}
    };
    void sync();
    return()=>{clearTimeout(timer);controller.abort();};
  },[jobId,job?.id,job?.status,job?.cursor]);
  useEffect(()=>{if(job?.phase==='domain_review')setApprovedDomains([]);},[job?.id,job?.version,job?.phase]);
  const epoch=useRef(0);
  useEffect(()=>{epoch.current++;return()=>{epoch.current++;};},[mode,jobId,initialNotes]);
  async function perform(action:()=>Promise<UnoJob>) {
    const version=epoch.current;
    if(lock.current||!connected)return;lock.current=true;setBusy(true);setError("");
    try { const next=await action();if(version!==epoch.current)return;setJob(next);setAllow([]);setSkip([]);changed.current(next); }
    catch(e){if(version===epoch.current){setError(e instanceof Error?e.message:String(e));if(unconfirmedStart&&!pendingStart(unconfirmedStart.library_id??'legacy'))setUnconfirmedStart(null);}}
    finally{lock.current=false;setBusy(false);}
  }
  const isCompile=mode==="compile";
  const capability=isCompile?compileAvailability(preparation):constructionAvailability(preparation);
  const controlsReady=preparation?.construction_controls?.contract===CONSTRUCTION_CONTROLS&&CONSTRUCTION_OPERATIONS.every(o=>preparation.construction_controls?.operations.includes(o.id));
  const startReady=capability.ready&&(isCompile||controlsReady);
  const validScope=scopeMode==='cards'?selectedCards.length>0:scopeMode!=='domain'||!!domain;
  const summary=constructionSummary(controls);
  const relationWeaving=!isCompile&&usesRelationWeaving(controls);
  const scopeLabel=scopeMode==='cards'?`所选 ${selectedCards.length} 张卡片`:domain?(preparation?.domains.find(d=>d.id===domain)?.title??domain):'当前知识库 · 自动选择';
  const count=preparation?.cards.filter(c=>(!domain||c.domains.includes(domain))&&(!type||c.type===type)).length??0;
  const cards=job?.pending?.cards?(job.pending?.cards??[]) as UnoCardDraft[]:[];
  const duplicateIds=Object.entries(job?.pending?.duplicates??{}).filter(([,items])=>items.length).map(([id])=>id);
  const ending=Boolean(job?.end_requested && job.status!=="ended");
  const legacyCompile=Boolean(job&&(job.readonly||isLegacyCompileJob(job))),bookCompile=['uno-unit-compile-v2','uno-unit-compile-v3'].includes(job?.workflow??'');
  const bookSettled=Boolean(job&&bookCompile&&(['done','ended'].includes(job.phase??'')||['completed','ended'].includes(job.status)));
  const domainReviewPending=!legacyCompile&&bookCompile&&!ending&&job?.status==='review'&&job.phase==='domain_review'&&!!job.domain_governance?.pending_proposals.length;
  const showDomainReview=()=>{
    const section=domainReviewRef.current;
    if(!section)return;
    section.scrollIntoView({block:'start',behavior:'instant'});
    section.focus({preventScroll:true});
  };
  const legacyStart=unconfirmedStart?.mode==='compile'&&unconfirmedStart.compile_profile!=='unit-cards-v3';
  const waiting=!legacyCompile&&job?.pending && job.status!=="running" && job.status!=="ended" && !ending;
  const bounded=bookCompile||job?.orchestration_profile==='bounded-workflow-v1',budgetUnavailable=Boolean(bounded&&(job?.provider_budget?.available===false||typeof job?.provider_budget?.used!=='number'));
  const resumePlan=job?.resume_plan;
  const repairRecovery=job?repairRecoveryGuidance(job):null;
  const resumable=Boolean(job&&["paused","failed","partial"].includes(job.status)&&!waiting&&!ending&&(resumePlan?resumePlan.kind==='resume':(!bookCompile||bookCanContinue(job))));
  const resumeDecision=Boolean(job&&["paused","failed","partial"].includes(job.status)&&resumePlan?.kind==='decision'&&!waiting&&!ending);
  const resumeBlocked=Boolean(job&&["paused","failed","partial"].includes(job.status)&&resumePlan?.kind==='blocked'&&!waiting&&!ending);
  const sourceWarnings=job?uniqueSourceWarnings(job):[];
  const queueVisible=Boolean(job&&unassignedQueue&&(unassignedQueue.currentJobId===job.id||unassignedQueue.results.at(-1)?.jobId===job.id));
  const queueProgressValue=unassignedQueue?queueProgress(unassignedQueue):null;
  const queueOwnsJob=Boolean(job&&queueVisible&&unassignedQueue?.currentJobId===job.id&&['running','stopping'].includes(unassignedQueue.status));
  const queueActions=queueVisible&&unassignedQueue&&queueProgressValue?<div className="uno-work__actions uno-work__actions--working">
    {unassignedQueue.status==='running'&&<button type="button" onClick={onStopUnassignedQueue}>当前项完成后停止</button>}
    {unassignedQueue.status==='stopping'&&<button type="button" disabled>将在当前项后停止</button>}
    {unassignedQueue.status==='paused'&&queueProgressValue.remaining>0&&!unassignedQueue.currentJobId&&<button type="button" className="uno-work__primary" onClick={onResumeUnassignedQueue}>重新连接并继续</button>}
    {unassignedQueue.status==='paused'&&queueProgressValue.remaining>0&&unassignedQueue.currentJobId&&onDeferUnassignedQueueItem&&<button type="button" onClick={onDeferUnassignedQueueItem}>保留此项，继续下一项</button>}
    {onOpenUnassigned&&<button type="button" onClick={onOpenUnassigned}>打开编译修复队列</button>}
    {!['running','stopping'].includes(unassignedQueue.status)&&<button type="button" onClick={onClearUnassignedQueue}>清除队列记录</button>}
  </div>:null;
  const jobActions=job&&!legacyCompile?<>
    <div className={`uno-work__actions${resumable||resumeDecision?' uno-work__actions--resume':''}${(resumable||resumeDecision)&&bookCompile?' uno-work__actions--book-resume':''}${bookSettled?' uno-work__actions--settlement':''}`}>
          {bookSettled&&(job.isolation_summary?.open??0)>0&&onOpenUnassigned&&<button type="button" className="uno-work__primary" onClick={onOpenUnassigned}>处理 {job.isolation_summary!.open} 项待修复</button>}
          {job.status==="running"&&!ending&&!queueOwnsJob&&<button disabled={busy||!connected} onClick={()=>void perform(()=>updateUnoJob(job,"stop-after-batch"))}>{bookCompile?'当前阅读单元完成后暂停':'本批完成后停止'}</button>}
          {job.status==="running"&&!ending&&!queueOwnsJob&&<button disabled={busy||!connected} onClick={()=>void perform(()=>updateUnoJob(job,"cancel"))}>暂停任务</button>}
          {resumable&&<>
            {job.workflow&&!bookCompile&&<label className="uno-work__action-budget">累计请求预算<input type="number" min={bounded?Math.max(4,job.provider_budget?.limit??job.budget?.calls??4):Math.max(10,job.calls.length)} max={2000} value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label>}
            <button className="uno-work__primary" disabled={busy||!connected||budgetUnavailable} onClick={()=>void perform(()=>updateUnoJob(job,"resume",[],[],job.workflow&&!bookCompile?budget:undefined))}>{repairRecovery?.primaryLabel??resumePlan?.primary?.label??'从未完成处继续'}</button>
            {budgetUnavailable&&<p role="status" className="uno-work__muted">实际请求账本暂不可用，等待刷新后再继续。</p>}
            {!resumePlan&&job.workflow&&!!job.failures.length&&<button disabled={busy||!connected} onClick={()=>void perform(()=>updateUnoJob(job,"retry",[],[],bookCompile?undefined:budget))}>重试提取失败材料</button>}
          </>}
          {!queueOwnsJob&&!resumeDecision&&!["ended","completed"].includes(job.status)&&<button className={bookSettled||repairRecovery?'uno-work__quiet':'uno-work__end'} disabled={busy||!connected||ending} onClick={()=>void perform(()=>updateUnoJob(job,"end"))}>{ending?"正在结束…":bookSettled?"暂时关闭":repairRecovery?.closeLabel??"结束本次任务"}</button>}
    </div>
        {!bookSettled&&resumeDecision&&<section className="uno-work__review uno-work__resume-decision" role="status" aria-label="继续前处理停点"><h3>继续前需要处理当前停点</h3><p>{resumePlan!.reason}</p>
          <div className="uno-work__actions">{resumePlan!.actions.map(item=><button type="button" className={item.id==='quarantine-candidates'?'uno-work__primary':undefined} disabled={busy||!connected||budgetUnavailable} key={item.id} title={item.effect} onClick={()=>void perform(()=>resolveUnoJob(job,item.id as 'quarantine-candidates'|'discard-candidates'|'defer-unit'))}>{item.label}</button>)}<button type="button" className="uno-work__end" disabled={busy||!connected||ending} onClick={()=>void perform(()=>updateUnoJob(job,"end"))}>暂不处理，结束任务</button></div>
          <details><summary>这些选项有什么区别</summary>{resumePlan!.actions.map(item=><p className="uno-work__muted" key={item.id+'-effect'}><strong>{item.label}：</strong>{item.effect}</p>)}<p className="uno-work__muted"><strong>暂不处理，结束任务：</strong>关闭任务并保留当前停点、已保存成果与审核记录。</p></details>
        </section>}
        {!bookSettled&&resumeBlocked&&<p role="status" className="uno-work__error">{resumePlan!.reason}</p>}
        {!bookSettled&&!queueOwnsJob&&!['ended','completed'].includes(job.status)&&<p className="uno-work__muted uno-work__action-note">{resumeDecision?'选择一项明确处理方式后才会继续；不会重复执行无效的普通继续。':resumeBlocked?'当前没有安全的普通继续路径；已有成果和检查点保持不变。':repairRecovery?'关闭只会结束当前处理任务；候选与问题仍留在编译修复队列，可稍后继续。':'暂停后可以继续；结束本次任务会保留已保存成果、草稿及未处理材料，之后可新建任务接着整理。'}</p>}
  </>:null;
  const panelTitle=job?(bookCompile?(bookSettled?bookPanelTitle(job):bookWorkingTitle(job)):job.title):(isCompile?'编译材料':'建构知识');
  const focusedJob=Boolean(job&&!legacyCompile);
  const setupPanel=!job;
  return <section className={`uno-work${focusedJob?' uno-work--focused':''}${bookSettled?' uno-work--settled':''}${setupPanel?' uno-work--setup':''}`} aria-label={isCompile?"编译材料":"建构知识"}>
    <header className="uno-work__header"><div className="uno-work__header-copy"><small>知识工作</small><h2>{panelTitle}</h2></div><button type="button" aria-label="收起知识工作面板" onClick={onClose}>收起</button></header>
    {domainReviewPending&&<div className="uno-work__domain-notice" role="status">
      <span className="uno-work__domain-notice-icon" aria-hidden="true">↓</span>
      <div className="uno-work__domain-notice-copy"><strong>等待确认领域</strong><p>{job.domain_governance!.pending_proposals.length} 个领域提案待处理，请向下滚动确认。</p></div>
      <button type="button" onClick={showDomainReview}>前往确认</button>
    </div>}
    <div className="uno-work__scroll">
      {!isCompile&&<p className="uno-work__intro">{job&&!job.construction_profile?"检查所选卡片的内容、主类型、联系与领域组织；此历史任务继续按原有范围与流程执行。":"选择本次建构的侧重与允许调整，再由 UNO 寻找相关知识、阅读比较并完成有依据的整理。"}</p>}
      {backgroundJob&&<section className="uno-work__background" role="status" aria-label="另一任务正在运行"><div><strong>另一个建构任务正在后台执行</strong><p>当前面板仍在查看另一条任务记录；侧栏运行状态来自“{backgroundJob.title}”。该任务仍在推进，打开后可查看最新轮次。</p></div>{onOpenBackgroundJob&&<button type="button" onClick={onOpenBackgroundJob}>打开正在运行的任务</button>}</section>}
      {job&&!isCompile&&job.construction_profile&&!['direction-driven-v1','strategy-driven-v2'].includes(job.construction_profile)&&<p className="uno-work__muted">此历史任务不会自动转换为当前建构协议；范围和处理要求保持创建时的设置。</p>}

      {error&&<div role="alert" className="uno-work__error">{error}<button onClick={()=>jobId||job?void fetchUnoJob(jobId??job!.id).then(setJob).catch(e=>setError(String(e))):void fetchUnoPreparation().then(setPreparation).catch(e=>setError(String(e)))}>刷新</button></div>}
      {!connected&&!job&&<p role="status" className="uno-work__error">进度暂未同步，网页会自动重试。这不代表模型调用失败；当前显示上次确认的进度，刷新不会暂停任务。</p>}
      {!job&&unconfirmedStart&&<section aria-label="上次开始请求" className="uno-work__selection"><h3>{legacyStart?'历史编译开始请求':'上次开始请求尚未确认'}</h3><p>{legacyStart?'此请求使用旧编译流程。可以查询原任务记录，不会重放请求或自动启动新任务。':'先核对保留的原请求，避免重复启动。核对完成前不会改写原要求或创建另一项任务。'}</p><p className="uno-work__muted">{unconfirmedStart.mode==='compile'?`材料 ${unconfirmedStart.sources?.length??0} 项`:'建构请求'}{unconfirmedStart.theme?` · ${unconfirmedStart.theme}`:''}</p>{unconfirmedStart.notes&&<p>{unconfirmedStart.notes}</p>}
        {legacyStart?<><button disabled={busy||!connected} onClick={()=>{const saved=pendingStart(unconfirmedStart.library_id??'legacy');if(!saved)return;void perform(async()=>{try{const recovered=await fetchUnoJob(saved.id);completeStart(unconfirmedStart.library_id??'legacy',saved.id,recovered.owner_session_id??recovered.session_id);return recovered;}catch(error){setMissingLegacyStart(Number((error as {status?:number}).status)===404);throw error;}});}}>查询原任务记录</button>{missingLegacyStart&&<><p className="uno-work__muted">服务确认未找到对应任务。可清除本地未确认请求，重新选择 Inbox 书籍；这不会删除服务器上的材料或成果。</p><button onClick={()=>{const library=unconfirmedStart.library_id??'legacy',saved=pendingStart(library);if(saved)rejectStart(library,saved.id);setUnconfirmedStart(null);setMissingLegacyStart(false);setSources([]);setContinuous(true);setDelivery('auto');setAutomaticDomains(false);setError('');}}>清除未确认请求并重新选书</button></>}</>:<>{!startReady&&<p role="status" className="uno-work__error">{capability.message||'当前服务尚未加载建构侧重与权限控制，请加载新版服务后使用。'}</p>}<button className="uno-work__primary" disabled={busy||!connected||!startReady} onClick={()=>void perform(()=>startUnoJob(unconfirmedStart))}>{busy?'正在核对…':'核对上次开始请求'}</button></>}
      </section>}
      {!job&&!unconfirmedStart&&<form id="uno-start-form" onSubmit={e=>{e.preventDefault();if(!startReady||(isCompile?!sources.length:!validScope))return;void perform(()=>startUnoJob({mode,...(isCompile?{sources,theme,material_kind:materialKind,compile_profile:'unit-cards-v3' as const,compile_quality_mode:compileQuality,domain_approval_mode:automaticDomains?'automatic' as const:'manual' as const}:{construction_controls:controls,...(scopeMode==='cards'?{card_ids:selectedCards}:{}),domain,type,construction_profile:'strategy-driven-v2' as const,orchestration_profile:'bounded-workflow-v1' as const,force_recheck:forceRecheck}),notes,budget_calls:budget,library_id:preparation?.library?.id,continuous,inherit_preferences:inherit,delivery:isCompile?'auto':delivery,external_images:externalImages}));}}>
        {!preparation?<p role="status">正在读取可用材料…</p>:<>
          {isCompile?<>
            <label>材料主题<input ref={input} value={theme} maxLength={100} onChange={e=>setTheme(e.target.value)} placeholder="留空时使用材料名称"/></label>
            <label>材料类型<select value={materialKind} onChange={e=>setMaterialKind(e.target.value as typeof materialKind)}><option value="auto">自动识别</option><option value="book">图书 · 按章节</option><option value="article">文章 · 优先整篇</option></select></label>
            <label>编译质量<select aria-label="编译质量" value={compileQuality} onChange={e=>setCompileQuality(e.target.value as typeof compileQuality)}><option value="standard">标准编译</option><option value="refine-each-card-v1">高质量编译 · 逐卡精修</option></select></label>
            {compileQuality==='refine-each-card-v1'&&<p className="uno-work__muted">每张候选卡会增加一次独立精修请求：重读本单元原文，优化表达并核对类型、领域和已有关系，然后仍须通过正常审核才会保存。请求量、输入量和耗时会明显增加。</p>}
            <fieldset><legend>选择材料 · 已选 {sources.length}</legend><p className="uno-work__muted">图书按章节整理，短文章保留整篇；长单元按段落切分。每个单元完整提交一次生成知识卡，检查后只修改问题卡。</p>
              {!!preparation.archived_sources?.length&&<p className="uno-work__muted">已识别 {preparation.archived_sources.length} 份与完成归档逐字节一致的 Inbox 副本，不再列为待编译材料；不可变原件仍保留在归档目录。</p>}
              {!preparation.sources.length&&<p>Inbox 当前没有待编译材料，请先上传原始文件。历史整理材料保留在原任务中，不作为新编译入口。</p>}
              <button type="button" onClick={()=>setSources(preparation.sources.filter(s=>s.compile_available!==false).map(s=>s.path.startsWith("00-Inbox/")?s.path:"00-Inbox/"+s.path))}>全选可编译材料</button><button type="button" onClick={()=>setSources([])}>清空选择</button><div className="uno-work__materials">{preparation.sources.map(source=>({source,path:source.path,ref:source.path.startsWith("00-Inbox/")?source.path:"00-Inbox/"+source.path})).map(item=>{
                const ref=item.ref;
                return <label key={ref}><input type="checkbox" checked={sources.includes(ref)} disabled={busy||!connected||item.source.compile_available===false}
                  onChange={e=>setSources(current=>e.target.checked?[...current,ref]:current.filter(s=>s!==ref))}/><span>{item.path}{inboxSourceProgress(item.source)&&<small> · {inboxSourceProgress(item.source)}</small>}{item.source.compile_unavailable_reason&&<small> · {item.source.compile_unavailable_reason}</small>}</span></label>;
              })}</div>
            </fieldset>
            <fieldset><legend>编译倾向 · 快捷提示词</legend><div className="uno-work__actions">{COMPILE_HINTS.map(h=><button type="button" key={h.id} onClick={()=>setNotes(current=>current?current+'\n'+h.prompt:h.prompt)}>{h.label}</button>)}</div></fieldset>
            <label>本轮编译提示词<textarea rows={5} value={notes}  onChange={e=>setNotes(e.target.value)} placeholder="例如：重点保留作者的论证主线、关键历史案例与不同立场。快捷选项会将文字加入这里，可自由修改。"/></label>
            <label className="uno-work__inline"><input type="checkbox" checked={automaticDomains} onChange={e=>setAutomaticDomains(e.target.checked)}/>允许编译自行决定领域</label>
            <p className="uno-work__muted">开启后，领域治理检查点提出的新领域会在通过成员、边界、版本和原子写入校验后自动创建并挂靠；关闭时逐项确认。此授权只属于本次编译。</p>

            <p className="uno-work__muted">每个原文单元不超过 6 万字符，其余上下文合计不超过 6 万字符；不同请求不叠加历史正文。卡片经规格、类型、关系与内容检查后保存。预算按实际外发请求累计，达到上限保留进度，不会把未处理内容算作完成。</p>
          </>:<>
            {inherit&&preparation.preferences?.purpose&&<div className="construction-library-purpose"><strong>知识库用途</strong>{preparation.preferences.purpose}</div>}
            <ConstructionControls value={controls} onChange={setControls} disabled={busy}/>
            <div className="construction-scope">
              <label>本次处理范围<select aria-label="本次处理范围" value={scopeMode} onChange={e=>{setScopeMode(e.target.value as typeof scopeMode);setDomain('');setSelectedCards([]);}}><option value="library">全库自由建构 · 无需选卡</option><option value="domain">限定一个领域 · 自动选卡</option><option value="cards">以指定卡片为锚点</option></select></label>
              {scopeMode==='domain'&&<label>领域范围<select aria-label="领域范围" value={domain} onChange={e=>setDomain(e.target.value)}><option value="">选择一个领域</option>{preparation.domains.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
              <p className="uno-work__muted construction-scope__note">{scopeMode==='cards'?`已选卡片作为不可丢弃的锚点；当前筛选下有 ${count} 张卡片可供核对。`:`无需预先选择卡片；UNO 会从当前 ${count} 张卡片中安排一个小型工作包，结算后再按最新知识图继续。`}范围外知识只作只读对照，未入选内容尚未检查。</p>
            </div>
            {scopeMode==='cards'&&<fieldset><legend>选择卡片 · 已选 {selectedCards.length}</legend><input aria-label="查找卡片" placeholder="按标题查找" value={cardQuery} onChange={e=>setCardQuery(e.target.value)}/><div className="uno-work__materials">{preparation.cards.filter(c=>(!type||c.type===type)&&(!cardQuery||c.title.includes(cardQuery))).slice(0,60).map(c=><label key={c.id}><input type="checkbox" checked={selectedCards.includes(c.id)} onChange={e=>setSelectedCards(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/>{c.title}</label>)}</div><small>每次显示最多 60 项，可以搜索后继续选择。</small></fieldset>}
            <label>具体问题与补充要求<textarea aria-label="具体问题与补充要求" rows={3} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="例如：重点比较地方财政与产业政策之间的联系，保留不同作者的分歧。"/></label>
            <details><summary>类型筛选与检查记录</summary><label>主类型范围<select value={type} onChange={e=>{setType(e.target.value);setSelectedCards([]);}}><option value="">全部主类型</option>{preparation.types.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="uno-work__inline"><input type="checkbox" checked={forceRecheck} onChange={e=>setForceRecheck(e.target.checked)}/>重新检查，不复用同一方向的已有检查</label></details>
          </>}
          <label className="uno-work__inline"><input type="checkbox" checked={inherit} onChange={e=>setInherit(e.target.checked)}/>使用「{preparation.library?.name??'当前知识库'}」的用途与文字要求</label>
          <p className="uno-work__muted">偏好与本次要求合计：{tokenUsage?`${tokenUsage.exact?'':'约 '}${tokenUsage.tokens} / 3,000 tokens`:'正在计量…'}{tokenUsage?.warning&&' · '+tokenUsage.warning}</p>
          <label className="uno-work__inline"><input type="checkbox" checked={continuous} onChange={e=>setContinuous(e.target.checked)}/>{isCompile?'连续处理全部所选内容':relationWeaving?'持续发现知识关系':'连续处理本次候选组'}</label><p className="uno-work__muted">{isCompile?(continuous?'依次处理全书阅读单元，达到预算时保存进度。':'当前阅读单元处理完成后暂停；其余内容保留待处理。'):relationWeaving?(continuous?'每轮随机抽取一张尚未检查的卡片，再从全库检索最可能的关系端点；结算后继续随机抽样，达到预算时保存进度。':'随机抽取一张卡并完成一次全库候选检索；继续时抽取下一张尚未检查的卡。'):(continuous?'按本次方向逐组处理，达到预算时保存进度；未入选卡片不计为已完成。':'先处理一个候选组后暂停，其余候选和未入选卡片保留待处理。')}</p>
          <details><summary>本次处理选项</summary><label>本轮模型请求预算<input type="number" min={4} max={2000} value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label>{isCompile&&<label className="uno-work__inline"><input type="checkbox" checked={externalImages} onChange={e=>setExternalImages(e.target.checked)}/>尝试归档外链图片</label>}</details>
          <p className="uno-work__muted">{isCompile?"开始后模型可在本知识库新增或丰富卡片并建立有理由的联系；写入校验通过即保存，修改保留历史版本。":"每张检查过的卡片都需有修订结果或保留理由；未解决的问题留待继续，历史版本可恢复。"}</p>
          {!startReady&&<p role="status" className="uno-work__error">{capability.message||'当前服务尚未加载建构侧重与权限控制，请加载新版服务后使用。'}</p>}
          {isCompile&&<button className="uno-work__primary" disabled={busy||!connected||!startReady||(tokenUsage?.tokens??0)>3000||!sources.length}>{busy?"正在开始…":"开始编译"}</button>}
          {!!preparation.jobs.filter(j=>j.mode===mode).length&&<details className="uno-work__history"><summary>查看已有任务</summary>{preparation.jobs.filter(j=>j.mode===mode).map(j=><button type="button" key={j.id} onClick={()=>void perform(()=>fetchUnoJob(j.id))}>{j.title}<small>{states[j.status]??j.status}</small></button>)}</details>}
        </>}
      </form>}
      {job&&(legacyCompile?<HistoricalKnowledgeView job={job} onOpenCard={onOpenCard}/>:<>
        {!bookSettled&&<ActiveJobOverview job={job} queue={queueVisible?unassignedQueue:null} connected={connected} ending={ending} actions={<>{queueActions}{jobActions}</>}/>}
        {domainReviewPending&&<section ref={domainReviewRef} tabIndex={-1} className="uno-work__review" aria-label="领域治理提案">
          <h3>领域治理检查点</h3><p>系统按最近 10 个有效阅读单元、20 张未组织卡或全书结束触发一次批量治理。新领域必须由你确认；未选提案会暂缓，不影响卡片正文和已保存成果。</p>
          {job.domain_governance!.pending_proposals.map(proposal=><article key={proposal.proposal_id}>
            <label className="uno-work__inline"><input type="checkbox" checked={approvedDomains.includes(proposal.proposal_id)} onChange={event=>setApprovedDomains(current=>event.target.checked?[...current,proposal.proposal_id]:current.filter(id=>id!==proposal.proposal_id))}/><strong>{proposal.title}</strong></label>
            <p>{proposal.summary}</p><p><strong>核心问题：</strong>{proposal.core_questions.join('；')}</p><p><strong>纳入：</strong>{proposal.includes.join('；')}</p><p><strong>排除：</strong>{proposal.excludes.join('；')}</p>
            <p><strong>首批成员：</strong>{proposal.member_card_ids.length} 张</p><div className="uno-work__saved-cards">{proposal.member_card_ids.map(id=><button type="button" key={id} onClick={()=>onOpenCard(id)}>查看卡片 · {id}</button>)}</div>
            <p className="uno-work__muted">{proposal.why_new}{proposal.alternative&&` · 暂不建域时：${proposal.alternative}`}</p>
          </article>)}
          <div className="uno-work__actions"><button className="uno-work__primary" disabled={busy||!connected||!approvedDomains.length} onClick={()=>{const all=job.domain_governance!.pending_proposals.map(row=>row.proposal_id),defer=all.filter(id=>!approvedDomains.includes(id));void perform(()=>reviewUnoDomains(job,approvedDomains,defer));}}>应用选中领域并继续</button><button disabled={busy||!connected} onClick={()=>{const all=job.domain_governance!.pending_proposals.map(row=>row.proposal_id);void perform(()=>reviewUnoDomains(job,[],all));}}>全部暂缓并继续</button></div>
        </section>}
        {bookCompile?<BookCompilationView job={job} onOpenCard={onOpenCard} actions={bookSettled?jobActions:undefined} compactActive={!bookSettled} onOpenUnassigned={onOpenUnassigned} archiveReviewBusy={busy||!connected} onReviewArchive={source=>void perform(()=>reviewUnoBookArchive(job,source))}/>:null}
        {!bookCompile&&job.construction_controls&&<ConstructionResults job={job} onOpenCard={onOpenCard}/>}
        <ConstructionPlanView job={job} onOpenCard={onOpenCard}/>
        {!!job.issues?.length&&<details open><summary>校对事项 · {job.issues.length}</summary>{job.issues.map((issue,i)=><p key={i}><button onClick={()=>onOpenCard(issue.id)}>查看卡片</button>{issue.detail}</p>)}</details>}
        {!bookSettled&&!!job.failures.length&&<div className="uno-work__error"><strong>保留待处理</strong>{job.failures.map(f=><p key={f.source}>{f.source}：{f.detail}</p>)}</div>}
        {!!sourceWarnings.length&&<details><summary>原件与提取提醒 · {sourceWarnings.length}</summary>{sourceWarnings.map(row=><p key={row.source+row.warning} className="uno-work__muted">{row.source}：{row.warning}</p>)}</details>}
        {waiting&&<div className="uno-work__review">
          <h3>本批知识修订</h3>
          {cards.map(card=><article key={card.id}>
            <h4>{card.title}</h4><p className="uno-work__tags"><span>{card.type}</span>{card.domains.map(id=><span key={id}>{preparation?.domains.find(domain=>domain.id===id)?.title??id}</span>)}</p>
            <CardMarkdown body={card.body}/>
            {card.sources.map((ref,i)=><button type="button" key={ref} onClick={()=>void fetchUnoSource(job.id,ref).then(setSource).catch(e=>setError(String(e)))}>查看原文 {i+1}</button>)}
            {!!job.pending?.duplicates?.[card.id]?.length&&<div className="uno-work__duplicate">
              <p>名称高度相似：{job.pending.duplicates[card.id].map(c=>c.title).join("、")}</p>
              <label><input type="radio" name={"duplicate-"+card.id} checked={allow.includes(card.id)} onChange={()=>{setAllow(current=>[...current.filter(id=>id!==card.id),card.id]);setSkip(current=>current.filter(id=>id!==card.id));}}/>不同内容，保留为独立卡片</label>
              <label><input type="radio" name={"duplicate-"+card.id} checked={skip.includes(card.id)} onChange={()=>{setSkip(current=>[...current.filter(id=>id!==card.id),card.id]);setAllow(current=>current.filter(id=>id!==card.id));}}/>确认内容重复，不再保存这张卡</label>
            </div>}
          </article>)}
          {job.pending?.skipped?.map(s=><p key={s.ref}>未制卡原文：{s.reason}</p>)}
          {job.pending?.links?.map((link,i)=><article key={i}><h4>{job.pending?.cards.find(c=>c.id===link.source)?.title??link.source} → {job.pending?.cards.find(c=>c.id===link.target)?.title??link.target}</h4>
            <strong>{linkLabels[link.type]??link.type}</strong><p>{link.note}</p><small>用于检索的线索，回答时仍需核对两端正文。</small>
            <div><button onClick={()=>onOpenCard(link.source)}>查看起点</button><button onClick={()=>onOpenCard(link.target)}>查看另一端</button></div></article>)}
          <div className="uno-work__actions"><button className="uno-work__primary" disabled={busy||!connected||duplicateIds.some(id=>!allow.includes(id)&&!skip.includes(id))} onClick={()=>void perform(()=>updateUnoJob(job,"review",allow,skip))}>保存本批并继续</button>
            {job.workflow!=='uno-compile-v3'&&<button disabled={busy||!connected} onClick={()=>void perform(()=>updateUnoJob(job,"retry"))}>重新生成本批</button>}</div>
        </div>}
        {source&&<aside className="uno-work__source"><header><strong>{source.locator}</strong><button onClick={()=>setSource(null)}>关闭原文</button></header><pre>{source.body}</pre></aside>}
        {!isCompile&&Object.values(job.batch_records??{}).some(batch=>Object.values(batch.reviewed??{}).some(review=>review.unchanged))&&<details><summary>保留原样的检查记录</summary>{Object.entries(job.batch_records??{}).flatMap(([batch,record])=>Object.entries(record.reviewed??{}).filter(([,review])=>review.unchanged).map(([id,review])=><p key={batch+':'+id}><button onClick={()=>onOpenCard(id)}>{id}</button> · {review.issues?.length?'待核对':'审核后保留'}：{review.note}{review.issues?.map(issue=><span key={issue}> · {issue}</span>)}</p>))}</details>}
        {!bookCompile&&!job.construction_controls&&!!job.receipts.length&&<details open={job.status==="completed"||job.status==="partial"}><summary>已保存的成果 · {job.receipts.length} {job.workflow?'次操作':'批'}</summary>
          {job.receipts.map(r=><p key={r.key}>{r.summary}{(!r.staged?(r.card_ids??[]):[]).map(id=><button key={id} onClick={()=>onOpenCard(id)}>查看卡片</button>)}</p>)}</details>}
        {bookCompile&&['done','ended'].includes(job.phase??'')?<details><summary>模型请求与用量</summary><UnoRequestUsage job={job}/></details>:<UnoRequestUsage job={job}/>}
      </>)}
    </div>
    {!isCompile&&!job&&!unconfirmedStart&&<footer className="construction-startbar"><div><strong>本次建构 · {scopeLabel}</strong><p>{summary} {continuous?'在预算内连续处理。':'先处理一组。'}{delivery==='manual'?'审核后由你确认发布。':'审核通过后保存。'}</p></div><button type="submit" form="uno-start-form" className="uno-work__primary" disabled={busy||!connected||!startReady||!count||!validScope||(tokenUsage?.tokens??0)>3000}>{busy?'正在开始…':controls.allowed.length?'开始建构':'开始诊断'}</button></footer>}
  </section>;
}
