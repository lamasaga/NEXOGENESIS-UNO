import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { unoMarkdown, unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { planConstruction } from '../packages/nexogenesis-tools/lib/uno/construction-plan.js';
import { initializeProviderBudget } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import { readCompileJob, saveCompileJob, jobRef } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { runConstructionTool } from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import { buildEvidencePack, confirmEvidencePackDelivery } from '../packages/nexogenesis-tools/lib/uno/evidence-pack.js';

const length = text => Array.from(text).length;
const response = {type:'text-delta', text:'已收到这些具体版本。'};
function fixture(t, {scope=['a'], long=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'uno-construction-evidence-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['01-Cards','03-Archive'])mkdirSync(join(root,dir));
  const source='甲作者：透明条件下，信息服务降低查找成本。 ^a\n乙作者：名单失效时，需要保留反例和观察窗口。 ^b\n'
    +'原材料正文不应为纯标题修改重复送出。'.repeat(3000);
  writeFileSync(join(root,'03-Archive/source.md'),unoMarkdown({title:'合成原始资料'},source));
  const bodies={a:'甲作者：透明条件下，信息服务降低查找成本。\n反例：信息不对称时未必有效。',
    b:'乙作者：名单失效时，需要保留反例和观察窗口。\n只说明局部现象，不代表所有服务无效。'};
  if(long)for(const id of Object.keys(bodies))bodies[id]+='😀这段完整条件不可被省略。'.repeat(600)+'最后的独立限制。';
  for(const id of ['a','b'])writeFileSync(join(root,`01-Cards/${id}.md`),unoMarkdown({
    id,schema:'uno-card-v4',title:`信息服务 ${id} 的原标题`,summary:'合成作者、条件及反例。',type:'claim',domains:[],
    boundary:'仅限资料中的透明与观察条件。',sources:[`03-Archive/source.md#${id}`],relations:[],origin:'document',
    lifecycle:'active',generated_by:'uno-compile-v3',
  },bodies[id]));
  const plan=planConstruction(root,{notes:'核对信息服务的标题与比较导航',card_ids:scope});
  const job={id:'construction-pack',workflow:'uno-compile-v3',orchestration_profile:'bounded-workflow-v1',
    construction_profile:'direction-driven-v1',construct_contract:'scoped-review-v1',construction_plan:plan,
    mode:'construct',role:'reviewer',phase:'organize',status:'running',session_id:'reviewer-one',owner_session_id:'owner',sessions:['reviewer-one'],
    scope,batches:[scope],batch_index:0,sources:[],calls:[],budget:{calls:20},receipts:[],issues:[],touched:[],outcomes:{},reviewed:{},
    requirements:{notes:plan.goal,preferences:{delivery:'manual'}}};
  saveCompileJob(root,job);initializeProviderBudget(root,job.id,{limit:20});
  const gateway=new HarnessGateway(root);let serial=0;
  const read=()=>readCompileJob(root,job.id),update=patch=>saveCompileJob(root,{...read(),...patch});
  const stage=(args={})=>{
    const id=args.id??'a',draft=readDraft(root,job.id+'-b0',id);
    const result=gateway.stageUnoKnowledge({task:job.id+'-b0',key:'draft-'+(++serial),action:'patch',id,
      revision:draft?.revision??unoRevision(root,`01-Cards/${id}.md`),...args});
    assert.equal(result.staged,true,JSON.stringify(result.issues));return readDraft(root,job.id+'-b0',id);
  };
  const request=packet=>({sessionId:read().session_id,messages:[{role:'user',content:[{type:'text',text:packet.text}]}]});
  const confirm=(packet,req=request(packet),chunk=response)=>confirmEvidencePackDelivery(root,packet,req,chunk);
  const review=(draft,checks)=>runConstructionTool(root,read(),'compile_review',{ids:[draft.card.id],note:'核对本次变化与原有条件，不扩大结论。',checks});
  return {root,source,bodies,read,update,stage,request,confirm,review};
}
const check=(draft,ref,quote)=>({id:draft.card.id,claim:'资料支持这个具体条件，导航不代表因果或反驳已成立。',ref,quote});
function merge(f) {
  const draft=f.stage({body:f.bodies.a+'\n\n'+f.bodies.b,merge:[{id:'b',revision:unoRevision(f.root,'01-Cards/b.md')}]});
  return {draft,checks:[check(draft,draft.ref,'需要保留反例和观察窗口'),
    check(draft,'01-Cards/a.md','信息服务降低查找成本'),check(draft,'01-Cards/b.md','需要保留反例和观察窗口'),
    check(draft,'03-Archive/source.md','透明条件下，信息服务降低查找成本。')]};
}

test('metadata review gets current body and previous fields without source full text or duplicate baseline body',t=>{
  const f=fixture(t),draft=f.stage({title:'透明条件下的信息服务'}),before=readFileSync(join(f.root,jobRef(f.read().id)),'utf8');
  const packet=buildEvidencePack(f.root,f.read()),pack=JSON.parse(packet.text),summary=pack.construction_reviews[0];
  assert.equal(readFileSync(join(f.root,jobRef(f.read().id)),'utf8'),before,'building cannot record reading');
  assert.equal(summary.tier,'metadata');
  assert.deepEqual(summary.metadata.title,{before:'信息服务 a 的原标题',after:'透明条件下的信息服务'});
  assert.deepEqual(summary.required_sources,[]);assert.ok(pack.evidence.some(row=>row.ref===draft.ref&&row.text===draft.body));
  assert.equal(pack.evidence.some(row=>row.kind==='material'),false);
  assert.equal(pack.evidence.some(row=>row.kind==='baseline'&&row.id==='a'),false,'unchanged body needs only one copy; before fields already present');
  assert.equal(packet.text.includes('原材料正文不应为纯标题修改重复送出'),false);
  const checks=[check(draft,draft.ref,'信息服务降低查找成本')];
  assert.throws(()=>f.review(draft,checks),{code:'STALE_EVIDENCE'});
  assert.equal(f.confirm(packet).confirmed,true);
  assert.equal(f.read().review_evidence?.['03-Archive/source.md'],undefined);
  f.review(draft,checks);assert.equal(f.read().reviewed.a.tier,'metadata');
});

test('navigation defaults to formal target; full baseline does not credit omitted draft tail or leak alternative bodies',t=>{
  const f=fixture(t,{scope:['a','b']}),target=f.stage({id:'b',body:f.bodies.b+'\n草稿专有新增段落。'.repeat(200)+'草稿最后未交付的反证。'});
  const draft=f.stage({action:'link',link:{target:'b',type:'contrast',basis:'navigation',note:'比较透明条件与名单失效的解释边界。'}});
  const packet=buildEvidencePack(f.root,f.read(),{maxCharsPerItem:100}),pack=JSON.parse(packet.text);
  const plan=pack.construction_reviews.find(row=>row.id==='a'),required=plan.required_cards.find(row=>row.id==='b');
  assert.equal(required.ref,'01-Cards/b.md');assert.equal(required.prefer_baseline,true);
  assert.equal(required.alternatives[0].ref,target.ref);
  assert.equal(required.alternatives[0].body,undefined);assert.equal(required.alternatives[0].meta,undefined);
  assert.equal(JSON.stringify(pack.construction_reviews).includes('草稿最后未交付的反证'),false);
  const formal=pack.evidence.find(row=>row.kind==='baseline'&&row.id==='b'),partial=pack.evidence.find(row=>row.ref===target.ref);
  assert.equal(formal.text,f.bodies.b);assert.equal(formal.complete,true);
  assert.equal(partial.complete,false);assert.equal(partial.end,100);
  f.confirm(packet);
  assert.equal(f.read().review_evidence['01-Cards/b.md'].revision,formal.revision);
  assert.deepEqual(f.read().review_evidence['01-Cards/b.md'].intervals,[[0,length(f.bodies.b)]]);
  assert.equal(f.read().review_reads.b.revision,target.revision);
  assert.deepEqual(f.read().review_reads.b.intervals,[[0,100]]);
  f.review(draft,[check(draft,draft.ref,'信息服务降低查找成本'),check(draft,'01-Cards/b.md','需要保留反例和观察窗口')]);
  assert.deepEqual(f.read().reviewed.a.dependencies,[{id:'b',ref:'01-Cards/b.md',revision:formal.revision,draft:false}]);
  assert.throws(()=>f.review(target,[check(target,target.ref,'草稿最后未交付的反证')]),{code:'UNDELIVERED_EVIDENCE'});
});

test('merge cannot validate until both baselines and merged proposal are actually dispatched and answered',t=>{
  const f=fixture(t,{scope:['a','b']}),{draft,checks}=merge(f),packet=buildEvidencePack(f.root,f.read()),pack=JSON.parse(packet.text);
  assert.deepEqual(new Set(pack.evidence.filter(row=>row.kind==='baseline').map(row=>row.ref)),new Set(['01-Cards/a.md','01-Cards/b.md']));
  assert.equal(f.read().review_evidence,undefined);
  for(const chunk of [{type:'usage',usage:{inputTokens:10}},{type:'text-delta',text:''},{type:'finish',reason:{kind:'error'}}])
    assert.equal(f.confirm(packet,f.request(packet),chunk).confirmed,false);
  const altered=JSON.parse(packet.text);altered.evidence=altered.evidence.filter(row=>row.ref!=='01-Cards/b.md');
  const missing={...f.request(packet),messages:[{role:'user',content:[{type:'text',text:JSON.stringify(altered)}]}]};
  assert.equal(f.confirm(packet,missing).confirmed,false,'request must contain exact serialized packet');
  assert.equal(f.read().review_evidence,undefined);
  assert.throws(()=>f.review(draft,checks),{code:'STALE_EVIDENCE'});
  f.confirm(packet);
  for(const id of ['a','b']) {
    const ledger=f.read().review_evidence[`01-Cards/${id}.md`];
    assert.equal(ledger.session_id,'reviewer-one');assert.deepEqual(ledger.intervals,[[0,length(f.bodies[id])]]);
  }
  f.review(draft,checks);assert.equal(f.read().reviewed.a.tier,'merge');
});

test('long merge packets never credit omitted baselines or truncated Unicode tails as fully read',t=>{
  const f=fixture(t,{scope:['a','b'],long:true}),{draft,checks}=merge(f);
  const packet=buildEvidencePack(f.root,f.read(),{maxBytes:16000}),pack=JSON.parse(packet.text);
  assert.ok(packet.bytes<=16000);assert.equal(Buffer.byteLength(packet.text),packet.bytes);
  assert.ok(pack.evidence.some(row=>!row.complete));assert.ok(pack.evidence.length<pack.directory.items.length);
  f.confirm(packet);const job=f.read();
  for(const candidate of pack.directory.items) {
    const entry=pack.evidence.find(row=>row.kind===candidate.kind&&(candidate.kind==='material'?row.ref===candidate.ref:row.id===candidate.id));
    const ref=candidate.kind==='baseline'?`01-Cards/${candidate.id}.md`:candidate.ref;
    const ledger=candidate.kind==='card'?job.review_reads?.[candidate.id]:job.review_evidence?.[ref];
    if(!entry?.end)assert.equal(ledger,undefined,'directory-only evidence is not a reading receipt');
    else {
      assert.deepEqual(ledger.intervals,[[0,entry.end]]);
      assert.equal(length(entry.text),entry.end);assert.equal(entry.next_offset,entry.complete?null:entry.end);
      if(!entry.complete)assert.ok(entry.end<entry.total);
    }
  }
  assert.throws(()=>f.review(draft,checks),error=>['STALE_EVIDENCE','UNDELIVERED_EVIDENCE'].includes(error.code));
  assert.equal(f.read().reviewed.a,undefined);
});

test('fresh reviewer cannot reuse old-session complete baselines and new partial delivery replaces old intervals',t=>{
  const f=fixture(t,{scope:['a','b']}),{draft,checks}=merge(f),old=buildEvidencePack(f.root,f.read());
  f.confirm(old);const oldRequest=f.request(old);
  f.update({session_id:'reviewer-two',sessions:['reviewer-one','reviewer-two']});
  assert.throws(()=>f.review(draft,checks),{code:'STALE_EVIDENCE'});
  assert.throws(()=>f.confirm(old,oldRequest),{code:'STALE_CONTEXT'});
  const packet=buildEvidencePack(f.root,f.read(),{maxCharsPerItem:12});f.confirm(packet);
  assert.equal(f.read().review_reads.a.session_id,'reviewer-two');assert.deepEqual(f.read().review_reads.a.intervals,[[0,12]]);
  for(const id of ['a','b']) {
    assert.equal(f.read().review_evidence[`01-Cards/${id}.md`].session_id,'reviewer-two');
    assert.deepEqual(f.read().review_evidence[`01-Cards/${id}.md`].intervals,[[0,12]]);
  }
  assert.throws(()=>f.review(draft,checks),{code:'UNDELIVERED_EVIDENCE'});
});

test('new draft revision invalidates an unacknowledged packet atomically',t=>{
  const f=fixture(t),draft=f.stage({title:'第一版标题'}),packet=buildEvidencePack(f.root,f.read());
  f.stage({title:'第二版标题'});
  assert.throws(()=>f.confirm(packet),{code:'REVISION_CONFLICT'});
  assert.equal(f.read().review_reads,undefined);assert.equal(f.read().review_evidence,undefined);
  assert.equal(f.read().evidence_pack_deliveries,undefined);
  assert.throws(()=>f.review(draft,[check(draft,draft.ref,'信息服务降低查找成本')]),{code:'STALE_EVIDENCE'});
});

test('changed merge baseline invalidates all packet receipts before any reading is recorded',t=>{
  const f=fixture(t,{scope:['a','b']});merge(f);const packet=buildEvidencePack(f.root,f.read());
  const path=join(f.root,'01-Cards/b.md');writeFileSync(path,readFileSync(path,'utf8')+'\n外部补充的边界。');
  assert.throws(()=>f.confirm(packet),{code:'REVISION_CONFLICT'});
  assert.equal(f.read().review_reads,undefined);assert.equal(f.read().review_evidence,undefined);
  assert.equal(f.read().evidence_pack_deliveries,undefined);
});
