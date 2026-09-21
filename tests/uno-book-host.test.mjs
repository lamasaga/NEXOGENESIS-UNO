import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { sha, unoMarkdown } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { saveCompileJob, readCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { initializeProviderBudget, getProviderBudget, reserveProviderRequest, settleProviderRequest } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import { executeBookCompile, runBookTurn, BOOK_WORKFLOW, bindCardVersions, completeBookState, prepareBookResume, resolveBookPause } from '../packages/nexogenesis-web-host/lib/book-compile.js';
import { bookResumeState } from '../packages/nexogenesis-tools/lib/uno/book-agent.js';
import { CARD_CLASSIFICATION_CONTRACT } from '../packages/nexogenesis-tools/lib/uno/card-classification.js';
import { normalizeGeneratedEnvelope, validateGeneratedCards } from '../packages/nexogenesis-web-host/lib/unit-card-request.js';

function fixture(t,texts=['甲'.repeat(59000)+'末尾关键反证甲','乙'.repeat(58000)+'末尾关键反证乙']) {
 const root=mkdtempSync(join(tmpdir(),'uno-unit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'00-Inbox'));
 const source='00-Inbox/test.md',original=texts.join('\n\n');writeFileSync(join(root,source),original);
 const prepared={fingerprint:sha(original),chapters:texts.map((text,i)=>({text,title:'章节'+i,locator:'章节'+i}))};
 const info=new HarnessGateway(root).prepareBookSource({source,prepared});
 const job={id:'job',mode:'compile',workflow:BOOK_WORKFLOW,status:'running',phase:'read',session_id:'s1',owner_session_id:'s1',sessions:['s1'],sources:[{...info,original_source:source}],selected_sources:[source],source_revisions:{[source]:sha(original)},book_units:info.units,book_outcomes:{},book_focus_refs:[info.units[0].ref],book_reads:{},book_card_reads:{},calls:[],receipts:[],touched:[],failures:[],batch_index:0,budget:{calls:20},continuous:true,model_selection:{provider:'nexo-deepseek',model:'test'},compile_profile:'unit-cards-v3',card_classification:CARD_CLASSIFICATION_CONTRACT,domain_catalog:[]};
 initializeProviderBudget(root,job.id,{limit:20});saveCompileJob(root,job);return {root,job};
}
const data=req=>JSON.parse(req.messages[0].content[0].text.split('\n').slice(1).join('\n'));
const card=(ref,id)=>({id,title:'具体机制'+id,type:'model',body:'## 核心思想\n原文描述了制度条件下的作用机制。\n\n## 关键组件\n制度约束行动者可选择的行为。\n\n## 结构关系或因果链条\n约束变化通过激励影响行动。\n\n## 失效边界\n只适用于来源限定的制度环境。\n\n## 来源与证据边界\n依据本单元的制度描述，不能从特定经验推广为普遍因果。',domains:[],sources:[{ref}],relations:[]});
function model(root, handler){const requests=[];const ctx={get:name=>name==='llm'?{async *stream(req){requests.push(req);const reserved=reserveProviderRequest(ctx,req);try{yield {type:'text-delta',text:JSON.stringify(await handler(req,requests.length))};yield {type:'usage',usage:{inputTokens:100,outputTokens:40}};yield {type:'finish',reason:{kind:'stop'}};settleProviderRequest(reserved,{state:'completed'});}catch(e){settleProviderRequest(reserved,{state:'failed'});throw e;}}}:null};return {ctx,requests};}
const happy=req=>{const d=data(req);return d.phase==='generate'?{cards:[card(d.source.ref,'card-'+sha(d.source.ref).slice(0,8))],note:'已覆盖本单元机制及条件'}:{checked_ids:(d.supplied_cards??[d.supplied_card]).map(c=>c.id),issues:[],unit_issues:[]}};

test('high-quality compile refines every generated card before the independent review',async t=>{
 const {root,job}=fixture(t,['制度机制原文。']),ref=job.book_focus_refs[0];job.compile_quality_mode='refine-each-card-v1';saveCompileJob(root,job);
 const generated=[card(ref,'alpha'),card(ref,'beta')],{ctx,requests}=model(root,req=>{
  const d=data(req);
  if(d.phase==='generate')return {cards:generated,note:'已覆盖制度机制'};
  if(d.phase==='refine'){
   assert.equal(req.messages.length,2);assert.ok(req.unit_context.source_chars>0);assert.deepEqual(d.relation_targets,[]);
   return {card:{...d.supplied_card,title:'精修 · '+d.supplied_card.title,summary:'经原文核对的独立摘要'}};
  }
  assert.equal(d.phase,'check');assert.ok(d.supplied_cards.every(item=>item.title.startsWith('精修 · ')));
  return {checked_ids:d.supplied_cards.map(item=>item.id),issues:[],unit_issues:[]};
 });
 await runBookTurn(ctx,root,job,new AbortController().signal);
 const saved=readCompileJob(root,job.id),work=saved.unit_work[ref];
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','refine','refine','check']);
 assert.deepEqual(Object.keys(work.refinements).sort(),['alpha','beta']);
 assert.match(readFileSync(join(root,'01-Cards/alpha.md'),'utf8'),/精修 · 具体机制alpha/);
});
test('resume never repeats completed card refinement after a later review transport failure',async t=>{
 const {root,job}=fixture(t,['制度机制原文。']),ref=job.book_focus_refs[0];job.compile_quality_mode='refine-each-card-v1';saveCompileJob(root,job);
 let checks=0;const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(ref,'only')],note:'已覆盖'};
  if(d.phase==='refine')return {card:{...d.supplied_card,summary:'精修摘要'}};
  if(++checks===1)throw new Error('review interrupted');
  return {checked_ids:d.supplied_cards.map(item=>item.id),issues:[],unit_issues:[]};
 });
 await assert.rejects(runBookTurn(ctx,root,job,new AbortController().signal),/review interrupted/);
 await runBookTurn(ctx,root,readCompileJob(root,job.id),new AbortController().signal);
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','refine','check','check']);
 assert.equal(readCompileJob(root,job.id).unit_work[ref].phase,'done');
});
test('high-quality refinement cannot change sources or invent a relation endpoint',async t=>{
 const {root,job}=fixture(t,['制度机制原文。']),ref=job.book_focus_refs[0];
 Object.assign(job,{compile_quality_mode:'refine-each-card-v1',compile_isolation:'compile-isolation-v1'});saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(ref,'unsafe'),card(ref,'safe')],note:'已覆盖'};
  if(d.phase==='refine'&&d.supplied_card.id==='unsafe')return {card:{...d.supplied_card,relations:[{target:'not-delivered',type:'supplement',note:'越权',basis:'source'}]}};
  if(d.phase==='refine')return {card:{...d.supplied_card,summary:'安全精修'}};
  return {checked_ids:d.supplied_cards.map(item=>item.id),issues:[],unit_issues:[]};
 });
 await runBookTurn(ctx,root,job,new AbortController().signal);
 const saved=readCompileJob(root,job.id),work=saved.unit_work[ref];
 assert.equal(work.isolation.items['card-unsafe'].code,'UNIT_REPAIR_SCOPE_VIOLATION');
 assert.equal(existsSync(join(root,'01-Cards/unsafe.md')),false);assert.equal(existsSync(join(root,'01-Cards/safe.md')),true);
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','refine','refine','check']);
});

for(const retained of [false,true])test(`missing generation note uses normal review without regenerating (${retained?'retained':'fresh'})`,async t=>{
 const {root,job}=fixture(t,['制度机制原文。']),ref=job.book_focus_refs[0],candidate=card(ref,'candidate'),raw=JSON.stringify({cards:[candidate]});
 if(retained){job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],phase:'generate',last_response:{phase:'generate',text:raw}}};saveCompileJob(root,job);}
 const {ctx,requests}=model(root,req=>{
  const d=data(req);if(d.phase==='generate')return JSON.parse(raw);
  assert.equal(d.phase,'check');assert.deepEqual(d.supplied_cards,[candidate]);
  return {checked_ids:['candidate'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,job.id),work=end.unit_work[ref];
 assert.equal(end.status,'completed',end.detail);assert.equal(requests.length,retained?1:2);
 assert.match(work.note,/未提供覆盖说明/);assert.equal(end.last_recovery.model_calls,0);
 assert.equal(work.recovery.events[0].original_response,raw);
 assert.ok(existsSync(join(root,'01-Cards/candidate.md')));
});

test('generation note normalization never fabricates an empty result rationale or repairs invalid cards',()=>{
 const c=card('u','safe');
 for(const note of [undefined,null,'','  ']){
  const input={cards:[c],note},before=JSON.stringify(input),result=normalizeGeneratedEnvelope(input);
  assert.equal(JSON.stringify(input),before);assert.equal(result.value.cards,input.cards);
  assert.deepEqual(result.changes,['missing-generation-note']);
  assert.throws(()=>validateGeneratedCards(normalizeGeneratedEnvelope({cards:[],note}).value),{code:'INVALID_GENERATION_RESPONSE'});
 }
 for(const cards of [[c,c],Array.from({length:101},(_,i)=>({...c,id:'card-'+i})),[{...c,body:''}],[{...c,id:'../unsafe'}]])assert.throws(()=>normalizeGeneratedEnvelope({cards}),{code:'INVALID_GENERATION_RESPONSE'});
 assert.throws(()=>validateGeneratedCards(normalizeGeneratedEnvelope({cards:[c],note:{coverage:'unknown'}}).value),{code:'INVALID_GENERATION_RESPONSE'});
 assert.equal(validateGeneratedCards({cards:[],note:'只有章节导航'}).cards.length,0);
});

test('missing note does not bypass semantic review or publish rejected candidates',async t=>{
 const {root,job}=fixture(t,['原文。']);
 const {ctx,requests}=model(root,req=>{
  const d=data(req);if(d.phase==='generate')return {cards:[card(d.source.ref,'rejected')]};
  if(d.phase==='repair')return {card:d.supplied_card};
  return {checked_ids:['rejected'],issues:[{id:'rejected',kind:'card',related_card_ids:[],message:'核心思想缺少必要条件，当前内容无法支持结论。'}],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,job.id);assert.equal(end.last_failure.code,'UNIT_CARD_REPAIR_EXHAUSTED');
 assert.equal(existsSync(join(root,'01-Cards/rejected.md')),false);
 assert.equal(requests.filter(req=>data(req).phase==='generate').length,1);
});

test('empty candidates without a note remain blocked without regeneration',async t=>{
  const {root,job}=fixture(t,['原文。']);
  const {ctx,requests}=model(root,()=>({cards:[]}));
  await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
  assert.equal(end.status,'paused');assert.equal(end.last_failure.code,'INVALID_GENERATION_RESPONSE');assert.equal(end.last_failure.category,'response_contract');
  assert.equal(requests.length,1);assert.equal(Object.keys(end.book_outcomes).length,0);
});

function collisionFixture(t) {
 const f=fixture(t,['本章提供新的制度条件。']),ref=f.job.book_focus_refs[0],candidate=card(ref,'existing');
 const prior=unoMarkdown({id:'existing',title:'已有制度机制',type:'model',domains:[],sources:['old-evidence'],lifecycle:'active'},candidate.body+'\n旧卡独有的例外必须保留。');
 mkdirSync(join(f.root,'01-Cards'),{recursive:true});writeFileSync(join(f.root,'01-Cards/existing.md'),prior);
 f.job.unit_work={[ref]:{source_revision:sha(readFileSync(join(f.root,ref))),references:[],cards:[candidate,card(ref,'other')],phase:'check',repairs:{},checks:{}}};
 saveCompileJob(f.root,f.job);return {...f,ref,candidate,prior};
}

test('unseen existing ID is compared locally before merging, then passes normal review and Gateway history',async t=>{
 const {root,job,ref,prior}=collisionFixture(t),{ctx,requests}=model(root,req=>{
  const d=data(req);
  if(d.phase==='collision'){
   assert.equal(req.unit_context.source_chars,0);assert.equal(req.messages.length,1);
   assert.deepEqual(Object.keys(d),['phase','candidate','existing_card']);assert.equal(d.existing_card.revision,undefined);
   assert.ok(d.existing_card.body.includes('旧卡独有的例外必须保留'));
   return {action:'revise',reason:'同一对象，新条件需合并',card:{...d.candidate,body:d.existing_card.body+'\n新条件已合并。'}};
  }
  assert.equal(d.phase,'check');return {checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};
 });
 await runBookTurn(ctx,root,job,new AbortController().signal);
 const saved=readCompileJob(root,job.id);assert.equal(saved.unit_work[ref].phase,'done');
 assert.deepEqual(requests.map(req=>data(req).phase),['collision','check']);
 assert.equal(readFileSync(join(root,`03-Archive/card-history/existing/${sha(prior)}.md`),'utf8'),prior);
 const written=readFileSync(join(root,'01-Cards/existing.md'),'utf8');assert.match(written,/旧卡独有的例外必须保留/);assert.match(written,/old-evidence/);
 assert.equal(saved.unit_work[ref].card_collisions.existing.action,'revise');
});

test('reuse of a collided identity retains old bytes, verifies its version and supports reviewed incoming relations',async t=>{
 const {root,job,ref,prior}=collisionFixture(t);
 job.unit_work[ref].cards[1].relations=[{target:'existing',type:'supplement',note:'具体制度条件补充旧对象',basis:'source'}];saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{const d=data(req);return d.phase==='collision'?{action:'reuse',reason:'旧对象完整覆盖候选，无增量',card:null}:{checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};});
 await runBookTurn(ctx,root,job,new AbortController().signal);
 assert.equal(readFileSync(join(root,'01-Cards/existing.md'),'utf8'),prior);
 assert.match(readFileSync(join(root,'01-Cards/other.md'),'utf8'),/target: existing/);
 assert.deepEqual(readCompileJob(root,job.id).book_outcomes[ref].card_ids,['other','existing']);
 assert.deepEqual(requests.map(req=>data(req).phase),['collision','check']);
});

test('separate collided objects get a host ID and local incoming relations follow it without changing the old card',async t=>{
 const {root,job,ref,prior}=collisionFixture(t);
 job.unit_work[ref].cards[1].relations=[{target:'existing',type:'supplement',note:'补充新对象',basis:'source'}];saveCompileJob(root,job);
 const {ctx}=model(root,req=>{const d=data(req);return d.phase==='collision'?{action:'separate',reason:'同名但不同对象',card:null}:{checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};});
 await runBookTurn(ctx,root,job,new AbortController().signal);
 const saved=readCompileJob(root,job.id),next=saved.unit_work[ref].card_collisions.existing.new_id;
 assert.ok(next.startsWith('existing-'));assert.ok(existsSync(join(root,'01-Cards',next+'.md')));
 assert.equal(readFileSync(join(root,'01-Cards/existing.md'),'utf8'),prior);
 assert.match(readFileSync(join(root,'01-Cards/other.md'),'utf8'),new RegExp('target: '+next));
});

test('collision resolution survives a later review failure without repeating generation or identity comparison',async t=>{
 const {root,job,ref}=collisionFixture(t),{ctx,requests}=model(root,req=>{
  const d=data(req);if(d.phase==='collision')return {action:'revise',reason:'同一对象增量',card:{...d.candidate,body:d.existing_card.body}};
  if(requests.filter(r=>data(r).phase==='check').length===1)throw new Error('review interrupted');
  return {checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};
 });
 await assert.rejects(runBookTurn(ctx,root,job,new AbortController().signal),/review interrupted/);
 await runBookTurn(ctx,root,readCompileJob(root,job.id),new AbortController().signal);
 assert.equal(readCompileJob(root,job.id).unit_work[ref].phase,'done');
 assert.deepEqual(requests.map(req=>data(req).phase),['collision','check','check']);
});

test('concurrent edits and invalid collision decisions stay blocked without replaying the same paid response',async t=>{
 for(const mode of ['changed','invalid']){
  const {root,job,prior}=collisionFixture(t),{ctx,requests}=model(root,req=>{
   const d=data(req);assert.equal(d.phase,'collision');
   if(mode==='changed')writeFileSync(join(root,'01-Cards/existing.md'),prior+'\n另一操作的变更');
   return mode==='invalid'?{action:'revise',reason:'合并',card:{...d.candidate,relations:[{target:'unknown',type:'supplement',note:'未经授权'}]}}:{action:'reuse',reason:'已覆盖',card:null};
  });
  const code=mode==='changed'?'REVISION_CONFLICT':'INVALID_COLLISION_DECISION';
  await assert.rejects(runBookTurn(ctx,root,job,new AbortController().signal),{code});
  await assert.rejects(runBookTurn(ctx,root,readCompileJob(root,job.id),new AbortController().signal),{code});
  assert.equal(requests.length,1);assert.equal(existsSync(join(root,'01-Cards/other.md')),false);
 }
});

test('a summary collision must receive the complete existing card before it grants update authority',async t=>{
 const {root,job,ref,prior}=collisionFixture(t);
 job.unit_work[ref].references=[{id:'existing',delivery:'summary',revision:sha(prior),title:'摘要不授权'}];
 job.unit_work[ref].cards[1].relations=[{target:'existing',type:'supplement',note:'补充具体条件',basis:'source'}];saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{const d=data(req);if(d.phase==='collision'){
  assert.match(d.existing_card.body,/旧卡独有的例外/);return {action:'reuse',reason:'旧卡完整覆盖',card:null};
 }return {checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};});
 await runBookTurn(ctx,root,job,new AbortController().signal);assert.equal(requests[0].nexoPrompt.phase,'unit-collision');
 assert.equal(readFileSync(join(root,'01-Cards/existing.md'),'utf8'),prior);
});

test('a changed full reference remains a real version conflict and never enters collision recovery',async t=>{
 const {root,job,ref,prior,candidate}=collisionFixture(t);
 job.unit_work[ref].references=[{...candidate,delivery:'full',revision:sha(prior)}];saveCompileJob(root,job);
 writeFileSync(join(root,'01-Cards/existing.md'),prior+'\n并发修改');
 const {ctx,requests}=model(root,()=>{throw Error('must not call model');});
 await assert.rejects(runBookTurn(ctx,root,job,new AbortController().signal),{code:'REVISION_CONFLICT'});assert.equal(requests.length,0);
});

test('collision merge accepts omitted default source basis but preserves explicit navigation provenance',async t=>{
 for(const basis of ['source','navigation']){
  const {root,job,ref,candidate}=collisionFixture(t);
  candidate.relations=[{target:'other',type:'supplement',note:'说明具体增量',basis}];job.unit_work[ref].cards[0]=candidate;saveCompileJob(root,job);
  const {ctx}=model(root,req=>{const d=data(req);return d.phase==='collision'
   ? {action:'revise',reason:'合并相同对象',card:{...d.candidate,body:d.existing_card.body,relations:d.candidate.relations.map(({basis,...relation})=>relation)}}
   : {checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};});
  if(basis==='navigation')await assert.rejects(runBookTurn(ctx,root,job,new AbortController().signal),{code:'INVALID_COLLISION_DECISION'});
  else{await runBookTurn(ctx,root,job,new AbortController().signal);assert.match(readFileSync(join(root,'01-Cards/existing.md'),'utf8'),/basis: source/);}
 }
});

test('finished originals leave Inbox before a manual domain checkpoint waits for approval',async t=>{
 const {root,job}=fixture(t,['第一单元。','第二单元。','第三单元。']),{ctx}=model(root,happy);let checked=false;
 await executeBookCompile(ctx,root,job,new AbortController(),{domainCheckpoint:async(_ctx,_root,current)=>{
  checked=true;assert.equal(existsSync(join(root,'00-Inbox/test.md')),false);assert.equal(current.archives.length,1);
  current.status='review';current.phase='domain_review';saveCompileJob(root,current);return true;
 }});
 assert.ok(checked);const saved=readCompileJob(root,job.id);assert.equal(saved.status,'review');assert.equal(saved.archives.length,1);
 assert.equal(Object.values(saved.book_outcomes).filter(o=>o.status==='processed').length,3);
});

test('a read navigation-only unit completes with zero cards and no supplement or repair',async t=>{
 const {root,job}=fixture(t,['全书分为两篇十二章，本单元仅介绍各章主题和阅读顺序。']);
 const note='本单元只有全书分篇与章节导航，没有独立知识对象；编排信息保留在原文中。';
 const {ctx,requests}=model(root,req=>{
  const d=data(req);
  if(d.phase==='generate')return {cards:[],note};
  assert.equal(d.phase,'check');assert.deepEqual(d.supplied_cards,[]);
  assert.match(req.system,/supplied_cards 为空不构成遗漏/);
  return {checked_ids:[],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,job.id),ref=job.book_units[0].ref;
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(end.touched,[]);
 assert.equal(end.book_outcomes[ref].status,'processed');assert.equal(end.unit_work[ref].note,note);
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','check']);
 assert.equal(getProviderBudget(root,job.id).used,2);
 assert.equal(existsSync(join(root,'00-Inbox/test.md')),false);
 assert.equal(existsSync(join(root,ref)),true,'the navigation source remains traceable');
});

test('a review-confirmed outline cannot publish through cosmetic repair while valid cards are saved',async t=>{
 const {root,job}=fixture(t,['本章包含篇章介绍和独立机制。']);
 const message='正文“关键组件”仅列各章主题，“结构关系”仅描述章节顺序，没有独立知识对象；不能用改名、更换 type 或补空话修复。';
 const issue={id:'roadmap',kind:'card',related_card_ids:[],message};
 const {ctx,requests}=model(root,req=>{
  const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'valid'),{...card(d.source.ref,'roadmap'),title:'全书路线图',body:'## 核心思想\n全书分为两篇。\n\n## 关键组件\n第一章产业，第二章金融。\n\n## 结构关系或因果链条\n先读第一章再读第二章。\n\n## 失效边界\n仅为章节导航。\n\n## 来源与证据边界\n依据原文的篇章说明。'}],note:'机制与目录'};
  if(d.phase==='check')return {checked_ids:['valid','roadmap'],issues:[issue],unit_issues:[]};
  assert.equal(d.supplied_card.id,'roadmap');assert.equal(existsSync(join(root,'01-Cards/valid.md')),true);
  if(d.phase==='repair')return {card:{...d.supplied_card,title:'专题框架'}};
  assert.equal(d.phase,'verify');return {checked_ids:['roadmap'],issues:[issue],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,job.id);
 assert.equal(end.status,'paused');assert.equal(end.error_code,'UNIT_CARD_REPAIR_EXHAUSTED');
 assert.deepEqual(end.touched,['valid']);assert.equal(existsSync(join(root,'01-Cards/roadmap.md')),false);
 assert.equal(end.unit_work[job.book_units[0].ref].repairs.roadmap,2);
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','check','repair','verify','repair','verify']);
});

test('completion distinguishes source gaps, remaining units, archive failures and separate domain debt',()=>{
  const base={book_units:[{ref:'one'}],book_outcomes:{one:{status:'processed'}},sources:[{source:'book',incomplete:true}],failures:[],touched:['a'],last_failure:{message:'old failure'},error_code:'OLD',domain_governance:{open_unassigned:15}};
  const done=completeBookState(structuredClone(base));
  assert.equal(done.status,'partial');assert.equal(bookResumeState(done).available,false);assert.equal(done.last_failure,undefined);
  assert.match(done.detail,/未提取正文/);assert.match(done.detail,/领域组织另有 15 张/);
  const organizedLater=completeBookState({...structuredClone(base),sources:[{source:'book'}]});
  assert.equal(organizedLater.status,'completed','domain debt does not replay source compilation');
  for(const status of ['deferred',null]){
    const remaining=completeBookState({...structuredClone(base),book_outcomes:status?{one:{status}}:{}});
    assert.equal(remaining.status,'partial');assert.equal(bookResumeState(remaining).available,true);
  }
  const archive=completeBookState({...structuredClone(base),failures:[{kind:'archive',source:'book'}]});
  assert.equal(bookResumeState(archive).available,true);assert.match(archive.detail,/提取或归档失败/);
  assert.equal(bookResumeState({...done,phase:'read',status:'paused'}).available,true,'interrupted finalization can still resume');
});

test('reasoning-only model stop is retryable and never caches an empty generation as success',async t=>{
  const {root,job}=fixture(t,['本章包含可独立提炼的制度机制。']),requests=[];
  const ctx={get:name=>name==='llm'?{async *stream(req){requests.push(req);const reserved=reserveProviderRequest(ctx,req);
    yield {type:'usage',usage:{inputTokens:120,outputTokens:40,reasoningTokens:40}};
    yield {type:'finish',reason:{kind:'stop'}};settleProviderRequest(reserved,{state:'completed'});
  }}:null};
  await executeBookCompile(ctx,root,job,new AbortController());
  const end=readCompileJob(root,job.id),work=end.unit_work[job.book_units[0].ref];
  assert.equal(end.status,'paused');assert.equal(end.error_code,'MODEL_EMPTY_RESPONSE');
  assert.equal(end.last_failure.message,'模型本次没有返回可解析正文；当前单元未保存，继续后只重试这个单元。');
  assert.equal(end.last_failure.category,'response_contract');assert.equal(end.last_failure.automatic_recovery,false);assert.equal(end.last_failure.retryable,true);
  assert.equal(end.calls.at(-1).status,'failed');assert.equal(end.calls.at(-1).response,'');
  assert.equal(work.response,undefined);assert.equal(work.last_response,undefined);assert.equal(end.book_outcomes[job.book_units[0].ref],undefined);assert.equal(requests.length,1);
});

test('explicit resume discards only a legacy empty generation envelope',t=>{
  const {job}=fixture(t,['本章包含可独立提炼的制度机制。']),ref=job.book_focus_refs[0];
  job.unit_work={[ref]:{source_revision:job.book_units[0].revision,references:[],phase:'generate',repairs:{},checks:{},response:{key:'old',phase:'generate',text:''},last_response:{phase:'generate',text:''}}};
  job.book_outcomes={'already-done':{status:'processed',card_ids:['saved']}};job.touched=['saved'];job.last_recovery={at:'2026-09-18T14:42:52.000Z'};job.last_failure={at:'2026-09-18T15:04:03.000Z'};
  assert.equal(prepareBookResume(job),true);assert.equal(job.unit_work[ref].response,undefined);assert.equal(job.unit_work[ref].last_response,undefined);
  assert.equal(job.unit_work[ref].empty_generation_retries.at(-1).unit_ref,ref);assert.equal(job.last_recovery,undefined);assert.deepEqual(job.book_outcomes,{'already-done':{status:'processed',card_ids:['saved']}});assert.deepEqual(job.touched,['saved']);
  assert.equal(prepareBookResume(job),false);
});

test('review-exhausted candidates require an explicit discard decision and then settle without another model call',async t=>{
  const {root,job}=fixture(t,['只有章节导语，没有形成可独立复用的知识对象。']),ref=job.book_focus_refs[0],candidate=card(ref,'outline-only');
  job.status='paused';job.error_code='UNIT_CARD_REPAIR_EXHAUSTED';job.last_failure={code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'已保存 0 张卡片；1 张问题卡尚未通过。',retryable:false};
  job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[candidate],note:'章首问题框架',phase:'check',published:{},reused:{},pending_issues:{'outline-only':['本单元没有展开机制，不能形成独立知识对象。']},pending_issue_records:{},repairs:{'outline-only':2},repair_counts:{'outline-only':{card:2}},checks:{},initial_review_done:true,coverage_checked:true}};
  resolveBookPause(root,job,'discard-candidates');saveCompileJob(root,job);job.status='running';saveCompileJob(root,job);
  const {ctx,requests}=model(root,()=>{throw Error('discard settlement must not call model');});
  await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),work=end.unit_work[ref];
  assert.equal(end.status,'completed',end.detail);assert.equal(end.book_outcomes[ref].status,'processed');assert.deepEqual(end.book_outcomes[ref].card_ids,[]);
  assert.equal(work.rejected_candidates[0].id,'outline-only');assert.match(work.note,/放弃 1 张未通过候选/);assert.equal(requests.length,0);
});

test('defer decision advances the range without erasing the failed unit checkpoint',t=>{
  const {root,job}=fixture(t,['暂时无法安全结算的材料。']),ref=job.book_focus_refs[0],candidate=card(ref,'blocked');
  job.status='paused';job.error_code='UNIT_COVERAGE_BLOCKED';job.last_failure={code:'UNIT_COVERAGE_BLOCKED',message:'本单元遗漏仍未解决。',retryable:false};
  job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[candidate],phase:'check',published:{},reused:{},pending_issues:{blocked:['证据不足']},checks:{}}};
  resolveBookPause(root,job,'defer-unit');
  assert.equal(job.book_outcomes[ref].status,'deferred');assert.equal(job.unit_work[ref].phase,'deferred');assert.equal(job.unit_work[ref].pending_issues.blocked[0],'证据不足');
  assert.equal(job.last_failure,undefined);assert.match(job.detail,/已延期/);
});

test('discarding an exhausted deferred unit reopens only that unit for settlement',t=>{
  const {root,job}=fixture(t,['暂时无法安全结算的材料。']),ref=job.book_focus_refs[0],candidate=card(ref,'blocked');
  job.status='paused';job.error_code='UNIT_CARD_REPAIR_EXHAUSTED';job.last_failure={code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'问题卡修订耗尽。',retryable:false};
  job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[candidate],phase:'check',published:{},reused:{},pending_issues:{blocked:['证据不足']},pending_issue_records:{},repairs:{blocked:2},repair_counts:{blocked:{card:2}},checks:{}}};
  resolveBookPause(root,job,'defer-unit');job.status='partial';job.phase='done';job.book_focus_refs=[];
  resolveBookPause(root,job,'discard-candidates');
  assert.equal(job.book_outcomes[ref],undefined);assert.equal(job.unit_work[ref].pending_issues.blocked,undefined);assert.equal(job.unit_work[ref].rejected_candidates[0].id,'blocked');
  assert.equal(job.book_defer_history.at(-1).ref,ref);assert.match(job.detail,/正在按实际通过成果结算/);
});
test('an exhausted deferred unit can keep candidates in the repair pool and finish the main line without another model call',async t=>{
  const {root,job}=fixture(t,['暂时无法安全结算的材料。']),ref=job.book_focus_refs[0],candidate=card(ref,'blocked');
  job.compile_isolation='compile-isolation-v1';job.status='paused';job.error_code='UNIT_CARD_REPAIR_EXHAUSTED';
  job.last_failure={code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'问题卡修订耗尽。',retryable:false};
  job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[candidate],phase:'check',published:{},reused:{},pending_issues:{blocked:['证据不足']},pending_issue_records:{blocked:[{id:'blocked',kind:'card',related_card_ids:[],message:'证据不足'}]},repairs:{blocked:2},repair_counts:{blocked:{card:2}},checks:{}}};
  resolveBookPause(root,job,'defer-unit');job.status='partial';job.phase='done';job.book_focus_refs=[];
  resolveBookPause(root,job,'quarantine-candidates');saveCompileJob(root,job);job.status='running';saveCompileJob(root,job);
  const {ctx,requests}=model(root,()=>{throw Error('quarantine settlement must not call model');});
  await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),work=end.unit_work[ref];
  assert.equal(end.status,'partial');assert.equal(end.book_outcomes[ref].status,'quarantined');assert.equal(work.pending_issues.blocked[0],'证据不足');
  assert.equal(work.isolation.items['card-blocked'].status,'open');assert.equal(job.book_defer_history.at(-1).ref,ref);assert.equal(requests.length,0);
});
function seedLegacyCoverage(root,job,issue,id='legacy-card'){
 const ref=job.book_focus_refs[0],candidate=card(ref,id);
 job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[candidate],note:'历史整章审核结果',phase:'check',repairs:{},checks:{[id]:sha(JSON.stringify(candidate))},published:{},pending_issues:{},publish_first_version:1,initial_review_done:true,coverage_checked:true,unit_issues:[issue]}};
 saveCompileJob(root,job);return {ref,candidate};
}
test('large Chinese units each generate once then check, no history or reading tools; real budget and Gateway',async t=>{
 const {root,job}=fixture(t),{ctx,requests}=model(root,happy);await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,job.id);assert.equal(end.status,'completed',end.detail);assert.equal(end.touched.length,2);assert.equal(requests.length,4);assert.equal(getProviderBudget(root,job.id).used,4);
 for(const req of requests){assert.deepEqual(req.tools,[]);assert.ok(req.unit_context.other_chars<60000);
  if(data(req).phase==='generate'){assert.equal(req.messages.length,2);assert.ok(req.unit_context.source_chars>58000);}
  else {assert.equal(data(req).phase,'check');assert.equal(req.messages.length,1);assert.equal(req.unit_context.source_chars,0);assert.ok(!JSON.stringify(req).includes('末尾关键反证'));}
 }
 assert.ok(requests[0].messages[1].content[0].text.endsWith('末尾关键反证甲'));assert.ok(requests[2].messages[1].content[0].text.endsWith('末尾关键反证乙'));
 assert.ok(!JSON.stringify(requests[2]).includes('甲'.repeat(200)));assert.equal(existsSync(join(root,'00-Inbox/test.md')),false);
});
test('one flawed card is repaired alone and passed card is not regenerated',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let checks=0;
 const {ctx,requests}=model(root,req=>{const d=data(req);if(d.phase==='generate')return {cards:[card(d.source.ref,'good'),card(d.source.ref,'bad')],note:'两个知识对象'};
 if(d.phase==='repair'){assert.equal(d.supplied_card.id,'bad');assert.equal(d.supplied_cards,undefined);assert.ok(existsSync(join(root,'01-Cards/good.md')));assert.equal(existsSync(join(root,'01-Cards/bad.md')),false);assert.deepEqual(Object.keys(d).sort(),['issues','phase','supplied_card']);assert.equal(req.unit_context.source_chars,0);assert.equal(req.messages.length,1);assert.ok(!JSON.stringify(req).includes('完整原文。'));return {card:{...d.supplied_card,body:d.supplied_card.body+' 原作者保留了例外。'}};}
 return {checked_ids:(d.supplied_cards??[d.supplied_card]).map(c=>c.id),issues:checks++===0?[{id:'bad',message:'补回作者限制'}]:[],unit_issues:[]};});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,'job');assert.equal(end.status,'completed',end.detail);
 assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','repair','verify']);assert.deepEqual([data(requests[3]).supplied_card.id],['bad']);assert.equal(end.touched.length,2);
});
test('a reviewed empty relation uses the scoped relation repair path instead of the single-card guard',async t=>{
 const {root,job}=fixture(t,['完整原文。']);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'general'),card(d.source.ref,'specific')],note:'一般框架与具体对象'};
  if(d.phase==='check')return {checked_ids:['general','specific'],issues:[{id:'general',kind:'relation',related_card_ids:['specific'],message:'general 是一般对象；新增 specialization 指向 specific。'}],unit_issues:[]};
  if(d.phase==='relation-repair'){
   assert.deepEqual(d.related_cards.map(c=>c.id),['specific']);assert.equal(d.source,undefined);assert.equal(d.supplied_card.id,'general');
   return {card:{...d.supplied_card,relations:[{target:'specific',type:'specialization',note:'一般框架指向具体对象。',basis:'source'}]}};
  }
  assert.equal(d.phase,'relation-verify');assert.deepEqual(d.related_cards.map(c=>c.id),['specific']);
  return {checked_ids:['general'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','relation-repair','relation-verify']);
 assert.equal(parseCardFile(join(root,'01-Cards/general.md')).meta.relations[0].target,'specific');
});
test('relation repair restores punctuation-only summary drift and keeps the reviewed relation change',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const originalSummary='一般命题因此需要具体机制。';
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'general'),summary:originalSummary},card(d.source.ref,'specific')],note:'一般命题与具体机制'};
  if(d.phase==='check')return {checked_ids:['general','specific'],issues:[{id:'general',kind:'relation',related_card_ids:['specific'],message:'新增 supplement 指向具体机制。'}],unit_issues:[]};
  if(d.phase==='relation-repair')return {card:{...d.supplied_card,summary:'一般命题，因此需要具体机制。',relations:[{target:'specific',type:'supplement',note:'具体机制补充一般命题。',basis:'source'}]}};
  assert.equal(d.phase,'relation-verify');assert.equal(d.supplied_card.summary,originalSummary);return {checked_ids:['general'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),saved=parseCardFile(join(root,'01-Cards/general.md'));
 assert.equal(end.status,'completed',end.detail);assert.equal(saved.meta.summary,originalSummary);assert.equal(saved.meta.relations[0].target,'specific');
 assert.deepEqual(end.unit_work[job.book_focus_refs[0]].relation_scope_events[0].restored_fields,['summary']);
 assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','relation-repair','relation-verify']);
});
test('a semantic review-scope violation gets one bounded recheck instead of schema recovery',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let verifies=0;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'general'),relations:[{target:'specific',type:'supplement',note:'错误方向',basis:'source'}]},card(d.source.ref,'specific')],note:'两个对象'};
  if(d.phase==='check')return {checked_ids:['general','specific'],issues:[{id:'general',kind:'relation',related_card_ids:['specific'],message:'把 supplement 改为 specialization。'}],unit_issues:[]};
  if(d.phase==='relation-repair')return {card:{...d.supplied_card,relations:[{target:'specific',type:'specialization',note:'一般对象指向具体对象',basis:'source'}]}};
  assert.equal(d.phase,'relation-verify');verifies++;
  if(verifies===1)return {checked_ids:['general'],issues:[{id:'general',kind:'relation',related_card_ids:['not-supplied'],message:'错误引用未提供端点。'}],unit_issues:[]};
  assert.deepEqual(d.review_retry.allowed_related_card_ids,['specific']);assert.equal(d.review_retry.expected_issue_kind,'relation');
  return {checked_ids:['general'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.equal(verifies,2);
 assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','relation-repair','relation-verify','relation-verify']);
 assert.equal(requests.some(r=>data(r).phase==='recovery'),false);
});
test('resume processes the card named by the persisted verification checkpoint before older pending cards',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let relationVerifyCalls=0;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'older'),{...card(d.source.ref,'relation-card'),relations:[{target:'target',type:'supplement',note:'错误关系',basis:'source'}]},card(d.source.ref,'target')],note:'三个对象'};
  if(d.phase==='check')return {checked_ids:['older','relation-card','target'],issues:[
   {id:'older',kind:'card',related_card_ids:[],message:'仍需补充限制。'},
   {id:'relation-card',kind:'relation',related_card_ids:['target'],message:'把 supplement 改为 specialization。'}],unit_issues:[]};
  if(d.phase==='repair')return {card:{...d.supplied_card,body:d.supplied_card.body+'\n限制仍不完整。'}};
  if(d.phase==='verify')return {checked_ids:['older'],issues:[{id:'older',kind:'card',related_card_ids:[],message:'仍需补充限制。'}],unit_issues:[]};
  if(d.phase==='relation-repair')return {card:{...d.supplied_card,relations:[{target:'target',type:'specialization',note:'具体化',basis:'source'}]}};
  assert.equal(d.phase,'relation-verify');relationVerifyCalls++;
  if(relationVerifyCalls===1)throw Error('transport failed after checkpoint');
  return {checked_ids:['relation-card'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());let paused=readCompileJob(root,job.id);
 assert.equal(paused.status,'paused');assert.equal(paused.unit_work[job.book_units[0].ref].verifying.id,'relation-card');
 const before=requests.length;paused.status='running';saveCompileJob(root,paused);await executeBookCompile(ctx,root,paused,new AbortController());paused=readCompileJob(root,job.id);
 assert.equal(data(requests[before]).phase,'relation-verify');assert.equal(data(requests[before]).supplied_card.id,'relation-card');
 assert.equal(paused.error_code,'UNIT_CARD_REPAIR_EXHAUSTED');
});
test('an explicitly requested relation deletion is verified deterministically from the before and after endpoints',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'general'),relations:[{target:'specific',type:'supplement',note:'错误方向',basis:'source'}]},card(d.source.ref,'specific')],note:'两个对象'};
  if(d.phase==='check')return {checked_ids:['general','specific'],issues:[{id:'general',kind:'relation',related_card_ids:['specific'],message:'删除这条不成立的 supplement 关系。'}],unit_issues:[]};
  if(d.phase==='relation-repair')return {card:{...d.supplied_card,relations:[]}};
  throw Error('明确删除关系后不应再调用模型复核');
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','relation-repair']);
 assert.deepEqual(parseCardFile(join(root,'01-Cards/general.md')).meta.relations,[]);
});
test('resume reconciles stale routine-review findings and reopens only the remaining relation repair',async t=>{
 const {root,job}=fixture(t,['完整原文。']),ref=job.book_focus_refs[0];
 const general={...card(ref,'general'),relations:[{target:'specific',type:'example',note:'一般机制的具体案例。',basis:'source'}]};
 const specific=card(ref,'specific');
 const falseEnum='example 关系类型不合法，不在允许枚举。';
 const realIssue='这条 example 与另一条表达重复；删除当前关系。';
 job.unit_work={[ref]:{
  source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[general,specific],note:'两个对象',phase:'check',
  repairs:{general:2},repair_counts:{general:{relation:2}},checks:{specific:sha(JSON.stringify(specific))},published:{},
  pending_issues:{general:[falseEnum,realIssue]},pending_issue_records:{general:[
   {id:'general',kind:'relation',related_card_ids:['specific'],message:falseEnum},
   {id:'general',kind:'relation',related_card_ids:['specific'],message:realIssue}
  ]},publish_first_version:1,initial_review_done:true,coverage_checked:true,unit_issues:[]
 }};
 saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  assert.equal(d.phase,'relation-repair');assert.equal(d.supplied_card.id,'general');assert.deepEqual(d.issues,[realIssue]);
  return {card:{...d.supplied_card,relations:[]}};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(req=>data(req).phase),['relation-repair']);
 assert.deepEqual(parseCardFile(join(root,'01-Cards/general.md')).meta.relations,[]);
 const work=end.unit_work[ref];assert.equal(work.review_governance_version,'routine-review-governance-v2');
 assert.ok(work.review_governance_events.some(event=>event.changes.some(change=>change.includes('false-relation-enum'))));
});

test('verify cannot spend a second repair on a Markdown hierarchy that does not exist',async t=>{
 const {root,job}=fixture(t,['权利与责任的原文。']);
 const claimBody='## 一句话主张\n权利与责任相互约束。\n\n## 依据\n责任必须受到规制。责任可按容斥原理表述，实例只用于说明。\n\n## 已知限制\n具体制度仍需分别核对。\n\n## 原文摘录\n材料明确并列讨论权利与责任。';
 const falseIssue='正文骨架仍不符合 claim 的四段式要求：“## 依据”下继续保留“责任必须受到规制”“责任按容斥原理表述”等独立小节式要点，使四段之间夹入额外分类层。';
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'rights-duty'),type:'claim',body:claimBody}],note:'一个命题'};
  if(d.phase==='check')return {checked_ids:['rights-duty'],issues:[{id:'rights-duty',kind:'card',related_card_ids:[],message:'一句话主张重复了同一结论，需要压缩。'}],unit_issues:[]};
  if(d.phase==='repair')return {card:{...d.supplied_card,body:claimBody}};
  assert.equal(d.phase,'verify');return {checked_ids:['rights-duty'],issues:[{id:'rights-duty',kind:'card',related_card_ids:[],message:falseIssue}],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),work=end.unit_work[job.book_focus_refs[0]];
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(req=>data(req).phase),['generate','check','repair','verify']);
 assert.equal(work.repairs['rights-duty'],1);assert.ok(work.review_governance_events.some(event=>event.changes.includes('discarded-false-markdown-hierarchy:rights-duty')));
 assert.ok(existsSync(join(root,'01-Cards/rights-duty.md')));
});
test('relation repair scope violations enter the repair pool instead of pausing the main line',async t=>{
 const {root,job}=fixture(t,['完整原文。']);
 job.compile_isolation='compile-isolation-v1';saveCompileJob(root,job);
 const {ctx}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'general'),card(d.source.ref,'specific')],note:'两个对象'};
  if(d.phase==='check')return {checked_ids:['general','specific'],issues:[{id:'general',kind:'relation',related_card_ids:['specific'],message:'新增 specialization 指向 specific。'}],unit_issues:[]};
  if(d.phase==='relation-repair')return {card:{...d.supplied_card,body:d.supplied_card.body+' 越权改写。',relations:[{target:'specific',type:'specialization',note:'具体化',basis:'source'}]}};
  throw Error('越权关系修复不得进入复核');
 });
 await executeBookCompile(ctx,root,job,new AbortController(),{domainCheckpoint:async()=>false});const end=readCompileJob(root,job.id);
 const ref=job.book_focus_refs[0];assert.equal(end.status,'partial',JSON.stringify({detail:end.detail,error_code:end.error_code,last_failure:end.last_failure}));assert.equal(end.book_outcomes[ref].status,'quarantined');
 const isolated=Object.values(end.unit_work[ref].isolation.items).find(item=>item.card_id==='general');
 assert.equal(isolated?.kind,'relation',JSON.stringify(end.unit_work[ref].isolation.items));assert.equal(isolated?.code,'UNIT_REPAIR_SCOPE_VIOLATION');
 assert.equal(existsSync(join(root,'01-Cards/general.md')),false);assert.equal(existsSync(join(root,'01-Cards/specific.md')),true);
});
test('legacy single-card checkpoint is discarded when its pending issue is actually a stale relation issue',async t=>{
 const {root,job}=fixture(t,['完整原文。']),ref=job.book_focus_refs[0],general=card(ref,'general'),specific=card(ref,'specific');
 const message='关系方向问题：specific 当前反向指向 general；如保留关系，应由 general 用 specialization 指向 specific。';
 job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[general,specific],note:'两个对象',phase:'check',repairs:{general:1},checks:{specific:sha(JSON.stringify(specific))},published:{},pending_issues:{general:[message]},publish_first_version:1,initial_review_done:true,coverage_checked:true,unit_issues:[],repair_response:{id:'general',input_hash:sha(JSON.stringify(general)),card:{...general,relations:[{target:'specific',type:'specialization',note:'旧单卡结果',basis:'source'}]}},response:{phase:'repair',text:'旧响应'}}};
 saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='relation-repair'){assert.deepEqual(d.related_cards.map(c=>c.id),['specific']);return {card:d.supplied_card};}
  assert.equal(d.phase,'relation-verify');return {checked_ids:['general'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(r=>data(r).phase),['relation-repair','relation-verify']);
 assert.deepEqual(parseCardFile(join(root,'01-Cards/general.md')).meta.relations,[]);
});
test('pause after generation retains candidates; resume checks without re-generating',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let failed=false;const {ctx,requests}=model(root,req=>{if(data(req).phase==='check'&&!failed){failed=true;throw Error('network failed');}return happy(req);});
 await executeBookCompile(ctx,root,job,new AbortController());let current=readCompileJob(root,'job');assert.equal(current.status,'paused');assert.equal(existsSync(join(root,'00-Inbox/test.md')),true);
 current.status='running';saveCompileJob(root,current);await executeBookCompile(ctx,root,current,new AbortController());current=readCompileJob(root,'job');assert.equal(current.status,'completed',current.detail);assert.equal(requests.filter(r=>data(r).phase==='generate').length,1);
});
test('output truncation checkpoints complete cards and resume requests only the remainder',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let truncated=false;const requests=[];
 const generate=async(_ctx,_root,_job,req)=>{requests.push(req);const d=data(req);
  if(d.phase==='generate'&&!truncated){truncated=true;const error=Error('达到输出上限');error.code='MODEL_OUTPUT_TRUNCATED';
   error.partialResponse='{"cards":['+JSON.stringify(card(d.source.ref,'kept'))+',{"id":"cut","title":"未完成';throw error;}
  if(d.phase==='generate'){assert.deepEqual(d.completed_cards.map(c=>c.id),['kept']);return JSON.stringify({cards:[card(d.source.ref,'remaining')],note:'补完剩余对象'});}
  return JSON.stringify({checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]});
 };
 const turn=(ctx,task,active,signal)=>runBookTurn(ctx,task,active,signal,generate);
 await executeBookCompile({},root,job,new AbortController(),{turn});let current=readCompileJob(root,'job');
 assert.equal(current.status,'paused');assert.match(current.detail,/已保留 1 张完整候选/);assert.deepEqual(current.unit_work[current.book_focus_refs[0]].partial_generation.cards.map(c=>c.id),['kept']);assert.equal(current.touched.length,0);
 current.status='running';saveCompileJob(root,current);await executeBookCompile({},root,current,new AbortController(),{turn});current=readCompileJob(root,'job');
 assert.equal(current.status,'completed',current.detail);assert.deepEqual(new Set(current.touched),new Set(['kept','remaining']));
 assert.equal(requests.filter(req=>data(req).phase==='generate').length,2);
});
test('bad type repairs only that card via the same Gateway preflight',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx,requests}=model(root,req=>{const d=data(req);if(d.phase==='generate')return {cards:[card(d.source.ref,'good'),{...card(d.source.ref,'bad'),type:'invalid'}],note:'知识对象'};
 if(d.phase==='repair')return {card:{...d.supplied_card,type:'model'}};return happy(req);});
 await executeBookCompile(ctx,root,job,new AbortController());assert.equal(readCompileJob(root,'job').status,'completed',readCompileJob(root,'job').detail);assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','repair','verify']);
});
test('a structurally rejected repair response is not replayed forever from the request cache',async t=>{
 const {root,job}=fixture(t,['完整历史案例原文。']),ref=job.book_focus_refs[0];
 const invalid={id:'case-with-empty-process',title:'有阶段但过程节没有直接正文的案例',type:'case',domains:[],summary:'案例摘要。',sources:[{ref}],relations:[],
  body:'## 情境与对象\n特定历史情境。\n\n## 过程\n### 第一阶段\n阶段叙述。\n\n## 结果与证据\n形成结果。\n\n## 限制与边界\n只适用于该历史情境。\n\n## 来源与证据边界\n依据完整原文。'};
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[invalid],note:'一个历史案例'};
  if(d.phase==='check')return {checked_ids:[invalid.id],issues:[],unit_issues:[]};
  if(d.phase==='repair')return {card:d.supplied_card};
  throw Error('结构检查未通过时不应进入语义复核');
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),work=end.unit_work[ref];
 assert.equal(end.status,'paused');assert.equal(end.error_code,'UNIT_CARD_REPAIR_EXHAUSTED');
 assert.deepEqual(requests.map(req=>data(req).phase),['generate','check','repair']);
 assert.equal(work.repair_counts[invalid.id].card,2);assert.equal(Object.keys(work.rejected_repair_responses).length,1);
});
test('stop during response prevents all writes and late results cannot complete task',async t=>{
 const {root,job}=fixture(t,['完整原文。']),controller=new AbortController();const {ctx}=model(root,req=>{const current=readCompileJob(root,'job');current.end_requested=true;saveCompileJob(root,current);controller.abort(Error('用户结束'));return happy(req);});
 await executeBookCompile(ctx,root,job,controller);const end=readCompileJob(root,'job');assert.equal(end.status,'ended');assert.equal(end.touched.length,0);assert.equal(existsSync(join(root,'00-Inbox/test.md')),true);
});
test('same unit replay returns receipt, never saves duplicate cards',async t=>{
 const {root,job}=fixture(t,['完整原文。']),{ctx,requests}=model(root,happy);await runBookTurn(ctx,root,job,new AbortController().signal);
 await runBookTurn(ctx,root,readCompileJob(root,'job'),new AbortController().signal);const end=readCompileJob(root,'job');assert.equal(requests.length,2);assert.equal(end.receipts.length,1);assert.equal(end.touched.length,1);
});
for(const legacySource of [false,true])test(`an undelivered existing card from the exact source unit is reused without blocking new cards (${legacySource?'Archive':'Buffer'})`,async t=>{
 const {root,job}=fixture(t,['完整原文。']),ref=job.book_focus_refs[0],existing=card(ref,'same-source'),existingRef=legacySource?ref.replace(/^05-Buffer\//,'03-Archive/'):ref;
 mkdirSync(join(root,'01-Cards'),{recursive:true});writeFileSync(join(root,'01-Cards/same-source.md'),unoMarkdown({schema:'uno-card-v4',id:existing.id,title:existing.title,type:existing.type,domains:[],summary:'已经保存的同源卡',sources:[existingRef+'#char-0-5'],relations:[],lifecycle:'active',origin:'document',maturity:'growing',created:'2026-09-18',updated:'2026-09-18'},existing.body));
 job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],repairs:{},checks:{},phase:'generate'}};saveCompileJob(root,job);
 const before=readFileSync(join(root,'01-Cards/same-source.md'),'utf8');
 const {ctx,requests}=model(root,req=>{const d=data(req);return d.phase==='generate'?{cards:[card(ref,'same-source'),card(ref,'new-card')],note:'一个已有对象和一个新增对象'}:{checked_ids:d.supplied_cards.map(c=>c.id),issues:[],unit_issues:[]};});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),work=end.unit_work[ref];
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(r=>data(r).phase),['generate','check']);
 assert.deepEqual(end.touched,['new-card']);assert.deepEqual(end.book_outcomes[ref].card_ids.sort(),['new-card','same-source']);
 assert.equal(work.reused['same-source'].reason,'same-source-existing-card');assert.equal(readFileSync(join(root,'01-Cards/same-source.md'),'utf8'),before);
});
test('source-free routine review cannot create a chapter coverage claim',async t=>{
 const {root,job}=fixture(t,['完整原文。']),{ctx}=model(root,req=>data(req).phase==='generate'?happy(req):{checked_ids:data(req).supplied_cards.map(c=>c.id),issues:[],unit_issues:['原文反证尚未保留']});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,'job');assert.equal(end.status,'paused');assert.equal(end.touched.length,0);assert.match(end.detail,/候选卡检查没有原文/);assert.ok(existsSync(join(root,'00-Inbox/test.md')));
});

test('new-card revision copied from a reference during repair is never write authority',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let checks=0;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'new-card')],note:'具体机制'};
  if(d.phase==='repair')return {card:{...d.supplied_card,revision:'b177d74e13035bf76c1e9c8f993be418c5f7b823cc1a04b02feb72a3fe84e91d'}};
  return {checked_ids:(d.supplied_cards??[d.supplied_card]).map(c=>c.id),issues:checks++===0?[{id:'new-card',message:'核对来源条件'}]:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 assert.equal(readCompileJob(root,'job').status,'completed',readCompileJob(root,'job').detail);
 assert.equal(data(requests.at(-1)).supplied_card.revision,undefined);
 assert.deepEqual(bindCardVersions([{id:'old',revision:'model-invented'},{id:'new',revision:'copied'}],[{id:'old',revision:'frozen-delivery'}]),[{id:'old',revision:'frozen-delivery'},{id:'new'}]);
});

test('partial recheck explicitly scopes IDs and never includes an all-unit coverage claim',async t=>{
 const {root,job}=fixture(t,['完整原文。']);let checks=0;
 const {ctx}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'good'),relations:[]},{...card(d.source.ref,'bad'),relations:[{target:'good',type:'supplement',note:'机制补充',basis:'source'}]}],note:'两个对象全部生成'};
  if(d.phase==='repair')return {card:{...d.supplied_card,body:d.supplied_card.body+'\n具体限制保持来源范围。'}};
  if(checks++===0){assert.equal(d.review_scope.kind,'cards');assert.equal(req.messages.length,1);assert.equal(req.unit_context.source_chars,0);return {checked_ids:['good','bad'],issues:[{id:'bad',message:'明确适用条件'}],unit_issues:[]};}
  assert.equal(d.phase,'verify');assert.equal(d.note,undefined);assert.equal(d.relation_targets,undefined);assert.equal(d.source,undefined);assert.equal(req.messages.length,1);
  return {checked_ids:['bad'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());assert.equal(readCompileJob(root,'job').status,'completed',readCompileJob(root,'job').detail);
});

test('free-form output fails structure once and only the problem card is repaired into the approved skeleton',async t=>{
 const {root,job}=fixture(t,['完整原文。']);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'good'),{...card(d.source.ref,'bad'),body:'# 主张\n\n只有散文和粗体标签。'}],note:'两张卡'};
  if(d.phase==='repair'){assert.equal(d.supplied_card.id,'bad');assert.match(d.issues.join(' '),/核心思想/);return {card:card(d.supplied_card.sources[0].ref,'bad')};}
  return happy(req);
 });
 await executeBookCompile(ctx,root,job,new AbortController());assert.equal(readCompileJob(root,'job').status,'completed',readCompileJob(root,'job').detail);
 assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','repair','verify']);
});

import { parseCardFile } from '../packages/nexogenesis-tools/lib/cards.js';
import { auditCardBodyStructure, cardBodyInstructions } from '../packages/nexogenesis-tools/lib/harness/knowledge-quality.js';
import { COMPILE_HEALTH, COMPILE_REVIEW_POLICY } from '../packages/nexogenesis-web-host/lib/book-compile.js';

test('a failed repair preserves approved cards; deferred cross-card links attach only after the target passes',async t=>{
 const {root,job}=fixture(t,['SOURCE_SENTINEL']);let fail=true;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[{...card(d.source.ref,'good'),relations:[{target:'bad',type:'supplement',note:'具体机制补充',basis:'source'}]},{...card(d.source.ref,'bad'),relations:[{target:'good',type:'example',note:'具体实例',basis:'source'}]}],note:'两对象'};
  if(d.phase==='check')return {checked_ids:['good','bad'],issues:[{id:'bad',message:'只补本卡限制，明确只适用于制度环境。'}],unit_issues:[]};
  assert.equal(req.messages.length,1);assert.equal(req.unit_context.source_chars,0);assert.equal(d.references,undefined);assert.equal(d.relation_targets,undefined);assert.ok(!JSON.stringify(req).includes('SOURCE_SENTINEL'));
  const saved=parseCardFile(join(root,'01-Cards/good.md'));assert.equal(saved.meta.relations.length,0);
  if(d.phase==='repair'){if(fail){fail=false;throw Error('provider unavailable');}return {card:d.supplied_card};}
  return {checked_ids:['bad'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());let current=readCompileJob(root,'job');assert.equal(current.status,'paused');assert.deepEqual(current.touched,['good']);assert.equal(existsSync(join(root,'01-Cards/bad.md')),false);
 current.status='running';saveCompileJob(root,current);await executeBookCompile(ctx,root,current,new AbortController());current=readCompileJob(root,'job');assert.equal(current.status,'completed',current.detail);
 assert.equal(parseCardFile(join(root,'01-Cards/good.md')).meta.relations[0].target,'bad');assert.equal(requests.filter(r=>data(r).phase==='generate').length,1);assert.equal(requests.filter(r=>data(r).phase==='check').length,1);
});

test('a legacy already-received repair is consumed at its attempt cap; no regeneration or repair call',async t=>{
 const {root,job}=fixture(t,['完整原文。']),ref=job.book_focus_refs[0];
 const good=card(ref,'good'),bad=card(ref,'bad');job.unit_work={[ref]:{source_revision:job.book_units[0].revision,references:[],cards:[good,bad],note:'两对象',phase:'check',repairs:{bad:2},checks:{good:sha(JSON.stringify(good))},pending_issues:{bad:['补回边界']},last_response:{phase:'repair',text:'```json\n'+JSON.stringify({card:{...bad,body:bad.body+'\n来源边界已保留。'}})+'\n```\n修复说明：旧响应留下的说明'}}};
 // The authoritative unit revision is read from the actual archive file.
 job.unit_work[ref].source_revision=sha(readFileSync(join(root,ref)));saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{assert.equal(data(req).phase,'verify');assert.ok(existsSync(join(root,'01-Cards/good.md')));return {checked_ids:['bad'],issues:[],unit_issues:[]};});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,'job');assert.equal(end.status,'completed',end.detail);assert.equal(requests.length,1);assert.equal(end.unit_work[ref].repairs.bad,2);assert.equal(end.touched.length,2);
});

test('a crash after Gateway commit recovers the receipt without regenerating or duplicating publication',async t=>{
 const {root,job}=fixture(t,['完整原文。']),original=HarnessGateway.prototype.saveBookCards;let crash=true;
 HarnessGateway.prototype.saveBookCards=function(args){const receipt=original.call(this,args);if(crash){crash=false;throw Error('simulated crash after durable receipt');}return receipt;};
 t.after(()=>{HarnessGateway.prototype.saveBookCards=original;});const {ctx,requests}=model(root,happy);
 await executeBookCompile(ctx,root,job,new AbortController());let current=readCompileJob(root,'job');assert.equal(current.status,'paused');assert.ok(current.unit_work[job.book_focus_refs[0]].pending_commit);
 current.status='running';saveCompileJob(root,current);await executeBookCompile(ctx,root,current,new AbortController());current=readCompileJob(root,'job');assert.equal(current.status,'completed',current.detail);assert.equal(current.receipts.length,1);assert.equal(requests.length,2);
});

test('retry limit on one card does not prevent other approved or repairable cards from publishing',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx}=model(root,req=>{const d=data(req);
 if(d.phase==='generate')return {cards:['good','bad','fixable'].map(id=>card(d.source.ref,id)),note:'三对象'};
 if(d.phase==='check')return {checked_ids:['good','bad','fixable'],issues:[{id:'bad',message:'具体条件遗漏'},{id:'fixable',message:'具体条件遗漏'}],unit_issues:[]};
 if(d.phase==='repair'){assert.ok(existsSync(join(root,'01-Cards/good.md')));return {card:d.supplied_card};}
 return {checked_ids:[d.supplied_card.id],issues:d.supplied_card.id==='bad'?[{id:'bad',message:'具体条件仍遗漏'}]:[],unit_issues:[]};});
 await executeBookCompile(ctx,root,job,new AbortController());const current=readCompileJob(root,'job');assert.equal(current.status,'paused');assert.deepEqual(current.touched,['good','fixable']);assert.ok(existsSync(join(root,'00-Inbox/test.md')));assert.equal(current.unit_work[job.book_focus_refs[0]].repairs.bad,2);
});

test('prompt example passes the same body validator and service policy describes the tested publication order',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx,requests}=model(root,happy);await executeBookCompile(ctx,root,job,new AbortController());
 const system=requests[0].system;assert.ok(system.includes(cardBodyInstructions()));assert.match(system,/不输出代码围栏、修复说明/);
 const example=system.split('## 完整卡片写法示例')[1].split('## 核心思想')[1].split('正文结构（')[0];assert.deepEqual(auditCardBodyStructure('model','## 核心思想'+example),[]);
 assert.equal(COMPILE_REVIEW_POLICY,'review-publish-repair-v2');assert.equal(COMPILE_HEALTH.compile_review_policy,COMPILE_REVIEW_POLICY);assert.equal(COMPILE_HEALTH.compile_review_context,'typed-card-and-relation-repair-v2');assert.equal(COMPILE_HEALTH.uno_relation_repair,1);assert.equal(COMPILE_HEALTH.uno_generation_json_tail_recovery,'unit-json-trailing-closers-v1');assert.equal(readCompileJob(root,'job').review_policy,COMPILE_REVIEW_POLICY);
});
import { validateRepairedCard, buildUnitRequest } from '../packages/nexogenesis-web-host/lib/unit-card-request.js';

test('single-card repair accepts bare and wrapped objects, rejects wrong identity and ambiguous shape',()=>{
 const c=card('source','expected');
 assert.deepEqual(validateRepairedCard(c,'expected'),c);
 assert.deepEqual(validateRepairedCard({card:c},'expected'),c);
 for(const value of [{card:{...c,id:'another'}},{card:null},{cards:[c]},{card:c,id:'another'},{id:'expected'},{...c,body:''}])
  assert.throws(()=>validateRepairedCard(value,'expected'),{code:'INVALID_REPAIR_RESPONSE'});
});

test('bare single-card model response reaches verification and publication without extra repair',async t=>{
 const {root,job}=fixture(t,['完整原文。']);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'good'),card(d.source.ref,'bad')],note:'两个对象'};
  if(d.phase==='check')return {checked_ids:['good','bad'],issues:[{id:'bad',message:'保留来源限制'}],unit_issues:[]};
  if(d.phase==='repair')return {...d.supplied_card,body:d.supplied_card.body+'\n仅适用于该制度环境。'};
  return happy(req);
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','repair','verify']);
 assert.equal(end.unit_work[job.book_focus_refs[0]].repairs.bad,1);assert.equal(end.touched.length,2);
});

for(const stale of [false,true])test('missing-card persisted checkpoint '+(stale?'rejects changed input':'recovers paid raw response at retry limit'),async t=>{
 const {root,job}=fixture(t,['完整原文。']),ref=job.book_focus_refs[0],c=card(ref,'bad'),issues=['保留来源限制'];
 const inputHash=sha(JSON.stringify(c)),request=buildUnitRequest(job,{ref},[],'repair',{supplied_card:c,issues}),key=sha(JSON.stringify(request));
 job.unit_work={[ref]:{source_revision:sha(readFileSync(join(root,ref))),references:[],cards:[stale?{...c,body:c.body+'已变更'}:c],note:'一个对象',phase:'check',repairs:{bad:2},checks:{},published:{},pending_issues:{bad:issues},publish_first_version:1,initial_review_done:true,coverage_checked:true,unit_issues:[],repair_attempt:{id:'bad',key:inputHash+sha(JSON.stringify(issues)),response_key:key},response:{key,phase:'repair',text:JSON.stringify(c)},repair_response:{id:'bad',input_hash:inputHash}}};saveCompileJob(root,job);
 const {ctx,requests}=model(root,req=>{assert.equal(data(req).phase,'verify');return happy(req);});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,stale?'paused':'completed',end.detail);assert.equal(requests.length,stale?0:1);assert.equal(end.unit_work[ref].repairs.bad,2);
 assert.equal(existsSync(join(root,'01-Cards/bad.md')),!stale);
});

test('invalid repair gets one bounded correction with the same card and original issues',async t=>{
 const {root,job}=fixture(t,['完整原文。']);
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'good'),card(d.source.ref,'bad')],note:'两对象'};
  if(d.phase==='check')return {checked_ids:['good','bad'],issues:[{id:'bad',message:'保留限制'}],unit_issues:[]};
  if(d.phase==='repair'&&!d.repair_retry)return {...d.supplied_card,id:'wrong'};
  if(d.phase==='repair'){assert.equal(d.repair_retry.expected_card_id,'bad');return {card:{...d.supplied_card,body:d.supplied_card.body+'\n保留限制。'}};}
  return {checked_ids:['bad'],issues:[],unit_issues:[]};});
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.equal(end.unit_work[job.book_focus_refs[0]].repair_response,undefined);
 assert.deepEqual(requests.map(r=>data(r).phase),['generate','check','repair','repair','verify']);assert.deepEqual(new Set(end.touched),new Set(['good','bad']));
});

import { unitRequestKey } from '../packages/nexogenesis-web-host/lib/book-compile.js';
test('request cache identity ignores native random message IDs but includes content and model',()=>{
 const job={model_selection:{provider:'p',model:'m'}},data={supplied_card:card('ref','card'),issues:['保留限制']};
 const a=buildUnitRequest(job,{},[],'repair',data),b=buildUnitRequest(job,{},[],'repair',data);
 assert.notEqual(a.messages[0].id,b.messages[0].id);assert.equal(unitRequestKey(a),unitRequestKey(b));
 const changed=buildUnitRequest(job,{},[],'repair',{...data,issues:['另一问题']});
 assert.notEqual(unitRequestKey(a),unitRequestKey(changed));assert.notEqual(unitRequestKey(a),unitRequestKey({...b,model:'different'}));
});


test('a persisted legacy coverage gap is supplemented once, checked against source, then advances without rewriting passed cards',async t=>{
 const {root,job}=fixture(t,['完整原文甲：缺失机制证据。','下一章原文乙。']);seedLegacyCoverage(root,job,'缺失机制：来源说明制度变化影响行动。');let original;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return happy(req);
  if(d.phase==='supplement'){
   original=readFileSync(join(root,'01-Cards',d.existing_cards[0].id+'.md'),'utf8');
   assert.equal(req.messages.length,1);assert.equal(req.unit_context.source_chars,0);assert.ok(!JSON.stringify(req).includes('完整原文甲'));assert.deepEqual(d.coverage_issues,['缺失机制：来源说明制度变化影响行动。']);
   assert.deepEqual(Object.keys(d.existing_cards[0]).sort(),['id','title']);
   return {cards:[card(d.source.ref,'missing-mechanism')],note:'补充缺失机制'};
  }
  if(d.review_scope.kind==='gap'){
   assert.deepEqual(d.supplied_cards.map(c=>c.id),['missing-mechanism']);assert.equal(d.references.length,0);assert.equal(d.coverage_issues.length,1);
   assert.ok(req.messages[1].content[0].text.includes('完整原文甲'));return happy(req);
  }
  return happy(req);
 });
 await executeBookCompile(ctx,root,job,new AbortController());
 const end=readCompileJob(root,'job');assert.equal(end.status,'completed',end.detail);assert.equal(end.touched.length,3);assert.equal(requests.length,4);
 assert.equal(readFileSync(join(root,'01-Cards',end.unit_work[job.book_units[0].ref].coverage_recovery.existing_cards[0].id+'.md'),'utf8'),original);
 assert.equal(requests.filter(r=>data(r).phase==='generate').length,1);assert.equal(requests.filter(r=>data(r).phase==='supplement').length,1);
});

test('gap recovery resumes retained generated candidates after a failed check; never pays for supplementation twice',async t=>{
 const {root,job}=fixture(t,['原文']);seedLegacyCoverage(root,job,'遗漏对象与原文依据');let stop=true;
 const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='supplement')return {cards:[card(d.source.ref,'missing')],note:'补全对象'};
  if(d.review_scope.kind==='gap'){if(stop){stop=false;throw Error('transport failed');}return happy(req);}
  return happy(req);
 });
 await executeBookCompile(ctx,root,job,new AbortController());let paused=readCompileJob(root,'job');assert.equal(paused.status,'paused');
 assert.equal(paused.unit_work[job.book_units[0].ref].coverage_recovery.phase,'check');
 paused.status='running';saveCompileJob(root,paused);await executeBookCompile(ctx,root,paused,new AbortController());
 assert.equal(readCompileJob(root,'job').status,'completed');assert.equal(requests.filter(r=>data(r).phase==='supplement').length,1);assert.equal(requests.filter(r=>data(r).phase==='generate').length,0);
});

test('unresolved supplemented coverage remains incomplete and repeated resume makes no more model calls',async t=>{
 const {root,job}=fixture(t,['原文']);seedLegacyCoverage(root,job,'原文反证仍缺失');
 const {ctx,requests}=model(root,req=>{const d=data(req);if(d.phase==='supplement')return {cards:[card(d.source.ref,'missing')],note:'尝试补全'};return {...happy(req),unit_issues:['原文反证仍缺失']};});
 await executeBookCompile(ctx,root,job,new AbortController());let paused=readCompileJob(root,'job');assert.equal(paused.error_code,'UNIT_COVERAGE_BLOCKED');assert.equal(requests.length,2);
 paused.status='running';saveCompileJob(root,paused);await executeBookCompile(ctx,root,paused,new AbortController());
 assert.equal(requests.length,2);assert.equal(readCompileJob(root,'job').book_outcomes[job.book_units[0].ref],undefined);assert.ok(existsSync(join(root,'00-Inbox/test.md')));
});

test('supplementation cannot overwrite an approved card and invalid output stays cached across resume',async t=>{
 const {root,job}=fixture(t,['原文']);seedLegacyCoverage(root,job,'遗漏对象');
 const {ctx,requests}=model(root,req=>{const d=data(req);if(d.phase==='supplement')return {cards:[card(d.source.ref,d.existing_cards[0].id)],note:'错误重写'};return happy(req);});
 await executeBookCompile(ctx,root,job,new AbortController());const paused=readCompileJob(root,'job');assert.equal(paused.error_code,'UNIT_COVERAGE_BLOCKED');assert.equal(paused.receipts.length,1);
 paused.status='running';saveCompileJob(root,paused);await executeBookCompile(ctx,root,paused,new AbortController());assert.equal(requests.length,1);assert.equal(readCompileJob(root,'job').receipts.length,1);
});

test('routine review missing the required empty unit_issues field recovers locally without another model request',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'safe')],note:'一个对象'};
  if(d.phase==='check')return {checked_ids:['safe'],issues:[]};
  throw Error('deterministic recovery must not call the model');
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id);
 assert.equal(end.status,'completed',end.detail);assert.equal(requests.length,2);assert.equal(end.last_recovery.method,'deterministic');
 assert.deepEqual(end.last_recovery.changes,['required-empty-unit-issues']);assert.equal(end.last_recovery.model_calls,0);
 const retained=end.unit_work[job.book_focus_refs[0]].response;assert.ok(retained.text);assert.equal(JSON.parse(retained.recovered.text).unit_issues.length,0);
});

test('ambiguous review envelope receives one schema-only recovery call with no source or card context',async t=>{
 const {root,job}=fixture(t,['SOURCE_MUST_NOT_BE_REDELIVERED']);const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'safe')],note:'一个对象'};
  if(d.phase==='check')return {checked_ids:['safe'],issues:{id:'safe',kind:'card',related_card_ids:[],message:'保留限制'},unit_issues:[]};
  if(d.phase==='recovery')return {action:'repair_response',repaired_response:{checked_ids:['safe'],issues:[{id:'safe',kind:'card',related_card_ids:[],message:'保留限制'}],unit_issues:[]}};
  if(d.phase==='repair')return {card:{...d.supplied_card,body:d.supplied_card.body+'\n保留限制。'}};
  return {checked_ids:['safe'],issues:[],unit_issues:[]};
 });
 await executeBookCompile(ctx,root,job,new AbortController());const end=readCompileJob(root,job.id),recovery=requests.find(req=>data(req).phase==='recovery');
 assert.equal(end.status,'completed',end.detail);assert.ok(recovery);assert.equal(recovery.unit_context.source_chars,0);assert.equal(recovery.reasoningEffort,'off');
 assert.ok(!JSON.stringify(recovery).includes('SOURCE_MUST_NOT_BE_REDELIVERED'));assert.equal(end.recovery_model_calls,1);assert.equal(end.last_recovery.status,'recovered');
});

test('failed recovery is fingerprinted and resume cannot repeat the same model recovery call',async t=>{
 const {root,job}=fixture(t,['完整原文。']);const {ctx,requests}=model(root,req=>{const d=data(req);
  if(d.phase==='generate')return {cards:[card(d.source.ref,'safe')],note:'一个对象'};
  if(d.phase==='check')return {checked_ids:['safe'],issues:{id:'safe',message:'保留限制'},unit_issues:[]};
  if(d.phase==='recovery')return {action:'cannot_repair',reason:'原返回结构存在歧义'};
  throw Error('unexpected phase');
 });
 await executeBookCompile(ctx,root,job,new AbortController());let end=readCompileJob(root,job.id);
 assert.equal(end.status,'paused');assert.equal(end.error_code,'COMPILE_RECOVERY_DECLINED');assert.equal(requests.length,3);
 end.status='running';saveCompileJob(root,end);await executeBookCompile(ctx,root,end,new AbortController());end=readCompileJob(root,job.id);
 assert.equal(end.error_code,'COMPILE_RECOVERY_EXHAUSTED');assert.equal(requests.length,3);assert.equal(end.last_failure.category,'response_contract');
});

