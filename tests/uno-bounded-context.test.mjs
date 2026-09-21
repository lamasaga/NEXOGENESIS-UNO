import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Context} from '../packages/nexogenesis-web-host/node_modules/@deepseek-ai/cordis/lib/index.js';
import {apply,runCompileTool} from '../packages/nexogenesis-tools/lib/uno/agent.js';
import {taskProgress} from '../packages/nexogenesis-tools/lib/uno/context.js';
import {BOUNDED_WORKFLOW_PROFILE,stageInstructions,boundSearchResult} from '../packages/nexogenesis-tools/lib/uno/prompt-orchestration.js';
import {buildEvidencePack,confirmEvidencePackDelivery} from '../packages/nexogenesis-tools/lib/uno/evidence-pack.js';
import {saveCompileJob,readCompileJob,jobRef} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {initializeProviderBudget,bindProviderBudgetSession,getProviderBudget,reserveProviderRequest} from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {sha,unoMarkdown,unoRevision,readUnoUnit} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {runConstructionTool} from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import {CARD_CLASSIFICATION_CONTRACT,LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT} from '../packages/nexogenesis-tools/lib/uno/card-classification.js';

const require=createRequire(new URL('../packages/nexogenesis-tools/lib/uno/agent.js',import.meta.url));
const native=require.resolve('@deepseek-ai/dsh-tools');
const {ToolRuntime}=await import(pathToFileURL(native));
const {SystemPrompt}=await import(pathToFileURL(createRequire(native).resolve('@deepseek-ai/dsh-system-prompt')));
const {createScope}=await import(pathToFileURL(createRequire(native).resolve('@deepseek-ai/dsh-scope')));

function fixture(t,{body='需求稳定时甲机制成立。反例：需求变化会使推断失效。',budget=20}={}){
  const root=mkdtempSync(join(tmpdir(),'uno-bounded-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'00-Inbox'));mkdirSync(join(root,'01-Cards'));const source='00-Inbox/book.md';writeFileSync(join(root,source),body);
  const job={id:'bounded-context',workflow:'uno-compile-v3',orchestration_profile:BOUNDED_WORKFLOW_PROFILE,
    mode:'construct',phase:'read',role:'author',status:'running',session_id:'author',sessions:['author'],selected_sources:[source],
    construct_contract:'scoped-review-v1',scope:['draft'],batches:[['draft']],batch_index:0,calls:[],budget:{calls:budget},
    receipts:[],issues:[],touched:[],sources:[],outcomes:{},reviewed:{},checkpoint:'不遗漏反例',requirements:{notes:'检查需求机制',preferences:{}}};
  saveCompileJob(root,job);initializeProviderBudget(root,job.id,{limit:budget});
  const read=()=>readCompileJob(root,job.id),update=patch=>saveCompileJob(root,{...read(),...patch});
  const tool=(name,args={})=>runCompileTool(root,read().session_id,name,args);
  const prepare=()=>{const info=prepareSourceFixture(root,{source,theme:'机制',prepared:{fingerprint:sha(body),format:'md',material_kind:'book',classification_reason:'已选章节',chapters:[{title:'需求机制',text:body,locator:'第二章'}]}});
    const ref=info.units[0].ref;writeFileSync(join(root,'01-Cards/draft.md'),unoMarkdown({schema:'uno-card-v4',id:'draft',title:'需求机制',summary:'已有需求机制与边界',type:'mechanism',domains:[],sources:[ref],boundary:'需求稳定时',lifecycle:'active'},body));update({phase:'read',batches:[['draft']],sources:[info]});return ref;};
  const addCard=(id='existing',title='需求机制')=>{writeFileSync(join(root,'01-Cards',id+'.md'),unoMarkdown({schema:'uno-card-v4',id,title,summary:'已有需求机制与边界',type:'mechanism',domains:[],sources:[source],boundary:'稳定需求',lifecycle:'active'},body));};
  const request=packet=>({sessionId:read().session_id,messages:[{role:'user',content:[{type:'text',text:packet.text}]}]});
  const confirm=(packet)=>confirmEvidencePackDelivery(root,packet,request(packet),{type:'text-delta',text:'已收到'});
  const bind=(role='author',sessionId=read().session_id)=>bindProviderBudgetSession(root,{jobId:job.id,sessionId,packageId:'0',role,stageId:`0:${role}:${sessionId}`,stageLimit:Math.max(1,budget),reviewReserve:0});
  return {root,source,body,job:read,update,tool,prepare,addCard,request,confirm,bind};
}
function nativeFixture(t,options){
  const f=fixture(t,options),ctx=new Context();new SystemPrompt(ctx,{includeHarnessIdentity:false});const runtime=new ToolRuntime(ctx);
  const agent={session:{id:'author',header:{cwd:f.root}}},scope=createScope(ctx,agent);t.after(()=>scope.dispose());
  apply(scope.ctx,{projectRoot:f.root,instanceRegistry:''});
  const assemble=()=>ctx.systemPrompt.assemble({scope:agent,agent});
  let call=0;return {...f,ctx,agent,runtime,assemble,call:(name,args)=>runtime.execute({callId:'bounded-'+(++call),name,arguments:args,agent,signal:new AbortController().signal})};
}

test('hidden operations cannot be called directly or smuggled after a valid batch item',async t=>{
  const f=nativeFixture(t);f.prepare();f.update({role:'reviewer',phase:'organize'});
  const before=readFileSync(join(f.root,jobRef('bounded-context')),'utf8');
  const rejected=await f.call('compile_batch',{operations:[{tool:'compile_search',args:{query:'需求'}},{tool:'compile_edit',args:{operation_id:'bad',id:'bad',title:'bad'}}]});
  assert.equal(JSON.parse(rejected.content[0].text).ok,false);assert.match(JSON.stringify(rejected),/SCOPE_VIOLATION|此阶段不提供/);
  assert.equal(f.job().touched.length,0);
  assert.throws(()=>f.tool('compile_prepare',{ref:'anything',cleaning_review_note:'核对',theme:'扩大范围'}),/此阶段不提供|不支持|已移除/);
  assert.throws(()=>f.tool('compile_review',{checks:[{id:'a',claim:'长'.repeat(601),ref:'x',quote:'x'}]}),/600/);
  assert.ok(before.includes('reviewer'));
});

test('search bytes are bounded without malformed JSON or skipping omitted result offsets',()=>{
  const original={total:9,offset:4,next_offset:null,items:[{id:'a',text:'汉'.repeat(1700)},{id:'b',text:'乙'.repeat(1700)}],drafts:[]};
  const result=boundSearchResult(original,6000);assert.equal(result.items.length,1);assert.equal(result.next_offset,5);assert.equal(result.byte_limited,true);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=6000);assert.equal(original.items.length,2);
});

test('last already-reserved request can deliver evidence and finish tools when remaining becomes zero',async t=>{
  const f=nativeFixture(t,{budget:1}),ref=f.prepare();f.bind();const packet=buildEvidencePack(f.root,f.job());
  reserveProviderRequest({}, {sessionId:'author',nexoPrompt:{root:f.root}});
  assert.equal(getProviderBudget(f.root,'bounded-context').remaining,0);assert.equal(f.confirm(packet).confirmed,true);
  const result=await f.call('compile_finish',{phase:'organize',summary:'已读本批卡片，交回审核'});
  assert.equal(result.concludesTurn,true);assert.equal(f.job().handoff_requested,true);
  assert.equal(taskProgress(f.job(),{providerBudget:getProviderBudget(f.root,'bounded-context')}).remaining_calls,0);
  assert.equal(f.job().budget.calls,1);
});

test('new reviewer receives its own draft/source proofs, with no inherited verdict or writing tool',async t=>{
  const f=fixture(t),ref=f.prepare();f.confirm(buildEvidencePack(f.root,f.job()));
  await f.tool('compile_edit',{operation_id:'draft',id:'draft',revision:unoRevision(f.root,'01-Cards/draft.md'),title:'需求机制',summary:'稳定需求下成立',body:f.body,type:'mechanism',domains:[],sources:[ref],boundary:'需求稳定时'});
  f.update({role:'reviewer',phase:'organize',session_id:'reviewer',sessions:['author','reviewer']});
  const packet=buildEvidencePack(f.root,f.job());f.confirm(packet);
  assert.equal(f.job().review_reads.draft.session_id,'reviewer');assert.ok(f.job().review_evidence[ref]);assert.deepEqual(f.job().reviewed,{});
  assert.match(stageInstructions(f.job()),/只验证当前提案/);assert.throws(()=>f.tool('compile_edit',{operation_id:'write-in-review',id:'draft'}),/此阶段不提供/);
});

test('new profile never falls back to model-call telemetry when provider budget is missing',t=>{
  const f=fixture(t);f.prepare();rmSync(join(f.root,'.nexogenesis/provider-request-budgets/bounded-context.json'));
  assert.throws(()=>buildEvidencePack(f.root,f.job()),error=>error.code==='UNO_BUDGET_STATE');assert.equal(f.job().reading,undefined);
});


test('native construction tools are role-scoped; retired tools and book tools never leak into construction',async t=>{
 const f=nativeFixture(t);f.prepare();let assembly=await f.assemble();
 assert.ok(assembly.tools.some(t=>t.name==='compile_edit'));
 assert.ok(!assembly.tools.find(t=>t.name==='compile_edit').parameters.properties.type.enum.includes('undetermined'));
 for(const name of ['compile_select','compile_sources','compile_prepare','compile_settle','compile_buffer','compile_inspect','book_save_cards'])assert.ok(!assembly.tools.some(t=>t.name===name),name);
 f.update({card_classification:CARD_CLASSIFICATION_CONTRACT});assembly=await f.assemble();assert.ok(assembly.tools.find(t=>t.name==='compile_edit').parameters.properties.type.enum.includes('undetermined'));
 f.update({phase:'organize',role:'reviewer'});assembly=await f.assemble();assert.ok(assembly.tools.some(t=>t.name==='compile_review'));assert.ok(!assembly.tools.some(t=>t.name==='compile_edit'));
 assert.ok(assembly.tools.find(t=>t.name==='compile_review').parameters.properties.checks);
});

test('construction stages and guides use the task-frozen classification contract',t=>{
  const f=fixture(t);f.prepare();
  assert.equal(JSON.parse(buildEvidencePack(f.root,f.job()).text).task.card_classification,LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT);
  assert.doesNotMatch(stageInstructions(f.job()),/undetermined/);
  assert.doesNotMatch(f.tool('compile_guide',{name:'types'}).text,/undetermined/);
  f.update({card_classification:CARD_CLASSIFICATION_CONTRACT,session_id:'current-author'});
  const current=f.job(),instructions=stageInstructions(current),guide=f.tool('compile_guide',{name:'types'});
  assert.match(instructions,/conflict 争议 → entity 实体 → case 案例/);
  assert.match(instructions,/phenomenon 必须有可观察对象与依据/);
  assert.equal(guide.card_classification,CARD_CLASSIFICATION_CONTRACT);
  assert.match(guide.text,/undetermined/);
  assert.equal(JSON.parse(buildEvidencePack(f.root,current).text).task.card_classification,CARD_CLASSIFICATION_CONTRACT);
});
