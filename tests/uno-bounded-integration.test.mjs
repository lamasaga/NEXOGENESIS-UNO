import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {handleUnoApi,hasUnoJobRunning} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import {readCompileJob,saveCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {runCompileTool} from '../packages/nexogenesis-tools/lib/uno/agent.js';
import {loadCards} from '../packages/nexogenesis-tools/lib/cards.js';
import {unoMarkdown,unoRevision} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {getProviderBudget,initializeProviderBudget,reserveProviderRequest,settleProviderRequest} from '../packages/nexogenesis-tools/lib/uno/request-budget.js';

// Construction stays in current regression. Its input card is published by a
// Gateway fixture, without reopening the retired compilation controller.
// Exercise the real HTTP handler, host loop, first-pack observer, scoped tools,
// Gateway, and durable budget. Only native RPC transport and model responses are
// simulated. Any non-loopback fetch fails; these tests never contact a provider.
const response=()=>Object.assign(new EventEmitter(),{data:'',headersSent:false,writableEnded:false,
  writeHead(code){this.code=code;this.headersSent=true;},write(value){this.data+=value;},end(value=''){this.data+=value;this.writableEnded=true;}});
const wait=async(check,message)=>{for(let i=0;i<600;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error(message??'Timed out waiting for host');};
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'uno-bounded-integration-')),oldHome=process.env.DSH_HOME,oldFetch=globalThis.fetch;
  process.env.DSH_HOME=root;mkdirSync(join(root,'00-Inbox'));
  const source='00-Inbox/book.md',quote='本案例只有12个观察值，不能推出普遍规律。';
  writeFileSync(join(root,source),'# 第一章\n背景历史甲。\n\n# 第二章\n作者把工资调整视为可能机制。\n\n'+quote+'\n\n# 第三章\n不同条件下的后续丙。');
  const sessions=new Map(),listeners=new Map(),prompts=[],rpc=[],turns=[];let id;
  const ctx={webServer:{port:9997},settings:{get:()=>({provider:'deepseek',model:'deepseek-v4-flash',thinking_mode:'disabled'})},
    get(name){return name==='sessions'?{get:key=>sessions.get(key),flush:async()=>{}}:undefined;},
    on(name,fn){const group=listeners.get(name)??new Set();listeners.set(name,group);group.add(fn);return()=>group.delete(fn);}};
  const emit=(sessionId,type,data)=>{if(type==='turn/end')sessions.get(sessionId).running=false;for(const fn of [...listeners.get('session/event')??[]])fn({id:sessionId},{type,data});};
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).hostname,'127.0.0.1','No provider/network requests are allowed');
    const call=JSON.parse(init.body);rpc.push(call);let value={};
    if(call.method==='session.list')value={items:[...sessions.values()]};
    else if(call.method==='session.create'){
      const sessionId='integration-'+(sessions.size+1);sessions.set(sessionId,{id:sessionId,sessionId,header:{cwd:root},events:[],running:false,
        append(type,data){this.events.push({type,data,time:Date.now()});}});value={sessionId};
    }else if(call.method==='session.prompt'){sessions.get(call.payload.sessionId).running=true;prompts.push(call.payload);}
    else if(call.method==='session.history')value={events:sessions.get(call.payload.sessionId)?.events??[]};
    else if(call.method==='session.cancel')queueMicrotask(()=>emit(call.payload.sessionId,'turn/end',{reason:{kind:'cancelled'}}));
    return {json:async()=>({type:'server-response',result:{ok:true,value}})};
  };
  const job=()=>readCompileJob(root,id),budget=()=>getProviderBudget(root,id);
  async function api(path,body={}){const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno'+path,method:'POST',headers:{'content-type':'application/json'}}),res=response();await handleUnoApi(ctx,req,res,root);return JSON.parse(res.data);}
  async function start(options={}){assert.equal(options.mode,'construct');const result=await api('/jobs',{external_images:false,delivery:'auto',budget_calls:4,orchestration_profile:'bounded-workflow-v1',...options});id=result.id;return result;}
  async function next(phase,role){await wait(()=>prompts.length||!hasUnoJobRunning(root),'Expected a native prompt for '+phase);assert.ok(prompts.length,'Host stopped: '+job().detail);const prompt=prompts.shift(),state=job();assert.equal(state.phase,phase);assert.equal(state.role,role);return prompt;}
  const payload=prompt=>{const text=prompt.content.find(block=>block.type==='text'&&block.text.startsWith('{'))?.text;assert.ok(text,'Stage must have a first evidence pack');return JSON.parse(text);};
  async function answer(prompt,actions,{deliver=true,reason={kind:'completed'}}={}){
    const sessionId=prompt.sessionId,options={sessionId,provider:'nexo-deepseek',model:'deepseek-v4-flash',messages:[{role:'user',content:deliver?prompt.content:[]}],signal:new AbortController().signal};
    const reservation=reserveProviderRequest(ctx,options),state=job();turns.push({sessionId,phase:state.phase,role:state.role});
    emit(sessionId,'step/start',{step:1,turn:turns.length});
    let stream=(async function*(){yield {type:'tool-call-delta',name:'synthetic-response',argumentsDelta:'{}'};})();
    for(const fn of [...listeners.get('llm/stream')??[]]){const previous=stream;stream=fn(options,()=>previous);}
    for await(const ignored of stream){} // A real nonempty response confirms only the exact transmitted pack.
    const tool=(name,args)=>runCompileTool(root,sessionId,name,args);
    await actions(tool,payload(prompt));
    settleProviderRequest(reservation,{state:'completed',usage:{inputTokens:10,outputTokens:1}});
    emit(sessionId,'assistant/message',{message:{content:[{type:'text',text:'Synthetic response completed.'}]}});
    emit(sessionId,'turn/end',{reason});
  }
  async function idle(){await wait(()=>!hasUnoJobRunning(root));return job();}
  t.after(async()=>{if(id&&hasUnoJobRunning(root)){await api('/jobs/'+id+'/cancel',{version:job().version});await idle();}globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(root,{recursive:true,force:true});});
  return {root,source,quote,ctx,job,budget,api,start,next,payload,answer,idle,prompts,rpc,turns};
}

test('API construction uses only its selected published card and a separate budget; unchanged content needs no write',async t=>{
  const f=fixture(t),ref=f.source;mkdirSync(join(f.root,'01-Cards'));writeFileSync(join(f.root,'01-Cards/a.md'),unoMarkdown({schema:'uno-card-v4',id:'a',title:'工资调整机制的样例边界',summary:'有限样例',type:'mechanism',domains:[],boundary:'仅限本样例',sources:[ref]},'作者把工资调整视为可能机制。'+f.quote+'该解释只作为这个样例的可能机制，不能把观察数量当作因果识别。'));
  const compiled={id:'saved-previous-task',mode:'compile',status:'partial',calls:[],sources:[],failures:[],receipts:[]};saveCompileJob(f.root,compiled);initializeProviderBudget(f.root,compiled.id,{limit:6,alreadyUsed:3,provenance:'合成已结束任务'});
  const before=loadCards(f.root).get('a').body;
  const created=await f.start({mode:'construct',card_ids:['a'],notes:'检查刚编译卡片是否准确保留小样本限制',budget_calls:4});
  assert.notEqual(created.id,compiled.id);assert.deepEqual(created.scope,['a']);assert.equal(created.budget.calls,4);
  const author=await f.next('read','author');await f.answer(author,async(tool,pack)=>{
    assert.deepEqual(pack.task.scope,['a']);assert.equal(pack.evidence[0].id,'a');assert.equal(pack.evidence[0].complete,true);
    await assert.rejects(Promise.resolve().then(()=>tool('compile_edit',{operation_id:'outside',action:'patch',id:'outside',title:'扩张范围'})),/范围/);
    const result=await tool('compile_finish',{phase:'organize',summary:'当前卡准确保留作者与样本限制，无需修改'});assert.equal(result.end_turn,true);
  });
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    const result=await tool('compile_review',{ids:['a'],note:'现有表述准确保留12个观察值及不可外推的边界，无需修改'});assert.equal(result.end_turn,true);
  });
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(final.completed_batches[0].pending,0);
  assert.equal(loadCards(f.root).get('a').body,before);assert.equal(loadCards(f.root).size,1);assert.equal(final.receipts.length,0);
  assert.equal(f.budget().used,2);assert.equal(getProviderBudget(f.root,compiled.id).used,3);assert.equal(readCompileJob(f.root,compiled.id).status,'partial');
});
