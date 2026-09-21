import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { cancelUnoShutdown, launch, prepareUnoShutdown, readUnoJob, recoverInterruptedUnoJobs, isUnoJobRunning, hasUnoJobRunning, handleUnoApi, startUnoJob } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { readCompileJob, saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { executeConstruction } from '../packages/nexogenesis-web-host/lib/construction-host.js';
import { handleChatCancel, handleChatStream } from '../packages/nexogenesis-web-host/lib/chat.js';
import { handleWorkStop, workSnapshot } from '../packages/nexogenesis-web-host/lib/work.js';
import { handleConversationControl } from '../packages/nexogenesis-web-host/lib/conversation-control.js';
import { handleCognitiveSessionSteer } from '../packages/nexogenesis-web-host/lib/cognition.js';
import { handleConversationDelete, handleConversationGet, handleProjectsGet } from '../packages/nexogenesis-web-host/lib/projects.js';
import { patchConversationExt, readMeta } from '../packages/nexogenesis-web-host/lib/meta.js';
import { subscribeGraphEvents } from '../packages/nexogenesis-web-host/lib/events-bus.js';
import { isQuickThinkingRunning } from '../packages/nexogenesis-web-host/lib/quick-thinking.js';

const req=body=>Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{headers:{'content-type':'application/json'}});
const res=()=>Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,data:'',writeHead(code){this.code=code;this.headersSent=true;},write(v){this.data+=v;},end(v=''){this.data+=v;this.writableEnded=true;}});
const wait=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out waiting for lifecycle');};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'uno-lifecycle-test-')),home=process.env.DSH_HOME,fetch=globalThis.fetch;
 process.env.DSH_HOME=root;
 const calls=[],listeners=new Set(),sessions=new Map();
 const add=id=>{const s={sessionId:id,id,running:false,updatedAt:Date.now(),events:[],append(type,data){assert.deepEqual(data,JSON.parse(JSON.stringify(data)),'Native events must be lossless JSON');this.events.push({type,data,time:Date.now()});}};sessions.set(id,s);return s;};
 add('owner');patchConversationExt('owner',{project_id:'test',task_kind:'construct',uno_job_id:'job'});
 const ctx={webServer:{port:9999},settings:{get:()=>({provider:'deepseek',model:'deepseek-chat'})},on(_name,fn){listeners.add(fn);return()=>listeners.delete(fn);},get(name){return {sessions:{get:id=>sessions.get(id),flush:async()=>{}},llm:this.llm}[name];}};
 const emit=(id,type,data)=>{if(type==='turn/end')sessions.get(id).running=false;for(const fn of [...listeners])fn({id},{type,data});};
 globalThis.fetch=async(_url,init)=>{const c=JSON.parse(init.body);calls.push(c);let value={};
  if(c.method==='session.list')value={items:[...sessions.values()]};
  if(c.method==='session.create')value={sessionId:add('child-'+sessions.size).id};
  if(c.method==='session.prompt')sessions.get(c.payload.sessionId).running=true;
  if(c.method==='session.history')value={events:sessions.get(c.payload.sessionId)?.events??[]};
  return {json:async()=>({type:'server-response',result:{ok:true,value}})};
 };
 const job={id:'job',workflow:'uno-compile-v3',mode:'construct',title:'Synthetic construct',notes:'保留反例',project_id:'test',owner_session_id:'owner',session_id:'owner',sessions:['owner'],phase:'read',role:'author',batch_index:0,batches:[['synthetic']],completed_batches:[],status:'paused',requirements:{preferences:{delivery:'auto'}},budget:{calls:120},calls:[],receipts:[],failures:[],issues:[],sources:[],outcomes:{},reviewed:{},touched:[],continuous:false};
 saveCompileJob(root,job);
 t.after(async()=>{for(const s of sessions.values())if(s.running)emit(s.id,'turn/end',{reason:{kind:'cancelled'}});await wait(()=>!hasUnoJobRunning(root));globalThis.fetch=fetch;if(home===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=home;rmSync(root,{recursive:true,force:true});});
 const start=async()=>{launch(ctx,root,readUnoJob(root,'job'));await wait(()=>[...sessions.values()].some(s=>s.running));};
 const handoff=async()=>{const current=readCompileJob(root,'job');current.handoff_requested=true;saveCompileJob(root,current);emit(current.session_id,'turn/end',{reason:{kind:'completed'}});await wait(()=>readCompileJob(root,'job').session_id!=='owner'&&[...sessions.values()].some(s=>s.id!=='owner'&&s.running));return readCompileJob(root,'job').session_id;};
 const pause=async()=>{const out=res();await handleChatCancel(ctx,req({conversation_id:'owner'}),out,[],root);return JSON.parse(out.data);};
 const exit=async()=>{emit(readCompileJob(root,'job').session_id,'turn/end',{reason:{kind:'cancelled'}});await wait(()=>!hasUnoJobRunning(root));};
 return {root,ctx,job,calls,sessions,add,emit,start,handoff,pause,exit};
}

test('作者交接审核后，主会话停止命中实际执行，退出之前保留运行状态和删除保护',async t=>{
 const f=fixture(t);await f.start();const child=await f.handoff();
 assert.equal(isUnoJobRunning(child),true);assert.equal(isUnoJobRunning('owner'),true);
 const result=await f.pause();assert.equal(result.cancelled,false);assert.equal(result.pending,true);
 await wait(()=>f.calls.some(c=>c.method==='session.cancel'));assert.equal(f.calls.filter(c=>c.method==='session.cancel').at(-1).payload.sessionId,child);
 await assert.rejects(handleConversationDelete(f.ctx,null,res(),[],'owner',f.root),/停止|结束/);
 await f.exit();assert.equal(readUnoJob(f.root,'job').status,'paused');
 await f.start();assert.equal(isUnoJobRunning('owner'),true);
 await assert.rejects(handleConversationDelete(f.ctx,null,res(),[],'owner',f.root),/停止|结束/);
 assert.equal((await workSnapshot(f.ctx,f.root)).items.length,1);
});

test('暂停讨论留在主会话，恢复保留预算、补充要求和审核阶段；结束后可交流但不能恢复',async t=>{
 const f=fixture(t);await f.start();const child=await f.handoff();
 const directive={message:'保留相反案例，不扩大范围',request_id:'directive-0001',expected_run_id:null};
 await handleCognitiveSessionSteer(f.ctx,req(directive),res(),[],f.root,'owner');
 await handleCognitiveSessionSteer(f.ctx,req(directive),res(),[],f.root,'owner');
 assert.equal(readUnoJob(f.root,'job').user_directives.length,1);
 await f.pause();await f.exit();
 await handleConversationControl(f.ctx,req({action:'discuss',run_id:'job'}),res(),[],f.root,'owner');
 f.ctx.llm={async *stream(){yield {type:'text-delta',text:'{"action":"answer","judgment":"讨论"}\n保留反例。'};yield {type:'finish',reason:{kind:'stop'}};}};
 await handleChatStream(f.ctx,req({conversation_id:'owner',message:'为什么保留反例？'}),res(),[],f.root);
 assert.equal(readUnoJob(f.root,'job').session_id,child);assert.equal(readUnoJob(f.root,'job').calls.length,0);
 const job=readUnoJob(f.root,'job'),r=req({version:job.version});r.url='/api/uno/jobs/job/resume';r.method='POST';
 await handleUnoApi(f.ctx,r,res(),f.root);await wait(()=>f.sessions.get(child).running);
 assert.equal(readUnoJob(f.root,'job').user_directives.length,1);assert.equal(readUnoJob(f.root,'job').budget.calls,120);
 const end=res();await handleWorkStop(f.ctx,req({action:'finish',expected_job_id:'job'}),end,[],f.root,'owner');
 assert.equal(JSON.parse(end.data).pending,true);await f.exit();assert.equal(readUnoJob(f.root,'job').status,'ended');
 await handleChatStream(f.ctx,req({conversation_id:'owner',message:'现在讨论另一件事'}),res(),[],f.root);
 assert.throws(()=>launch(f.ctx,f.root,readUnoJob(f.root,'job')),/已经结束/);
 await handleConversationDelete(f.ctx,null,res(),[],'owner',f.root);assert.equal(readMeta().deleted.owner,true);
});

test('单批建构有剩余范围时暂停，继续从下一批开始，不伪造 completed',async t=>{
 const f=fixture(t),job=readUnoJob(f.root,'job');job.phase='batch_done';job.batches=[['one'],['two']];job.completed_batches=[{index:0,pending:0}];saveCompileJob(f.root,job);
 await executeConstruction(f.ctx,f.root,job,new AbortController());let next=readCompileJob(f.root,'job');
 assert.equal(next.status,'paused');assert.equal(next.remaining_units,1);assert.equal(next.phase,'batch_done');
 const r=req({version:next.version});r.method='POST';r.url='/api/uno/jobs/job/resume';await handleUnoApi(f.ctx,r,res(),f.root);
 await wait(()=>[...f.sessions.values()].some(s=>s.running));next=readUnoJob(f.root,'job');assert.equal(next.batch_index,1);assert.equal(next.budget.calls,120);
});

test('审核活动回传主会话，主会话历史包含内部审核消息',async t=>{
 const f=fixture(t),stream=res();const off=subscribeGraphEvents('owner',stream);t.after(off);
 await f.start();const child=await f.handoff();f.emit(child,'step/start',{step:1});
 assert.match(stream.data,/work.updated/);assert.match(stream.data,new RegExp(child));
 f.sessions.get(child).append('assistant/message',{message:{content:[{type:'text',text:'审核保留反例'}]}});
 const out=res();await handleConversationGet(f.ctx,null,out,[],'owner',f.root);assert.match(out.data,/审核保留反例/);
});

test('普通聊天断连仍继续；显式暂停才退出，另一会话不受影响',async t=>{
 const f=fixture(t),session=f.add('quick');patchConversationExt('quick',{project_id:'test',thinking_mode:'quick'});
 let entered,finish;const ready=new Promise(r=>entered=r),done=new Promise(r=>finish=r);let signal;
 f.ctx.llm={async *stream(options){signal=options.signal;yield {type:'text-delta',text:'{"action":"answer","judgment":"问候"}\n你好'};entered();await Promise.race([done,new Promise(r=>signal.addEventListener('abort',r,{once:true}))]);signal.throwIfAborted();yield {type:'finish',reason:{kind:'stop'}};}};
 const out=res(),execution=handleChatStream(f.ctx,req({conversation_id:'quick',message:'你好'}),out,[],f.root);await ready;out.emit('close');
 assert.equal(signal.aborted,false);assert.equal(isQuickThinkingRunning('quick'),true);
 await assert.rejects(handleConversationDelete(f.ctx,null,res(),[],'quick',f.root),/停止/);
 await f.start();assert.equal(hasUnoJobRunning(f.root),true);finish();await execution;
 assert.equal(session.events.at(-1).data.status,'completed');assert.equal(isQuickThinkingRunning('quick'),false);assert.equal(hasUnoJobRunning(f.root),true);
});

test('拒绝跨任务停止以及运行中旧原生会话删除',async t=>{
 const f=fixture(t);await assert.rejects(handleWorkStop(f.ctx,req({action:'finish',expected_job_id:'other'}),res(),[],f.root,'owner'),/变化/);
 const legacy=f.add('legacy');legacy.running=true;patchConversationExt('legacy',{project_id:'test'});
 await assert.rejects(handleConversationDelete(f.ctx,null,res(),[],'legacy',f.root),/结束/);legacy.running=false;
});

test('单卡维护任务不再占用任务置顶，历史自动置顶在侧栏读取时清理',async t=>{
 const f=fixture(t),job=readUnoJob(f.root,'job');job.operation='isolated-card-repair';job.status='completed';job.phase='done';saveCompileJob(f.root,job);
 patchConversationExt('owner',{pinned:true});
 const out=res();await handleProjectsGet(f.ctx,null,out,[],f.root);
 assert.equal(readMeta().conversations.owner.pinned,false);
 patchConversationExt('owner',{pinned:true,pin_source:'user'});
 await handleProjectsGet(f.ctx,null,res(),[],f.root);
 assert.equal(readMeta().conversations.owner.pinned,true);
});

test('删除已停止的单卡维护对话会自动结束任务',async t=>{
 const f=fixture(t),job=readUnoJob(f.root,'job');job.operation='isolated-card-repair';job.status='partial';job.phase='done';job.detail='单卡仍有待处理问题。';saveCompileJob(f.root,job);
 patchConversationExt('owner',{pinned:true});
 await handleConversationDelete(f.ctx,null,res(),[],'owner',f.root);
 assert.equal(readUnoJob(f.root,'job').status,'ended');assert.equal(readMeta().conversations.owner.pinned,false);assert.equal(readMeta().deleted.owner,true);
});

test('建构只读讨论中的显式暂停绕过流持有的入口锁，原工作仍可恢复',async t=>{
 const f=fixture(t);let entered;const ready=new Promise(r=>entered=r);
 f.ctx.llm={async *stream({signal}){entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));signal.throwIfAborted();}};
 const execution=handleChatStream(f.ctx,req({conversation_id:'owner',message:'讨论尚未完成'}),res(),[],f.root);await ready;
 const out=res();await handleWorkStop(f.ctx,req({action:'pause',expected_job_id:'job'}),out,[],f.root,'owner');
 assert.equal(JSON.parse(out.data).pending,true);await execution;
 assert.equal(isQuickThinkingRunning('owner'),false);assert.equal(readUnoJob(f.root,'job').status,'paused');
 assert.equal((await workSnapshot(f.ctx,f.root)).items[0].can_continue,true);
});

test('原生取消已到 idle 但未广播 turn/end 时，核验实际退出后仍能释放任务',async t=>{
 const f=fixture(t);await f.start();const previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const call=JSON.parse(init.body);if(call.method==='session.cancel')f.sessions.get(call.payload.sessionId).running=false;return previous(url,init);};
 await f.pause();await wait(()=>!hasUnoJobRunning(f.root));assert.equal(readUnoJob(f.root,'job').status,'paused');
 assert.equal((await workSnapshot(f.ctx,f.root)).items[0].can_continue,true);
});

test('开始回执丢失后重试只返回原任务，暂停后重试也不自动恢复；同标识改范围被拒绝',async t=>{
 const f=fixture(t);mkdirSync(join(f.root,'01-Cards'));writeFileSync(join(f.root,'01-Cards/a.md'),'---\nid: a\ntitle: 合成卡\ntags: [观点]\n---\n仅用于验证生命周期的合成观点。');
 const input={request_id:'12345678-1234-1234-1234-123456789012',mode:'construct',notes:''};
 const first=await startUnoJob(f.ctx,f.root,input);await wait(()=>f.sessions.get(first.session_id).running);
 const replay=await startUnoJob(f.ctx,f.root,{notes:'',mode:'construct',request_id:input.request_id});
 assert.equal(replay.id,first.id);assert.equal(f.calls.filter(c=>c.method==='session.create').length,1);
 await assert.rejects(startUnoJob(f.ctx,f.root,{...input,notes:'扩大范围'}),/不能更改/);
 await handleChatCancel(f.ctx,req({conversation_id:first.session_id}),res(),[],f.root);f.emit(first.session_id,'turn/end',{reason:{kind:'cancelled'}});await wait(()=>!hasUnoJobRunning(f.root));
 const paused=readUnoJob(f.root,first.id),again=await startUnoJob(f.ctx,f.root,input);
 assert.equal(again.status,'paused');assert.equal(again.version,paused.version);assert.equal(hasUnoJobRunning(f.root),false);
});

test('进程失去执行句柄后读取恢复状态只标记中断，保留批次和收据，不发起模型调用',async t=>{
 const f=fixture(t),job=readUnoJob(f.root,'job');Object.assign(job,{status:'running',batch_index:1,phase:'organize',role:'reviewer',calls:[{status:'completed'},{status:'running'}],receipts:[{key:'saved-once'}]});saveCompileJob(f.root,job);
 recoverInterruptedUnoJobs(f.root);const restored=readUnoJob(f.root,'job');assert.equal(restored.status,'paused');assert.equal(restored.batch_index,1);assert.equal(restored.role,'reviewer');assert.equal(restored.calls.length,2);assert.equal(restored.calls[0].status,'completed');assert.equal(restored.calls[1].status,'interrupted');assert.match(restored.calls[1].error,/不计入成果/);assert.equal(restored.receipts[0].key,'saved-once');assert.equal(f.calls.length,0);
});

test('服务停止准备态拒绝运行中任务，并在封闸后阻止新任务启动',async t=>{
 const f=fixture(t);await f.start();assert.equal(prepareUnoShutdown().ready,false);
 await f.pause();await f.exit();assert.equal(prepareUnoShutdown().ready,true);
 const job=readUnoJob(f.root,'job');assert.throws(()=>launch(f.ctx,f.root,job),/准备停止或重启/);
 cancelUnoShutdown();
 assert.equal(prepareUnoShutdown({pendingMutations:1}).ready,false);
});
