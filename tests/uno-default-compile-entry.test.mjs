import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import {quarantineUnit} from '../packages/nexogenesis-tools/lib/uno/compile-isolation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renameSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {startUnoJob,handleUnoApi,hasUnoJobRunning,DEFAULT_COMPILE_PROFILE} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { COMPILE_HEALTH } from '../packages/nexogenesis-web-host/lib/book-compile.js';
import {compileCommand} from '../packages/nexogenesis-web-host/lib/chat.js';
import {readCompileJob,saveCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {getProviderBudget} from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import {sha} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {parseCompileCommand} from '../packages/nexogenesis-tools/lib/compile-options.js';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { workSnapshot } from '../packages/nexogenesis-web-host/lib/work.js';
import {buildEvidencePack,confirmEvidencePackDelivery} from '../packages/nexogenesis-tools/lib/uno/evidence-pack.js';

const rawHash=input=>sha(JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key])=>key!=='request_id').sort(([a],[b])=>a.localeCompare(b)))));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'uno-default-entry-')),oldHome=process.env.DSH_HOME,oldFetch=globalThis.fetch;
  process.env.DSH_HOME=root;mkdirSync(join(root,'00-Inbox'));writeFileSync(join(root,'00-Inbox/book.md'),'# 第一章\n本章只有合成材料。\n\n# 第二章\n另一章的合成材料。');
  const sessions=new Map(),listeners=new Map(),requests=[],prompts=[];let settings={provider:'deepseek',model:'deepseek-v4-flash',thinking_mode:'disabled'};
  const ctx={webServer:{port:9995},settings:{get:()=>settings},get(name){return name==='sessions'?{get:id=>sessions.get(id),flush:async()=>{}}:undefined;},
    on(name,fn){const group=listeners.get(name)??new Set();listeners.set(name,group);group.add(fn);return()=>group.delete(fn);}};
  const emit=(id,type,data)=>{if(type==='turn/end')sessions.get(id).running=false;for(const fn of [...listeners.get('session/event')??[]])fn({id},{type,data});};
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).hostname,'127.0.0.1','Only simulated local native RPC is allowed');const call=JSON.parse(init.body);requests.push(call);let value={};
    if(call.method==='session.list')value={items:[...sessions.values()]};
    else if(call.method==='session.create'){const id='entry-'+(sessions.size+1);sessions.set(id,{id,sessionId:id,running:false,header:{cwd:root},events:[],append(type,data){this.events.push({type,data,time:Date.now()});}});value={sessionId:id};}
    else if(call.method==='session.prompt'){sessions.get(call.payload.sessionId).running=true;prompts.push(call.payload);setImmediate(()=>emit(call.payload.sessionId,'turn/end',{reason:{kind:'completed'}}));}
    else if(call.method==='session.history')value={events:sessions.get(call.payload.sessionId)?.events??[]};
    else if(call.method==='session.cancel')setImmediate(()=>emit(call.payload.sessionId,'turn/end',{reason:{kind:'cancelled'}}));
    return {json:async()=>({type:'server-response',result:{ok:true,value}})};
  };
  async function idle(){for(let i=0;i<600&&hasUnoJobRunning(root);i++)await pause(5);assert.equal(hasUnoJobRunning(root),false);}
  async function api(path,body={},method='POST'){
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno'+path,method,headers:{'content-type':'application/json'}});
    const res=Object.assign(new EventEmitter(),{data:'',writeHead(status){this.status=status;},write(text){this.data+=text;},end(text=''){this.data+=text;}});
    await handleUnoApi(ctx,req,res,root);return {status:res.status,data:JSON.parse(res.data)};
  }
  function historical(input={}){
    const id=input.request_id??randomUUID(),sessionId='legacy-'+id;sessions.set(sessionId,{id:sessionId,sessionId,running:false,header:{cwd:root},events:[],append(){}});
    const job={id,mode:'compile',workflow:'uno-compile-v3',title:'历史编译',status:'paused',phase:'select',role:'author',selection_workflow:'agent-selection-v1',selection:{},selected_sources:['00-Inbox/book.md'],
      owner_session_id:sessionId,session_id:sessionId,sessions:[sessionId],batch_index:0,batches:[],sources:[],archives:[],receipts:[],calls:[],failures:[],touched:[],issues:[],outcomes:{},reviewed:{},
      notes:'原有历史要求',budget:{calls:20},requirements:{notes:'原有历史要求',preferences:{delivery:'auto',budget_calls:20,external_images:false}},model_selection:{provider:'foreign-legacy',model:'frozen-native'},continuous:false,
      created_at:new Date().toISOString(),...(input.request_id?{start_request_hash:rawHash(input)}:{})};
    saveCompileJob(root,job);return job;
  }
  const jobs=()=>existsSync(join(root,'.nexogenesis/uno-jobs'))?readdirSync(join(root,'.nexogenesis/uno-jobs')).filter(name=>name.endsWith('.json')):[];
  t.after(async()=>{await idle();globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(root,{recursive:true,force:true});});
  return {root,ctx,api,idle,historical,jobs,requests,prompts,setSettings:value=>{settings=value;}};
}


test('new compile requires the book profile and rejects stale creation without task or session effects',async t=>{
  const f=fixture(t);
  for(const input of [{mode:'compile',sources:['00-Inbox/book.md']},{mode:'compile',sources:['00-Inbox/book.md'],orchestration_profile:'bounded-workflow-v1'}])
    await assert.rejects(f.api('/jobs',input),{status:409});
  assert.equal(f.jobs().length,0);assert.equal(f.requests.length,0);
});

test('book compile creates one full-book task with the actual request budget and chapter units',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',domain_approval_mode:'automatic',sources:['00-Inbox/book.md'],material_kind:'book',budget_calls:4};
  const {data:created}=await f.api('/jobs',input);await f.idle();const job=readCompileJob(f.root,created.id);
  assert.equal(DEFAULT_COMPILE_PROFILE,'unit-cards-v3');assert.equal(job.compile_profile,DEFAULT_COMPILE_PROFILE);assert.equal(job.workflow,'uno-unit-compile-v3');assert.equal(job.card_classification,'ordered-single-type-and-domains-v2');
  assert.equal(job.orchestration_profile,'bounded-workflow-v1');assert.equal(job.continuous,true);
  assert.equal(job.domain_approval_mode,'automatic');
  assert.equal(job.compile_quality_mode,'standard');
  assert.deepEqual(job.model_selection,{provider:'nexo-deepseek',model:'deepseek-v4-flash'});
  assert.deepEqual(job.workflow_reasoning,{generate:'low',supplement:'low',repair:'low',check:'off',verify:'off'});
  assert.equal(getProviderBudget(f.root,job.id).limit,4);assert.equal(getProviderBudget(f.root,job.id).used,0,'No actual model response was simulated');
  assert.equal(job.book_units.length,2);assert.equal(f.prompts.length,0);assert.equal(job.selection_workflow,undefined);
});

test('resuming a retryable paused book clears the stale stop error before relaunching',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],material_kind:'book',budget_calls:4};
  const {data:created}=await f.api('/jobs',input);await f.idle();const paused=readCompileJob(f.root,created.id);
  paused.status='paused';paused.error_code='UNIT_COMPILE_STOPPED';paused.last_failure={code:'UNIT_COMPILE_STOPPED',message:'模型连接暂时中断。',retryable:true};saveCompileJob(f.root,paused);
  const {data:resumed}=await f.api('/jobs/'+paused.id+'/resume',{version:paused.version});
  assert.equal(resumed.status,'running');assert.equal(resumed.error_code,undefined);await f.idle();
});

test('slash compile enters the same book workflow rather than the historical selector',async t=>{
  const f=fixture(t),result=await compileCommand(f.ctx,f.root,parseCompileCommand('/compile 保留各章条件'),{sources:['00-Inbox/book.md'],material_kind:'book',budget_calls:4});
  await f.idle();assert.equal(result.action,'compile_started');const job=readCompileJob(f.root,result.job.id);
  assert.equal(job.compile_profile,DEFAULT_COMPILE_PROFILE);assert.equal(job.workflow,'uno-unit-compile-v3');assert.equal(job.budget.calls,4);assert.match(job.notes,/保留各章条件/);assert.equal(job.book_units.length,2);
});

test('historical Buffer materials are not accepted as a new book and archived originals remain unchanged',async t=>{
  const f=fixture(t),source='00-Inbox/archived-book.pdf',bytes=Buffer.from('%PDF synthetic fixture; parser output supplied explicitly');writeFileSync(join(f.root,source),bytes);
  const receipt=prepareSourceFixture(f.root,{source,prepared:{fingerprint:sha(bytes),format:'pdf',material_kind:'book',classification_reason:'合成两章书',assets:[],warnings:[],chapters:[{title:'第一章',locator:'第1章',text:'第一章的合成论点。'},{title:'第二章',locator:'第2章',text:'只选择本章的具体条件，并保留可回查的原文。'}]}});
  mkdirSync(join(f.root,'03-Archive'),{recursive:true});const archive='03-Archive/archived-book.pdf';renameSync(join(f.root,source),join(f.root,archive));receipt.source=archive;
  assert.equal(existsSync(join(f.root,source)),false);const archived=readFileSync(join(f.root,receipt.source)),chosen=receipt.units[1].ref;
  const old=f.historical();old.selected_sources=[chosen];saveCompileJob(f.root,old);const before=readFileSync(join(f.root,'.nexogenesis/uno-jobs',old.id+'.json'),'utf8');
  await assert.rejects(f.api('/jobs',{mode:'compile',compile_profile:'unit-cards-v3',sources:[chosen],budget_calls:4}),/有效的待编译材料/);
  assert.equal(f.jobs().length,1);assert.equal(f.prompts.length,0);assert.equal(f.requests.filter(r=>r.method==='session.create').length,0);
  assert.equal(existsSync(join(f.root,source)),false);assert.deepEqual(readFileSync(join(f.root,receipt.source)),archived);assert.equal(readFileSync(join(f.root,'.nexogenesis/uno-jobs',old.id+'.json'),'utf8'),before);
});

test('new book compile rejects unknown or incomplete model selections before creating task, budget or native session',async t=>{
  const f=fixture(t);for(const settings of [{provider:'unmetered-native',model:'x'},{provider:'custom',model:''}]){
    f.setSettings(settings);const id=randomUUID();await assert.rejects(f.api('/jobs',{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],request_id:id}),/不支持|未接入请求预算/);
    assert.equal(f.jobs().length,0);assert.equal(f.requests.length,0);assert.equal(existsSync(join(f.root,'.nexogenesis/provider-request-budgets',id+'.json')),false);
  }
});

test('historical compile mutating execution endpoints reject while GET preserves its original record',async t=>{
  const f=fixture(t),legacy=f.historical(),path=join(f.root,'.nexogenesis/uno-jobs',legacy.id+'.json'),before=readFileSync(path,'utf8');
  for(const action of ['resume','retry','review','stop-after-batch'])await assert.rejects(f.api('/jobs/'+legacy.id+'/'+action,{version:legacy.version}),/历史记录/);
  await assert.rejects(f.api('/jobs/'+legacy.id+'/reconsider',{version:legacy.version}),error=>error.status===404);
  const read=await f.api('/jobs/'+legacy.id,{},'GET');assert.equal(read.data.id,legacy.id);assert.equal(read.data.status,'paused');
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.requests.length,0);
});

test('same new-book request only retrieves one task, preserves raw input hash and never relaunches',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],request_id:randomUUID(),budget_calls:4};
  const first=await startUnoJob(f.ctx,f.root,input);await f.idle();const path=join(f.root,'.nexogenesis/uno-jobs',first.id+'.json'),before=readFileSync(path,'utf8'),calls=f.requests.length;
  f.setSettings({provider:'unmetered-native',model:'x'});const retry=await startUnoJob(f.ctx,f.root,JSON.parse(JSON.stringify(input)));
  assert.equal(retry.id,first.id);assert.equal(retry.start_request_hash,rawHash(input));assert.equal(retry.compile_profile,DEFAULT_COMPILE_PROFILE);assert.equal(f.requests.length,calls);assert.equal(f.jobs().length,1);assert.equal(readFileSync(path,'utf8'),before);
  await assert.rejects(startUnoJob(f.ctx,f.root,{...input,notes:'改变原要求'}),/同一开始请求不能更改/);
});

test('a concurrent pending start is rejected temporarily and the same request later retrieves the single created task',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],request_id:randomUUID(),budget_calls:4};
  const creating=startUnoJob(f.ctx,f.root,input);await assert.rejects(startUnoJob(f.ctx,f.root,{...input}),/另一个任务正在创建/);
  const first=await creating;await f.idle();const promptCount=f.prompts.length;
  const retry=await startUnoJob(f.ctx,f.root,{...input});assert.equal(retry.id,first.id);assert.equal(f.jobs().length,1);assert.equal(f.requests.filter(call=>call.method==='session.create').length,1);assert.equal(f.prompts.length,promptCount);
});

test('preparation advertises book profile, review-publish-repair and model availability without starting a task',async t=>{
  const f=fixture(t),available=(await f.api('/prepare',{},'GET')).data;
  assert.equal(available.compile_profile,COMPILE_HEALTH.compile_profile);
  assert.equal(available.compile_version,COMPILE_HEALTH.compile_version);
  assert.equal(available.card_classification,'ordered-single-type-and-domains-v2');
  assert.deepEqual(available.types.map(row=>row.id),['conflict','entity','case','concept','method','mechanism','model','claim','phenomenon','undetermined']);
  assert.equal(available.compile_review_policy,COMPILE_HEALTH.compile_review_policy);
  assert.equal(available.compile_card_refinement,'refine-each-card-v1');assert.deepEqual(available.compile_quality_modes,['standard','refine-each-card-v1']);
  assert.deepEqual(available.domain_approval_modes,['manual','automatic']);assert.equal(COMPILE_HEALTH.uno_domain_auto_approval,1);
  assert.equal(COMPILE_HEALTH.uno_unassigned_card_management,1);assert.equal(COMPILE_HEALTH.uno_manual_seed_domain,1);
  assert.equal(available.compile_profile,DEFAULT_COMPILE_PROFILE);assert.equal(available.compile_model.available,true);
  assert.deepEqual(available.types.map(item=>item.id),['conflict','entity','case','concept','method','mechanism','model','claim','phenomenon','undetermined']);
  f.setSettings({provider:'unmetered-native',model:'x'});const unavailable=(await f.api('/prepare',{},'GET')).data;assert.equal(unavailable.compile_model.available,false);assert.equal(f.jobs().length,0);assert.equal(f.requests.length,0);
});

test('legacy semantic stop exposes decisions, rejects generic resume and applies defer through the dedicated endpoint',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],material_kind:'book',budget_calls:4};
  const {data:created}=await f.api('/jobs',input);await f.idle();const job=readCompileJob(f.root,created.id),ref=job.book_units[0].ref;
  delete job.compile_isolation;
  job.status='paused';job.phase='read';job.book_focus_refs=[ref];delete job.book_outcomes[ref];job.error_code='UNIT_CARD_REPAIR_EXHAUSTED';
  job.last_failure={code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'已保存 0 张卡片；1 张问题卡尚未通过。',category:'knowledge_review',automatic_recovery:false,retryable:false,at:new Date().toISOString()};
  job.unit_work[ref]={source_revision:job.book_units[0].revision,references:[],cards:[{id:'blocked',title:'章首框架',type:'claim',domains:[],sources:[{ref}],relations:[],body:'待审核'}],phase:'check',published:{},reused:{},pending_issues:{blocked:['没有形成独立知识对象']},checks:{},repairs:{blocked:2},repair_counts:{blocked:{card:2}}};saveCompileJob(f.root,job);
  const visible=(await f.api('/jobs/'+job.id,{},'GET')).data;
  assert.equal(visible.resume_available,false);assert.equal(visible.resume_plan.kind,'decision');assert.deepEqual(visible.resume_plan.actions.map(row=>row.id),['discard-candidates','defer-unit']);
  const budget=getProviderBudget(f.root,job.id);await assert.rejects(f.api('/jobs/'+job.id+'/resume',{version:job.version}),/修订上限/);assert.deepEqual(getProviderBudget(f.root,job.id),budget);
  const resolved=(await f.api('/jobs/'+job.id+'/resolve',{version:job.version,decision:'defer-unit'})).data;assert.equal(resolved.status,'running');await f.idle();
  const after=readCompileJob(f.root,job.id);assert.equal(after.book_outcomes[ref].status,'deferred');assert.equal(after.last_resolution.decision,'defer-unit');
});

test('isolated repair API binds library and revision, preserves originals, and deduplicates an explicit repair request',async t=>{
 const f=fixture(t),{data:created}=await f.api('/jobs',{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],budget_calls:4});
 await f.idle();const parent=readCompileJob(f.root,created.id),ref=parent.book_units[0].ref;
 parent.status='partial';parent.phase='done';parent.unit_work[ref]={source_revision:parent.book_units[0].revision,references:[],cards:[{id:'pending',title:'候选',body:'待细化的候选正文',type:'claim',domains:[],sources:[{ref}],relations:[]}],checks:{},repairs:{},pending_issues:{pending:['补充具体条件']}};
 quarantineUnit(parent,ref,{code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'待专门修复'});saveCompileJob(f.root,parent);
 const {data:pool}=await f.api('/unassigned',{},'GET'),item=pool.items.find(row=>row.kind==='repair');assert.ok(item);assert.equal(item.body,undefined);
 const {data:detail}=await f.api('/repairs/'+item.id,{},'GET');assert.match(detail.body,/候选正文/);
 const body={library_id:pool.library.id,expected_revision:item.revision,request_id:randomUUID(),notes:'仅补充条件'};
 const before=f.jobs().length;
 await assert.rejects(f.api('/repairs/'+item.id,{...body,library_id:'wrong'}),/知识库已切换/);
 await assert.rejects(f.api('/repairs/'+item.id,{...body,expected_revision:'stale'}),/内容已变化/);assert.equal(f.jobs().length,before);
 const {status,data:repair}=await f.api('/repairs/'+item.id,body);assert.equal(status,202);await f.idle();
 assert.equal(repair.operation,'isolated-card-repair');assert.equal(repair.repair_origin.parent_job_id,parent.id);assert.equal(repair.budget.calls,12);
 const repeated=await f.api('/repairs/'+item.id,body);assert.equal(repeated.data.id,repair.id);assert.equal(f.jobs().length,before+1);
 assert.equal(existsSync(join(f.root,'01-Cards/pending.md')),false);assert.equal(readCompileJob(f.root,parent.id).unit_work[ref].isolation.items['card-pending'].active_repair_job,repair.id);
});

test('a settled book with extraction gaps cannot resume or change its budget, task or native session',async t=>{
  const f=fixture(t);
  const {data:created}=await f.api('/jobs',{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],budget_calls:4});
  await f.idle();const job=readCompileJob(f.root,created.id);
  job.status='partial';job.phase='done';job.sources[0].incomplete=true;
  job.detail='本轮编译已结束。已处理 1/1 个可读原文单元。';
  job.book_outcomes=Object.fromEntries(job.book_units.map(unit=>[unit.ref,{status:'processed',card_ids:[]}]));
  job.last_failure={code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'历史错误'};job.error_code='UNIT_CARD_REPAIR_EXHAUSTED';
  saveCompileJob(f.root,job);
  const before=readFileSync(join(f.root,'.nexogenesis/uno-jobs',job.id+'.json'),'utf8'),budget=getProviderBudget(f.root,job.id),rpcCount=f.requests.length;
  const {data:visible}=await f.api('/jobs/'+job.id,{},'GET');
  assert.equal(visible.status,'partial');assert.equal(visible.resume_available,false);assert.match(visible.resume_blocked_reason,/补充可读材料/);
  assert.match(visible.detail,/本轮执行已结束，整本编译未完成/);assert.equal(visible.last_failure,undefined);assert.equal(visible.error_code,undefined);
  const work=(await workSnapshot(f.ctx,f.root)).items.find(item=>item.uno_job_id===job.id);
  assert.equal(work.can_continue,false);assert.equal(work.phase,'closed');assert.equal(work.task_status,'partial');
  const afterSnapshotRpc=f.requests.length;
  for(const action of ['resume','retry'])await assert.rejects(f.api('/jobs/'+job.id+'/'+action,{version:job.version,budget_calls:120}),/直接继续不会补出缺失正文/);
  assert.equal(readFileSync(join(f.root,'.nexogenesis/uno-jobs',job.id+'.json'),'utf8'),before);
  assert.deepEqual(getProviderBudget(f.root,job.id),budget);assert.equal(f.requests.length,afterSnapshotRpc);assert.ok(afterSnapshotRpc>=rpcCount);assert.equal(hasUnoJobRunning(f.root),false);
});

test('an ended fully processed book exposes explicit archive review and removes only the matching Inbox copy',async t=>{
  const f=fixture(t),source='00-Inbox/cover-gap.epub',bytes=Buffer.from('synthetic epub bytes');writeFileSync(join(f.root,source),bytes);
  const info=new HarnessGateway(f.root).prepareBookSource({source,prepared:{fingerprint:sha(bytes),format:'epub',title:'封面缺口图书',material_kind:'book',incomplete:true,
    warnings:['EPUB spine 1 (titlepage) 未能提取：无可提取正文'],assets:[],chapters:[{title:'正文',locator:'EPUB spine 2',text:'已经完整处理的正文。'}]}});
  const id=randomUUID(),job={id,mode:'compile',workflow:'uno-unit-compile-v3',compile_profile:'unit-cards-v3',status:'ended',phase:'ended',end_requested:true,
    title:'编译',session_id:'archive-review-session',sessions:['archive-review-session'],sources:[{...info,original_source:source}],selected_sources:[source],book_units:info.units,
    book_outcomes:Object.fromEntries(info.units.map(unit=>[unit.ref,{status:'processed',revision:unit.revision,delivered_chars:unit.chars,card_ids:[]}])) ,archives:[],receipts:[],calls:[],failures:[],touched:[],book_receipt_issues:[]};
  saveCompileJob(f.root,job);const saved=readCompileJob(f.root,id),visible=(await f.api('/jobs/'+id,{},'GET')).data;
  assert.equal(visible.archive_review.contract,'book-archive-review-v1');assert.deepEqual(visible.archive_review.sources.map(row=>row.source),[source]);
  const reviewed=(await f.api('/jobs/'+id+'/archive-review',{version:saved.version,source,note:'已核对该缺口只有封面页。'})).data;
  assert.equal(existsSync(join(f.root,source)),false);assert.equal(reviewed.status,'ended');assert.equal(reviewed.archives[0].inbox_removed,true);
  assert.match(reviewed.detail,/已复核原文提取警告并完成归档/);assert.equal(reviewed.archive_review,undefined);
  writeFileSync(join(f.root,source),bytes);
  const preparation=(await f.api('/prepare',{},'GET')).data;
  assert.ok(!preparation.sources.some(row=>'00-Inbox/'+row.path===source));
  assert.deepEqual(preparation.archived_sources.map(row=>row.path),['cover-gap.epub']);
});

test('domain approval and compile quality default safely and reject unknown modes before creating a task',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],budget_calls:4};
  const created=await startUnoJob(f.ctx,f.root,input);await f.idle();assert.equal(created.domain_approval_mode,'manual');assert.equal(created.compile_quality_mode,'standard');
  const before=f.jobs().length,requests=f.requests.length;
  await assert.rejects(f.api('/jobs',{...input,request_id:randomUUID(),domain_approval_mode:'unreviewed'}),/领域建设授权方式无效/);
  await assert.rejects(f.api('/jobs',{...input,request_id:randomUUID(),compile_quality_mode:'maximum'}),/编译质量模式无效/);
  assert.equal(f.jobs().length,before);assert.equal(f.requests.length,requests);
});

test('an existing legacy start request can only retrieve its saved task, without migration or new model preflight',async t=>{
  const f=fixture(t),input={mode:'compile',sources:['00-Inbox/book.md'],request_id:randomUUID(),notes:'旧浏览器尚未确认的要求'},legacy=f.historical(input);
  const path=join(f.root,'.nexogenesis/uno-jobs',legacy.id+'.json'),before=readFileSync(path,'utf8');f.setSettings({provider:'unmetered-native',model:'x'});
  const retry=await startUnoJob(f.ctx,f.root,input);assert.equal(retry.orchestration_profile,undefined);assert.equal(retry.status,'paused');assert.equal(retry.id,legacy.id);assert.equal(f.requests.length,0);assert.equal(f.jobs().length,1);assert.equal(readFileSync(path,'utf8'),before);
  await assert.rejects(f.api('/jobs/'+legacy.id+'/resume',{version:legacy.version}),/历史记录/);
});

test('new compilation freezes review-publish-repair and exact replay cannot change its requested policy',async t=>{
  const f=fixture(t),input={mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],request_id:randomUUID(),budget_calls:4};
  const created=await startUnoJob(f.ctx,f.root,input);await f.idle();assert.equal(created.review_policy,'review-publish-repair-v2');assert.equal(input.review_policy,undefined);
  const retry=await startUnoJob(f.ctx,f.root,input);assert.equal(retry.id,created.id);assert.equal(retry.review_policy,'review-publish-repair-v2');
  await assert.rejects(startUnoJob(f.ctx,f.root,{...input,review_policy:'review-publish-repair-v2'}),/同一开始请求不能更改/);
  const prepare=(await f.api('/prepare',{},'GET')).data;assert.deepEqual(prepare.compile_review_policies,['review-publish-repair-v2']);
});

test('old or unknown review policies and construction misuse fail before creating sessions or tasks',async t=>{
  const f=fixture(t);
  for(const input of [{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],review_policy:'harness-first-v1'},{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/book.md'],review_policy:'unchecked'},{mode:'construct',notes:'整理',review_policy:'harness-first-v1'}])await assert.rejects(f.api('/jobs',input),/审核策略/);
  assert.equal(f.jobs().length,0);assert.equal(f.requests.length,0);
});
