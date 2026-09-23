import {defaultConstructionControls} from '../packages/nexogenesis-tools/lib/construction-controls.js';
import {writeDomainFixture} from './fixtures/domain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {handleUnoApi,hasUnoJobRunning} from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import {readCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {runCompileTool} from '../packages/nexogenesis-tools/lib/uno/agent.js';
import {loadCards} from '../packages/nexogenesis-tools/lib/cards.js';
import {sha,unoMarkdown} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {prepareBookSource} from '../packages/nexogenesis-tools/lib/uno/book-store.js';
import {readDraft} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {getProviderBudget,reserveProviderRequest,settleProviderRequest} from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import {synchronizeUnassignedPool} from '../packages/nexogenesis-tools/lib/uno/domain-governance.js';
import {conversationExt} from '../packages/nexogenesis-web-host/lib/meta.js';

// Native transport and replies only are simulated. Real local HTTP handlers,
// first-pack delivery, tools, Gateway, planner, recovery and budget all run.
const response=()=>Object.assign(new EventEmitter(),{data:'',headersSent:false,writableEnded:false,
  writeHead(code){this.code=code;this.headersSent=true;},write(value){this.data+=value;},end(value=''){this.data+=value;this.writableEnded=true;}});
const wait=async check=>{for(let i=0;i<600;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Timed out waiting for synthetic host');};
function fixture(t,{ids=['a'],missingSource=false,bookSourceMode=null,longSource=false,repairReview=false,repairExtraField=false,repairLeavesIssue=false,deferDomain=false,interruptDomainOnce=false,interruptReviewOnce=false,directRelation=false,repairDirectRelation=false,invalidSourceRelation=false,truncateStrategyTail=false,dynamicWeaving=false,malformedReviewOnce=false,unsupportedRelation=false}={}){
  const root=mkdtempSync(join(tmpdir(),'uno-direction-host-')),oldHome=process.env.DSH_HOME,oldFetch=globalThis.fetch;
  process.env.DSH_HOME=root;mkdirSync(join(root,'00-Inbox'));mkdirSync(join(root,'01-Cards'));mkdirSync(join(root,'03-Archive'));
  const quote='只有在限定条件下，市场竞争机制才成立。';let source='03-Archive/source.md';
  if(bookSourceMode){
    const inbox='00-Inbox/合成图书.md',text=longSource?('无关背景。'.repeat(4000))+'\n'+quote+'\n'+('后续材料。'.repeat(8000)):quote+'\n\n第二段保留关系成立的边界。';writeFileSync(join(root,inbox),text);
    const info=prepareBookSource(root,{source:inbox,prepared:{fingerprint:sha(Buffer.from(text)),format:'markdown',title:'合成图书',chapters:[{title:'第一章',locator:'行 1–3',text}],warnings:[]}});
    source=bookSourceMode==='legacy'?info.units[0].ref.replace(/^05-Buffer\//,'03-Archive/'):info.units[0].ref;
    if(longSource)source+='#char-0-'+info.units[0].chars;
  }else if(!missingSource){
    const sourceBody=longSource?quote+'\n'+('长来源正文。'.repeat(14000)):quote;
    writeFileSync(join(root,source),unoMarkdown({title:'合成来源'},sourceBody));
  }
  const cardPath=id=>join(root,'01-Cards',id+'.md');
  for(const id of ids)writeFileSync(cardPath(id),unoMarkdown({schema:'uno-card-v4',id,title:'市场竞争条件 '+id,summary:'市场竞争机制需要限定条件',type:'mechanism',domains:[],sources:[source],boundary:'限定条件',lifecycle:'active',relations:[]},quote+'对象 '+id+' 保留独立表述。'));
  const sessions=new Map(),listeners=new Map(),prompts=[],rpc=[],turns=[],directCalls=[];let id,domainInterrupted=false,reviewInterrupted=false,malformedReviewReturned=false;
  const ctx={webServer:{port:9996},settings:{get:()=>({provider:'deepseek',model:'deepseek-v4-flash',thinking_mode:'disabled'})},
    get(name){
      if(name==='sessions')return {get:key=>sessions.get(key),flush:async()=>{}};
      if(name==='llm')return {stream:async function*(options){
        directCalls.push(options);const reservation=reserveProviderRequest(ctx,options);
        const phase=options.nexoPrompt?.phase;
        if(phase==='single-card-domain-review'&&interruptDomainOnce&&!domainInterrupted){domainInterrupted=true;settleProviderRequest(reservation,{state:'failed',error:'合成预算停点'});throw Object.assign(new Error('本任务供应商请求额度已用尽；已有响应仍可保存和交接。'),{code:'UNO_PROVIDER_BUDGET'});}
        if(phase==='construction-review'&&interruptReviewOnce&&!reviewInterrupted){reviewInterrupted=true;settleProviderRequest(reservation,{state:'truncated'});throw Object.assign(new Error('模型响应未完整结束：max-tokens。'),{code:'MODEL_OUTPUT_TRUNCATED'});}
        const body='## 起点与条件\n\n来源把政府行为解释限定为官员在制度约束下的个体选择。\n\n## 传导链条\n\n官员依据个人激励作出选择，多个选择经组织规则聚合为政府行为。\n\n## 结果\n\n政府层面的结果可以由受约束的个体行动及其聚合过程解释。\n\n## 失效边界\n\n当组织规则本身不能还原为个体选择，或来源没有给出聚合路径时，这一解释不能直接外推。\n\n## 来源与证据边界\n\n仅依据当前绑定来源中的限定条件，不代表所有市场或政府情境。';
        const repairedBody=repairLeavesIssue?body:body.replace('不能直接外推','必须停止外推');
        const rewrite={action:'rewrite',card:{title:'个体选择聚合为组织行为的机制',type:'mechanism',summary:phase==='single-card-repair'&&repairExtraField?'局部修复不应改写这条摘要。':'个体激励和组织规则如何把官员选择聚合为政府行为。',boundary:'只适用于来源明确给出个体选择与聚合路径的情境。',body:phase==='single-card-repair'?repairedBody:body},note:'重写个体选择经组织规则聚合为整体行为的知识对象。'};
        const requestText=options.messages?.[0]?.content?.[0]?.text??'';
        const requestData=requestText.includes('\n{')?JSON.parse(requestText.slice(requestText.indexOf('{'))):null;
        const phaseIds=phase==='construction-response-recovery'?(requestData?.expected_ids??ids)
          :phase==='construction-strategy'?(dynamicWeaving?requestData.candidates.slice(0,2).map(row=>row.id):ids)
          :requestData?.package?.card_ids??ids;
        const value=phase==='construction-strategy'?{
          strategy:{goal:'比较市场竞争的成立条件',expected_improvement:'保留条件并避免弱关系',operations:['relation_add'],decision_rules:['只选择当前问题需要的卡片'],evidence_requirements:['核对完整卡片正文'],stop_conditions:['证据不足即保留原样']},
          selection:{selected:phaseIds.map((id,index)=>({id,role:index?'comparison':'anchor',reason:'属于用户明确选择的市场竞争条件卡片',required_evidence:['完整正文']})),excluded:[],packages:[{card_ids:phaseIds,purpose:'比较成立条件',reason:'同一问题下的明确对照'}]}
        }:phase==='construction-author'?{decisions:phaseIds.map((id,index)=>(directRelation||repairDirectRelation||invalidSourceRelation)&&index===0?{id,status:'proposed',note:'第二张卡构成第一张卡的条件对照。',changes:{relations:[{target:phaseIds[1],type:'contrast',note:'两张卡对市场竞争成立条件给出可比较的限定。',basis:invalidSourceRelation?'source':'navigation',origin:invalidSourceRelation?'document':'navigation'}]},evidence:invalidSourceRelation?[{ref:source,quote}]:[]}:{id,status:'unchanged',note:'当前正文已经保留限定条件，没有有据修改。',changes:{},evidence:[]}),note:directRelation||repairDirectRelation||invalidSourceRelation?'提出一条条件对照。':'本组保留原样'}
          :phase==='construction-review'&&malformedReviewOnce&&!malformedReviewReturned?(malformedReviewReturned=true,{reviews:phaseIds.map((id,index)=>index===0?{id,decision:'reject',note:'两端正文不足以支持该关系。',issues:['删除候选关系并保持独立。']}:{id,decision:'unchanged 成立，只读端点不修改',note:'只读端点保持不变。'}),note:'候选关系不成立。'})
          :phase==='construction-response-recovery'&&malformedReviewOnce?{reviews:phaseIds.map((id,index)=>index===0?{id,decision:'reject',note:'两端正文不足以支持该关系。',issues:['删除候选关系并保持独立。']}:{id,decision:'approve',note:'只读端点保持不变。',issues:[]}),note:'候选关系不成立。'}
          :phase==='construction-repair'&&unsupportedRelation?{decisions:[{id:phaseIds[0],status:'unchanged',note:'已撤销缺少依据的候选关系，保持当前卡独立。',changes:{},evidence:[]}],note:'没有可靠关系可保留。'}
          :phase==='construction-verify'&&unsupportedRelation?{reviews:[{id:phaseIds[0],decision:'approve',note:'缺少依据的关系已撤销，保持独立足以结算。',issues:[]}],note:'保留独立通过复核。'}
          :phase==='construction-review'&&repairDirectRelation?{reviews:phaseIds.map((id,index)=>index===0?{id,decision:'reject',note:'关系可以成立，但说明需明确比较边界。',issues:['在关系说明中补充只比较成立条件，不外推到其他机制。']}:{id,decision:'approve',note:'只读端点保持不变。',issues:[]}),note:'局部修正关系说明后可发布。'}
          :phase==='construction-repair'&&repairDirectRelation?{decisions:[{id:ids[0],status:'proposed',note:'仅修正关系说明的比较边界。',changes:{relations:[{target:ids[1],type:'contrast',note:'两张卡只对市场竞争成立条件给出可比较的限定，不外推到其他机制。',basis:'navigation',origin:'navigation'}]},evidence:[]}],note:'已补充关系边界。'}
          :phase==='construction-verify'&&repairDirectRelation?{reviews:[{id:ids[0],decision:'approve',note:'关系说明已限定比较范围。',issues:[]}],note:'局部修复通过。'}
          :phase==='construction-repair'&&invalidSourceRelation?{decisions:[{id:ids[0],status:'proposed',note:'来源未交付，改为只由两端卡片支持的导航对照。',changes:{relations:[{target:ids[1],type:'contrast',note:'两张卡对市场竞争成立条件给出可比较的限定。',basis:'navigation',origin:'navigation'}]},evidence:[]}],note:'已修正关系证据类型。'}
          :phase==='construction-review'?{reviews:phaseIds.map(id=>({id,decision:'approve',note:'保留结论与当前卡片正文一致。',issues:[]})),note:'独立审核通过保留结论'}
          :['single-card-rewrite','single-card-repair'].includes(phase)?rewrite
          :phase==='single-card-domain-review'?(deferDomain?{decision:'defer',domains:[],reason:'当前合成卡与既有领域边界不足以可靠匹配。'}:{decision:'assign',domains:['economics'],reason:'卡片讨论受约束的个体选择如何聚合为经济组织行为，符合信息与经济机制领域边界。'})
          :phase==='single-card-review'&&repairReview
            ?{decision:'repair',issues:[{field:'body',message:'失效边界需要改成明确停止外推的条件。',evidence:'来源只支持限定条件下的结论。'}],note:'主体结构通过，修复失效边界措辞。'}
            :{decision:'approve',issues:[],note:'候选已按来源重建机制链条、边界和证据范围。'};
        const serialized=JSON.stringify(value);
        yield {type:'text-delta',text:phase==='construction-strategy'&&truncateStrategyTail?serialized.slice(0,-1):serialized};yield {type:'finish',reason:{kind:'stop'}};
        settleProviderRequest(reservation,{state:'completed',usage:{inputTokens:100,outputTokens:40}});
      }};
    },
    on(name,fn){const group=listeners.get(name)??new Set();listeners.set(name,group);group.add(fn);return()=>group.delete(fn);}};
  const emit=(sessionId,type,data)=>{if(type==='turn/end')sessions.get(sessionId).running=false;for(const fn of [...listeners.get('session/event')??[]])fn({id:sessionId},{type,data});};
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).hostname,'127.0.0.1','No model/provider request is allowed');
    const call=JSON.parse(init.body);rpc.push(call);let value={};
    if(call.method==='session.list')value={items:[...sessions.values()]};
    else if(call.method==='session.create'){
      const sessionId='direction-'+(sessions.size+1);sessions.set(sessionId,{id:sessionId,sessionId,header:{cwd:root},events:[],running:false,
        append(type,data){this.events.push({type,data,time:Date.now()});}});value={sessionId};
    }else if(call.method==='session.prompt'){sessions.get(call.payload.sessionId).running=true;prompts.push(call.payload);}
    else if(call.method==='session.history')value={events:sessions.get(call.payload.sessionId)?.events??[]};
    else if(call.method==='session.cancel')queueMicrotask(()=>emit(call.payload.sessionId,'turn/end',{reason:{kind:'cancelled'}}));
    return {json:async()=>({type:'server-response',result:{ok:true,value}})};
  };
  const job=()=>readCompileJob(root,id),budget=()=>getProviderBudget(root,id);
  async function api(path,body={}){const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{url:'/api/uno'+path,method:'POST',headers:{'content-type':'application/json'}}),res=response();await handleUnoApi(ctx,req,res,root);return JSON.parse(res.data);}
  async function start(options={}){const result=await api('/jobs',{mode:'construct',card_ids:ids,notes:'检查市场竞争的限定条件',continuous:true,external_images:false,delivery:'auto',budget_calls:20,orchestration_profile:'bounded-workflow-v1',construction_profile:'direction-driven-v1',...options});id=result.id;return result;}
  async function recompile(){writeDomainFixture(root,'economics','信息与经济机制');synchronizeUnassignedPool(root,{card_ids:[ids[0]]});const result=await api('/unassigned/'+encodeURIComponent(ids[0])+'/recompile',{});id=result.id;return result;}
  async function organize(){writeDomainFixture(root,'economics','信息与经济机制');synchronizeUnassignedPool(root,{card_ids:[ids[0]]});const result=await api('/unassigned/'+encodeURIComponent(ids[0])+'/organize',{});id=result.id;return result;}
  async function next(phase='read',role='author'){await wait(()=>prompts.length||!hasUnoJobRunning(root));assert.ok(prompts.length,'Host stopped: '+job().detail);const prompt=prompts.shift();assert.equal(job().phase,phase);assert.equal(job().role,role);return prompt;}
  const payload=prompt=>JSON.parse(prompt.content.find(block=>block.type==='text'&&block.text.startsWith('{')).text);
  async function answer(prompt,actions){
    const sessionId=prompt.sessionId,options={sessionId,provider:'nexo-deepseek',model:'deepseek-v4-flash',messages:[{role:'user',content:prompt.content}],signal:new AbortController().signal};
    const reservation=reserveProviderRequest(ctx,options),state=job();turns.push({sessionId,phase:state.phase,role:state.role,batch:state.batch_index});emit(sessionId,'step/start',{step:1,turn:turns.length});
    let stream=(async function*(){yield {type:'tool-call-delta',name:'synthetic-response',argumentsDelta:'{}'};})();
    for(const fn of [...listeners.get('llm/stream')??[]]){const previous=stream;stream=fn(options,()=>previous);}for await(const ignored of stream){}
    await actions((name,args)=>runCompileTool(root,sessionId,name,args),payload(prompt));
    settleProviderRequest(reservation,{state:'completed',usage:{inputTokens:10,outputTokens:1}});
    emit(sessionId,'assistant/message',{message:{content:[{type:'text',text:'Synthetic completed.'}]}});emit(sessionId,'turn/end',{reason:{kind:'completed'}});
  }
  async function conclude(status='unchanged',note='已检查当前正文，限定条件明确，保留独立对象。'){
    const prompt=await next();await answer(prompt,async(tool,pack)=>{const result=await tool('compile_finish',{phase:'organize',summary:note,conclusions:pack.task.scope.map(id=>({id,status,note}))});assert.equal(result.ready,true);});
  }
  async function deferMissing(){
    const prompt=await next();await answer(prompt,async(tool,pack)=>{
      await assert.rejects(Promise.resolve().then(()=>tool('compile_finish',{phase:'organize',summary:'不应接受',conclusions:pack.task.scope.map(id=>({id,status:'unchanged',note:'只有正文不能证明缺失来源完整'}))})),/来源或关系端点缺失/);
      assert.notEqual(job().handoff_requested,true);assert.equal(job().construction_results?.[job().batch_index],undefined);
      const result=await tool('compile_finish',{phase:'organize',summary:'来源缺失，明确延期',conclusions:pack.task.scope.map(id=>({id,status:'deferred',note:'来源文件缺失，不能完整核对，等待恢复来源'}))});assert.equal(result.ready,true);
    });
    const state=await idle();assert.equal(state.status,'partial');assert.equal(state.completed_batches[0].pending,1);return state;
  }
  async function idle(){await wait(()=>!hasUnoJobRunning(root));return job();}
  t.after(async()=>{if(id&&hasUnoJobRunning(root)){await api('/jobs/'+id+'/cancel',{version:job().version});await idle();}globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(root,{recursive:true,force:true});});
  return {root,source,quote,cardPath,job,budget,api,start,recompile,organize,next,payload,answer,conclude,deferMissing,idle,prompts,rpc,turns,directCalls};
}

for(const cardId of ['zhou tou-example','中文卡片（案例）','literal%20value'])for(const operation of ['recompile','organize']){
  test(`unassigned-card ${operation} preserves encoded stable ID ${cardId}`,async t=>{
    const f=fixture(t,{ids:[cardId]});await f[operation]();const final=await f.idle();
    assert.equal(final.status,'completed');assert.deepEqual(final.scope,[cardId]);
    assert.deepEqual(loadCards(f.root).get(cardId).meta.domains,['economics']);
    assert.equal(loadCards(f.root).size,1);assert.equal(f.budget().used,operation==='recompile'?3:1);
  });
}

test('unassigned-card domain-only route assigns an existing domain without rewriting content',async t=>{
  const f=fixture(t);const before=loadCards(f.root).get('a'),created=await f.organize();assert.equal(conversationExt(created.session_id).pinned,false);const final=await f.idle(),after=loadCards(f.root).get('a');
  assert.equal(final.status,'completed');assert.equal(final.operation,'unassigned-card-domain');assert.equal(final.single_card_domain_contract,'single-card-domain-assignment-v1');
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-domain-review']);assert.equal(f.budget().used,1);
  assert.equal(after.meta.title,before.meta.title);assert.equal(after.body,before.body);assert.deepEqual(after.meta.domains,['economics']);
  assert.equal(synchronizeUnassignedPool(f.root,{card_ids:['a']}).unassigned.a,undefined);
});

test('unassigned-card route creates a forced single-card compile-and-review job',async t=>{
  const f=fixture(t);const created=await f.recompile(),state=f.job();
  assert.equal(conversationExt(created.session_id).pinned,false);
  assert.equal(created.id,state.id);assert.equal(state.operation,'unassigned-card-recompile');assert.deepEqual(state.scope,['a']);
  assert.equal(state.single_card_recompile_contract,'single-card-source-rewrite-v2');assert.equal(state.construction_profile,undefined);assert.deepEqual(state.batches,[['a']]);
  assert.equal(state.card_classification,'ordered-single-type-and-domains-v2');
  assert.match(state.title,/^单卡重编译/);assert.match(state.notes,/完整重写并独立审核/);
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(f.turns.length,0);assert.equal(f.directCalls.length,3);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-rewrite','single-card-review','single-card-domain-review']);
  assert.ok(f.directCalls.every(call=>call.tools.length===0));
  assert.ok(f.directCalls.every(call=>Array.from(call.system+call.messages.flatMap(message=>message.content).map(block=>block.text).join('')).length<12000),'A single-card request must stay far below the former cumulative prompt');
  assert.equal(loadCards(f.root).get('a').meta.title,'个体选择聚合为组织行为的机制');assert.deepEqual(loadCards(f.root).get('a').meta.domains,['economics']);assert.equal(f.budget().used,3);
  assert.equal(synchronizeUnassignedPool(f.root,{card_ids:['a']}).unassigned.a,undefined);
});

test('strategy-driven construction plans first and uses stateless direct author and reviewer requests',async t=>{
  const f=fixture(t,{ids:['a','b']});await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});const final=await f.idle();
  assert.equal(final.workflow,'uno-construction-v1');assert.equal(final.construction_profile,'strategy-driven-v2');
  assert.equal(final.strategy_contract,'construction-strategy-v1');assert.equal(final.construction_review_policy,'construction-review-v2');
  assert.equal(final.status,'completed');assert.deepEqual(final.scope,['a','b']);assert.equal(final.construction_plan.packages.length,1);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-strategy','construction-author','construction-review']);
  assert.ok(f.directCalls.every(call=>call.tools.length===0&&call.messages.length===1));assert.equal(f.prompts.length,0);
  assert.equal(f.budget().used,3);assert.deepEqual(final.completed_batches[0].published,[]);
  assert.deepEqual(Object.values(final.construction_results[0]).map(row=>row.status),['unchanged','unchanged']);
});

test('continuous relation weaving replans from the updated graph in small waves',async t=>{
  const f=fixture(t,{ids:['a','b','c','d','e'],dynamicWeaving:true});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const final=await f.idle();
  assert.equal(final.status,'completed');assert.equal(final.relation_weaving.contract,'random-focus-semantic-retrieval-v2');
  assert.equal(final.relation_weaving.rounds.length,5);assert.ok(final.batches.every(batch=>batch.length<=6));
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),Array.from({length:5},()=>['construction-author','construction-review']).flat());
  assert.equal(final.relation_weaving.last_diagnosis.counts.unreviewed,0);
  assert.equal(final.relation_weaving.last_diagnosis.counts.isolated,5,'保留独立与没有检查必须分开记录');
});

test('single-wave relation weaving pauses and explicit resume replans from the latest graph',async t=>{
  const f=fixture(t,{ids:['a','b','c'],dynamicWeaving:true});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections'),continuous:false});
  const paused=await f.idle();assert.equal(paused.status,'paused');assert.equal(paused.relation_weaving.rounds.length,1);
  assert.equal(paused.relation_weaving.needs_replan,true);assert.equal(paused.relation_weaving.last_diagnosis.counts.unreviewed,2);
  await f.api('/jobs/'+paused.id+'/resume',{version:paused.version,budget_calls:20});
  const second=await f.idle();assert.equal(second.status,'paused');assert.equal(second.relation_weaving.rounds.length,2);
  await f.api('/jobs/'+second.id+'/resume',{version:second.version,budget_calls:20});
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(final.relation_weaving.rounds.length,3);
  assert.equal(final.relation_weaving.last_diagnosis.counts.unreviewed,0);
});

test('strategy-driven construction reuses an unambiguous tail-closed strategy response',async t=>{
  const f=fixture(t,{ids:['a','b'],truncateStrategyTail:true});await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});const final=await f.idle();
  assert.equal(final.status,'completed');assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-strategy','construction-author','construction-review']);
  assert.deepEqual(final.calls[0].response_recovery,{contract:'construction-json-tail-close-v1',appended:'}'});assert.equal(f.budget().used,3);
});

test('strategy-driven relation proposal passes diff-aware staging, independent review and Gateway publication',async t=>{
  const f=fixture(t,{ids:['a','b'],directRelation:true});await f.start({card_ids:['a'],construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});const final=await f.idle();
  assert.equal(final.status,'completed');assert.deepEqual(final.completed_batches[0].published,['a']);
  const relation=loadCards(f.root).get('a').meta.relations[0];assert.deepEqual(relation,{target:'b',type:'contrast',note:'两张卡对市场竞争成立条件给出可比较的限定。',basis:'navigation',origin:'navigation'});
  assert.equal(readDraft(f.root,final.id+'-b0','a').state,'published');assert.equal(f.budget().used,2);
});

test('review repair keeps the frozen relation endpoint in scope while only rewriting the rejected card',async t=>{
  const f=fixture(t,{ids:['a','b'],repairDirectRelation:true});
  await f.start({card_ids:['a'],construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const final=await f.idle();assert.equal(final.status,'completed',final.detail);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-author','construction-review','construction-repair','construction-verify']);
  assert.deepEqual(final.completed_batches[0].published,['a']);
  const relation=loadCards(f.root).get('a').meta.relations[0];
  assert.equal(relation.target,'b');assert.match(relation.note,/不外推到其他机制/);
});

test('whole-library relation weaving starts without explicit card ids and uses two model calls for one successful bridge',async t=>{
  const f=fixture(t,{ids:['a','b'],directRelation:true});
  const created=await f.start({card_ids:undefined,construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const final=await f.idle();
  assert.equal(created.requested_card_ids.length,0);assert.equal(final.status,'completed',JSON.stringify({detail:final.detail,rounds:final.relation_weaving?.rounds,completed:final.completed_batches,direct:final.direct_work,phases:f.directCalls.map(call=>call.nexoPrompt.phase)}));
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-author','construction-review']);
  assert.equal(f.budget().used,2);assert.equal(final.completed_batches[0].published.length,1);
  assert.ok(f.directCalls.every(call=>call.construction_context.other_chars<12000));
  assert.ok(f.directCalls.every(call=>!call.messages[0].content[0].text.includes('main_component_ids')));
});

test('malformed relation review is recovered locally, unsupported relation settles independent, and weaving continues',async t=>{
  const f=fixture(t,{ids:['a','b'],directRelation:true,dynamicWeaving:true,malformedReviewOnce:true,unsupportedRelation:true});
  await f.start({card_ids:undefined,construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const final=await f.idle();
  assert.equal(final.status,'completed',final.detail);
  assert.deepEqual(f.directCalls.slice(0,5).map(call=>call.nexoPrompt.phase),
    ['construction-author','construction-review','construction-response-recovery','construction-repair','construction-verify']);
  assert.equal(final.direct_work[0].response_contract_failures['construction-review'].resolved,true);
  assert.equal(final.relation_weaving.rounds[0].status,'reviewed-independent');
  assert.equal(final.completed_batches[0].published.length,0);
  assert.ok(final.relation_weaving.rounds.length>=2,'恢复后应继续下一随机焦点，而不是终止整项任务');
  assert.equal(loadCards(f.root).get(final.relation_weaving.rounds[0].focus_ids[0]).meta.relations.length,0);
});

test('explicit resume retries only a truncated review in a fresh audited stage',async t=>{
  const f=fixture(t,{ids:['a','b'],directRelation:true,interruptReviewOnce:true});
  await f.start({card_ids:['a'],construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const failed=await f.idle();assert.equal(failed.status,'failed');assert.equal(failed.phase,'reviewing');assert.equal(f.budget().used,2);
  await f.api('/jobs/'+failed.id+'/resume',{version:failed.version,budget_calls:20});
  const final=await f.idle();assert.equal(final.status,'completed',final.detail);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-author','construction-review','construction-review']);
  assert.equal(f.budget().used,3);assert.deepEqual(final.completed_batches[0].published,['a']);
});

test('relation weaving compares complete cards without sending partial source text',async t=>{
  const f=fixture(t,{ids:['a','b'],directRelation:true,longSource:true,bookSourceMode:'buffer'});
  await f.start({card_ids:undefined,construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections')});
  const final=await f.idle(),author=f.directCalls.find(call=>call.nexoPrompt.phase==='construction-author');
  assert.equal(final.status,'completed',final.detail);assert.equal(author.construction_context.source_chars,0);
  assert.ok(author.construction_context.other_chars<60000);
  const payload=JSON.parse(author.messages[0].content[0].text.split('\n').slice(1).join('\n'));
  assert.deepEqual(payload.sources,[]);assert.equal(payload.cards.length,2);
  assert.ok(payload.cards.every(card=>card.body.includes('对象')&&card.body.includes('保留独立表述')));
  assert.match(author.system,/必须使用 basis=navigation/);
});

test('source-dependent construction locates claim-aligned windows across a long source instead of truncating its prefix',async t=>{
  const f=fixture(t,{ids:['a','b'],longSource:true,bookSourceMode:'buffer'});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});
  const final=await f.idle(),author=f.directCalls.find(call=>call.nexoPrompt.phase==='construction-author');
  assert.equal(final.status,'completed',final.detail);assert.ok(author.construction_context.source_chars>0&&author.construction_context.source_chars<=5000);
  const payload=JSON.parse(author.messages[0].content[0].text.split('\n').slice(1).join('\n'));
  assert.equal(payload.sources.length,1);assert.equal(payload.sources[0].complete,false);
  assert.equal(payload.sources[0].selection_method,'claim-aligned-windows-v1');assert.ok(payload.sources[0].omitted_ranges.length>0);
  assert.ok(payload.sources[0].delivered_ranges.some(range=>range.start>5000));
  assert.match(payload.sources[0].text,/只有在限定条件下，市场竞争机制才成立/);
});

test('strategy-driven construction delivers current Buffer book units as source evidence',async t=>{
  const f=fixture(t,{ids:['a','b'],bookSourceMode:'buffer'});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});
  const final=await f.idle(),author=f.directCalls.find(call=>call.nexoPrompt.phase==='construction-author');
  assert.equal(final.status,'completed');assert.ok(author.construction_context.source_chars>0);
  assert.match(author.messages[0].content[0].text,/只有在限定条件下，市场竞争机制才成立/);
  assert.doesNotMatch(author.messages[0].content[0].text,/"unavailable":true/);
});

test('strategy-driven construction resolves historical Archive unit refs to retained Buffer evidence',async t=>{
  const f=fixture(t,{ids:['a','b'],bookSourceMode:'legacy'});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});
  const final=await f.idle(),author=f.directCalls.find(call=>call.nexoPrompt.phase==='construction-author');
  assert.equal(final.status,'completed');assert.ok(author.construction_context.source_chars>0);
  assert.match(author.messages[0].content[0].text,/03-Archive\\?\/books|03-Archive\/books/);
  assert.match(author.messages[0].content[0].text,/只有在限定条件下，市场竞争机制才成立/);
  assert.doesNotMatch(author.messages[0].content[0].text,/"unavailable":true/);
});

test('strategy-driven construction locally repairs unavailable source relations before any staging',async t=>{
  const f=fixture(t,{ids:['a','b'],missingSource:true,invalidSourceRelation:true});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('viewpoints')});
  const final=await f.idle();
  assert.equal(final.status,'completed',final.detail);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-strategy','construction-author','construction-repair','construction-review']);
  assert.equal(f.directCalls[1].construction_context.source_chars,0);
  assert.match(f.directCalls[1].system,/unavailable.*禁止输出 basis=source/);
  assert.match(f.directCalls[2].messages[0].content[0].text,/若只依据两端卡片，改为 navigation/);
  assert.equal(final.direct_work[0].repair_used,true);
  assert.equal(final.direct_work[0].preflight_issues.length,1);
  assert.equal(final.direct_work[0].preflight_repair.decisions.length,1);
  assert.equal(f.budget().used,4);
  assert.deepEqual(final.completed_batches[0].published,['a']);
  assert.equal(readDraft(f.root,final.id+'-b0','a').state,'published');
  assert.deepEqual(loadCards(f.root).get('a').meta.relations,[{target:'b',type:'contrast',note:'两张卡对市场竞争成立条件给出可比较的限定。',basis:'navigation',origin:'navigation'}]);
});

test('relation weaving defers a deterministic preflight failure without spending a repair call',async t=>{
  const f=fixture(t,{ids:['a','b'],missingSource:true,invalidSourceRelation:true});
  await f.start({construction_profile:'strategy-driven-v2',construction_controls:defaultConstructionControls('connections'),continuous:false});
  const paused=await f.idle();
  assert.equal(paused.status,'paused');
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['construction-author','construction-review']);
  assert.equal(paused.direct_work[0].preflight_issues.length,1);
  assert.equal(paused.direct_work[0].preflight_repair,undefined);
  assert.equal(paused.direct_work[0].repair_used,undefined);
  assert.equal(f.budget().used,2);
});

test('single-card repair receives only the candidate and concrete issue, then returns to an independent verifier',async t=>{
  const f=fixture(t,{repairReview:true});await f.recompile();const final=await f.idle();
  assert.equal(final.status,'completed');assert.equal(f.budget().used,5);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-rewrite','single-card-review','single-card-repair','single-card-verify','single-card-domain-review']);
  const repair=f.directCalls[2],repairText=repair.messages[0].content[0].text;
  assert.equal(repair.unit_context.source_chars,0);assert.doesNotMatch(repairText,/source_fragments|current_card|只有在限定条件下，市场竞争机制才成立/);
  assert.match(repairText,/失效边界需要改成明确停止外推/);assert.match(loadCards(f.root).get('a').body,/必须停止外推/);
  const verify=f.directCalls[3],verifyText=verify.messages[0].content[0].text;
  assert.equal(verify.messages.length,1);assert.equal(verify.unit_context.source_chars,0);
  assert.doesNotMatch(verifyText,/source_fragments|current_card|只有在限定条件下，市场竞争机制才成立/);
  assert.match(verifyText,/repaired_candidate/);assert.match(verifyText,/失效边界需要改成明确停止外推/);
  const domain=f.directCalls[4],domainText=domain.messages[0].content[0].text;
  assert.equal(domain.messages.length,1);assert.equal(domain.unit_context.source_chars,0);assert.match(domainText,/candidate_domains/);assert.doesNotMatch(domainText,/source_fragments|current_card/);
  assert.deepEqual(loadCards(f.root).get('a').meta.domains,['economics']);
});

test('single-card content publication remains partial when no existing domain fits',async t=>{
  const f=fixture(t,{deferDomain:true});await f.recompile();const final=await f.idle();
  assert.equal(final.status,'partial');assert.equal(final.error_code,'SINGLE_CARD_DOMAIN_UNRESOLVED');assert.equal(f.budget().used,3);
  assert.deepEqual(final.completed_batches[0].published,['a']);assert.equal(final.completed_batches[0].pending,1);
  const card=loadCards(f.root).get('a');assert.equal(card.meta.title,'个体选择聚合为组织行为的机制');assert.deepEqual(card.meta.domains,[]);
  assert.ok(synchronizeUnassignedPool(f.root,{card_ids:['a']}).unassigned.a);
});

test('single-card resume reuses the published content receipt and continues only domain review',async t=>{
  const f=fixture(t,{interruptDomainOnce:true});await f.recompile();const paused=await f.idle();
  assert.equal(paused.status,'paused',JSON.stringify({detail:paused.detail,error_code:paused.error_code,failures:paused.failures}));assert.equal(paused.error_code,'UNO_PROVIDER_BUDGET');assert.equal(loadCards(f.root).get('a').meta.title,'个体选择聚合为组织行为的机制');
  await f.api('/jobs/'+paused.id+'/resume',{version:paused.version});const final=await f.idle();
  assert.equal(final.status,'completed');assert.deepEqual(loadCards(f.root).get('a').meta.domains,['economics']);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-rewrite','single-card-review','single-card-domain-review','single-card-domain-review']);
});

test('single-card repair cannot rewrite fields outside the reviewer issue scope',async t=>{
  const f=fixture(t,{repairReview:true,repairExtraField:true});await f.recompile();const final=await f.idle();
  assert.equal(final.status,'partial');assert.equal(final.error_code,'SINGLE_CARD_REPAIR_SCOPE_EXPANDED');assert.equal(f.budget().used,3);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-rewrite','single-card-review','single-card-repair']);
  assert.equal(loadCards(f.root).get('a').meta.summary,'市场竞争机制需要限定条件');
});

test('single-card repair cannot pass by returning the unrepaired candidate unchanged',async t=>{
  const f=fixture(t,{repairReview:true,repairLeavesIssue:true});await f.recompile();const final=await f.idle();
  assert.equal(final.status,'partial');assert.equal(final.error_code,'SINGLE_CARD_REPAIR_NOT_APPLIED');assert.equal(f.budget().used,3);
  assert.deepEqual(f.directCalls.map(call=>call.nexoPrompt.phase),['single-card-rewrite','single-card-review','single-card-repair']);
  assert.equal(loadCards(f.root).get('a').meta.title,'市场竞争条件 a');
});

test('direction API unchanged completion is one call; identical current evidence reuses all groups with zero model calls',async t=>{
  const f=fixture(t);await f.start();await f.conclude();const original=await f.idle();
  assert.equal(original.status,'completed');assert.equal(original.completed_batches[0].pending,0);assert.equal(f.budget().used,1);assert.equal(f.turns.length,1);
  const created=await f.start(),reused=await f.idle();assert.notEqual(created.id,original.id);assert.equal(reused.status,'completed');assert.equal(reused.batches.length,0);assert.equal(reused.construction_plan.skipped.length,1);assert.equal(f.budget().used,0);assert.equal(f.prompts.length,0);assert.equal(f.turns.length,1);
});

test('force_recheck on the API bypasses a valid cache and requires a fresh delivered inspection',async t=>{
  const f=fixture(t);await f.start();await f.conclude();await f.idle();
  await f.start({force_recheck:true});assert.equal(f.job().construction_plan.skipped.length,0);assert.equal(f.job().batches.length,1);await f.conclude();assert.equal((await f.idle()).status,'completed');assert.equal(f.budget().used,1);assert.equal(f.turns.length,2);
});

test('deferred group remains partial and explicit resume returns to author; a later supported conclusion resolves it',async t=>{
  const f=fixture(t);await f.start();await f.conclude('deferred','当前还缺限定条件说明，保留本组待办。');const partial=await f.idle();
  assert.equal(partial.status,'partial');assert.equal(partial.completed_batches[0].pending,1);assert.equal(f.budget().used,1);
  await f.api('/jobs/'+partial.id+'/resume',{version:partial.version});await f.conclude('unchanged','重新检查，原文明确保留了限定条件，不需修改。');
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(final.completed_batches[0].pending,0);assert.equal(f.budget().used,2);assert.deepEqual(f.turns.map(row=>row.role),['author','author']);
});

test('missing source cannot produce a reusable completion under a stable null dependency hash',async t=>{
  const f=fixture(t,{missingSource:true});await f.start();await f.deferMissing();
  await f.start();const current=f.job();
  assert.equal(current.construction_plan.skipped.length,0,'A missing dependency must not become valid merely because null equals null');
  assert.equal(current.batches.length,1);
});

test('source deletion invalidates prior cache, and force recheck does not bless the missing source for later reuse',async t=>{
  const f=fixture(t);await f.start();await f.conclude();await f.idle();rmSync(join(f.root,f.source));
  await f.start({force_recheck:true});assert.equal(f.job().construction_plan.skipped.length,0);await f.deferMissing();
  await f.start();assert.equal(f.job().construction_plan.skipped.length,0,'Rechecking card text cannot turn missing source bytes into a stable reusable evidence version');
});

test('seven-card cross-package merge skips the retired later package before any native prompt and settles unaffected cards',async t=>{
  const f=fixture(t,{ids:['a','b','c','d','e','f','g']});await f.start({notes:'整理市场竞争的重复机制'});
  assert.deepEqual(f.job().batches,[['a','b','c','d','e','f'],['g']]);
  const author=await f.next();await f.answer(author,async(tool,pack)=>{
    const a=await tool('compile_read_card',{id:'a'}),g=await tool('compile_read_card',{id:'g'});
    const receipt=await tool('compile_edit',{operation_id:'merge-a-g',action:'patch',id:'a',revision:a.revision,body:f.quote+'合并 a 与 g 的同一机制，保留限定条件。',merge:[{id:'g',revision:g.revision}]});assert.equal(receipt.accepted,true);
    const result=await tool('compile_finish',{phase:'organize',summary:'合并同一机制，其余对象保持独立',conclusions:pack.task.scope.filter(id=>id!=='a').map(id=>({id,status:'unchanged',note:'该对象有独立使用范围，保留原样。'}))});assert.equal(result.ready,true);
  });
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    const current=await tool('compile_read_card',{id:'a'}),a=await tool('compile_read_card',{id:'a',view:'baseline'}),g=await tool('compile_read_card',{id:'g',view:'baseline'});
    await tool('compile_read_material',{ref:f.source});
    const result=await tool('compile_review',{ids:['a'],note:'已核对两个合并对象的限定条件，未外推',checks:[f.source,current.ref,a.ref,g.ref].map(ref=>({id:'a',claim:'限定条件必须保留',ref,quote:f.quote}))});assert.equal(result.end_turn,true);
  });
  await wait(()=>!hasUnoJobRunning(f.root)||f.prompts.length);
  assert.equal(f.job().completed_batches[0].pending,0,'Publishing the reviewed merge must not reopen unrelated unchanged cards from its own group');
  assert.equal(f.prompts.length,0,'Resolved retirement package must be reconciled before requesting a model');
  const final=await f.idle();assert.equal(final.status,'completed');assert.deepEqual(final.completed_batches.map(row=>row.pending),[0,0]);assert.equal(f.turns.length,2);assert.equal(f.budget().used,2);
  assert.equal(loadCards(f.root).has('g'),false);assert.equal(readDraft(f.root,final.id+'-b1','g'),null);assert.match(readFileSync(f.cardPath('g'),'utf8'),/superseded_by: a/);
});

test('factual audit cannot approve an unchanged card without delivered source and a located quotation',async t=>{
  const f=fixture(t);await f.start({notes:'事实核验市场竞争的限定条件'});await f.conclude();
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    await assert.rejects(Promise.resolve().then(()=>tool('compile_review',{ids:['a'],note:'只有卡片，不能事实核验通过'})),/checks|来源|原句/);
    assert.equal(f.job().reviewed?.a,undefined);
    await tool('compile_read_material',{ref:f.source});
    await assert.rejects(Promise.resolve().then(()=>tool('compile_review',{ids:['a'],note:'读过来源仍需要可定位核验依据'})),/checks|原句/);
    assert.equal(f.job().reviewed?.a,undefined);
    const result=await tool('compile_review',{ids:['a'],note:'已定位并核对当前来源中的限定条件',checks:[{id:'a',claim:'成立须限定条件',ref:f.source,quote:f.quote}]});assert.equal(result.end_turn,true);
  });
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(f.budget().used,2);assert.equal(final.reviewed.a.checks.length,1);assert.equal(final.reviewed.a.source_bindings.length,1);
  await f.start({notes:'事实核验市场竞争的限定条件'});assert.equal(f.job().construction_plan.skipped.length,0,'Fact audits never reuse a no-change inspection cache');
});

test('a draft dependency published earlier in the same settlement is verified against the pending draft revision and published receipt',async t=>{
  const f=fixture(t,{ids:['a','z']});await f.start();
  const author=await f.next();await f.answer(author,async tool=>{
    const a=await tool('compile_read_card',{id:'a'}),z=await tool('compile_read_card',{id:'z'});
    assert.equal((await tool('compile_edit',{operation_id:'rename-a',action:'patch',id:'a',revision:a.revision,title:'限定条件下的市场竞争'})).accepted,true);
    assert.equal((await tool('compile_edit',{operation_id:'link-z',action:'link',id:'z',revision:z.revision,link:{target:'a',type:'supplement',note:'比较相同条件下的两种表述',basis:'navigation'}})).accepted,true);
    assert.equal((await tool('compile_finish',{phase:'organize',summary:'标题和导航改动交独立审核'})).ready,true);
  });
  const reviewer=await f.next('organize','reviewer');let targetRevision;
  await f.answer(reviewer,async tool=>{
    const a=await tool('compile_read_card',{id:'a'}),z=await tool('compile_read_card',{id:'z'});targetRevision=a.revision;
    const result=await tool('compile_review',{ids:['a','z'],note:'标题和导航均受当前两卡正文支持',checks:[{id:'a',ref:a.ref},{id:'z',ref:z.ref},{id:'z',ref:a.ref}].map(row=>({...row,claim:'比较相同限定条件',quote:f.quote}))});assert.equal(result.end_turn,true);
    assert.equal(f.job().reviewed.z.dependencies[0].draft,true);
  });
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(final.completed_batches[0].pending,0);assert.deepEqual(final.completed_batches[0].published,['a','z']);
  const receipt=final.receipts.find(row=>row.publication?.cards.some(card=>card.id==='a'));assert.equal(receipt.publication.cards[0].draft_revision,targetRevision);assert.notEqual(readDraft(f.root,final.id+'-b0','a').revision,targetRevision);
  assert.equal(loadCards(f.root).get('z').meta.relations[0].target,'a');
});

test('a formal navigation dependency changed after review cannot be published using an old approval',async t=>{
  const f=fixture(t,{ids:['a','z']});await f.start({delivery:'manual'});
  const author=await f.next();await f.answer(author,async tool=>{
    const z=await tool('compile_read_card',{id:'z'});
    await tool('compile_edit',{operation_id:'link-z',action:'link',id:'z',revision:z.revision,link:{target:'a',type:'supplement',note:'比较相同限定条件',basis:'navigation'}});
    assert.equal((await tool('compile_finish',{phase:'organize',summary:'导航待审核',conclusions:[{id:'a',status:'unchanged',note:'正式目标已有明确限定条件'}]})).ready,true);
  });
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    const a=await tool('compile_read_card',{id:'a',view:'baseline'}),z=await tool('compile_read_card',{id:'z'});
    assert.equal((await tool('compile_review',{ids:['z'],note:'正式版本支持导航用途',checks:[z.ref,a.ref].map(ref=>({id:'z',ref,claim:'比较限定条件',quote:f.quote}))})).end_turn,true);
  });
  const approval=await f.idle();assert.equal(approval.status,'review');
  writeFileSync(f.cardPath('a'),readFileSync(f.cardPath('a'),'utf8').replace(f.quote,'更新后的条件排除了原有比较。'));
  await f.api('/jobs/'+approval.id+'/review',{version:approval.version,decision:'save'});
  const final=await f.idle();assert.equal(final.status,'partial');assert.ok(final.issues.some(row=>/正式关系目标已变化/.test(row.detail)));assert.equal(loadCards(f.root).get('z').meta.relations.length,0);assert.equal(readDraft(f.root,final.id+'-b0','z').state,'pending');
});

test('factual unchanged approval becomes pending if its source changes before manual settlement',async t=>{
  const f=fixture(t);await f.start({notes:'事实核验市场竞争的限定条件',delivery:'manual'});await f.conclude();
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    await tool('compile_read_material',{ref:f.source});
    assert.equal((await tool('compile_review',{ids:['a'],note:'引用当前来源核对了限定条件',checks:[{id:'a',claim:'成立条件',ref:f.source,quote:f.quote}]})).end_turn,true);
  });
  const approval=await f.idle();assert.equal(approval.status,'review');
  writeFileSync(join(f.root,f.source),unoMarkdown({title:'修正来源'},'原有主张被新材料撤回。'));
  await f.api('/jobs/'+approval.id+'/review',{version:approval.version,decision:'save'});const final=await f.idle();
  assert.equal(final.status,'partial','Source revisions that support factual approval must still match at settlement');assert.ok(final.completed_batches[0].pending>0);
  await f.api('/jobs/'+final.id+'/resume',{version:final.version});await f.next('organize','reviewer');
  assert.equal(f.job().repair_ids,undefined,'Stale evidence requires a fresh review, not an unneeded author edit');
});


test('structured diagnosis starts without free text, freezes permissions and delivers them to the model',async t=>{
  const f=fixture(t),controls={...defaultConstructionControls('connections'),allowed:[]};
  await f.start({notes:'',construction_controls:controls});
  assert.deepEqual(f.job().construction_controls,controls);
  const author=await f.next();await f.answer(author,async(tool,pack)=>{
    assert.deepEqual(pack.task.construction_controls,controls);
    await assert.rejects(Promise.resolve().then(()=>tool('compile_edit',{operation_id:'forbidden',action:'patch',id:'a',title:'越权'})),/阶段不提供|只诊断/);
    await tool('compile_finish',{phase:'organize',summary:'完整检查后保留现状',conclusions:[{id:'a',status:'unchanged',note:'信息条件明确，保持独立对象。'}]});
  });
  assert.equal((await f.idle()).status,'completed');assert.equal(f.budget().used,1);
});

test('domain assignment runs through author, independent definition review and governance settlement',async t=>{
  const f=fixture(t);writeDomainFixture(f.root,'economics','信息与经济机制');
  await f.start({notes:'',construction_controls:defaultConstructionControls('domains')});
  const author=await f.next();await f.answer(author,async tool=>{
    const card=await tool('compile_read_card',{id:'a'});
    await tool('compile_task',{view:'domains',id:'economics'});
    await tool('compile_edit',{operation_id:'assign-domain',action:'patch',id:'a',revision:card.revision,domains:['economics']});
    await tool('compile_finish',{phase:'organize',summary:'归入信息与经济机制'});
  });
  const reviewer=await f.next('organize','reviewer');await f.answer(reviewer,async tool=>{
    const draft=await tool('compile_read_card',{id:'a'});
    const review={ids:['a'],note:'核对卡片与领域定义相符',checks:[{id:'a',claim:'信息条件属于领域纳入边界',ref:draft.ref,quote:f.quote}]};
    await assert.rejects(Promise.resolve().then(()=>tool('compile_review',review)),/领域定义/);
    await tool('compile_task',{view:'domains',id:'economics'});
    await tool('compile_review',review);
  });
  const final=await f.idle();assert.equal(final.status,'completed');assert.equal(final.completed_batches[0].pending,0);
  assert.deepEqual(loadCards(f.root).get('a').meta.domains,['economics']);
  assert.equal(final.receipts.some(r=>r.construction_domain_request_hash),true);
});
