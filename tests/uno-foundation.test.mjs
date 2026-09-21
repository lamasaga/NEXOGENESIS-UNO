import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { sha, readUnoUnit, unoRevision, unoMarkdown } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { preprocessSource, searchKnowledge } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { readCompileJob, saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { apply, runCompileTool, compileToolDefinitions } from '../packages/nexogenesis-tools/lib/uno/agent.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { batchTask } from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import { pendingBatches, resumeUnfinishedBatch } from '../packages/nexogenesis-tools/lib/uno/recovery.js';
import { finalizeConstructionBatch } from '../packages/nexogenesis-web-host/lib/construction-host.js';
import { collectThinkingContext } from '../packages/nexogenesis-web-host/lib/thinking-routes.js';
import { applyTextEdits, textBlocks } from '../packages/nexogenesis-tools/lib/runtime/text-edits.js';
import { selectPassages } from '../packages/nexogenesis-tools/lib/runtime/text-edits.js';
import { sessionRootResolver, executionError, guardRepeatedFailure } from '../packages/nexogenesis-tools/lib/uno/execution-contract.js';
import { toolFailure } from '../packages/nexogenesis-tools/lib/runtime/tool-result.js';
import { updateRequestState } from '../packages/nexogenesis-web-host/lib/uno-request-state.js';

async function fixture(t,text='正文说明参与成本与共同决策的区别。\n\n案例编号 987654，保留不同作者立场。'){
  const root=mkdtempSync(join(tmpdir(),'uno-foundation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'00-Inbox'));writeFileSync(join(root,'00-Inbox/a.md'),text);
  const gateway=new HarnessGateway(root),info=prepareSourceFixture(root,{source:'00-Inbox/a.md',prepared:await preprocessSource(root,'00-Inbox/a.md',undefined,true)}),ref=info.units[0].ref;
  saveCompileJob(root,{id:'foundation',status:'running',workflow:'uno-compile-v3',session_id:'session',sessions:['session'],mode:'construct',role:'author',phase:'read',batch_index:0,batches:[[ref]],sources:[info],outcomes:{},calls:[],budget:{calls:100},touched:[],receipts:[],issues:[],requirements:{notes:'保留不同观点',long_term:'案例必须具体',preferences:{delivery:'auto'}}});
  const job=()=>readCompileJob(root,'foundation'),update=changes=>saveCompileJob(root,{...job(),...changes}),tool=(name,args={})=>runCompileTool(root,'session',name,args);
  const draft=(id='a',extra={})=>tool('compile_edit',{operation_id:'create-'+id,id,title:'参与成本 '+id,summary:'参与成本与决策范围的区分',type:'claim',domains:[],sources:[ref],boundary:'仅限作者提出的条件',body:text,...extra});
  const review=ids=>{update({role:'reviewer'});tool('compile_read_material',{ref});for(const id of ids)tool('compile_read_card',{id});return tool('compile_review',{ids,note:'核对合成来源、归属、数字与边界'});};
  return {root,ref,info,gateway,job,update,tool,draft,review};
}

test('模型工具返回 lossless JSON；系统前缀稳定，进度进入原生上下文',async t=>{
  assert.deepEqual(compileToolDefinitions(true),JSON.parse(JSON.stringify(compileToolDefinitions(true))));
  const f=await fixture(t),registered=[],sections=[],contexts=[],effects=[];
  apply({on(){return ()=>{};},effect(fn){effects.push(fn());},tools:{register(def){registered.push(def);return ()=>{};}},systemPrompt:{section(def){sections.push(def);return ()=>{};},context(def){contexts.push(def);return ()=>{};}}},{projectRoot:f.root,instanceRegistry:''});
  t.after(()=>effects.forEach(fn=>fn?.()));const assembly={agent:{session:{id:'session'}}},before=sections[0].text(assembly);
  f.update({checkpoint:'只补充来源，不重写正文',calls:[{}]});assert.equal(sections[0].text(assembly),before);assert.match(contexts[0].text(assembly),/只补充来源/);
  const output=await registered.find(t=>t.name==='compile_task').execute({},assembly);
  assert.deepEqual(output,JSON.parse(JSON.stringify(output)));assert.equal(output.selection_reminder,undefined);
  const failure=await registered.find(t=>t.name==='compile_read_card').execute({id:'missing'},assembly);assert.equal(failure.ok,false);assert.equal(failure.error.code,'TOOL_FAILED');
});

test('局部修改保留正文、主类型、领域与来源；歧义参数与冲突不改变草稿',async t=>{
  const f=await fixture(t,'有细节的论证。'.repeat(1000));f.draft();let d=readDraft(f.root,batchTask(f.job()),'a');
  const before=d.body;f.tool('compile_edit',{operation_id:'title',action:'patch',id:'a',revision:d.revision,title:'精炼标题'});d=readDraft(f.root,batchTask(f.job()),'a');
  assert.equal(d.body,before);assert.equal(d.card.type,'claim');assert.deepEqual(d.card.domains,[]);assert.deepEqual(d.card.sources,[f.ref]);
  const version=d.revision;
  assert.throws(()=>f.tool('compile_edit',{operation_id:'ambiguous',id:'a',revision:version,title:'不应保存',link:{target:'b',type:'contrast',note:'比较'}}),/必须使用 action/);
  assert.equal(readDraft(f.root,batchTask(f.job()),'a').revision,version);
  assert.throws(()=>f.tool('compile_edit',{operation_id:'stale',action:'patch',id:'a',revision:'old',title:'覆盖'}),/版本|已变化/);
  assert.throws(()=>applyTextEdits('甲段。乙段。',[{old_text:'甲段',new_text:'新段'},{old_text:'缺失',new_text:'另段'}]),/不存在/);
  assert.throws(()=>applyTextEdits('相同 相同',[{old_text:'相同',new_text:'替换'}]),/不唯一/);
});

test('精确补丁与幂等回执：重试成功操作不取消后来的审核',async t=>{
  const f=await fixture(t);f.draft();let d=readDraft(f.root,batchTask(f.job()),'a');
  const args={operation_id:'patch',action:'patch',id:'a',revision:d.revision,edits:[{old_text:'987654',new_text:'987654（来源编号）'}]};
  f.tool('compile_edit',args);f.review(['a']);const reviewed=f.job().reviewed.a;
  assert.equal(f.tool('compile_edit',args).replayed,true);assert.deepEqual(f.job().reviewed.a,reviewed);
  assert.equal(f.tool('compile_task',{view:'receipts',id:'patch'}).items.length,1);
});

test('短文章元数据保全且不生成空洞单元；显式图书仍按章节',async t=>{
  const raw='---\ntitle: 示例\nauthor: 作者甲\nurl: https://example.org/source\n---\n# 正文\n关键事实 123。\n\n## 分析\n限定条件与反例。';
  const f=await fixture(t,raw);assert.equal(f.info.units.length,1);const unit=readUnoUnit(f.root,f.ref);assert.doesNotMatch(unit.body,/author:/);assert.match(unit.meta.source_metadata,/作者甲/);assert.match(unit.body,/限定条件/);
  assert.equal(readFileSync(join(f.root,f.info.source),'utf8'),raw);
  writeFileSync(join(f.root,'00-Inbox/book.md'),'# 第一章\n论点甲。\n# 第二章\n反例乙。');
  assert.equal((await preprocessSource(f.root,'00-Inbox/book.md',undefined,true,'book')).chapters.length,2);
});

test('批量执行逐项回执，失败不重复成功写入，阅读上限不伪造完整覆盖',async t=>{
  const f=await fixture(t,'核心论证。'.repeat(2000));
  const result=await f.tool('compile_batch',{operations:[{tool:'compile_read_card',args:{id:'missing'}},{tool:'compile_read_material',args:{ref:f.ref,limit:24000}}]});
  assert.equal(result.results[0].ok,false);assert.equal(result.results[1].text.length,3000);assert.equal(result.results[1].next_offset,3000);
  assert.equal(f.job().reading[f.ref].intervals[0][1],3000);
  await assert.rejects(f.tool('compile_batch',{operations:[{tool:'compile_finish',args:{phase:'complete'}}]}),/不支持/);
});

test('来源关系与模型导航保留区别，搜索与思考上下文继续携带标记',async t=>{
  const f=await fixture(t);f.draft('a');f.draft('b');
  const r=f.tool('compile_edit',{operation_id:'nav',action:'link',id:'a',revision:readDraft(f.root,batchTask(f.job()),'a').revision,link:{target:'b',type:'analogy',basis:'navigation',note:'比较共同参与成本；制度背景不同，不迁移结论'}});assert.equal(r.relation_count,1);
  f.review(['a','b']);finalizeConstructionBatch(f.root,f.job());assert.equal(loadCards(f.root).get('a').meta.relations[0].basis,'navigation');
  const found=searchKnowledge(f.root,{neighbor:'a',kind:'card'});assert.ok(found.items.some(i=>i.links.some(l=>l.basis==='navigation')));
  assert.match(JSON.stringify(collectThinkingContext(f.root,'参与成本','analogize')),/navigation/);
});

test('不合格入边不会阻止目标发布；恢复指向原批待办而非空筛选',async t=>{
  const f=await fixture(t);f.draft('a');f.draft('b');f.tool('compile_edit',{operation_id:'edge',action:'link',id:'b',revision:readDraft(f.root,batchTask(f.job()),'b').revision,link:{target:'a',type:'supplement',note:'补充具体条件',basis:'source'}});
  f.review(['a']);f.tool('compile_read_card',{id:'b'});f.tool('compile_review',{ids:['b'],note:'需修正归属',issues:[{id:'b',detail:'归属尚不确定'}]});finalizeConstructionBatch(f.root,f.job());
  assert.ok(loadCards(f.root).has('a'));assert.ok(!loadCards(f.root).has('b'));let job=f.job();job.phase='done';job.status='partial';job.batch_index=1;saveCompileJob(f.root,job);
  assert.equal(pendingBatches(f.root,job)[0].drafts[0].id,'b');assert.ok(resumeUnfinishedBatch(f.root,job));assert.equal(job.batch_index,0);assert.notEqual(job.phase,'select');assert.equal(job.needs_fresh_context,true);
  job.status='running';saveCompileJob(f.root,job);assert.ok(!f.tool('compile_review').remaining.includes('a'));
});


test('思考保留末尾边界，按问题提取后段证据；索引随主题移动与正文更新重建',async t=>{
  const f=await fixture(t,'背景介绍。'.repeat(700)+'\n\n关键机制：小组决策成本随参与人数增加，记录号937771。\n\n## 边界与适用条件\n\n只讨论小组，不推广到所有组织。');
  f.draft();f.review(['a']);finalizeConstructionBatch(f.root,f.job());
  const packet=collectThinkingContext(f.root,'小组决策成本','explain').find(p=>p.id==='a');assert.match(packet.text,/关键机制/);assert.match(packet.boundary,/仅限作者|只讨论小组/);assert.equal(packet.truncated,true);
  let result=searchKnowledge(f.root,{query:'小组决策成本',kind:'buffer'});assert.ok(result.items.length);const before=result.items[0].ref;
  result=searchKnowledge(f.root,{query:'小组决策成本',kind:'buffer'});assert.equal(result.items[0].ref,before);
  const read=readUnoUnit(f.root,f.ref),phrase='小组决策成本随参与人数增加，记录号937771。';
  writeFileSync(join(f.root,read.physical_ref),unoMarkdown(read.meta,read.body.replace(phrase,''))); // External fixture edit must invalidate the rebuildable read index.
  assert.equal(searchKnowledge(f.root,{query:'937771',kind:'buffer'}).items.length,0);
});

test('返回预算在阅读登记之前执行，Unicode 页可无损续读；大批结果停止派发并指出余项',async t=>{
  const f=await fixture(t,'事实😀证据。'.repeat(5000)+'最后反例：此处不可推广。');
  const first=f.tool('compile_read_material',{ref:f.ref,limit:24000});
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=32000);
  assert.equal(first.next_offset,Array.from(first.text).length);
  assert.equal(f.job().reading[f.ref].intervals[0][1],first.next_offset);
  const second=f.tool('compile_read_material',{ref:f.ref,offset:first.next_offset,limit:24000});
  assert.equal(first.text+second.text,Array.from(readUnoUnit(f.root,f.ref).body).slice(0,second.next_offset).join(''));
  const batch=await f.tool('compile_batch',{operations:Array.from({length:8},()=>({tool:'compile_read_material',args:{ref:f.ref,limit:3000}}))});
  assert.ok(batch.attempted<8);assert.equal(batch.next_index,batch.attempted);
  assert.ok(Buffer.byteLength(JSON.stringify(batch))<64000);
  assert.deepEqual(batch,JSON.parse(JSON.stringify(batch)));
});

test('嵌套 Schema 拒绝拼错的补丁字段，整个批次预检在写入前完成',async t=>{
  const f=await fixture(t);f.draft();const d=readDraft(f.root,batchTask(f.job()),'a');
  const bad={operation_id:'bad',action:'patch',id:'a',revision:d.revision,edits:[{old_text:'参与成本',newtext:'不应写入'}]};
  assert.throws(()=>f.tool('compile_edit',bad),e=>e.code==='INVALID_ARGUMENTS');
  await assert.rejects(f.tool('compile_batch',{operations:[{tool:'compile_edit',args:{operation_id:'valid',action:'patch',id:'a',revision:d.revision,title:'不应提前保存'}},{tool:'compile_edit',args:bad}]}),e=>e.code==='INVALID_ARGUMENTS');
  assert.equal(readDraft(f.root,batchTask(f.job()),'a').revision,d.revision);
});

test('本地切库不改变原生会话归属，重新装载后仍使用创建目录；旧角色不能继续',async t=>{
  const a=await fixture(t),b=await fixture(t),registry=join(a.root,'registry.json');
  const records=[{id:'a',name:'A',root:a.root,legacy:true},{id:'b',name:'B',root:b.root,legacy:true}];
  writeFileSync(registry,JSON.stringify({schema_version:1,active_instance_id:'a',instances:records}));
  const config={projectRoot:a.root,instanceRegistry:registry},resolver=sessionRootResolver(config),context={agent:{session:{id:'session',header:{cwd:a.root}}}};
  assert.equal(resolver(context),a.root);
  writeFileSync(registry,JSON.stringify({schema_version:1,active_instance_id:'b',instances:records}));
  assert.equal(resolver(context),a.root);assert.equal(sessionRootResolver(config)(context),a.root);
  a.update({session_id:'reviewer',sessions:['session','reviewer']});
  assert.throws(()=>a.tool('compile_edit',{operation_id:'late',id:'late'}),e=>e.code==='STALE_CONTEXT');
  assert.equal(b.job().receipts.length,0);
});

test('错误类别不依赖文案；Harness 拒绝收据、截断与无正文不会变成业务完成',()=>{
  assert.equal(toolFailure(executionError('REVISION_CONFLICT','措辞完全改变')).error.code,'REVISION_CONFLICT');
  assert.equal(toolFailure(new Error('文档讲述结束与版本')).error.code,'TOOL_FAILED');
  const receipt={accepted:false,summary:'拒绝',issues:[{code:'source_missing'}]};
  assert.deepEqual(toolFailure(Object.assign(new Error('拒绝'),{receipt})).receipt,receipt);
  const call={status:'running',started_at:new Date().toISOString()};
  updateRequestState(call,{type:'assistant/chunk',data:{chunk:{type:'finish',reason:{kind:'max-tokens'}}}});
  updateRequestState(call,{type:'assistant/message',data:{message:{content:[]},usage:{outputTokens:500}}});
  updateRequestState(call,{type:'turn/end',data:{reason:{kind:'max-tokens'}}});
  assert.equal(call.status,'truncated');assert.equal(call.response_kind,'no_text');assert.equal(call.usage.outputTokens,500);
});

test('同一关键词的后段限制与反例保留，摘录预算内不切断 emoji',()=>{
  const body='参与成本最初判断。'+('背景😀。'.repeat(800))+'然而参与成本有重要反例：只在小组条件下成立，不能推广到所有组织。'+('结尾😀。'.repeat(500));
  const packet=selectPassages(body,['参与成本'],1800);
  assert.match(packet.text,/重要反例/);assert.ok(packet.text.length<=1800);
  assert.ok(packet.text.isWellFormed());
  for(const span of packet.spans)assert.ok(packet.text.includes(body.slice(span.start,span.end)));
});

test('相同失败连续三次才暂停；成功读回、不同参数与旧会话不误伤当前任务',async t=>{
  const f=await fixture(t),blocked={ready:false,remaining:['source']},attempt=(args={phase:'organize'})=>guardRepeatedFailure(f.root,'foundation','compile_finish',args,blocked,'session');
  attempt();attempt();assert.equal(f.job().status,'running');
  guardRepeatedFailure(f.root,'foundation','compile_read_material',{ref:f.ref},{text:'必要复读'},'session');
  attempt();attempt({phase:'complete'});attempt();assert.equal(f.job().status,'running');
  attempt();assert.equal(attempt().error.code,'NO_PROGRESS');assert.equal(f.job().status,'paused');
  f.update({session_id:'reviewer',status:'running'});attempt();assert.equal(f.job().session_id,'reviewer');assert.equal(f.job().status,'running');
});
