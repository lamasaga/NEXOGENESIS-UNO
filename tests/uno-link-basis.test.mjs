import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { unoMarkdown, transaction, readUnoReceipt } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { compileToolDefinitions, runCompileTool } from '../packages/nexogenesis-tools/lib/uno/agent.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { saveCompileJob, readCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';

function files(root, directory=root) {
  return Object.fromEntries(readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?Object.entries(files(root,path)):[[relative(root,path),readFileSync(path,'base64')]];
  }));
}
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'uno-link-basis-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'03-Archive'));
  writeFileSync(join(root,'03-Archive/source.md'),unoMarkdown({title:'合成来源'},'作者提出甲概念，并用乙说明成立条件。'));
  const task='basis-b0',gateway=new HarnessGateway(root);
  saveCompileJob(root,{id:'basis',status:'running',workflow:'uno-compile-v3',session_id:'session',sessions:['session'],mode:'construct',role:'author',phase:'read',batch_index:0,batches:[[]],sources:[],outcomes:{},calls:[],budget:{calls:20},touched:[],receipts:[],issues:[]});
  const tool=args=>runCompileTool(root,'session','compile_edit',args);
  for(const id of ['a','b'])tool({operation_id:'create-'+id,id,title:'合成概念 '+id,summary:'仅用于关系参数校验',type:'concept',domains:[],boundary:'仅限合成来源',body:'此处说明概念与适用条件。',sources:['03-Archive/source.md']});
  const args=(extra={})=>({operation_id:'link-test',action:'link',id:'a',revision:readDraft(root,task,'a').revision,link:{target:'b',type:'supplement',note:'乙补充甲概念的成立条件。'},...extra});
  const stage=input=>gateway.stageUnoKnowledge({...input,task,key:task+':'+input.operation_id});
  return {root,task,gateway,tool,args,stage};
}

test('modern compile_edit 明示嵌套关系字段、合法归属及 unlink 可省略',()=>{
  const modern=compileToolDefinitions(true).find(tool=>tool.name==='compile_edit').parameters.link;
  assert.deepEqual(Object.keys(modern.properties),['target','type','note','basis']);
  assert.deepEqual(modern.properties.basis.enum,['source','navigation']);
  assert.match(modern.description,/link.basis.*不在顶层/);
  assert.match(modern.description,/unlink 可省略 basis/);
  assert.match(modern.description,/action=link 必须提供 link.basis/);
});

test('实际错位参数由公开工具拒绝：顶层 navigation 不再静默保存为 source',t=>{
  const f=fixture(t),input=f.args({basis:'navigation'}),before=files(f.root);
  assert.throws(()=>f.tool(input),/位置错误.*link.basis.*顶层/);
  assert.deepEqual(files(f.root),before);
  assert.equal(readUnoReceipt(f.root,f.task+':'+input.operation_id),null);
});

for(const nested of ['source','navigation'])test('顶层与嵌套归属同时出现一律拒绝，不猜测优先级：'+nested,t=>{
  const f=fixture(t),input=f.args({basis:'navigation',link:{...f.args().link,basis:nested}}),before=files(f.root);
  assert.throws(()=>f.stage(input),/位置错误.*link.basis.*顶层/);
  assert.deepEqual(files(f.root),before);
  assert.equal(readUnoReceipt(f.root,f.task+':'+input.operation_id),null);
});

for(const basis of [undefined,null,'','inferred',false])test('新关系缺失或非法归属不写草稿、不追加收据：'+String(basis),t=>{
  const f=fixture(t),input=f.args(),before=files(f.root);
  if(basis!==undefined)input.link.basis=basis;
  assert.throws(()=>f.stage(input),/link.basis/);
  assert.deepEqual(files(f.root),before);
  assert.equal(readUnoReceipt(f.root,f.task+':'+input.operation_id),null);
});

for(const basis of ['source','navigation'])test('显式 '+basis+' 按原义保存，unlink 无需归属',t=>{
  const f=fixture(t),input=f.args();input.link.basis=basis;
  const result=f.tool(input),draft=readDraft(f.root,f.task,'a');
  assert.equal(result.accepted,true);assert.equal(result.staged,true);
  assert.deepEqual(draft.card.relations,[{...input.link,origin:basis==='source'?'document':'navigation'}]);
  assert.equal(result.relation.basis,basis);
  const removed=f.tool({operation_id:'unlink-test',action:'unlink',id:'a',revision:draft.revision,link:{target:'b',type:'supplement'}});
  assert.equal(removed.accepted,true);assert.deepEqual(readDraft(f.root,f.task,'a').card.relations,[]);
});

for(const outer of [false,true])test('历史 '+(outer?'错位归属':'省略归属')+' 收据同参数重放保留原结果且不改知识/后续审核',t=>{
  const f=fixture(t),input=f.args(outer?{basis:'navigation'}:{}),old=readDraft(f.root,f.task,'a');
  const {ref,revision,body,...metadata}=old;
  // Synthetic historical transaction models the former default-to-source behavior.
  const receipt=transaction(f.root,f.task+':'+input.operation_id,{task:f.task,...input},()=>({
    writes:new Map([[ref,unoMarkdown({...metadata,card:{...metadata.card,relations:[{...input.link,basis:'source',origin:'document'}]}},body)]]),
    result:{summary:'合成历史关系收据',card_ids:['a'],draft_id:'a',staged:true,issues:[],ref,relation:input.link,relation_action:'link'}
  }));
  const job=readCompileJob(f.root,'basis');job.reviewed={a:{revision:readDraft(f.root,f.task,'a').revision,note:'已完成的后续审核'}};saveCompileJob(f.root,job);
  const before=files(f.root),reviewed=job.reviewed;
  assert.deepEqual(f.stage(input),receipt);
  assert.deepEqual(files(f.root),before);
  const replay=f.tool(input);assert.equal(replay.replayed,true);assert.equal(replay.at,receipt.at);
  assert.deepEqual(readCompileJob(f.root,'basis').reviewed,reviewed);
  const after=files(f.root);
  for(const [path,bytes] of Object.entries(before))if(!path.includes('uno-jobs'))assert.equal(after[path],bytes,path);
  assert.deepEqual(Object.keys(after),Object.keys(before));
  assert.deepEqual(readDraft(f.root,f.task,'a').card.relations,[{...input.link,basis:'source',origin:'document'}]);
  assert.deepEqual(readUnoReceipt(f.root,f.task+':'+input.operation_id),receipt);
  assert.throws(()=>f.stage({...input,link:{...input.link,basis:'navigation'}}),/同一批次不能改写/);
});
