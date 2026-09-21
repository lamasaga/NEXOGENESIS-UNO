import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {sha} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {saveCompileJob,readCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {initializeProviderBudget} from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import {CARD_CLASSIFICATION_CONTRACT} from '../packages/nexogenesis-tools/lib/uno/card-classification.js';
import {COMPILE_ISOLATION,listCompileIsolation,compileIsolationSummary} from '../packages/nexogenesis-tools/lib/uno/compile-isolation.js';
import {prepareIsolationRepair,bindIsolationRepair,reconcileIsolationRepair} from '../packages/nexogenesis-tools/lib/uno/compile-repair.js';
import {reconcileBookReceipts} from '../packages/nexogenesis-tools/lib/uno/book-store.js';
import {executeBookCompile,BOOK_WORKFLOW} from '../packages/nexogenesis-web-host/lib/book-compile.js';
import {computeResumePlan} from '../packages/nexogenesis-web-host/lib/resume-plan.js';
import {bookProgress} from '../packages/nexogenesis-tools/lib/uno/book-agent.js';

function fixture(t,count=2){
 const root=mkdtempSync(join(tmpdir(),'uno-isolation-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'00-Inbox'));
 const source='00-Inbox/test.md',original='制度条件约束行为；不同单元独立处理。';writeFileSync(join(root,source),original);
 const info=new HarnessGateway(root).prepareBookSource({source,prepared:{fingerprint:sha(original),chapters:Array.from({length:count},(_,i)=>({title:'单元'+i,text:original+i,locator:'单元'+i}))}});
 const job={id:'job',mode:'compile',workflow:BOOK_WORKFLOW,compile_profile:'unit-cards-v3',compile_isolation:COMPILE_ISOLATION,
  card_classification:CARD_CLASSIFICATION_CONTRACT,status:'running',phase:'read',session_id:'s1',owner_session_id:'s1',sessions:['s1'],
  sources:[{...info,original_source:source}],selected_sources:[source],source_revisions:{[source]:sha(original)},book_units:info.units,
  book_outcomes:{},book_focus_refs:[info.units[0].ref],book_reads:{},book_card_reads:{},calls:[],receipts:[],touched:[],failures:[],archives:[],batch_index:0,
  budget:{calls:30},continuous:true,model_selection:{provider:'nexo-deepseek',model:'test'},domain_catalog:[]};
 initializeProviderBudget(root,job.id,{limit:30});saveCompileJob(root,job);return {root,job};
}
const card=(ref,id)=>({id,title:'制度机制'+id,type:'model',domains:[],summary:'制度条件通过激励影响行动。',body:'## 核心思想\n制度条件约束行为。\n\n## 关键组件\n约束和行动者。\n\n## 结构关系或因果链条\n约束改变激励，激励影响行动。\n\n## 失效边界\n只在来源限定环境中成立。\n\n## 来源与证据边界\n依据本单元的具体制度描述。',sources:[{ref}],relations:[]});
const data=req=>{const text=req.messages[0].content[0].text;return JSON.parse(text.startsWith('{')?text:text.slice(text.indexOf('\n')+1));};
const review=d=>({checked_ids:(d.supplied_cards??[d.supplied_card]).map(c=>c.id),issues:[],unit_issues:[]});
function model(handler){const requests=[];return {requests,generate:async(_ctx,_root,_job,req)=>{requests.push(req);const result=await handler(data(req),req);return typeof result==='string'?result:JSON.stringify(result);}};}
const issue={id:'bad',kind:'card',related_card_ids:[],message:'核心思想缺少必要条件，应保留来源限定环境，不得泛化。'};

async function quarantined(t){
 const f=fixture(t),first=f.job.book_units[0].ref;
 const m=model(d=>{
  if(d.phase==='generate')return {cards:d.source.ref===first?[card(first,'good'),card(first,'bad')]:[card(d.source.ref,'later')],note:'来源限定的对象'};
  if(d.phase==='repair')return {card:d.supplied_card};
  const r=review(d);return {...r,issues:r.checked_ids.includes('bad')?[issue]:[]};
 });
 await executeBookCompile({},f.root,f.job,new AbortController(),{generate:m.generate});
 return {...f,...m,end:readCompileJob(f.root,'job'),first};
}

test('exhausted card enters pool, later unit completes, and neither quarantine nor complete book is fabricated',async t=>{
 const {root,end,first,requests}=await quarantined(t);
 assert.equal(end.status,'partial',end.detail);assert.equal(end.book_outcomes[first].status,'quarantined');
 assert.equal(end.book_outcomes[end.book_units[1].ref].status,'processed');
 assert.ok(existsSync(join(root,'01-Cards/good.md')));assert.ok(existsSync(join(root,'01-Cards/later.md')));assert.equal(existsSync(join(root,'01-Cards/bad.md')),false);
 assert.ok(existsSync(join(root,'00-Inbox/test.md')));assert.equal(bookProgress(end).quarantined,1);assert.equal(bookProgress(end).pending,0);
 assert.equal(computeResumePlan(root,end).kind,'blocked');assert.equal(compileIsolationSummary(end).cards,1);
 const [item]=listCompileIsolation(root);assert.equal(item.card_id,'bad');assert.equal(item.kind,'repair');assert.equal(item.body,undefined);
 assert.equal(requests.filter(r=>data(r).phase==='generate').length,2);assert.equal(requests.filter(r=>data(r).phase==='repair').length,2);
 const before=readFileSync(join(root,'.nexogenesis/uno-jobs/job.json'),'utf8');listCompileIsolation(root);assert.equal(readFileSync(join(root,'.nexogenesis/uno-jobs/job.json'),'utf8'),before);
});

test('single candidate repair publishes through Gateway and closes only its parent pending item with durable receipts',async t=>{
 const {root,end,first}=await quarantined(t),item=listCompileIsolation(root)[0],good=readFileSync(join(root,'01-Cards/good.md'),'utf8');
 assert.throws(()=>prepareIsolationRepair(root,{item_id:item.id,expected_revision:'stale'}),{code:'ISOLATION_CONFLICT'});
 const prepared=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision,notes:'保留具体条件，只处理原问题。'});
 assert.equal(prepared.fields.unit_work[first].repair_diagnosis.status,'pending');
 assert.equal(prepared.fields.unit_work[first].repair_diagnosis.user_notes,'保留具体条件，只处理原问题。');
 assert.equal(prepared.fields.unit_work[first].pending_issues.bad.includes('保留具体条件，只处理原问题。'),false,'用户说明不是新的审核错误');
 const job={...end,...prepared.fields,id:'repair-job',session_id:'repair-session',owner_session_id:'repair-session',sessions:['repair-session'],status:'running',calls:[],receipts:[],failures:[],archives:[],phase:'read'};
 initializeProviderBudget(root,job.id,{limit:12});saveCompileJob(root,job);bindIsolationRepair(root,job);
 assert.throws(()=>prepareIsolationRepair(root,{item_id:item.id,expected_revision:listCompileIsolation(root)[0].revision}),{code:'ISOLATION_CONFLICT'});
 const m=model(d=>{
  if(d.phase==='check'&&d.repair_diagnosis){assert.deepEqual(d.repair_diagnosis.original_issues.map(row=>row.message),[issue.message]);assert.equal(d.repair_diagnosis.user_notes,'保留具体条件，只处理原问题。');return {...review(d),issues:[issue]};}
  if(d.phase==='repair')return {card:{...d.supplied_card,body:d.supplied_card.body+'\n结论仅适用于来源限定的制度条件。'}};
  assert.notEqual(d.phase,'generate');return review(d);
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 const repaired=readCompileJob(root,job.id),parent=readCompileJob(root,'job');
 assert.equal(repaired.status,'completed',repaired.detail);assert.equal(repaired.repair_reconciliation_error,undefined);
 assert.ok(existsSync(join(root,'01-Cards/bad.md')));assert.equal(readFileSync(join(root,'01-Cards/good.md'),'utf8'),good);
 assert.equal(listCompileIsolation(root).length,0);assert.equal(parent.book_outcomes[first].status,'processed');
 const receiptCheck=reconcileBookReceipts(root,parent);assert.deepEqual(receiptCheck.issues,[]);assert.ok(parent.touched.includes('bad'));
 assert.equal(reconcileIsolationRepair(root,repaired),false);assert.ok(m.requests.every(req=>req.unit_context.source_chars===0));
 assert.ok(m.requests.every(req=>!['generate','supplement'].includes(data(req).phase)));
 assert.deepEqual(m.requests.map(req=>data(req).phase),['check','repair','verify']);
 assert.match(readFileSync(join(root,'01-Cards/bad.md'),'utf8'),/结论仅适用于来源限定/);
 assert.equal(existsSync(join(root,'00-Inbox/test.md')),false,'last repaired unit permits verified original archiving');
 const link=parent.repair_receipts[0],receiptPath=join(root,'.nexogenesis/uno-receipts',sha(link.key)+'.json');
 const receiptText=readFileSync(receiptPath);unlinkSync(receiptPath);
 assert.ok(reconcileBookReceipts(root,readCompileJob(root,'job')).issues.some(issue=>issue.code==='MISSING_RECEIPT'));
 writeFileSync(receiptPath,receiptText);unlinkSync(join(root,'.nexogenesis/uno-jobs',repaired.id+'.json'));
 assert.ok(reconcileBookReceipts(root,readCompileJob(root,'job')).issues.some(issue=>issue.key===link.key));
});

test('bad JSON gets only one local response recovery, preserves raw result, and does not block next unit',async t=>{
 const {root,job}=fixture(t),first=job.book_units[0].ref;
 const raw='{"cards":[broken';
 const m=model((d,req)=>{
  if(d.phase==='generate')return d.source.ref===first?raw:{cards:[card(d.source.ref,'later')],note:'一个对象'};
  if(req.nexoPrompt.phase==='unit-recovery'){assert.equal(req.unit_context.source_chars,0);assert.equal(d.original_response,raw);return {action:'cannot_repair',reason:'缺少完整对象'};}
  return review(d);
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});const end=readCompileJob(root,'job');
 assert.equal(end.status,'partial');assert.equal(end.book_outcomes[job.book_units[1].ref].status,'processed');
 assert.equal(m.requests.filter(r=>r.nexoPrompt.phase==='unit-recovery').length,1);assert.equal(end.recovery_model_calls,1);
 const item=listCompileIsolation(root,{details:true})[0];assert.equal(item.raw_response,raw);
 const prepared=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision,
  response_json:JSON.stringify({cards:[card(first,'recovered')],note:'人工确认的完整响应'})});
 const repair={...end,...prepared.fields,id:'repair-response-delivery',session_id:'s2',owner_session_id:'s2',sessions:['s2'],status:'running',receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>review(d));await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 const reconciled=readCompileJob(root,'job');assert.equal(reconciled.book_outcomes[first].status,'processed');
 assert.equal(reconciled.book_outcomes[first].delivered_chars,job.book_units[0].chars);
 assert.equal(existsSync(join(root,'00-Inbox/test.md')),false,'repaired response keeps verified delivery evidence needed for archive');
});

test('extra terminal closers are recovered in the same round without a model recovery call',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref,c=card(ref,'kept');
 const raw=JSON.stringify({cards:[c],note:'完整响应'})+']}';
 const m=model((d,req)=>{
  assert.notEqual(req.nexoPrompt.phase,'unit-recovery');
  if(d.phase==='generate')return raw;
  return review(d);
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 const end=readCompileJob(root,'job');
 assert.equal(end.status,'completed',end.detail);assert.ok(existsSync(join(root,'01-Cards/kept.md')));
 assert.equal(end.recovery_model_calls??0,0);assert.equal(end.last_recovery.method,'deterministic');
 assert.deepEqual(end.last_recovery.changes,['remove-trailing-unmatched-closers']);
 assert.equal(m.requests.filter(req=>req.nexoPrompt.phase==='unit-recovery').length,0);
});

test('one malformed candidate identity is isolated while independent valid candidates are reviewed and saved',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref;
 const m=model(d=>d.phase==='generate'?{cards:[card(ref,'safe'),card(ref,'../bad')],note:'两个候选'}:review(d));
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 assert.ok(existsSync(join(root,'01-Cards/safe.md')));assert.equal(listCompileIsolation(root)[0].repair_kind,'response');
 assert.equal(m.requests.length,2);assert.match(listCompileIsolation(root,{details:true})[0].raw_response,/\.\.\/bad/);
});

test('global budget or user stop pauses mainline without quarantining or starting next unit',async t=>{
 for(const stop of [false,true]){
  const {root,job}=fixture(t),controller=new AbortController();
  const m=model(()=>{if(stop)controller.abort(new Error('用户停止'));throw Object.assign(new Error('额度耗尽'),{code:'UNO_PROVIDER_BUDGET'});});
  await executeBookCompile({},root,job,controller,{generate:m.generate});
  assert.equal(readCompileJob(root,'job').status,'paused');assert.equal(listCompileIsolation(root).length,0);assert.equal(m.requests.length,1);
 }
});

test('three consecutive unusable responses trip the circuit without attempting a fourth unit',async t=>{
 const {root,job}=fixture(t,4),m=model((d,req)=>req.nexoPrompt.phase==='unit-recovery'?{action:'cannot_repair',reason:'缺失正文'}:'not json');
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});const end=readCompileJob(root,'job');
 assert.equal(end.status,'paused');assert.equal(end.last_failure.code,'COMPILE_FAILURE_CIRCUIT');
 assert.equal(m.requests.filter(r=>r.nexoPrompt.phase==='unit-generate').length,3);assert.equal(bookProgress(end).pending,1);assert.equal(listCompileIsolation(root).length,3);
});

test('empty generation retries once, then retains a response pending item and advances',async t=>{
 const {root,job}=fixture(t),first=job.book_units[0].ref;
 const m=model(d=>{if(d.phase==='generate'){if(d.source.ref===first)throw Object.assign(new Error('没有响应'),{code:'MODEL_EMPTY_RESPONSE'});return {cards:[card(d.source.ref,'later')],note:'完整对象'};}return review(d);});
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 assert.equal(m.requests.filter(r=>data(r).phase==='generate').length,3);assert.ok(existsSync(join(root,'01-Cards/later.md')));
 const item=listCompileIsolation(root)[0],prepared=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision});
 assert.equal(prepared.fields.repair_origin.source_retry,true);
});

test('response format recovery preserves escaped multiline card content and never retransmits source',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref,c=card(ref,'kept');
 const m=model((d,req)=>{
  if(d.phase==='generate')return {card_list:[c]};
  if(req.nexoPrompt.phase==='unit-recovery'){assert.equal(req.unit_context.source_chars,0);return {action:'repair_response',repaired_response:{cards:[c],note:null}};}
  return review(d);
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 assert.equal(readCompileJob(root,'job').status,'completed');assert.ok(existsSync(join(root,'01-Cards/kept.md')));assert.equal(m.requests.length,3);
});

for(const rejectLink of [false,true])test(`repair rechecks pending incoming links and keeps unresolved relations in the pool (reject=${rejectLink})`,async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref;
 const good={...card(ref,'good'),relations:[{target:'bad',type:'supplement',basis:'source',note:'补充具体条件'}]};
 const m=model(d=>{
  if(d.phase==='generate')return {cards:[good,card(ref,'bad')],note:'两个对象'};
  if(d.phase==='repair')return {card:d.supplied_card};
  return {...review(d),issues:(d.supplied_cards??[d.supplied_card]).some(c=>c.id==='bad')?[issue]:[]};
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 assert.doesNotMatch(readFileSync(join(root,'01-Cards/good.md'),'utf8'),/target: bad/);
 const parent=readCompileJob(root,'job'),item=listCompileIsolation(root)[0],prepared=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision});
 const repair={...parent,...prepared.fields,id:'repair-links',session_id:'s2',owner_session_id:'s2',sessions:['s2'],status:'running',receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>d.phase==='repair'?{card:d.supplied_card}:rejectLink&&d.phase==='relation-verify'?{...review(d),issues:[{id:'good',kind:'relation',related_card_ids:['bad'],message:'当前两端不足以支持补充关系，请移除该关系。'}]}:review(d));
 await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 const end=readCompileJob(root,repair.id);assert.equal(end.status,'completed',end.detail);assert.equal(end.repair_reconciliation_error,undefined);
 if(!rejectLink)assert.match(readFileSync(join(root,'01-Cards/good.md'),'utf8'),/target: bad/);
 else{
  assert.doesNotMatch(readFileSync(join(root,'01-Cards/good.md'),'utf8'),/target: bad/);
  const pending=listCompileIsolation(root)[0];assert.equal(pending.repair_kind,'relation');assert.equal(pending.card_id,'good');
  const staleParent=readCompileJob(root,'job');staleParent.unit_work[ref].references.push({id:'bad',title:'旧目标',type:'model',domains:[],summary:'旧摘要',body:'旧目标正文',revision:'stale',relations:[],delivery:'full'});saveCompileJob(root,staleParent);
  const relationPreparation=prepareIsolationRepair(root,{item_id:pending.id,expected_revision:pending.revision});
  const refreshedTarget=relationPreparation.fields.unit_work[ref].references.find(reference=>reference.id==='bad');
  assert.equal(refreshedTarget.delivery,'full');assert.notEqual(refreshedTarget.revision,'stale');assert.match(refreshedTarget.body,/制度条件约束行为/);
  const next={...readCompileJob(root,'job'),...relationPreparation.fields,id:'repair-relation',status:'running',session_id:'s3',owner_session_id:'s3',sessions:['s3'],receipts:[],calls:[],failures:[],archives:[]};
  initializeProviderBudget(root,next.id,{limit:12});saveCompileJob(root,next);bindIsolationRepair(root,next);
  const resolve=model(d=>d.phase==='check'&&d.repair_diagnosis?{...review(d),issues:[{id:'good',kind:'relation',related_card_ids:['bad'],message:'当前两端不足以支持补充关系；删除 good 指向 bad 的 supplement。'}]}:d.phase==='relation-repair'?{card:{...d.supplied_card,relations:[]}}:review(d));
  await executeBookCompile({},root,next,new AbortController(),{generate:resolve.generate});
  assert.equal(readCompileJob(root,next.id).status,'completed',readCompileJob(root,next.id).detail);
  assert.deepEqual(resolve.requests.map(req=>data(req).phase),['check','relation-repair'],'明确删除原关系后由宿主确定性核验，不再额外调用模型');
 }
 const reconciled=readCompileJob(root,'job');assert.deepEqual(reconcileBookReceipts(root,reconciled).issues,[]);
 assert.equal(listCompileIsolation(root).length,0);
});

test('manual recovery of an invalid identity restores only that candidate and preserves sibling pending work',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref;
 const m=model(d=>{
  if(d.phase==='generate')return {cards:[card(ref,'safe'),card(ref,'../broken'),card(ref,'bad')],note:'保留三个对象'};
  if(d.phase==='repair')return {card:d.supplied_card};
  return {...review(d),issues:(d.supplied_cards??[d.supplied_card]).some(c=>c.id==='bad')?[issue]:[]};
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 const saved=readFileSync(join(root,'01-Cards/safe.md'),'utf8'),item=listCompileIsolation(root).find(row=>row.repair_kind==='response');
 const fields=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision,response_json:JSON.stringify({cards:[card(ref,'restored')],note:'只校正候选身份'})}).fields;
 const repair={...readCompileJob(root,'job'),...fields,id:'repair-response',status:'running',session_id:'s2',owner_session_id:'s2',sessions:['s2'],receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>{assert.deepEqual(review(d).checked_ids,['restored']);return review(d);});
 await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 assert.equal(readCompileJob(root,repair.id).status,'completed');assert.ok(existsSync(join(root,'01-Cards/restored.md')));
 assert.deepEqual(listCompileIsolation(root).map(row=>row.card_id),['bad']);assert.equal(readCompileJob(root,'job').book_outcomes[ref].status,'quarantined');
 assert.equal(readFileSync(join(root,'01-Cards/safe.md'),'utf8'),saved);
});

test('a failed dedicated repair keeps the latest candidate and concrete issues for another explicit repair',async t=>{
 const {root,end}=await quarantined(t),item=listCompileIsolation(root)[0];
 const fields=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision}).fields;
 const repair={...end,...fields,id:'failed-repair',status:'running',session_id:'s2',owner_session_id:'s2',sessions:['s2'],receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>d.phase==='repair'?{card:{...d.supplied_card,body:d.supplied_card.body+'\n保留最新候选。'}}:{...review(d),issues:[issue]});
 await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 const [retained]=listCompileIsolation(root,{details:true});assert.match(retained.body,/保留最新候选/);assert.equal(retained.last_repair.job_id,repair.id);
 assert.equal(retained.repair_status,'partial');assert.equal(existsSync(join(root,'01-Cards/bad.md')),false);
 assert.equal(prepareIsolationRepair(root,{item_id:retained.id,expected_revision:retained.revision}).fields.unit_work[item.unit_ref].repairs.bad,0);
});

test('provider budget failure during schema recovery remains a global stop',async t=>{
 const {root,job}=fixture(t),m=model((d,req)=>{
  if(req.nexoPrompt.phase==='unit-recovery')throw Object.assign(new Error('额度耗尽'),{code:'UNO_PROVIDER_BUDGET'});
  if(d.phase==='generate')return {cards:[card(d.source.ref,'safe')],note:'一个对象'};
  return 'bad json';
 });
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 assert.equal(readCompileJob(root,'job').status,'paused');assert.equal(readCompileJob(root,'job').last_failure.code,'UNO_PROVIDER_BUDGET');
 assert.equal(listCompileIsolation(root).length,0);assert.equal(m.requests.filter(req=>data(req).phase==='generate').length,1);
 const end=readCompileJob(root,'job');assert.equal(end.recovery_model_calls,0);assert.equal(Object.keys(end.unit_work[job.book_units[0].ref].recovery.attempts).length,0);
});

test('truncated response enters the pool with complete prefix preserved and explicit repair requests only the remainder',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref,kept=card(ref,'kept');
 const raw='{"cards":['+JSON.stringify(kept)+',{"id":"unfinished';
 const m=model(()=>{throw Object.assign(new Error('达到输出上限'),{code:'MODEL_OUTPUT_TRUNCATED',partialResponse:raw});});
 await executeBookCompile({},root,job,new AbortController(),{generate:m.generate});
 const item=listCompileIsolation(root,{details:true})[0];assert.equal(item.response_truncated,true);assert.equal(item.raw_response,raw);
 const fields=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision}).fields;
 const repair={...readCompileJob(root,'job'),...fields,id:'repair-truncated',status:'running',session_id:'s2',owner_session_id:'s2',sessions:['s2'],receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>{if(d.phase==='generate'){assert.equal(d.previous_truncated,true);assert.deepEqual(d.completed_cards.map(card=>card.id),['kept']);return {cards:[card(ref,'remaining')],note:'补充余下对象'};}return review(d);});
 await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 assert.equal(readCompileJob(root,repair.id).status,'completed');assert.equal(listCompileIsolation(root).length,0);
 assert.ok(existsSync(join(root,'01-Cards/kept.md')));assert.ok(existsSync(join(root,'01-Cards/remaining.md')));
});

test('context rejection before the first model call still freezes a repairable source checkpoint',async t=>{
 const {root,job}=fixture(t,1),ref=job.book_units[0].ref;
 await executeBookCompile({},root,job,new AbortController(),{turn:async()=>{throw Object.assign(new Error('上下文超过限制'),{code:'UNIT_CONTEXT_LIMIT'});}});
 assert.equal(readCompileJob(root,'job').unit_work[ref].source_revision,job.book_units[0].revision);
 const item=listCompileIsolation(root)[0],fields=prepareIsolationRepair(root,{item_id:item.id,expected_revision:item.revision}).fields;
 const repair={...readCompileJob(root,'job'),...fields,id:'repair-context',status:'running',session_id:'s2',owner_session_id:'s2',sessions:['s2'],receipts:[],calls:[],failures:[],archives:[]};
 initializeProviderBudget(root,repair.id,{limit:12});saveCompileJob(root,repair);bindIsolationRepair(root,repair);
 const fix=model(d=>d.phase==='generate'?{cards:[card(ref,'recovered')],note:'一个对象'}:review(d));
 await executeBookCompile({},root,repair,new AbortController(),{generate:fix.generate});
 assert.equal(readCompileJob(root,repair.id).repair_reconciliation_error,undefined);assert.equal(listCompileIsolation(root).length,0);
});
