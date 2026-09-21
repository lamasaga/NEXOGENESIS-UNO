import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UnoKnowledgePanel, HistoricalKnowledgeView, ConstructionPlanView, UnoRequestUsage, ActiveJobOverview, activeJobPresentation, repairRecoveryGuidance, bookCompilePhaseLabel, bookStatusDetail, uniqueSourceWarnings, constructionAvailability, compileAvailability, inboxSourceProgress, unoWorkProgress } from "./UnoKnowledgePanel";
import { __resetLocalRequestTokenForTests, resolveUnoJob, reviewUnoBookArchive, startUnoJob, updateUnoJob, type UnoJob, type UnoPreparation } from "../api/client";
import { BookCompilationView, bookActiveStatus, bookCompilationProgress, bookCanContinue, bookPanelTitle, bookSettlementSummary, bookWorkingTitle } from './BookCompilationView';
afterEach(()=>{vi.unstubAllGlobals();__resetLocalRequestTokenForTests();});
it('Inbox 材料状态区分未完成任务和完成归档副本',()=>{
 expect(inboxSourceProgress({path:'book.epub',compile_state:'unfinished',processed_units:24,total_units:26,open_items:2})).toBe('未完成 · 24/26 个单元 · 待修复 2 项');
 expect(inboxSourceProgress({path:'book.epub',compile_state:'archive_review',processed_units:15,total_units:15})).toBe('正文单元已处理 · 等待原件缺口复核');
 expect(inboxSourceProgress({path:'new.epub'})).toBe('');
});
it('已处理全部单元且仅有原文缺口时不再诱导继续或展示历史恢复提示',()=>{
 const job={status:'partial',phase:'done',book_units:[{ref:'one',title:'正文',chars:100}],book_outcomes:{one:{status:'processed',note:'已保存',card_ids:[]}},sources:[{incomplete:true}],failures:[],receipts:[],last_recovery:{status:'recovered',method:'deterministic'},resume_blocked_reason:'可读单元已全部处理，请核对封面和图像页。'} as unknown as UnoJob;
 expect(bookCanContinue(job)).toBe(false);
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}}/>);
 expect(html).toContain('请核对封面和图像页');expect(html).not.toContain('延期与未处理单元仍需继续');expect(html).not.toContain('已恢复上一条模型响应');
 expect(bookCanContinue({...job,book_outcomes:{}})).toBe(true);
 expect(bookCanContinue({...job,resume_available:true})).toBe(true);
});
it("编译直接进入材料设置，建构显示两层控制与固定开始入口",()=>{
 const compile=renderToStaticMarkup(<UnoKnowledgePanel mode="compile" onClose={()=>{}} onChanged={()=>{}} onOpenCard={()=>{}}/>);
 const construct=renderToStaticMarkup(<UnoKnowledgePanel mode="construct" onClose={()=>{}} onChanged={()=>{}} onOpenCard={()=>{}}/>);
 expect(compile).toContain('uno-work--setup');expect(compile).toContain('<small>知识工作</small><h2>编译材料</h2>');expect(compile).toContain('aria-label="收起知识工作面板"');
 expect(compile).not.toContain("选择图书或文章");expect(compile).not.toContain('先按你的用途选择章节');expect(construct).toContain('<h2>建构知识</h2>');expect(construct).toContain("侧重与允许调整");expect(construct).toContain('form="uno-start-form"');expect(construct).not.toContain('type="radio"');
});
it('查看旧记录时明确区分后台运行任务并提供切换入口',()=>{
 const html=renderToStaticMarkup(<UnoKnowledgePanel mode="construct" backgroundJob={{title:'后台建构'}} onOpenBackgroundJob={()=>{}} onClose={()=>{}} onChanged={()=>{}} onOpenCard={()=>{}}/>);
 expect(html).toContain('另一个建构任务正在后台执行');expect(html).toContain('当前面板仍在查看另一条任务记录');expect(html).toContain('打开正在运行的任务');expect(html).not.toContain('6/6');
});
it('归档复核明确展示提取警告并通过独立接口提交当前任务版本',async()=>{
 const job={id:'book',version:8,status:'ended',phase:'ended',receipts:[],book_units:[{ref:'u',title:'正文',chars:10}],book_outcomes:{u:{status:'processed',card_ids:[]}},
  archive_review:{contract:'book-archive-review-v1',sources:[{source:'00-Inbox/book.epub',title:'测试书',warnings:['封面页只有图像']}]}} as unknown as UnoJob;
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}} onReviewArchive={()=>{}}/>);
 expect(html).toContain('原书仍在 Inbox · 等待复核');expect(html).toContain('封面页只有图像');expect(html).toContain('我已核对缺口，归档原书');
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({token:'local',id:'book',status:'ended'})));vi.stubGlobal('fetch',fetcher);
 await reviewUnoBookArchive(job,'00-Inbox/book.epub');
 expect(fetcher.mock.calls[1][0]).toBe('/api/uno/jobs/book/archive-review');
 expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toMatchObject({version:8,source:'00-Inbox/book.epub'});
});
it("创建批次和重复标题决定使用本地安全令牌与原任务版本",async()=>{
 const fetcher=vi.fn(async(url:RequestInfo|URL,options?:RequestInit)=>new Response(JSON.stringify(String(url)==="/api/security/session"?{token:"local"}:{id:"j",version:3})));
 vi.stubGlobal("fetch",fetcher);
 await startUnoJob({mode:"compile",compile_profile:'unit-cards-v3',sources:["00-Inbox/a.md","00-Inbox/b.md"],theme:"信用"});
 expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).sources).toHaveLength(2);
 expect(new Headers(fetcher.mock.calls[1][1]!.headers).get("X-Nexogenesis-CSRF")).toBe("local");
 await updateUnoJob({id:"j",version:3} as UnoJob,"review",[],["duplicate-card"]);
 expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string)).toEqual({version:3,decision:"save",allow_titles:[],skip_titles:["duplicate-card"]});
});

it("结束任务使用独立接口，保留暂停接口语义",async()=>{
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({token:'local',id:'j',status:'ended'})));vi.stubGlobal('fetch',fetcher);
 await updateUnoJob({id:'j',version:3} as UnoJob,'end');expect(fetcher.mock.calls[1]?.[0]).toBe('/api/uno/jobs/j/end');
});

it('策略建构同时提交独立profile和用户方向，不预先提交全库card_ids',async()=>{
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({token:'local',id:'j',status:'paused'})));vi.stubGlobal('fetch',fetcher);
 await startUnoJob({mode:'construct',construction_profile:'strategy-driven-v2',orchestration_profile:'bounded-workflow-v1',notes:'整理通胀解释中的重复和边界',domain:'macro-economics',force_recheck:true,budget_calls:6});
 const body=JSON.parse(fetcher.mock.calls[1][1]!.body as string);
 expect(body).toMatchObject({construction_profile:'strategy-driven-v2',orchestration_profile:'bounded-workflow-v1',notes:'整理通胀解释中的重复和边界',force_recheck:true,budget_calls:6});
 expect(body.card_ids).toBeUndefined();
});

it('只有当前服务明确支持随机焦点、全库端点检索、策略建构服务与预算模型时才允许启动',()=>{
 const p={uno_construction_service:1,uno_relation_weaving:1,relation_weaving_contract:'random-focus-semantic-retrieval-v2',relation_weaving_focus_selection:'job-seeded-random-without-replacement-v1',relation_weaving_endpoint_retrieval:'all-cards-integration-candidates-v1',relation_weaving_max_focus_attempts:2,construction_response_recovery:'construction-response-recovery-v1',construction_repair_scope:'construction-repair-endpoint-scope-v1',default_construction_profile:'strategy-driven-v2',construction_profiles:['strategy-driven-v2','direction-driven-v1'],orchestration_profiles:['bounded-workflow-v1'],construction_model:{available:true}} as UnoPreparation;
 expect(constructionAvailability(p).ready).toBe(true);
 expect(constructionAvailability({...p,construction_model:{available:false,message:'当前套餐路由无法计数'}})).toEqual({ready:false,message:'当前套餐路由无法计数'});
 expect(constructionAvailability({...p,construction_model:undefined}).ready).toBe(false);
 expect(constructionAvailability({...p,construction_profiles:undefined}).ready).toBe(false);expect(constructionAvailability({...p,uno_construction_service:undefined}).ready).toBe(false);expect(constructionAvailability({...p,uno_relation_weaving:undefined}).ready).toBe(false);expect(constructionAvailability({...p,relation_weaving_focus_selection:undefined}).ready).toBe(false);expect(constructionAvailability({...p,relation_weaving_endpoint_retrieval:undefined}).ready).toBe(false);expect(constructionAvailability({...p,construction_response_recovery:undefined}).ready).toBe(false);expect(constructionAvailability({...p,construction_repair_scope:undefined}).ready).toBe(false);
});

it('新编译必须确认逐卡精修、领域授权和当前模型的计数能力，不借建构能力静默降级',()=>{
 const p={compile_profile:'unit-cards-v3',compile_review_policy:'review-publish-repair-v2',compile_card_refinement:'refine-each-card-v1',compile_quality_modes:['standard','refine-each-card-v1'],domain_approval_modes:['manual','automatic'],compile_model:{available:true},construction_model:{available:true},orchestration_profiles:['bounded-workflow-v1']} as UnoPreparation;
 expect(compileAvailability(p)).toEqual({ready:true,message:''});
 expect(compileAvailability(null).ready).toBe(false);
 expect(compileAvailability({...p,compile_profile:undefined})).toMatchObject({ready:false,message:expect.stringContaining('type＋domains')});
 expect(compileAvailability({...p,compile_profile:'bounded-workflow-v1'}).ready).toBe(false);
 expect(compileAvailability({...p,compile_review_policy:'harness-first-v1'}).ready).toBe(false);
 expect(compileAvailability({...p,compile_card_refinement:undefined}).ready).toBe(false);
 expect(compileAvailability({...p,compile_quality_modes:['standard']}).ready).toBe(false);
 expect(compileAvailability({...p,domain_approval_modes:['manual']}).ready).toBe(false);
 expect(compileAvailability({...p,compile_model:undefined}).ready).toBe(false);
 expect(compileAvailability({...p,compile_model:{available:false,message:'此模型暂不可用于编译'}})).toEqual({ready:false,message:'此模型暂不可用于编译'});
});

it('新编译提交全书profile、质量模式、选书范围和任务级领域授权，不再请求旧筛选审核流程',async()=>{
 const fetcher=vi.fn(async(url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify(String(url)==='/api/security/session'?{token:'local'}:{id:'book',session_id:'owner',workflow:'uno-unit-compile-v3'})));vi.stubGlobal('fetch',fetcher);
 const sources=['00-Inbox/a.md','00-Inbox/b.md'];
 await startUnoJob({mode:'compile',sources,compile_profile:'unit-cards-v3',compile_quality_mode:'refine-each-card-v1',domain_approval_mode:'automatic',budget_calls:4,continuous:true,delivery:'auto'});
 const body=JSON.parse(fetcher.mock.calls[1][1]!.body as string);
 expect(body).toMatchObject({mode:'compile',sources,compile_profile:'unit-cards-v3',compile_quality_mode:'refine-each-card-v1',domain_approval_mode:'automatic',budget_calls:4,continuous:true,delivery:'auto'});
 expect(body.orchestration_profile).toBeUndefined();expect(body.review_policy).toBeUndefined();
});

it('候选、复用、延期和未入选不显示为全部完成或事实已核验',()=>{
 const job={id:'synthetic',mode:'construct',construction_profile:'direction-driven-v1',construction_plan:{goal:'比较作者分歧',kind:'viewpoints',scope_count:20,notice:'分组只是候选。',packages:[{id:'group-1',goal:'比较作者分歧',card_ids:['甲','乙'],reason:'共同主题',status:'pending'},{id:'group-2',goal:'比较作者分歧',card_ids:['丙'],reason:'同一方向',status:'reused'}],skipped:[{id:'group-2',card_ids:['丙']}],unselected:['丁']},construction_results:{0:{甲:{id:'甲',status:'unchanged',note:'前提不同，应分别保留。',source_verified:false},乙:{id:'乙',status:'deferred',note:'来源不足。',source_verified:false}}}} as unknown as UnoJob;
 const html=renderToStaticMarkup(<ConstructionPlanView job={job} onOpenCard={()=>{}}/>);
 expect(html).toContain('候选与选卡都不是质量结论');expect(html).toContain('未入选 1 张 · 尚未检查');expect(html).toContain('暂缓处理');expect(html).toContain('未重新核验原始来源');expect(html).not.toContain('事实核验通过');
 expect(renderToStaticMarkup(<ConstructionPlanView job={{...job,construction_profile:undefined}} onOpenCard={()=>{}}/>)).toBe('');
});

it('预算显示使用实际外发次数，不把被拦截步骤或未知用量当调用',()=>{
 const job={orchestration_profile:'bounded-workflow-v1',provider_budget:{used:3,limit:6,remaining:3},calls:Array.from({length:12},()=>({phase:'select'}))} as UnoJob;
 const html=renderToStaticMarkup(<UnoRequestUsage job={job}/>);expect(html).toContain('模型请求 3 次');expect(html).not.toContain('模型请求 12 次');expect(html).not.toContain('输入 0');
 const missing=renderToStaticMarkup(<UnoRequestUsage job={{...job,provider_budget:undefined}}/>);expect(missing).toContain('模型请求计数暂不可用');expect(missing).not.toContain('模型请求 0');
 const book=renderToStaticMarkup(<UnoRequestUsage job={{...job,workflow:'uno-unit-compile-v3',orchestration_profile:undefined}}/>);expect(book).toContain('模型请求 3 次');
});

it('阅读进度与已保存卡分开计数，延期和预算暂停不能显示为全书完成',()=>{
 const job={workflow:'uno-unit-compile-v3',status:'partial',book_units:[{ref:'one',title:'第一章',chars:200},{ref:'two',title:'第二章',chars:200},{ref:'three',title:'第三章',chars:200}],book_outcomes:{one:{status:'processed',note:'已保存核心解释',card_ids:['saved']},two:{status:'deferred',note:'图表原文待核实',card_ids:[]},'old-stale':{status:'processed',note:'范围外',card_ids:[]}},touched:['saved'],receipts:[{key:'r1',card_ids:['saved','enriched']},{key:'r2',staged:true,card_ids:['draft-only']}]} as unknown as UnoJob;
 expect(bookCompilationProgress(job)).toEqual({processed:1,deferred:1,quarantined:0,remaining:1,total:3});
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}}/>);
 expect(html).toContain('已完成 1 个');expect(html).toContain('延期 1 个');expect(html).toContain('隔离待修复 0 个');expect(html).toContain('未开始 1 个（共 3 个）');expect(html).toContain('不计为全书完成');expect(html).toContain('已保存卡片 · 2');expect(html).not.toContain('draft-only');expect(html).toContain('图表原文待核实');
});

it('持续关系编织显示开放轮次，不把当前工作包误写成总批次',()=>{
 const weaving={mode:'construct',status:'running',batch_index:6,batches:Array.from({length:7},(_,index)=>({id:`wave-${index+1}`})),relation_weaving:{rounds:Array.from({length:6},()=>({}))},detail:'正在执行第 7/7 个建构工作包。'} as unknown as UnoJob;
 expect(unoWorkProgress(weaving)).toEqual({label:'关系编织第 7 轮',detail:'正在处理当前关系编织小组。完成后会重新扫描知识图，再决定是否开始下一轮。'});
 const fixed={...weaving,relation_weaving:undefined};
 expect(unoWorkProgress(fixed)).toEqual({label:'第 7 / 7 组',detail:'正在执行第 7/7 个建构工作包。'});
});

it('编译结算以单一状态层级区分阅读单元、修复项和未归属领域卡片',()=>{
 const units=Array.from({length:20},(_,index)=>({ref:`u${index}`,title:`单元 ${index+1}`,chars:100}));
 const outcomes=Object.fromEntries(units.slice(0,16).map(unit=>[unit.ref,{status:'processed',card_ids:[]}])) as Record<string,{status:string;card_ids:string[]}>;
 outcomes.u16={status:'deferred',card_ids:[]};for(const unit of units.slice(17))outcomes[unit.ref]={status:'quarantined',card_ids:[]};
 const job={workflow:'uno-unit-compile-v3',status:'partial',phase:'done',detail:'本轮执行已结束，整本编译未完成。',book_units:units,book_outcomes:outcomes,isolation_summary:{contract:'compile-isolation-v1',open:17,cards:17,responses:0},receipts:[],failures:[],sources:[]} as unknown as UnoJob;
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}} onOpenUnassigned={()=>{}}/>);
 expect(bookCompilePhaseLabel(job)).toBe('主线执行已结束');expect(bookCompilePhaseLabel({...job,status:'completed'})).toBe('全书编译完成');
 expect(bookSettlementSummary(job)).toMatchObject({headline:'已停止，等待处理',processed:16,total:20,unfinishedUnits:4,repairItems:17});
 expect(html).toContain('16 / 20');expect(html).toContain('剩余 4 个单元，共 17 项待修复');
 expect(html).toContain('<dt>编译修复队列</dt><dd>17 项</dd>');expect(html).toContain('<dt>未归属领域卡片</dt><dd>0 张</dd>');
 expect(html).toContain('<summary>为什么停止</summary>');expect(html).toContain('<summary>进度与记录</summary>');expect(html).not.toContain('<details class="uno-book-settlement__disclosure" open="">');
 expect(html).not.toContain('未组织池：');
});

it('结算标题移除下载来源后缀，并区分整书编译与单项修复',()=>{
 const book={title:'编译 · 当代中国政府与政治【精排】（景跃进）(z-library.sk, 1lib.sk, z-lib.sk).epub',sources:[],receipts:[],failures:[],status:'partial'} as unknown as UnoJob;
 expect(bookPanelTitle(book)).toBe('编译结算 · 当代中国政府与政治【精排】（景跃进）');
 expect(bookPanelTitle({...book,operation:'isolated-card-repair',title:'响应恢复 · 第1节 · 响应待恢复'})).toBe('修复结算 · 第1节 · 响应待恢复');
 expect(bookPanelTitle({...book,operation:'isolated-card-repair',title:'单卡修复 · 单卡修复 · 民主集中制'})).toBe('修复结算 · 民主集中制');
 expect(bookWorkingTitle(book)).toBe('编译 · 当代中国政府与政治【精排】（景跃进）');
 expect(bookWorkingTitle({...book,operation:'isolated-card-repair',title:'单卡修复 · 民主集中制'})).toBe('单卡修复 · 民主集中制');
});

it('编译、建构和队列修复共用单一工作概览层级',()=>{
 const repair={id:'repair-job',mode:'compile',operation:'isolated-card-repair',workflow:'uno-unit-compile-v3',title:'单卡修复 · 民主集中制',status:'running',phase:'read',detail:'第3节：审查卡片',book_units:[{ref:'u',title:'当前卡片',chars:10}],book_outcomes:{},calls:[{phase:'review',status:'running',started_at:'now'}],receipts:[],failures:[],sources:[],batches:[]} as unknown as UnoJob;
 const queue={version:2 as const,libraryId:'library',mode:'recompile' as const,targets:[1,2,3,4].map(index=>({id:`card-${index}`,kind:'repair' as const,revision:'1'})),index:1,currentJobId:'repair-job',currentRequestId:'request',status:'running' as const,results:[{cardId:'card-1',jobId:'done',status:'completed' as const,detail:'完成'}],message:'正在处理 2 / 4：repair-technical-id',startedAt:'now'};
 const repairView=activeJobPresentation(repair,queue);
 expect(repairView).toMatchObject({eyeline:'修复任务进行中',headline:'正在审查卡片',progressLead:'1 / 4',progressTail:'项已完成'});
 expect(repairView.detail).toBe('正在处理第 2 / 4 项；已完成项目不会重跑。');
 const html=renderToStaticMarkup(<ActiveJobOverview job={repair} queue={queue} connected={false}/>);
 expect(html).toContain('正在重新同步进度');expect(html).toContain('<dt>当前阶段</dt><dd>阅读与保存知识</dd>');expect(html).toContain('<summary>当前任务详情</summary>');expect(html).not.toContain('<details class="uno-book-settlement__disclosure uno-work__active-details" open="">');

 const construction={id:'construct',mode:'construct',title:'建构 · 发现知识联系',status:'running',phase:'read',detail:'正在核对当前工作组',batch_index:1,batches:[['a'],['b'],['c']],completed_batches:[{index:0,published:['a'],pending:0}],calls:[],receipts:[],failures:[],sources:[]} as unknown as UnoJob;
 expect(activeJobPresentation(construction)).toMatchObject({eyeline:'建构任务进行中',headline:'检查与修订',progressLead:'2 / 3',progressTail:'当前工作组'});
 expect(activeJobPresentation({...construction,status:'ended'})).toMatchObject({eyeline:'建构任务已关闭',headline:'任务已关闭',progressLead:'1 / 3',progressTail:'个工作组已结算'});
});

it('单卡修复把版本停点解释为可执行方案，不把技术错误当作主提示',()=>{
 const job={id:'repair-paused',mode:'compile',operation:'isolated-card-repair',workflow:'uno-unit-compile-v3',title:'单卡修复 · 当前卡',status:'paused',phase:'read',detail:'新增或改变关系前须读回目标卡当前完整正文：target-card',last_failure:{code:'UNDELIVERED_EVIDENCE',message:'新增或改变关系前须读回目标卡当前完整正文：target-card',category:'unexpected',automatic_recovery:false,retryable:true,at:'now'},resume_plan:{contract:'uno-resume-plan-v1',kind:'resume',reason:'旧提示',primary:{id:'resume',label:'重试当前检查点',effect:'重试'},actions:[],fingerprint:'x'},book_units:[{ref:'u',title:'当前卡',chars:10}],book_outcomes:{},calls:[],receipts:[],failures:[],sources:[],batches:[['u']]} as unknown as UnoJob;
 expect(repairRecoveryGuidance(job)).toMatchObject({headline:'需要更新依据后继续',primaryLabel:'读取最新目标卡并继续',closeLabel:'保留待办并关闭'});
 const html=renderToStaticMarkup(<ActiveJobOverview job={job}/>);
 expect(html).toContain('建议下一步');expect(html).toContain('只有通过复核才会保存');
 const main=html.split('<summary>当前任务详情</summary>')[0];expect(main).not.toContain('target-card');expect(main).not.toContain('须读回');
});

it('结束结算折叠大量明细并合并重复的原件提醒',()=>{
 const job={workflow:'uno-unit-compile-v3',status:'ended',phase:'ended',detail:'很长的内部结算文本',book_units:[{ref:'u',title:'单元',chars:10}],book_outcomes:{u:{status:'processed',card_ids:['a']}},touched:['a'],receipts:[],failures:[],sources:[{source:'book',warnings:['相同提醒','相同提醒'],units:[]}]} as unknown as UnoJob;
 const view=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}}/>);
 expect(view).toContain('阅读单元与处理记录 · 1 个');expect(view).toContain('已保存卡片 · 1');expect(view).not.toContain('<details open=""><summary>已保存卡片');
 expect(bookStatusDetail(job)).toBe('任务已关闭。已保存成果和待修复项均保留。');expect(bookStatusDetail(job)).not.toContain('很长的内部结算文本');
 expect(uniqueSourceWarnings(job)).toEqual([{source:'book',warning:'相同提醒'}]);
});

it('停点决策使用独立 resolve 接口并绑定任务版本',async()=>{
 const fetcher=vi.fn(async(url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify(String(url)==='/api/security/session'?{token:'local'}:{id:'j',status:'running'})));vi.stubGlobal('fetch',fetcher);
 await resolveUnoJob({id:'j',version:7} as UnoJob,'defer-unit');
 expect(fetcher.mock.calls[1][0]).toBe('/api/uno/jobs/j/resolve');expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({version:7,decision:'defer-unit'});
});

it('未通过候选可显式保留到未组织池',async()=>{
 const fetcher=vi.fn(async(url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify(String(url)==='/api/security/session'?{token:'local'}:{id:'j',status:'running'})));vi.stubGlobal('fetch',fetcher);
 await resolveUnoJob({id:'j',version:9} as UnoJob,'quarantine-candidates');
 expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({version:9,decision:'quarantine-candidates'});
});

it('阅读进度显示本次任务冻结的领域批准方式',()=>{
 const automatic=renderToStaticMarkup(<BookCompilationView job={{status:'running',receipts:[],domain_approval_mode:'automatic'} as unknown as UnoJob} onOpenCard={()=>{}}/>);
 const manual=renderToStaticMarkup(<BookCompilationView job={{status:'running',receipts:[],domain_approval_mode:'manual'} as unknown as UnoJob} onOpenCard={()=>{}}/>);
 expect(automatic).toContain('本任务允许自动建设领域');expect(manual).toContain('新领域需逐项确认');
});

it('编译响应恢复状态区分零调用恢复、局部恢复和熔断',()=>{
 const base={status:'paused',receipts:[],book_units:[],domain_approval_mode:'manual'} as unknown as UnoJob;
 const deterministic=renderToStaticMarkup(<BookCompilationView job={{...base,last_recovery:{contract:'compile-response-recovery-v1',status:'recovered',phase:'check',method:'deterministic',changes:['required-empty-unit-issues'],unit_ref:'u',at:'now',model_calls:0}}} onOpenCard={()=>{}}/>);
 const model=renderToStaticMarkup(<BookCompilationView job={{...base,last_recovery:{contract:'compile-response-recovery-v1',status:'recovered',phase:'check',method:'model',changes:['schema-only-repair'],unit_ref:'u',at:'now',model_calls:1}}} onOpenCard={()=>{}}/>);
 const failed=renderToStaticMarkup(<BookCompilationView job={{...base,last_recovery:{contract:'compile-response-recovery-v1',status:'failed',phase:'check',method:'model',changes:[],unit_ref:'u',at:'now',model_calls:1}}} onOpenCard={()=>{}}/>);
  expect(deterministic).toContain('未增加模型请求');expect(model).toContain('只发送失败响应与局部契约');expect(failed).toContain('停止循环重试');
});

it('新请求正在执行时明确显示继续状态并隐藏更早的恢复失败',()=>{
 const job={status:'running',phase:'read',detail:'第3节：生成卡片',receipts:[],book_units:[],domain_approval_mode:'automatic',
  last_recovery:{contract:'compile-response-recovery-v1',status:'failed',phase:'check',method:'model',changes:[],unit_ref:'u2',at:'2026-09-19T14:37:43.345Z',model_calls:1},
  calls:[{phase:'response-recovery',status:'completed',started_at:'2026-09-19T14:37:00.000Z'},{phase:'unit-generate',status:'running',started_at:'2026-09-19T14:40:31.937Z'}]} as unknown as UnoJob;
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}}/>);
 expect(bookActiveStatus(job)?.message).toContain('模型请求已发送，正在等待返回');
 expect(html).toContain('任务仍在继续：第3节：生成卡片');
 expect(html).not.toContain('停止循环重试');
 expect(renderToStaticMarkup(<BookCompilationView job={{...job,status:'paused'} as UnoJob} onOpenCard={()=>{}}/>)).toContain('停止循环重试');
});

it('当前空正文失败覆盖更早的恢复提示，并说明继续只重试当前单元',()=>{
 const job={status:'paused',phase:'read',receipts:[],book_units:[{ref:'done',title:'已完成',chars:10},{ref:'current',title:'当前单元',chars:10}],book_outcomes:{done:{status:'processed',card_ids:[]}},domain_approval_mode:'automatic',
  last_recovery:{contract:'routine-review-governance-v1',status:'recovered',phase:'check',method:'deterministic',changes:['discarded-domain-fit-issues'],unit_ref:'done',at:'2026-09-18T14:42:52.000Z',model_calls:0},
  last_failure:{code:'MODEL_EMPTY_RESPONSE',message:'模型本次没有返回可解析正文',category:'response_contract',automatic_recovery:false,retryable:true,at:'2026-09-18T14:53:55.000Z'}} as unknown as UnoJob;
 const html=renderToStaticMarkup(<BookCompilationView job={job} onOpenCard={()=>{}}/>);
 expect(html).toContain('已处理的 1 个单元保持不变');expect(html).toContain('继续后只重试当前待处理单元');expect(html).not.toContain('已恢复上一条模型响应');
});

it('恢复计划把明确决策与不可恢复状态从普通继续中分开',()=>{
 const base={status:'paused',phase:'read',receipts:[],book_units:[{ref:'u',title:'单元',chars:10}],book_outcomes:{}} as unknown as UnoJob;
 expect(bookCanContinue({...base,resume_plan:{contract:'uno-resume-plan-v1',kind:'decision',reason:'需要选择',actions:[],fingerprint:'a'}})).toBe(true);
 expect(bookCanContinue({...base,resume_plan:{contract:'uno-resume-plan-v1',kind:'blocked',reason:'不能继续',actions:[],fingerprint:'b'}})).toBe(false);
});

it('尚未建立阅读单元时不宣称空集合已经完成',()=>{
 const html=renderToStaticMarkup(<BookCompilationView job={{status:'running',receipts:[]} as unknown as UnoJob} onOpenCard={()=>{}}/>);
 expect(html).toContain('正在整理全书结构');expect(html).toContain('目前尚无已保存卡片');expect(html).not.toContain('全书已完成');
});

it('历史编译仅展示记录与正式成果，移除筛选恢复、审核和执行按钮',()=>{
 const job={mode:'compile',workflow:'uno-compile-v3',status:'running',detail:'旧批次尚有未处理材料',calls:[],receipts:[{key:'saved',card_ids:['a'],staged:false},{key:'draft',card_ids:['draft'],staged:true}],failures:[],selection_workflow:'agent-selection-v1',selection:{ref:{status:'exclude'}},pending:{cards:[{id:'draft'}]}} as unknown as UnoJob;
 const html=renderToStaticMarkup(<HistoricalKnowledgeView job={job} onOpenCard={()=>{}}/>);
 expect(html).toContain('历史记录 · 只读');expect(html).toContain('不表示任务仍在执行');expect(html).toContain('查看卡片 · a');
 for(const removed of ['恢复为待处理','保存本批并继续','从未完成处继续','重新生成本批','材料去向','查看卡片 · draft'])expect(html).not.toContain(removed);
});
it('服务器标注的旧建构只读任务也无法重放修改请求',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 for(const action of ['resume','retry','review','stop-after-batch'] as const)await expect(updateUnoJob({id:'old-construct',mode:'construct',readonly:true} as UnoJob,action)).rejects.toThrow('仅供查看');
 expect(fetcher).not.toHaveBeenCalled();
});
