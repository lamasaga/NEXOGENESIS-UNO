import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { registerNativeKimiBudget, nativeKimiBudgetReady } from '../packages/nexogenesis-web-host/lib/native-kimi-budget.js';
import { registerModelAdapter } from '../packages/nexogenesis-web-host/lib/model-adapter.js';
import { assertBoundedModel } from '../packages/nexogenesis-web-host/lib/uno-orchestration.js';
import { initializeProviderBudget, bindProviderBudgetSession, getProviderBudget } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';

const url='https://api.kimi.com/coding/v1/messages';
const collect=async iterator=>{const result=[];for await(const chunk of iterator)result.push(chunk);return result;};
const opts=(sessionId='author',extra={})=>({provider:'kimi-coding',model:'kimi-for-coding',sessionId,messages:[],...extra});
const done={type:'finish',reason:{kind:'stop'}};
function fixture(t,{limit=8,stageLimit=8}={}){
  const root=mkdtempSync(join(tmpdir(),'uno-native-kimi-budget-'));
  const hooks=new Map(),disposers=[];
  const ctx={get:name=>name==='sessions'?{get:id=>id==='unbound'?undefined:{header:{cwd:root}}}:undefined,
    on:(name,hook)=>{hooks.set(name,hook);return()=>hooks.delete(name);},effect:fn=>disposers.push(fn())};
  initializeProviderBudget(root,'job',{limit});
  bindProviderBudgetSession(root,{jobId:'job',sessionId:'author',packageId:'test',stageId:'author-1',role:'author',stageLimit,reviewReserve:0});
  const f={root,ctx,hooks,status:()=>getProviderBudget(root,'job'),ledger:()=>JSON.parse(readFileSync(join(root,'.nexogenesis/provider-request-budgets/job.json'),'utf8')),
    stream:(options,next)=>hooks.get('llm/stream')(options,next)};
  t.after(()=>{for(const dispose of disposers.reverse())dispose?.();rmSync(root,{recursive:true,force:true});});
  return f;
}
function install(t,f,fetchImpl){
  const target={fetch:fetchImpl};const dispose=registerNativeKimiBudget(f.ctx,{transportTarget:target});t.after(dispose);
  return {target,dispose};
}
const request=(target,input=url,init={method:'POST'})=>async function*(){await target.fetch(input,init);yield done;};

test('native budget reserves before dispatch, settles usage and stores no input or credentials',async t=>{
  const f=fixture(t);let count=0;
  const {target}=install(t,f,async(input,init)=>{count++;assert.equal(f.status().used,1);assert.equal(f.ledger().requests[0].state,'reserved');assert.equal(input,url);assert.equal(init.headers['x-api-key'],'synthetic-secret');assert.equal(init.redirect,'error');return new Response('ok');});
  await collect(f.stream(opts(),async function*(){await target.fetch(url,{method:'POST',headers:{'x-api-key':'synthetic-secret'},body:'private-material'});yield {type:'usage',usage:{inputTokens:3,outputTokens:2}};yield done;}));
  assert.equal(count,1);assert.equal(f.ledger().requests[0].state,'completed');assert.equal(f.ledger().requests[0].usage.outputTokens,2);
  assert.doesNotMatch(JSON.stringify(f.ledger()),/synthetic-secret|private-material/);
});

test('every actual retry consumes a reservation, while denied retry never dispatches',async t=>{
  const f=fixture(t,{limit:2,stageLimit:2});let sent=0;
  const {target}=install(t,f,async()=>{sent++;return new Response('retry',{status:503});});
  await assert.rejects(collect(f.stream(opts(),async function*(){
    for(let n=0;n<3;n++)try{await target.fetch(url,{method:'POST'});}catch{}
    yield done; // Simulate a library swallowing the budget error.
  })),{code:'UNO_PROVIDER_BUDGET'});
  assert.equal(sent,2);assert.equal(f.status().used,2);assert.deepEqual(f.ledger().requests.map(r=>r.state),['failed','failed']);
});

test('separate runtime retry calls count failures and success individually',async t=>{
  const f=fixture(t);let sent=0;
  const {target}=install(t,f,async()=>{if(++sent<3)throw new TypeError('synthetic disconnect');return new Response('ok');});
  for(let n=0;n<2;n++)await assert.rejects(collect(f.stream(opts(),request(target))),/disconnect/);
  await collect(f.stream(opts(),request(target)));
  assert.equal(f.status().used,3);assert.deepEqual(f.ledger().requests.map(r=>r.state),['failed','failed','completed']);
});

test('cancellation before dispatch costs zero; cancellation after dispatch remains consumed',async t=>{
  const f=fixture(t);let sent=0,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const {target}=install(t,f,async(input,init)=>{sent++;started();return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));});
  const before=new AbortController();before.abort();
  await assert.rejects(collect(f.stream(opts('author',{signal:before.signal}),request(target))));assert.equal(sent,0);assert.equal(f.status().used,0);
  const after=new AbortController(),running=collect(f.stream(opts('author',{signal:after.signal}),request(target)));
  await ready;after.abort();await assert.rejects(running);assert.equal(f.status().used,1);assert.equal(f.ledger().requests[0].state,'cancelled');
});

test('unknown endpoints are blocked before network and budget debit',async t=>{
  const f=fixture(t);let sent=0;const {target}=install(t,f,async()=>{sent++;return new Response('ok');});
  for(const input of ['https://api.moonshot.cn/v1/chat/completions','https://evil.example/coding/v1/messages','https://api.kimi.com/coding/v1/messages/extra'])
    await assert.rejects(collect(f.stream(opts(),request(target,input))),{code:'UNO_BUDGET_TRANSPORT'});
  assert.equal(sent,0);assert.equal(f.status().used,0);
});

test('ordinary chat, old unbound sessions, other providers and unrelated fetches stay untouched',async t=>{
  const f=fixture(t);const invocations=[];const original=async(input,init)=>{invocations.push([input,init]);return new Response('ok');};
  const {target}=install(t,f,original),init={method:'POST',body:'same'};
  for(const options of [opts(undefined),opts('unbound'),opts('author',{provider:'nexo-deepseek'})]){
    if(options.sessionId==='author'&&options.provider==='kimi-coding')delete options.sessionId;
    await collect(f.stream(options,request(target,'https://unchanged.example',init)));
  }
  await target.fetch('https://unrelated.example',init);
  assert.equal(invocations.length,4);assert.ok(invocations.every(([,actual])=>actual===init));assert.equal(f.status().used,0);
});

test('concurrent calls in separate knowledge roots retain their own ledgers',async t=>{
  const a=fixture(t),b=fixture(t);let sent=0;const target={fetch:async()=>{await new Promise(r=>setTimeout(r,5));sent++;return new Response('ok');}};
  const disposeA=registerNativeKimiBudget(a.ctx,{transportTarget:target}),disposeB=registerNativeKimiBudget(b.ctx,{transportTarget:target});t.after(()=>{disposeA();disposeB();});
  await Promise.all([collect(a.stream(opts(),request(target))),collect(b.stream(opts(),request(target)))]);
  assert.equal(sent,2);assert.equal(a.status().used,1);assert.equal(b.status().used,1);
  assert.notEqual(a.ledger().requests[0].id,b.ledger().requests[0].id);
  const wrapped=target.fetch;disposeA();assert.equal(target.fetch,wrapped);assert.equal(nativeKimiBudgetReady(a.ctx),false);assert.equal(nativeKimiBudgetReady(b.ctx),true);
});

test('captured stage cannot be reassigned while credentials are awaiting',async t=>{
  const f=fixture(t);let sent=0;const {target}=install(t,f,async()=>{sent++;return new Response('ok');});
  await assert.rejects(collect(f.stream(opts(),async function*(){
    await Promise.resolve();bindProviderBudgetSession(f.root,{jobId:'job',sessionId:'reviewer',packageId:'test',stageId:'reviewer',role:'reviewer',stageLimit:3,reviewReserve:0});
    await target.fetch(url,{method:'POST'});yield done;
  })),{code:'UNO_BUDGET_STALE_STAGE'});
  assert.equal(sent,0);assert.equal(f.status().used,0);
});

test('unload restores fetch and rejects bounded Kimi readiness; live request is cancelled',async t=>{
  const f=fixture(t);let started;const ready=new Promise(r=>{started=r;});
  const original=async(input,init)=>{started();return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));};
  const {target,dispose}=install(t,f,original);
  const selection={provider:'kimi-coding',model:'kimi-for-coding'},job={orchestration_profile:'bounded-workflow-v1'};
  assert.equal(assertBoundedModel(job,selection,f.ctx),selection);assert.throws(()=>assertBoundedModel(job,selection),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
  const running=collect(f.stream(opts(),request(target)));await ready;dispose();await assert.rejects(running);
  assert.equal(target.fetch,original);assert.equal(f.ledger().requests[0].state,'cancelled');assert.equal(nativeKimiBudgetReady(f.ctx),false);
  assert.throws(()=>assertBoundedModel(job,selection,f.ctx),{code:'UNO_BUDGET_MODEL_UNSUPPORTED'});
});

test('successful chunks bypassing the verified transport are refused',async t=>{
  const f=fixture(t);install(t,f,async()=>new Response('ok'));
  await assert.rejects(collect(f.stream(opts(),async function*(){yield done;})),{code:'UNO_BUDGET_TRANSPORT'});assert.equal(f.status().used,0);
});

test('formal model registration installs and disposes native budget without claiming native adapter route',t=>{
  const f=fixture(t);let routes;
  f.ctx.inject=(needs,callback)=>callback({llm:{registerAdapter:values=>{routes=values;return()=>{};}}});
  const original=globalThis.fetch;registerModelAdapter(f.ctx);
  assert.equal(nativeKimiBudgetReady(f.ctx),true);assert.equal(routes.includes('kimi-coding'),false);
  assert.notEqual(globalThis.fetch,original);
});

const nativeEntry=process.env.UNO_DSH_ENTRY;
test('installed native PiAiAdapter and Anthropic SDK cross the real fetch seam for success, retries and cap',{
  skip:nativeEntry?false:'Set UNO_DSH_ENTRY to test the actual installed native Kimi SDK without external network',
},async t=>{
  const requireHost=createRequire(resolve(nativeEntry));const importHost=name=>import(pathToFileURL(requireHost.resolve(name)).href);
  const {PiAiAdapter}=await importHost('@deepseek-ai/dsh-llm-pi-ai');
  const {Context}=await importHost('@deepseek-ai/cordis');
  const {LlmRuntime}=await importHost('@deepseek-ai/dsh-llm');
  // pi-ai exposes this subpath for ESM only; createRequire.resolve has no import
  // condition. Resolve beside the actual native adapter, never a local stand-in.
  const {kimiCodingProvider}=await import(new URL('../../../@earendil-works/pi-ai/dist/providers/kimi-coding.js',pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-llm-pi-ai'))));
  const f=fixture(t,{limit:4,stageLimit:3});const original=globalThis.fetch;let sent=0;
  const events=[
    {type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',content:[],model:'kimi-for-coding',usage:{input_tokens:5,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}},
    {type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
    {type:'message_stop'},
  ];
  globalThis.fetch=async(input,init)=>{
    sent++;assert.equal(f.status().used,sent);assert.equal(String(input),url);
    assert.equal(new Headers(init.headers).get('x-api-key'),'synthetic-code-plan-key');
    const body=JSON.parse(init.body);assert.equal(body.model,'kimi-for-coding');assert.equal(body.stream,true);assert.equal(body.messages[0].content[0].text,'synthetic native test');
    if(sent<3)return new Response(JSON.stringify({type:'error',error:{type:'overloaded_error',message:'synthetic overload'}}),{status:503,headers:{'content-type':'application/json'}});
    return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  };
  const nativeCtx=new Context(),runtime=new LlmRuntime(nativeCtx);
  const bridgeCtx={on:nativeCtx.on.bind(nativeCtx),get:f.ctx.get};
  const dispose=registerNativeKimiBudget(bridgeCtx);t.after(async()=>{dispose();globalThis.fetch=original;await nativeCtx.fiber.dispose();});
  const profiles=new Map([['kimi-coding',{provider:'kimi-coding',displayName:'Kimi Code',piProvider:kimiCodingProvider(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:1000}]]);
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>'synthetic-code-plan-key'});
  const unregister=runtime.registerAdapter(['kimi-coding'],adapter);t.after(unregister);
  const options=opts('author',{messages:[{id:'test-input',role:'user',content:[{type:'text',text:'synthetic native test'}]}]});
  for(let n=0;n<2;n++){
    const failed=await collect(runtime.stream(options));
    assert.equal(failed.at(-1).reason.kind,'error');assert.equal(sent,n+1);
  }
  const chunks=await collect(runtime.stream(options));
  assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(sent,3);assert.equal(f.status().used,3);
  assert.deepEqual(f.ledger().requests.map(row=>row.state),['failed','failed','completed']);
  assert.equal(f.ledger().requests[2].usage.outputTokens,2);
  // Stage denial happens inside the SDK fetch boundary (one global slot remains).
  // Preserve the code even though the SDK catches and translates transport errors.
  await assert.rejects(collect(runtime.stream(options)),{code:'UNO_STAGE_BUDGET'});assert.equal(sent,3);
});

for(const replaceOwner of [false,true])test(`native credential-await unload keeps the fetch fence until drain${replaceOwner?' and preserves a replacement owner':''}`,{
  skip:nativeEntry?false:'Set UNO_DSH_ENTRY for the installed native SDK unload race regression',
},async t=>{
  const requireHost=createRequire(resolve(nativeEntry)),load=name=>import(pathToFileURL(requireHost.resolve(name)).href);
  const {PiAiAdapter}=await load('@deepseek-ai/dsh-llm-pi-ai');
  const {Context}=await load('@deepseek-ai/cordis'),{LlmRuntime}=await load('@deepseek-ai/dsh-llm');
  const {kimiCodingProvider}=await import(new URL('../../../@earendil-works/pi-ai/dist/providers/kimi-coding.js',pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-llm-pi-ai'))));
  const f=fixture(t),original=globalThis.fetch;let sent=0,entered,release;
  const waiting=new Promise(r=>{entered=r;}),credential=new Promise(r=>{release=r;});
  const mock=async input=>{
    assert.equal(String(input),url);sent++;
    return new Response(JSON.stringify({type:'error',error:{type:'overloaded_error',message:'synthetic'}}),{status:503,headers:{'content-type':'application/json'}});
  };
  globalThis.fetch=mock;
  const nativeCtx=new Context(),runtime=new LlmRuntime(nativeCtx),bridgeCtx={on:nativeCtx.on.bind(nativeCtx),get:f.ctx.get};
  const dispose=registerNativeKimiBudget(bridgeCtx);let disposeReplacement;
  const profiles=new Map([['kimi-coding',{provider:'kimi-coding',displayName:'Kimi Code',piProvider:kimiCodingProvider(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:1000}]]);
  const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>{entered();await credential;return 'synthetic-key';}});
  const unregister=runtime.registerAdapter(['kimi-coding'],adapter);
  t.after(async()=>{release();disposeReplacement?.();dispose();unregister();await nativeCtx.fiber.dispose();globalThis.fetch=original;});
  const options=opts('author',{messages:[{id:'synthetic',role:'user',content:[{type:'text',text:'synthetic'}]}]});
  const running=collect(runtime.stream(options));await waiting;
  const wrapped=globalThis.fetch;dispose();
  assert.equal(nativeKimiBudgetReady(bridgeCtx),false);
  assert.equal(globalThis.fetch,wrapped,'a credential wait still owns the transport fence');
  if(replaceOwner){disposeReplacement=registerNativeKimiBudget(bridgeCtx);assert.equal(globalThis.fetch,wrapped);assert.equal(nativeKimiBudgetReady(bridgeCtx),true);}
  release();await assert.rejects(running,{code:'UNO_BUDGET_STALE_STAGE'});
  assert.equal(sent,0);assert.equal(f.status().used,0,'unloaded credential-waiting call must never dispatch');
  if(replaceOwner){
    assert.equal(globalThis.fetch,wrapped,'old call cleanup must not release the new owner');
    const result=await collect(runtime.stream(options));assert.equal(result.at(-1).reason.kind,'error');
    assert.equal(sent,1);assert.equal(f.status().used,1);assert.equal(f.ledger().requests[0].state,'failed');
    disposeReplacement();
  }
  assert.equal(globalThis.fetch,mock,'last owner and last bound call release the fetch bridge');
});
