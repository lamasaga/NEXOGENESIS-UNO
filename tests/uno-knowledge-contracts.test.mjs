import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { loadCards, invalidateKnowledgeSnapshot } from '../packages/nexogenesis-tools/lib/cards.js';
import { unoRevision, unoCardRef, readUnoUnit } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { preprocessSource, searchKnowledge, readMaterial, cardVersions, listDomainsV2, readGuide, readKnowledgeCard } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { saveCompileJob, readCompileJob } from "../packages/nexogenesis-tools/lib/uno/state.js";
import { apply as mountCompile } from '../packages/nexogenesis-tools/lib/uno/agent.js';
import { startUnoJob, readUnoJob, hasUnoJobRunning, cancelUnoJob } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { collectThinkingContext } from '../packages/nexogenesis-web-host/lib/thinking-routes.js';
import { parseCompileCommand } from '../packages/nexogenesis-tools/lib/compile-options.js';
import { compileCommand } from '../packages/nexogenesis-web-host/lib/chat.js';
import { buildGraphEdges, handleCardGet } from '../packages/nexogenesis-web-host/lib/graph.js';
import { launch } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';
import { initializeProviderBudget } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';

import { fixture } from './fixtures/uno-knowledge.mjs';
function jobFor(f,info){const job={id:'test-job',workflow:'uno-unit-compile-v2',mode:'compile',session_id:'test-session',status:'running',phase:'read',notes:'保留立场和案例',budget:{calls:120},calls:[],receipts:[],sources:[info],batches:info.units.map(u=>[u.ref]),cursor:0,touched:[],reviewed:{},outcomes:{},issues:[],failures:[],archives:[]};saveCompileJob(f.root,job);return job;}
test('Python 保留章节、数字、引文、矛盾；同义内容不被语义去重',async t=>{
 const f=fixture(t),info=await f.prep('# 第一章\n\n“应保留不同意见”[12]。\n观点甲主张集中。\n观点乙主张分散。\n数字 987654。\n\n# 第二章\n\n相近表达依然保留。');
 assert.equal(info.units.length,2);assert.match(readMaterial(f.root,info.units[0].ref).text,/\[12\]/);assert.match(readMaterial(f.root,info.units[0].ref).text,/观点乙/);
 assert.match(readMaterial(f.root,info.units[0].ref).text,/987654/);assert.match(info.units[0].locator,/行/);
});

test('原文分页和 BM25 数字细节检索进入思考上下文；索引可重建',async t=>{
 const f=fixture(t),info=await f.prep();const ref=info.units[0].ref;
 const first=readMaterial(f.root,ref,0,8);assert.equal(first.text.length,8);assert.equal(first.next_offset,8);
 assert.ok(searchKnowledge(f.root,{query:'987654',kind:'buffer'}).items.some(i=>i.ref===ref));
 assert.ok(collectThinkingContext(f.root,'987654','synthesize').some(i=>i.buffer_ref===ref));
 assert.ok(existsSync(join(f.root,'.nexogenesis/uno-sparse-index.json')));
});

test('相近标题不是机械去重条件；缺少摘要的草稿不能发布',async t=>{
 const f=fixture(t),info=await f.prep(),sources=[info.units[0].ref];f.write('a',sources,{title:'同一个标题'});
 const r=f.write('b',sources,{title:'同一个标题',summary:''});assert.equal(r.staged,false);assert.match(r.issues.join(),/摘要/);assert.equal(loadCards(f.root).size,1);
});

test('修改历史卡保留完整版本，恢复及重复收据不重复执行',async t=>{
 const f=fixture(t),info=await f.prep();f.write('a',[info.units[0].ref]);const before=readFileSync(join(f.root,'01-Cards/a.md'),'utf8'),revision=unoRevision(f.root,'01-Cards/a.md');
 const input={key:'revise-a',id:'a',revision,title:'简练新名',summary:'新版摘要',type:'claim',domains:[],body:'保留作者观点与案例的新版完整正文。',sources:[info.units[0].ref]};
 const r=f.commit(input);assert.deepEqual(f.commit(input),r);assert.equal(cardVersions(f.root,'a').length,1);
 assert.throws(()=>f.commit({...input,key:'stale'}),/变化/);
 f.commit({key:'restore-a',action:'restore',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),version:revision});
 assert.equal(loadCards(f.root).get('a').meta.title,'知识 a');assert.equal(loadCards(f.root).get('a').body, before.split('\n---\n\n')[1]);
});

test('合并保留原卡和去向；来源并集及领域索引不是领域卡',async t=>{
 const f=fixture(t),info=await f.prep();f.write('a',[info.units[0].ref]);f.write('b',[info.units[1].ref]);
 f.commit({key:'merge',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),title:'合并卡',summary:'整合两份材料',body:'整合两份材料的内容及各自立场，保留案例。',type:'case',domains:[],sources:[info.units[0].ref],merge:[{id:'b',revision:unoRevision(f.root,'01-Cards/b.md')}]});
 assert.equal(readKnowledgeCard(f.root,'b').meta.superseded_by,'a');assert.equal(loadCards(f.root).get('a').meta.sources.length,2);assert.equal(cardVersions(f.root,'b').length,1);
 const current=loadCards(f.root).get('a');f.gateway.applyDomainGovernance({key:'domain',create_domains:[{id:'sociology',title:'社会学',summary:'社会关系与行动的长期问题空间',core_questions:['社会关系如何影响行动？'],includes:['社会关系与集体行动'],excludes:['单一事件名录'],parents:[],representative_card_ids:['a']}],assignments:[{card_id:'a',domains:['sociology']}],expected_cards:{a:unoRevision(f.root,unoCardRef(f.root,current))},expected_domains:{}});assert.equal(listDomainsV2(f.root).length,1);assert.equal(loadCards(f.root).size,1);
});

test('七种关系支持有向反查，对称关系不重复；主类型与领域筛选可组合',async t=>{
 const f=fixture(t),info=await f.prep();f.write('a',[info.units[0].ref],{type:'concept',domains:[]});f.write('b',[info.units[1].ref]);const current=loadCards(f.root).get('a');f.gateway.applyDomainGovernance({key:'domain-soc',create_domains:[{id:'soc',title:'社会行动',summary:'组织参与和社会行动的长期问题空间',core_questions:['组织参与如何影响社会行动？'],includes:['组织参与与集体行动'],excludes:['单一事件名录'],parents:[],representative_card_ids:['a']}],assignments:[{card_id:'a',domains:['soc']}],expected_cards:{a:unoRevision(f.root,unoCardRef(f.root,current))},expected_domains:{}});
 f.commit({key:'link',action:'link',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),link:{target:'b',type:'specialization',basis:'source',note:'乙是材料中明确区分的具体类别'}});
 assert.ok(searchKnowledge(f.root,{neighbor:'b',relation:'specialization',kind:'card'}).items.some(c=>c.id==='a'));
 assert.equal(searchKnowledge(f.root,{type:'concept',domain:'soc',kind:'card'}).items.length,1);
 f.commit({key:'contrast',action:'link',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),link:{target:'b',type:'contrast',basis:'navigation',note:'比较材料表达的两种方式'}});
 assert.throws(()=>f.commit({key:'reverse',action:'link',id:'b',revision:unoRevision(f.root,'01-Cards/b.md'),link:{target:'a',type:'contrast',basis:'navigation',note:'相同对照'}}),/对称关系/);
});

test('单元编译禁用原生工具循环，建构工具仍独立可用',async t=>{
 const f=fixture(t),info=await f.prep(),job=jobFor(f,info),registered=[],sections=[],contexts=[],effects=[],listeners=[];
 job.workflow='uno-unit-compile-v2';job.book_units=info.units;job.book_outcomes={};job.book_focus_refs=[info.units[0].ref];saveCompileJob(f.root,job);initializeProviderBudget(f.root,job.id,{limit:120});
 const ctx={on(name,fn){listeners.push({name,fn});return ()=>{};},effect(fn){effects.push(fn());},tools:{register(def){registered.push(def);return ()=>{};}},systemPrompt:{section(def){sections.push(def);return ()=>{};},context(def){contexts.push(def);return ()=>{};}}};
 mountCompile(ctx,{projectRoot:f.root,instanceRegistry:''});t.after(()=>effects.forEach(fn=>typeof fn==='function'&&fn()));
 const assembly={agent:{session:{id:'test-session'}}};assert.throws(()=>sections[0].text(assembly),/单元编译由宿主/);
 assert.equal(contexts.length,1);
 const filter= listeners.findLast(item=>item.name==='system-prompt/assemble').fn;
 const visible=await filter(null,assembly,async()=>({tools:[...registered,{name:'shell'}]}));
 assert.deepEqual(visible.tools,[]);assert.ok(registered.every(t=>!t.name.startsWith('book_')));

 job.workflow='uno-compile-v3';job.mode='construct';saveCompileJob(f.root,job);
 const construct=await filter(null,assembly,async()=>({tools:registered}));assert.ok(construct.tools.some(t=>t.name==='compile_edit'));assert.ok(construct.tools.every(t=>!t.name.startsWith('book_')));
 assert.match(readGuide('relations'),/例证/);
});

test('斜杠提示词与快捷入口共享请求语义，不误识别普通对话',async()=>{
 assert.deepEqual(parseCompileCommand('/编译 + 保留历史案例'),{notes:'保留历史案例'});assert.deepEqual(parseCompileCommand('/compile 主题与论证'),{notes:'主题与论证'});assert.equal(parseCompileCommand('解释 /compile 的用途'),null);assert.equal(parseCompileCommand('/compiler x'),null);
 assert.deepEqual(await compileCommand({},'',{notes:'保留矛盾'},{}),{action:'select_compile_sources',notes:'保留矛盾'});
});

test('合并后入链解析到保留卡，旧路径仍可读且可恢复',async t=>{
 const f=fixture(t),info=await f.prep(),sources=[info.units[0].ref];for(const id of ['a','b','c'])f.write(id,sources);
 const bVersion=unoRevision(f.root,'01-Cards/b.md');
 f.commit({key:'inbound',action:'link',id:'c',revision:unoRevision(f.root,'01-Cards/c.md'),link:{target:'b',type:'example',basis:'source',note:'材料用此案例阐释该观点'}});
 f.commit({key:'merge-b',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),title:'保留卡',summary:'保留内容',body:'整合后的两种观点与来源。',type:'claim',domains:[],sources,merge:[{id:'b',revision:bVersion}]});
 assert.ok(buildGraphEdges(f.root).some(e=>e.from==='c'&&e.to==='a'));
 assert.ok(searchKnowledge(f.root,{neighbor:'a',kind:'card'}).items.some(c=>c.id==='c'));
 let detail;await handleCardGet({},null,{writeHead(){},end(text){detail=JSON.parse(text);}},[],f.root,'b');assert.equal(detail.superseded_by,'a');
 f.commit({key:'restore-b',action:'restore',id:'b',revision:unoRevision(f.root,'01-Cards/b.md'),version:bVersion});
 assert.ok(loadCards(f.root).has('b'));assert.ok(buildGraphEdges(f.root).some(e=>e.from==='c'&&e.to==='b'));
});
