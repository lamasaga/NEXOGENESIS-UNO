import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const app=process.env.UNO_REPO_ROOT?pathToFileURL(process.env.UNO_REPO_ROOT+'/'):new URL('../',import.meta.url);
const kimiModule=process.env.UNO_KIMI_CONTEXT_MODULE?pathToFileURL(process.env.UNO_KIMI_CONTEXT_MODULE):new URL('packages/nexogenesis-web-host/lib/native-kimi-budget.js',app);
const governanceModule=process.env.UNO_CONTEXT_CORE?pathToFileURL(process.env.UNO_CONTEXT_CORE):new URL('packages/nexogenesis-tools/lib/uno/request-context.js',app);
const {registerNativeKimiBudget}=await import(kimiModule);
const {projectUnoMessages,assertUnoRequestBudget,getUnoRequestGovernance}=await import(governanceModule);
const budget=await import(new URL('packages/nexogenesis-tools/lib/uno/request-budget.js',app));
const {registerPromptInspector,promptStore}=await import(new URL('packages/nexogenesis-web-host/lib/prompt-inspector.js',app));
const url='https://api.kimi.com/coding/v1/messages',done={type:'finish',reason:{kind:'stop'}};
const collect=async stream=>{const rows=[];for await(const row of stream)rows.push(row);return rows;};
function fixture(t,{bound=true,governed=true,fetch=async()=>new Response('ok')}={}){
 const root=mkdtempSync(join(tmpdir(),'uno-kimi-context-'));const hooks=[];
 const ctx={get:name=>name==='sessions'?{get:()=>({header:{cwd:root}})}:undefined,on(name,fn){hooks.push({name,fn});return()=>hooks.splice(hooks.findIndex(h=>h.fn===fn),1);}};
 if(bound){budget.initializeProviderBudget(root,'job',{limit:4});budget.bindProviderBudgetSession(root,{jobId:'job',sessionId:'author',packageId:'test',stageId:'test',role:'author',stageLimit:4,reviewReserve:0});}
 const messages=[{role:'user',content:[{type:'text',text:'test'}],source:{kind:'human'}}];const options={provider:'kimi-coding',model:'kimi-for-coding',sessionId:'author',messages:governed?projectUnoMessages(messages).messages:messages};
 if(governed)assertUnoRequestBudget(options);
 const target={fetch},dispose=registerNativeKimiBudget(ctx,{transportTarget:target});t.after(()=>{dispose();rmSync(root,{recursive:true,force:true});});
 const stream=next=>hooks.filter(h=>h.name==='llm/stream').reduceRight((inner,hook)=>()=>hook.fn(options,inner),next)();
 return {root,ctx,options,target,dispose,stream,status:()=>budget.getProviderBudget(root,'job')};
}

test('wire expansion is blocked before debit; swallowed SDK failures cannot launch a retry',async t=>{
 let sent=0;const f=fixture(t,{fetch:async()=>{sent++;return new Response('ok');}});let catches=0;
 await assert.rejects(collect(f.stream(async function*(){for(let n=0;n<2;n++){try{await f.target.fetch(url,{method:'POST',body:'X'.repeat(128001)});}catch{catches++;}}yield done;})),{code:'UNO_CONTEXT_BUDGET'});
 assert.equal(catches,2);assert.equal(sent,0);assert.equal(f.status().used,0);assert.equal(getUnoRequestGovernance(f.options.messages).wire_bytes,128001);
});

test('governed historical task without a new budget binding still enforces wire cap',async t=>{
 let sent=0;const f=fixture(t,{bound:false,fetch:async()=>{sent++;return new Response('ok');}});
 await assert.rejects(collect(f.stream(async function*(){await f.target.fetch(url,{method:'POST',body:'X'.repeat(128001)});yield done;})),{code:'UNO_CONTEXT_BUDGET'});assert.equal(sent,0);
});

test('ordinary ungoverned Kimi traffic keeps original path',async t=>{
 let sent=0;const f=fixture(t,{bound:false,governed:false,fetch:async()=>{sent++;return new Response('ok');}});
 await collect(f.stream(async function*(){await f.target.fetch(url,{method:'POST',body:'X'.repeat(128001)});yield done;}));assert.equal(sent,1);
});

test('wire capture stores the actual payload without headers and shares final measurement',async t=>{
 let sent=0;const f=fixture(t,{fetch:async()=>{sent++;return new Response('ok');}});
 registerPromptInspector(f.ctx,()=>f.root);
 const body=JSON.stringify({model:'kimi-for-coding',messages:[{role:'user',content:[{type:'text',text:'test'}]}]});
 await collect(f.stream(async function*(){await f.target.fetch(url,{method:'POST',headers:{'x-api-key':'never-save'},body});yield done;}));
 assert.equal(sent,1);assert.equal(f.status().used,1);const store=promptStore(f.root),record=store.get(store.list().items[0].id);assert.equal(record.capture,'wire');assert.deepEqual(record.input,JSON.parse(body));assert.doesNotMatch(JSON.stringify(record),/never-save/);assert.equal(getUnoRequestGovernance(f.options.messages).wire_bytes,Buffer.byteLength(body));
});

test('unknown streaming body fails before network and budget',async t=>{
 const f=fixture(t,{fetch:async()=>{assert.fail('must not dispatch');}});
 await assert.rejects(collect(f.stream(async function*(){await f.target.fetch(url,{method:'POST',body:new Uint8Array([1,2])});yield done;})),{code:'UNO_CONTEXT_ADAPTER'});assert.equal(f.status().used,0);
});

test('unload while Request clone text is pending cannot reserve or dispatch late',async t=>{
 let sent=0;const f=fixture(t,{fetch:async()=>{sent++;return new Response('ok');}});let resolveText,started;
 const pending=new Promise(resolve=>{resolveText=resolve;}),began=new Promise(resolve=>{started=resolve;});
 const request=new Request(url,{method:'POST',body:'{}'});request.clone=()=>({text(){started();return pending;}});
 const result=collect(f.stream(async function*(){await f.target.fetch(request);yield done;}));await began;f.dispose();resolveText('{}');await assert.rejects(result);assert.equal(sent,0);assert.equal(f.status().used,0);
});
