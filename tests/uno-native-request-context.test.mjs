import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const moduleUrl=process.env.UNO_CONTEXT_MODULE?pathToFileURL(process.env.UNO_CONTEXT_MODULE):new URL('../packages/nexogenesis-tools/lib/uno/native-request-context.js',import.meta.url);
const {registerUnoRequestContext}=await import(moduleUrl);
const nativeEntry=process.env.UNO_DSH_ENTRY;
const nativeTest={skip:nativeEntry?false:'Set UNO_DSH_ENTRY for installed DSH rc.6 native invariant and mock transport tests'};
const nativeRequire=nativeEntry?createRequire(resolve(nativeEntry)):null;
const nativeImport=name=>import(pathToFileURL(nativeRequire.resolve(name)).href);

function fakeFixture() {
 const hooks=[];const ctx={on(name,fn){hooks.push({name,fn});return()=>hooks.splice(hooks.findIndex(h=>h.fn===fn),1);}};
 const raw=Object.freeze([{role:'user',content:[{type:'text',text:'old'}]},{role:'user',content:[{type:'text',text:'latest'}]}]);
 const session={id:'synthetic',deriveMessages(){return [...raw];}};
 const agent={session,async buildRequest(turn,step,tools,system,messages,signal){return {request:{sessionId:session.id,tools,system,messages,signal},preparedCall:{identity:'unchanged'}};}};
 const run=()=>hooks.find(h=>h.name==='agent/pre-step').fn({agent},()=>true);
 return {ctx,agent,session,run,raw};
}

test('native seam projects without mutating log, guards complete request and restores exact methods',async()=>{
 const f=fakeFixture(),before=JSON.stringify(f.raw),derive=f.session.deriveMessages,build=f.agent.buildRequest,seen=[];
 const dispose=registerUnoRequestContext(f.ctx,{project:messages=>({messages:messages.slice(-1),stats:{}}),assertBudget:request=>{assert.equal(request.system,'full-system');assert.equal(request.tools[0].name,'known');assert.equal(request.messages.length,1);return {input_bytes:100};},onMeasurement:event=>seen.push(event)});
 f.run();f.run();const result=await f.agent.buildRequest(1,1,[{name:'known'}],'full-system',f.session.deriveMessages(),new AbortController().signal);
 assert.equal(result.preparedCall.identity,'unchanged');assert.equal(JSON.stringify(f.raw),before);assert.equal(seen.length,1);assert.equal(seen[0].accepted,true);
 dispose();assert.equal(f.session.deriveMessages,derive);assert.equal(f.agent.buildRequest,build);assert.equal(f.session.deriveMessages().length,2);
});
test('unsupported or replaced methods fail closed; unrelated agents remain untouched',()=>{
 const f=fakeFixture();const dispose=registerUnoRequestContext(f.ctx,{isGoverned:()=>false});f.run();assert.equal(f.session.deriveMessages().length,2);dispose();
 const bad=fakeFixture();bad.agent.buildRequest=()=>{};const close=registerUnoRequestContext(bad.ctx);assert.throws(bad.run,{code:'UNO_CONTEXT_ADAPTER'});close();
 const altered=fakeFixture();const end=registerUnoRequestContext(altered.ctx,{project:messages=>({messages})});altered.run();altered.agent.buildRequest=()=>{};assert.throws(altered.run,{code:'UNO_CONTEXT_ADAPTER'});end();
});
test('complete request budget denial preserves code and never reaches prepared transport',async()=>{
 const f=fakeFixture(),measurements=[];let sent=0;
 f.agent.buildRequest=async function(turn,step,tools,system,messages,signal){return {request:{system,tools,messages},preparedCall:{stream(){sent++;}}};};
 const dispose=registerUnoRequestContext(f.ctx,{project:messages=>({messages}),assertBudget:()=>{throw Object.assign(new Error('too large'),{code:'UNO_CONTEXT_BUDGET',stats:{input_bytes:200}});},onMeasurement:event=>measurements.push(event)});f.run();
 await assert.rejects(f.agent.buildRequest(1,1,[],'system',f.session.deriveMessages()),{code:'UNO_CONTEXT_BUDGET'});assert.equal(sent,0);assert.equal(measurements[0].accepted,false);dispose();
});

async function nativeFixture(t,{project,assertBudget,onMeasurement,provider='synthetic',model='synthetic',cwd}={}){
 const [{Context},{AgentRegistry},{AgentLoop},{SessionStore},{LlmRuntime},{ToolRuntime},{SystemPrompt},llm]=await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-session','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-llm'].map(nativeImport));
 const ctx=new Context();new AgentRegistry(ctx);new SessionStore(ctx);new LlmRuntime(ctx);new SystemPrompt(ctx,{includeHarnessIdentity:false});new ToolRuntime(ctx,{});
 const loop=new AgentLoop(ctx,{agents:[]});const agent=loop.create('uno-governed',{provider,model,maxTokens:64},cwd?{cwd}:{});
 const violations=[];ctx.provide('invariants',{register(_name,install){return install(ctx,message=>{violations.push(message);throw Error(message);});}});
 const invariant=await nativeImport('@deepseek-ai/dsh-agent-loop/invariant');await invariant.apply(ctx);
 const dispose=registerUnoRequestContext(ctx,{project,assertBudget,onMeasurement});t.after(async()=>{dispose();await ctx.fiber.dispose();});
 return {ctx,agent,llm,violations};
}

test('installed native loop invariant consumes deterministic projection; snapshot and mock adapter agree',nativeTest,async t=>{
 const f=await nativeFixture(t,{project:messages=>({messages:messages.filter(m=>m.content?.[0]?.text!=='old-status')}),assertBudget:request=>({bytes:JSON.stringify(request.messages).length})});
 const seen=[],snapshots=[];
 f.ctx.on('llm/stream',(options,next)=>{snapshots.push(JSON.stringify(options.messages));return next();});
 f.ctx.llm.registerAdapter(['synthetic'],Object.assign(new f.llm.LlmAdapter(),{async describe(){return {provider:'synthetic',id:'synthetic',name:'synthetic'};},async *stream(options){seen.push(options);yield {type:'text-delta',text:'OK'};yield {type:'finish',reason:{kind:'stop'}};}}));
 f.agent.session.append('user/message',f.llm.createUserMessage({content:[{type:'text',text:'old-status'}],source:{kind:'plugin',plugin:'synthetic'}}),{surfaceOp:'append'});
 const before=JSON.stringify(f.agent.session.events);
 f.agent.followup(f.llm.createUserMessage({content:[{type:'text',text:'current-user'}],source:{kind:'human'}}));await f.agent.whenIdle();
 assert.equal(seen.length,1,JSON.stringify(f.agent.session.events.filter(e=>e.type==='turn/end')));assert.equal(f.violations.length,0);assert.ok(Object.isFrozen(seen[0]));assert.equal(snapshots[0],JSON.stringify(seen[0].messages));assert.doesNotMatch(snapshots[0],/old-status/);assert.match(JSON.stringify(f.agent.session.events),/old-status/);assert.equal(JSON.stringify(f.agent.session.events.slice(0,JSON.parse(before).length)),before);
});

test('installed native loop blocks oversized full input before snapshot, adapter or debit',nativeTest,async t=>{
 const f=await nativeFixture(t,{project:messages=>({messages}),assertBudget:request=>{throw Object.assign(Error('input too large'),{code:'UNO_CONTEXT_BUDGET'});}});let sent=0,snapshots=0;
 f.ctx.on('llm/stream',(options,next)=>{snapshots++;return next();});
 f.ctx.llm.registerAdapter(['synthetic'],Object.assign(new f.llm.LlmAdapter(),{async describe(){return {provider:'synthetic',id:'synthetic',name:'synthetic'};},async *stream(){sent++;yield {type:'finish',reason:{kind:'stop'}};}}));
 f.agent.followup(f.llm.createUserMessage({content:[{type:'text',text:'synthetic oversized input'}],source:{kind:'human'}}));await f.agent.whenIdle();
 assert.equal(sent,0);assert.equal(snapshots,0);assert.match(f.agent.session.events.findLast(e=>e.type==='turn/end').data.reason.error.message,/UNO_CONTEXT_BUDGET/);
});





test('installed Kimi SDK receives projection and can replay prior assistant state on the next turn',nativeTest,async t=>{
 const f=await nativeFixture(t,{provider:'kimi-coding',model:'kimi-for-coding',project:messages=>({messages:messages.filter(m=>m.content?.[0]?.text!=='old-status')}),assertBudget:request=>({bytes:JSON.stringify(request.messages).length})});
 const {PiAiAdapter}=await nativeImport('@deepseek-ai/dsh-llm-pi-ai');
 const {kimiCodingProvider}=await import(new URL('../../../@earendil-works/pi-ai/dist/providers/kimi-coding.js',pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'))));
 const original=globalThis.fetch,wire=[];t.after(()=>{globalThis.fetch=original;});
 const events=[{type:'message_start',message:{id:'synthetic-response',type:'message',role:'assistant',content:[],model:'kimi-for-coding',usage:{input_tokens:5,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
 globalThis.fetch=async(input,init)=>{
   assert.equal(String(input),'https://api.kimi.com/coding/v1/messages');
   const body=JSON.parse(init.body);wire.push(body);assert.doesNotMatch(JSON.stringify(body.messages),/old-status/);
   return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const profiles=new Map([['kimi-coding',{provider:'kimi-coding',displayName:'Kimi Code',piProvider:kimiCodingProvider(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:1000}]]);
 f.ctx.llm.registerAdapter(['kimi-coding'],new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>'synthetic-key-only'}));
 f.agent.session.append('user/message',f.llm.createUserMessage({content:[{type:'text',text:'old-status'}],source:{kind:'plugin',plugin:'synthetic'}}),{surfaceOp:'append'});
 for(const text of ['first request','follow-up']){
   f.agent.followup(f.llm.createUserMessage({content:[{type:'text',text}],source:{kind:'human'}}));await f.agent.whenIdle();
   assert.equal(f.agent.session.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
 }
 assert.equal(wire.length,2);assert.equal(f.violations.length,0);assert.ok(wire[1].messages.some(m=>m.role==='assistant'));assert.match(JSON.stringify(f.agent.session.events),/old-status/);assert.ok(f.agent.session.events.filter(e=>e.type==='assistant/message').every(e=>e.data.message.source.replayState.kind==='pi-ai'));
});

test('default governance survives three native Kimi turns with real runtime snapshots and redundant tool history',nativeTest,async t=>{
 const f=await nativeFixture(t,{provider:'kimi-coding',model:'kimi-for-coding'});
 const {getUnoRequestGovernance}=await import(new URL('./request-context.js',moduleUrl));
 const {PiAiAdapter}=await nativeImport('@deepseek-ai/dsh-llm-pi-ai');
 const {kimiCodingProvider}=await import(new URL('../../../@earendil-works/pi-ai/dist/providers/kimi-coding.js',pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'))));
 let step=0;f.ctx.systemPrompt.context({name:'uno-task-progress',order:100,text:()=> 'UNO 当前执行状态（替代旧进度，不改变知识规范）：\n'+JSON.stringify({id:'native-evidence',step:++step})});
 const large='机制成立有条件。'.repeat(700),args={operation_id:'write',id:'card',body:large};
 function pair(id,name,args,value){
   const message=f.llm.createAssistantMessage({content:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],source:{provider:'kimi-coding',model:'kimi-for-coding',replayState:{kind:'pi-ai',version:1,api:'anthropic-messages',provider:'kimi-coding',model:'kimi-for-coding',stopReason:'toolUse',blocks:[{type:'tool-call'}]}}});
   f.agent.session.append('assistant/message',{turn:0,step:0,message},{surfaceOp:'append'});
   f.agent.session.append('tool/result',{turn:0,step:0,message:f.llm.createToolResultMessage({callId:id,content:[{type:'text',text:JSON.stringify(value)}],isError:value.ok===false})},{surfaceOp:'append'});
 }
 pair('bad-batch','compile_batch',{operations:[{tool:'compile_edit',args}]},{ok:false,error:{code:'INVALID_ARGUMENTS',message:'invalid batch'}});
 pair('saved-edit','compile_edit',args,{ok:true,id:'card',revision:'r1'});
 const readArgs={ref:'05-Buffer/_index/source-1.md'},readValue={ok:true,ref:readArgs.ref,revision:'r1',body:'关键反证：制度环境不同时结论会反转。'+large};
 pair('read-one','compile_read_material',readArgs,readValue);pair('read-two','compile_read_material',readArgs,readValue);
 const before=JSON.stringify(f.agent.session.events),wire=[],snapshots=[],original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 f.ctx.on('llm/stream',(options,next)=>{snapshots.push({messages:options.messages,stats:getUnoRequestGovernance(options.messages)});return next();});
 globalThis.fetch=async(input,init)=>{
   assert.equal(String(input),'https://api.kimi.com/coding/v1/messages');wire.push(JSON.parse(init.body));
   const events=[{type:'message_start',message:{id:'synthetic-response',type:'message',role:'assistant',content:[],model:'kimi-for-coding',usage:{input_tokens:5,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
   return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 };
 const app=process.env.UNO_REPO_ROOT?pathToFileURL(process.env.UNO_REPO_ROOT+'/'):new URL('../',import.meta.url);
 const transportModule=process.env.UNO_KIMI_CONTEXT_MODULE?pathToFileURL(process.env.UNO_KIMI_CONTEXT_MODULE):new URL('packages/nexogenesis-web-host/lib/native-kimi-budget.js',app);
 const {registerNativeKimiBudget}=await import(transportModule);const disposeTransport=registerNativeKimiBudget(f.ctx);t.after(disposeTransport);
 const profiles=new Map([['kimi-coding',{provider:'kimi-coding',displayName:'Kimi Code',piProvider:kimiCodingProvider(),configuredMaxTokens:new Map(),streamIdleTimeoutMs:1000}]]);
 f.ctx.llm.registerAdapter(['kimi-coding'],new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>'synthetic-key-only'}));
 for(let n=0;n<3;n++){
   f.agent.followup(f.llm.createUserMessage({content:[{type:'text',text:'继续本阶段 '+n}],source:{kind:'human'}}));await f.agent.whenIdle();
   assert.equal(f.agent.session.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed',JSON.stringify(f.agent.session.events.findLast(e=>e.type==='turn/end')));
 }
 assert.equal(wire.length,3);assert.equal(f.violations.length,0);assert.equal(JSON.stringify(f.agent.session.events.slice(0,JSON.parse(before).length)),before);
 for(const [index,snapshot] of snapshots.entries()){
   assert.ok(snapshot.stats.wire_bytes>0);assert.equal(snapshot.stats.removed_progress,index);assert.equal(snapshot.stats.compacted_failed_calls,1);assert.equal(snapshot.stats.deduplicated_results,1);assert.ok(snapshot.stats.saved_bytes>20000);
   assert.equal(snapshot.messages.filter(m=>m.source?.sections?.some(s=>s.name==='uno-task-progress')).length,1);assert.match(JSON.stringify(wire[index].messages),/关键反证/);assert.match(JSON.stringify(wire[index].messages),/duplicate_result/);assert.match(JSON.stringify(wire[index].messages),/repeated_rejected_arguments/);
 }
 assert.equal(f.agent.session.events.filter(e=>e.type==='user/message'&&e.data.source?.sections?.some(s=>s.name==='uno-task-progress')).length,3);
});


test('default complete budget rejects before Kimi debit and keeps the original oversized source log',nativeTest,async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'uno-context-ledger-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const app=process.env.UNO_REPO_ROOT?pathToFileURL(process.env.UNO_REPO_ROOT+'/'):new URL('../',import.meta.url);
 const budget=await import(new URL('packages/nexogenesis-tools/lib/uno/request-budget.js',app));
 const {registerNativeKimiBudget}=await import(new URL('packages/nexogenesis-web-host/lib/native-kimi-budget.js',app));
 const f=await nativeFixture(t,{provider:'kimi-coding',model:'kimi-for-coding',cwd:root});
 budget.initializeProviderBudget(root,'budget-test',{limit:4});budget.bindProviderBudgetSession(root,{jobId:'budget-test',sessionId:f.agent.session.id,packageId:'test',stageId:'author-1',role:'author',stageLimit:4,reviewReserve:0});
 let sent=0;const target={fetch:async()=>{sent++;throw Error('must not dispatch');}};
 const dispose=registerNativeKimiBudget(f.ctx,{transportTarget:target});t.after(dispose);
 f.ctx.llm.registerAdapter(['kimi-coding'],Object.assign(new f.llm.LlmAdapter(),{async *stream(){await target.fetch('https://api.kimi.com/coding/v1/messages',{method:'POST'});yield {type:'finish',reason:{kind:'stop'}};}}));
 f.agent.followup(f.llm.createUserMessage({content:[{type:'text',text:'保留原文反证：'+'A'.repeat(140000)}],source:{kind:'human'}}));await f.agent.whenIdle();
 assert.equal(sent,0);assert.equal(budget.getProviderBudget(root,'budget-test').used,0);assert.match(f.agent.session.events.findLast(e=>e.type==='turn/end').data.reason.error.message,/UNO_CONTEXT_BUDGET/);assert.match(JSON.stringify(f.agent.session.events),/A{140000}/);
});

