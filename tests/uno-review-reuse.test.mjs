import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { runConstructionTool,batchTask,CONSTRUCTION_WORKFLOW } from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { unoMarkdown,sha } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { buildEvidencePack,confirmEvidencePackDelivery } from '../packages/nexogenesis-tools/lib/uno/evidence-pack.js';
import { saveCompileJob,readCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';

function fixture(t,{profile='evidence-pack-v1',role='reviewer',limit}={}){
  const root=mkdtempSync(join(tmpdir(),'uno-review-reuse-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())));rmSync(root,{recursive:true,force:true});});
  mkdirSync(join(root,'03-Archive'),{recursive:true});
  const ref='03-Archive/source.md',body='作者明确区分研究自由与公共资助。其论证有条件，不能推定一切公共研究都无价值。';
  const source=text=>writeFileSync(join(root,ref),unoMarkdown({title:'合成来源'},text));source(body);
  const job={id:'review-reuse',mode:'construct',workflow:CONSTRUCTION_WORKFLOW,execution_profile:profile,
    session_id:'author-one',role:'author',batch_index:0,batches:[[ref]],budget:{calls:40},calls:[],touched:[],receipts:[],issues:[],sources:[],outcomes:{},requirements:{preferences:{delivery:'auto'}}};
  const tool=(name,args={})=>runConstructionTool(root,job,name,args);
  tool('compile_edit',{operation_id:'create',id:'a',title:'研究自由与资助',summary:'讨论研究自由和公共资助之间的区别。',type:'claim',domains:[],boundary:'作者的条件性论证，不是对全部公共研究的经验结论。',body,sources:[ref]});
  job.role=role;job.session_id=role+'-one';
  const read=tool('compile_read_card',{id:'a',...(limit===undefined?{}:{limit})});
  if(role==='reviewer')tool('compile_read_material',{ref});
  const draft=()=>readDraft(root,batchTask(job),'a');
  const patch=fields=>{const args={operation_id:'metadata',action:'patch',id:'a',revision:draft().revision,title:'研究自由与公共资助的区别',...fields};return {args,result:tool('compile_edit',args)};};
  return {root,job,tool,draft,patch,source,ref,body,read};
}

test('同一 reviewer 完整阅读后仅改标题/主类型/领域，可复用正文但必须重新审核',t=>{
  const f=fixture(t);f.tool('compile_review',{ids:['a'],note:'已核对作者归属和边界'});
  const before=f.draft(),oldRead=structuredClone(f.job.review_reads.a);
  const {result}=f.patch({type:'mechanism',domains:[]});
  assert.equal(result.body_read_reuse.kind,'unchanged_body_reading');
  assert.equal(result.body_read_reuse.from_revision,before.revision);
  assert.equal(result.body_read_reuse.to_revision,f.draft().revision);
  assert.equal(result.body_read_reuse.body_sha256,sha(f.body));
  assert.equal(result.body_read_reuse.review_required,true);
  assert.deepEqual(f.job.review_reads.a.intervals,oldRead.intervals);
  assert.equal(f.job.review_reads.a.revision,f.draft().revision);
  assert.equal(f.job.reviewed.a,undefined);
  assert.equal(f.tool('compile_finish',{phase:'complete'}).ready,false);
  f.tool('compile_review',{ids:['a'],note:'重新审核标题、主类型与领域归属，正文和来源版本未变'});
  assert.equal(f.job.reviewed.a.revision,f.draft().revision);
});

for(const [name,change] of [
  ['正文变化',{body:'作者主张研究自由，但尚不足以支持更普遍的结论。'}],
  ['证据边界变化',{boundary:'仅作为需要进一步核验的假说。'}],
  ['摘要变化',{summary:'这是新的检索摘要。'}],
  ['显式相同正文仍不属于允许字段',{body:'作者明确区分研究自由与公共资助。其论证有条件，不能推定一切公共研究都无价值。'}]
])test(name+' 不复用正文阅读',t=>{
  const f=fixture(t),old=f.draft().revision;f.tool('compile_review',{ids:['a'],note:'旧版本审核'});
  const {result}=f.patch(change);assert.equal(result.body_read_reuse,undefined);assert.equal(f.job.review_reads.a.revision,old);assert.equal(f.job.reviewed.a,undefined);
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'不能跳过当前正文'}),/完整读回/);
});

test('新增来源不继承，即使正文未变',t=>{
  const f=fixture(t);writeFileSync(join(f.root,'03-Archive/other.md'),unoMarkdown({title:'另一来源'},'其他作者持不同观点。'));
  const {result}=f.patch({sources:[f.ref,'03-Archive/other.md']});
  assert.equal(result.body_read_reuse,undefined);assert.notEqual(f.job.review_reads.a.revision,f.draft().revision);
});

test('引用路径相同但来源文件版本改变，不继承旧证据阅读',t=>{
  const f=fixture(t);f.source(f.body+'新增反例改变原来的证据条件。');
  const {result}=f.patch({});assert.equal(result.body_read_reuse,undefined);
  assert.notEqual(f.job.review_reads.a.revision,f.draft().revision);
});

test('只读部分正文不会被升级为完整阅读',t=>{
  const f=fixture(t,{limit:5}),old=structuredClone(f.job.review_reads.a);const {result}=f.patch({});
  assert.equal(result.body_read_reuse,undefined);assert.deepEqual(f.job.review_reads.a,old);
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'未完整读取'}),/完整读回/);
});

test('作者上下文不复用 reviewer 阅读',t=>{
  const f=fixture(t,{role:'author'}),old=structuredClone(f.job.card_reads.a);const {result}=f.patch({});
  assert.equal(result.body_read_reuse,undefined);assert.equal(f.job.review_reads,undefined);assert.deepEqual(f.job.card_reads.a,old);
});

test('旧 profile 保持当前版本必须复读的历史契约',t=>{
  const f=fixture(t,{profile:'legacy'}),old=structuredClone(f.job.review_reads.a);const {result}=f.patch({});
  assert.equal(result.body_read_reuse,undefined);assert.equal(old.session_id,undefined);assert.deepEqual(f.job.review_reads.a,old);
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'旧流程'}),/完整读回/);
});

test('跨 reviewer 会话的阅读记录不能继承',t=>{
  const f=fixture(t),old=structuredClone(f.job.review_reads.a);f.job.session_id='reviewer-two';const {result}=f.patch({});
  assert.equal(result.body_read_reuse,undefined);assert.deepEqual(f.job.review_reads.a,old);
  f.tool('compile_read_card',{id:'a',limit:5});assert.equal(f.job.review_reads.a.session_id,'reviewer-two');assert.deepEqual(f.job.review_reads.a.intervals,[[0,5]]);
});

test('成功编辑重放不重置阅读区间或抹去后来登记的新版本审核',t=>{
  const f=fixture(t);const {args,result}=f.patch({});assert.ok(result.body_read_reuse);
  f.tool('compile_review',{ids:['a'],note:'已核对新标题与原文的对应关系'});
  const ledger=structuredClone(f.job.review_reads),reviewed=structuredClone(f.job.reviewed),receiptCount=f.job.receipts.length,version=f.draft().revision;
  const replay=f.tool('compile_edit',args);assert.equal(replay.replayed,true);assert.equal(replay.body_read_reuse,undefined);
  assert.deepEqual(f.job.review_reads,ledger);assert.deepEqual(f.job.reviewed,reviewed);assert.equal(f.job.receipts.length,receiptCount);assert.equal(f.draft().revision,version);
});

test('审核首包完整交付后改标题可免正文复读，改 boundary 必须真实读回新稿',t=>{
  const f=fixture(t);f.job.status='running';f.job.phase='organize';
  delete f.job.review_reads;delete f.job.review_evidence;saveCompileJob(f.root,f.job);
  const packet=buildEvidencePack(f.root,f.job),payload=JSON.parse(packet.text);
  assert.equal(payload.evidence.find(row=>row.kind==='card').complete,true);
  assert.equal(payload.evidence.find(row=>row.kind==='material').complete,true);
  const request={sessionId:f.job.session_id,messages:[{role:'user',content:[{type:'text',text:packet.text}]}]};
  assert.equal(confirmEvidencePackDelivery(f.root,packet,request,{type:'text-delta',text:'核对当前证据'}).confirmed,true);
  Object.assign(f.job,readCompileJob(f.root,f.job.id));
  assert.equal(f.job.review_reads.a.session_id,f.job.session_id);
  const firstVersion=f.draft().revision,{result}=f.patch({});
  assert.equal(result.body_read_reuse.from_revision,firstVersion);
  // No compile_read_card occurs between this title edit and its new review.
  f.tool('compile_review',{ids:['a'],note:'完整首包已包含正文与来源，标题修订未改变它们，重新确认命名与原文一致'});
  assert.equal(f.job.reviewed.a.revision,f.draft().revision);
  const boundary=f.tool('compile_edit',{operation_id:'boundary-after-pack',action:'patch',id:'a',revision:f.draft().revision,boundary:'新边界：仅限所提供的历史材料，不代表当代制度表现。'});
  assert.equal(boundary.body_read_reuse,undefined);assert.equal(f.job.reviewed.a,undefined);
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'不能把旧首包当新边界的阅读证明'}),/完整读回/);
  f.tool('compile_read_card',{id:'a'});
  f.tool('compile_review',{ids:['a'],note:'已实际读回新稿，核对调整后的证据边界及来源'});
  assert.equal(f.job.reviewed.a.revision,f.draft().revision);
});
