import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MODEL_PROVIDERS } from '../packages/nexogenesis-tools/lib/model-providers.js';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { sha } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { readCompileJob, saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { initializeProviderBudget, getProviderBudget, raiseProviderBudget, reserveProviderRequest, bindProviderBudgetSession } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import { assertBoundedModel, bindWorkflowBudget, nextPackageMinimum } from '../packages/nexogenesis-web-host/lib/uno-orchestration.js';
import { executeConstruction } from '../packages/nexogenesis-web-host/lib/construction-host.js';
import { startUnoJob, handleUnoApi, hasUnoJobRunning } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';

const profile='bounded-workflow-v1';
function fixture(t,{limit=20,used=0,changes={},onPrompt}={}) {
  const root=mkdtempSync(join(tmpdir(),'uno-bounded-host-')),previousFetch=globalThis.fetch,oldHome=process.env.DSH_HOME;
  process.env.DSH_HOME=root;
  t.after(()=>{globalThis.fetch=previousFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'00-Inbox'));const body='作者提出一个局部观察，其结论不能外推。';writeFileSync(join(root,'00-Inbox/a.md'),body);
  const gateway=new HarnessGateway(root),material=prepareSourceFixture(root,{source:'00-Inbox/a.md',prepared:{fingerprint:sha(body),material_kind:'article',classification_reason:'合成测试',chapters:[{title:'样例',locator:'全文',text:body}],assets:[],warnings:[],format:'md'}}),ref=material.units[0].ref;
  const job={id:'bounded-host',title:'测试',workflow:'uno-compile-v3',orchestration_profile:profile,mode:'construct',phase:'read',role:'author',status:'paused',
    session_id:'author',owner_session_id:'owner',sessions:['author'],model_selection:{provider:'nexo-custom',model:'synthetic'},
    batches:[[ref]],batch_index:0,selected_sources:[],preparation_cursor:0,sources:[material],failures:[],completed_batches:[],continuous:true,
    calls:[],budget:{calls:limit},touched:[],receipts:[],outcomes:{},issues:[],reviewed:{},requirements:{preferences:{delivery:'auto'}},...changes};
  saveCompileJob(root,job);initializeProviderBudget(root,job.id,{limit,alreadyUsed:used,provenance:used?'synthetic fixture':null});
  const listeners=new Set(),requests=[],prompts=[];
  const ctx={webServer:{port:9999},settings:{get:()=>({provider:'custom',model:'synthetic'})},on(name,fn){if(name==='session/event')listeners.add(fn);return ()=>listeners.delete(fn);}};
  const emit=(sessionId,reason)=>{for(const fn of [...listeners])fn({id:sessionId},{type:'turn/end',data:{reason}});};
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).hostname,'127.0.0.1','only local RPC stubs are allowed');
    const request=JSON.parse(init.body);requests.push(request);let value={};
    if(request.method==='session.list')value={items:[]};
    if(request.method==='session.create')value={sessionId:'context-'+requests.length};
    if(request.method==='session.prompt')setImmediate(()=>{const current=readCompileJob(root,job.id);prompts.push(current);emit(request.payload.sessionId,onPrompt?.(current)??{kind:'completed'});});
    return {json:async()=>({type:'server-response',result:{ok:true,value}})};
  };
  const run=async()=>{await executeConstruction(ctx,root,job,new AbortController());return readCompileJob(root,job.id);};
  const action=async(type,body={})=>{
    const current=readCompileJob(root,job.id),req=Readable.from([Buffer.from(JSON.stringify({version:current.version,...body}))]);
    req.url=`/api/uno/jobs/${job.id}/${type}`;req.method='POST';req.headers={'content-type':'application/json'};
    await handleUnoApi(ctx,req,{writeHead(){},end(){}},root);
    for(let n=0;hasUnoJobRunning(root)&&n<200;n++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(hasUnoJobRunning(root),false,'synthetic execution must stop');return readCompileJob(root,job.id);
  };
  return {root,job,ref,gateway,ctx,requests,prompts,run,action};
}

test('bounded model allowlist matches current budgeted routes and leaves legacy routes alone',()=>{
  for(const provider of Object.values(MODEL_PROVIDERS)) {
    const selection={provider:provider.route,model:'synthetic'};
    if(provider.id==='kimi_code_plan')assert.throws(()=>assertBoundedModel({orchestration_profile:profile},selection),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
    else assert.equal(assertBoundedModel({orchestration_profile:profile},selection),selection);
  }
  for(const selection of [undefined,{provider:'foreign',model:'x'},{provider:'nexo-custom',model:''}])
    assert.throws(()=>assertBoundedModel({orchestration_profile:profile},selection),{status:400,code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
  assert.doesNotThrow(()=>assertBoundedModel({}, {provider:'kimi-coding',model:'k3'}));
});

test('unsupported create is rejected before native session, task or budget creation',async t=>{
  const f=fixture(t);f.ctx.settings.get=()=>({provider:'kimi_code_plan',model:'k3'});
  const id='11111111-1111-4111-8111-111111111111';
  await assert.rejects(startUnoJob(f.ctx,f.root,{mode:'compile',compile_profile:'unit-cards-v3',sources:['00-Inbox/a.md'],request_id:id}),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
  assert.equal(f.requests.length,0);assert.equal(existsSync(join(f.root,'.nexogenesis/uno-jobs',id+'.json')),false);
  assert.equal(existsSync(join(f.root,'.nexogenesis/provider-request-budgets',id+'.json')),false);
});

test('construction resume and retry reject frozen unmetered routes before changing budget or progress',async t=>{
  const f=fixture(t,{used:14,changes:{mode:'construct',model_selection:{provider:'kimi-coding',model:'k3'}}});
  const path=join(f.root,'.nexogenesis/uno-jobs',f.job.id+'.json'),before=readFileSync(path,'utf8');
  for(const action of ['resume','retry'])await assert.rejects(f.action(action,{budget_calls:30}),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.requests.length,0);
  assert.equal(getProviderBudget(f.root,f.job.id).limit,20);assert.equal(getProviderBudget(f.root,f.job.id).used,14);
});

for(const fresh of [false,true])test(`execution fails closed before ${fresh?'fresh context':'native turn'} on unsupported route`,async t=>{
  const f=fixture(t,{changes:{needs_fresh_context:fresh,model_selection:{provider:'kimi-coding',model:'k3'}}});
  const job=await f.run();assert.match(job.detail,/UNO_BUDGET_MODEL_UNSUPPORTED/);assert.equal(f.requests.length,0);
  assert.equal(getProviderBudget(f.root,job.id).used,0);
});

test('native reason.failure preserves budget code and hands existing drafts to independent review',async t=>{
  const f=fixture(t,{onPrompt:job=>job.role==='author'?{kind:'failed',failure:{code:'UNO_STAGE_BUDGET',message:'阶段请求已用尽'}}:{kind:'completed'}});
  f.gateway.stageUnoKnowledge({task:f.job.id+'-b0',key:'draft',id:'a',title:'局部观察的边界',summary:'作者对结论作出范围限制。',type:'claim',domains:[],body:'作者提出一个局部观察，明确其结论不能外推。',boundary:'仅为合成观察。',sources:[f.ref]});
  const job=await f.run();assert.deepEqual(f.prompts.map(p=>p.role),['author','reviewer']);
  assert.equal(job.role,'reviewer');assert.equal(job.outcomes[f.ref],undefined);assert.equal(getProviderBudget(f.root,job.id).used,0);
});

test('native reason.failure message reaches saved task when no valid handoff exists',async t=>{
  const f=fixture(t,{onPrompt:()=>({kind:'failed',failure:{code:'SERVER',message:'合成供应商错误详情'}})});
  const job=await f.run();assert.equal(job.detail,'合成供应商错误详情');assert.equal(f.prompts.length,1);
});

for(const remaining of [3,4])test(`nonselection next batch requires author plus review reserve: remaining ${remaining}`,async t=>{
  const f=fixture(t,{limit:20,used:20-remaining,changes:{phase:'batch_done',repair_ids:['previous-batch-card']}});
  f.job.batches.push([f.ref]);saveCompileJob(f.root,f.job);
  const job=await f.run();assert.equal(job.batch_index,remaining===4?1:0);
  if(remaining===4){assert.equal(f.prompts.length,1);assert.equal(f.prompts[0].repair_ids,undefined);assert.equal(job.phase,'read');}
  else {assert.equal(f.requests.length,0);assert.match(job.detail,/剩余额度不足/);assert.deepEqual(job.repair_ids,['previous-batch-card']);}
  assert.equal(getProviderBudget(f.root,job.id).used,20-remaining);
});

test('bounded construction resume accepts 4-request budget without increasing or resetting it',async t=>{
  const f=fixture(t,{limit:4,changes:{mode:'construct'}});const job=await f.action('resume',{budget_calls:4});
  assert.equal(job.budget.calls,4);assert.equal(getProviderBudget(f.root,job.id).limit,4);assert.equal(getProviderBudget(f.root,job.id).used,0);
  assert.equal(f.prompts.length,1);
});

test('construction resume keeps minimum and monotonic budget restrictions for both profiles',async t=>{
  const f=fixture(t,{limit:8,changes:{mode:'construct'}});await assert.rejects(f.action('resume',{budget_calls:3}),/4–2000/);
  await assert.rejects(f.action('resume',{budget_calls:4}),/不能减少/);
  delete f.job.orchestration_profile;saveCompileJob(f.root,f.job);
  await assert.rejects(f.action('resume',{budget_calls:4}),/10–2000/);
  assert.equal(f.prompts.length,0);assert.equal(getProviderBudget(f.root,f.job.id).limit,8);
});


for(const [limit,reviewReserve] of [[4,1],[6,2],[10,3]])test(limit+'-request construction reserves review without a selection stage',t=>{
 const f=fixture(t,{limit}),attempt=()=>reserveProviderRequest(f.ctx,{sessionId:f.job.session_id,nexoPrompt:{root:f.root}});
 bindWorkflowBudget(f.root,f.job);let budget=getProviderBudget(f.root,f.job.id);assert.equal(budget.current.stageLimit,6);assert.equal(budget.current.reviewReserve,reviewReserve);
 const authorCalls=Math.min(6,limit-reviewReserve);for(let n=0;n<authorCalls;n++)attempt();assert.throws(attempt,error=>['UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE'].includes(error.code));
 Object.assign(f.job,{phase:'organize',role:'reviewer',session_id:'new-reviewer'});saveCompileJob(f.root,f.job);bindWorkflowBudget(f.root,f.job);
 for(let n=0;n<limit-authorCalls;n++)attempt();assert.throws(attempt,{code:'UNO_PROVIDER_BUDGET'});
 budget=getProviderBudget(f.root,f.job.id);assert.equal(budget.used,limit);assert.equal(budget.remaining,0);assert.equal(f.requests.length,0);
});
test('raising and rebinding retains frozen review reserve, stage ceiling and prior attempts',t=>{
 const f=fixture(t,{limit:4});bindWorkflowBudget(f.root,f.job);reserveProviderRequest(f.ctx,{sessionId:f.job.session_id,nexoPrompt:{root:f.root}});
 raiseProviderBudget(f.root,f.job.id,10);f.job.budget.calls=10;f.job.session_id='resumed-same-stage';saveCompileJob(f.root,f.job);bindWorkflowBudget(f.root,f.job);
 let budget=getProviderBudget(f.root,f.job.id);assert.equal(budget.current.stageLimit,6);assert.equal(budget.current.stageUsed,1);assert.equal(budget.used,1);
 assert.equal(nextPackageMinimum(f.root,f.job),2);assert.deepEqual(f.job.provider_budget_policy,{initial_limit:4,review_reserve:1});
 f.job.resume_round=1;f.job.session_id='explicit-resume';saveCompileJob(f.root,f.job);bindWorkflowBudget(f.root,f.job);budget=getProviderBudget(f.root,f.job.id);assert.equal(budget.current.stageLimit,6);assert.equal(budget.used,1);
});
test('pre-policy construction stage keeps its existing ledger configuration on rebind',t=>{
 const f=fixture(t,{limit:4});bindProviderBudgetSession(f.root,{jobId:f.job.id,sessionId:f.job.session_id,packageId:'batch-0-repair-0',role:'author',stageId:'batch-0-author-repair-0-resume-0',stageLimit:3,reviewReserve:1});
 reserveProviderRequest(f.ctx,{sessionId:f.job.session_id,nexoPrompt:{root:f.root}});bindWorkflowBudget(f.root,f.job);const budget=getProviderBudget(f.root,f.job.id);assert.equal(budget.current.stageLimit,3);assert.equal(budget.current.stageUsed,1);
});
for(const code of ['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_REVIEW_RESERVE'])
test(`native ${code} pauses with structured reason even when message has no Chinese budget keyword`,async t=>{
  const f=fixture(t,{onPrompt:()=>({kind:'failed',failure:{code,message:'Request allowance exhausted'}})});
  const job=await f.run();assert.equal(job.status,'paused');assert.equal(job.error_code,code);
  assert.equal(job.last_error.code,code);assert.equal(job.last_error.message,'Request allowance exhausted');assert.equal(job.last_error.phase,'read');
  assert.equal(f.prompts.length,1);assert.equal(getProviderBudget(f.root,job.id).used,0);
});

test('global budget preflight pauses without RPC and preserves provider error code',async t=>{
  const f=fixture(t,{limit:4,used:4});const job=await f.run();assert.equal(job.status,'paused');assert.equal(job.error_code,'UNO_PROVIDER_BUDGET');
  assert.equal(job.last_error.code,'UNO_PROVIDER_BUDGET');assert.equal(f.requests.length,0);
});

test('message-only native budget error is classified by its explicit code',async t=>{
  const f=fixture(t,{onPrompt:()=>({kind:'failed',message:'[UNO_STAGE_BUDGET] stage allowance exhausted'})});
  const job=await f.run();assert.equal(job.status,'paused');assert.equal(job.error_code,'UNO_STAGE_BUDGET');
});

test('blocked native steps do not force a bounded construction API resume to increase its actual request budget',async t=>{
  const f=fixture(t,{limit:4,used:1,changes:{mode:'construct',calls:Array.from({length:12},()=>({status:'failed',error_code:'UNO_STAGE_BUDGET'}))}});
  const job=await f.action('resume',{budget_calls:4}),budget=getProviderBudget(f.root,f.job.id);
  assert.equal(job.budget.calls,4);assert.equal(job.calls.length,12);assert.equal(budget.limit,4);assert.equal(budget.used,1);
  assert.equal(f.prompts.length,1);
});

test('legacy construction API resume still validates its historical call count',async t=>{
  const f=fixture(t,{limit:20,changes:{mode:'construct',orchestration_profile:undefined,calls:Array.from({length:12},()=>({status:'failed'}))}});
  await assert.rejects(f.action('resume',{budget_calls:10}),/不低于累计请求/);assert.equal(f.prompts.length,0);
});

test('historical bounded compile API resume is rejected without changing its budget or saved state',async t=>{
  const f=fixture(t,{limit:20,used:3,changes:{mode:'compile'}}),path=join(f.root,'.nexogenesis/uno-jobs',f.job.id+'.json'),before=readFileSync(path,'utf8');
  await assert.rejects(f.action('resume',{budget_calls:30}),/历史记录/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.prompts.length,0);assert.equal(f.requests.length,0);
  assert.equal(getProviderBudget(f.root,f.job.id).limit,20);assert.equal(getProviderBudget(f.root,f.job.id).used,3);
});

for(const nativeCode of ['UNO_CONTEXT_BUDGET','UNKNOWN'])test('context limit pauses without an automatic loop and recovers only current scope: '+nativeCode,async t=>{
 let first=true;
 const f=fixture(t,{limit:20,used:2,changes:{checkpoint:'已提交的决定',receipts:[{key:'saved-op',card_ids:['saved']}],reading:{old:{revision:'r',intervals:[[0,100]]}},card_reads:{oldcard:{revision:'r',intervals:[[0,100]]}}},
  onPrompt:()=>{if(first){first=false;return {kind:'failed',failure:{code:nativeCode,message:'[UNO_CONTEXT_BUDGET] full input budget exceeded'}};}return {kind:'completed'};}});
 const paused=await f.run();assert.equal(paused.status,'paused');assert.equal(paused.error_code,'UNO_CONTEXT_BUDGET');assert.equal(paused.needs_fresh_context,true);
 assert.equal(f.prompts.length,1);assert.equal(getProviderBudget(f.root,f.job.id).used,2);assert.equal(f.requests.filter(r=>r.method==='session.create').length,0);
 const resumed=await f.run();assert.equal(f.requests.filter(r=>r.method==='session.create').length,1);assert.equal(f.prompts.length,2);
 assert.notEqual(resumed.session_id,'author');assert.deepEqual(resumed.reading,{});assert.deepEqual(resumed.card_reads,{});assert.equal(resumed.checkpoint,'已提交的决定');assert.deepEqual(resumed.receipts,[{key:'saved-op',card_ids:['saved']}]);
 assert.equal(getProviderBudget(f.root,f.job.id).used,2);assert.equal(getProviderBudget(f.root,f.job.id).limit,20);
});
