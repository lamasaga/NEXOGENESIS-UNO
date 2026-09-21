import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { unoMarkdown, unoRevision, sha } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { parseCardFile } from '../packages/nexogenesis-tools/lib/cards.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { buildConstructionReview, validateConstructionReview } from '../packages/nexogenesis-tools/lib/uno/construction-review.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uno-construction-review-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  for (const dir of ['01-Cards', '03-Archive']) mkdirSync(join(root, dir));
  const source = '甲作者：自由市\n场仅在信息透明时降低成本。\n反例：存在市场势力时未必降价。 ^source-a\n乙作者：信息服务存在固定成本。 ^source-b';
  writeFileSync(join(root, '03-Archive/source.md'), unoMarkdown({title:'两位作者的条件'}, source));
  for (const id of ['a', 'b', 'c']) writeFileSync(join(root, `01-Cards/${id}.md`), unoMarkdown({
    id, schema:'uno-card-v4', title:`对象 ${id}`, summary:'保留作者、条件和反例。', type:'claim', domains:[],
    boundary:'仅限信息条件成立时。', sources:[`03-Archive/source.md#source-${id === 'a' ? 'a' : 'b'}`],
    relations:[], origin:'document', lifecycle:'active', generated_by:'uno-compile-v3',
  }, id === 'a' ? '甲作者：自由市场在信息透明时降低成本。\n反例：市场势力可能阻止降价。'
    : `乙作者：信息服务有固定成本。\n卡片 ${id} 只讨论服务，不能替代价格竞争的结论。`));
  const gateway = new HarnessGateway(root), job = {id:'job', mode:'construct', construction_profile:'direction-driven-v1',
    orchestration_profile:'bounded-workflow-v1', batch_index:0, scope:['a','b'], role:'reviewer', session_id:'reviewer-new',
    review_reads:{}, review_evidence:{}};
  let n = 0;
  const stage = (args={}) => {
    const id = args.id ?? 'a', current = readDraft(root, 'job-b0', id);
    const result = gateway.stageUnoKnowledge({task:'job-b0', key:`operation-${++n}`, action:'patch', id,
      revision:current?.revision ?? unoRevision(root, `01-Cards/${id}.md`), ...args});
    assert.equal(result.staged, true, JSON.stringify(result.issues));
    return readDraft(root, 'job-b0', id);
  };
  return {root, job, stage, source};
}
const quote = (draft, ref, text) => ({id:draft.card.id, claim:'审核具体条件与改动相符；引文存在仍须人工或模型判断含义。', ref, quote:text});
function deliver(f, item, {start=0, end=Array.from(item.body).length, session=f.job.session_id, evidence=false}={}) {
  const map = evidence ? f.job.review_evidence : f.job.review_reads;
  map[evidence ? item.ref : item.id] = {revision:item.revision, session_id:session, intervals:[[start,end]]};
}
function sourceItem(f) { return {ref:'03-Archive/source.md', revision:unoRevision(f.root,'03-Archive/source.md'), body:f.source}; }
function review(f, draft, checks, extra={}) {
  return validateConstructionReview(f.root, f.job, {ids:[draft.card.id], note:'独立检查了本次实际差异。', checks, ...extra}, [draft]).get(draft.card.id);
}
function mergeReady(f) {
  const body = '甲作者：自由市场在信息透明时降低成本。\n反例：市场势力可能阻止降价。\n乙作者：信息服务有固定成本，不能替代价格竞争结论。';
  const draft = f.stage({body, merge:[{id:'b', revision:unoRevision(f.root, '01-Cards/b.md')}]}), plan = buildConstructionReview(f.root, f.job, draft);
  deliver(f, plan.draft);
  for (const baseline of plan.baselines) deliver(f, baseline, {evidence:true});
  deliver(f, sourceItem(f), {evidence:true});
  const checks = [quote(draft, draft.ref, '乙作者：信息服务有固定成本'),
    ...plan.baselines.map(row => quote(draft, row.ref, row.body.split('\n')[0])),
    quote(draft, '03-Archive/source.md', '自由市场仅在信息透明时降低成本。')];
  return {draft, plan, checks};
}

test('actual metadata diff needs body support, not original source rereading; packet build is read-only', t => {
  const f = fixture(t), before = readFileSync(join(f.root, '01-Cards/a.md'), 'utf8');
  const draft = f.stage({title:'信息透明下的价格竞争', type:'claim', domains:[]});
  const ledgers = JSON.stringify(f.job), plan = buildConstructionReview(f.root, f.job, draft);
  assert.equal(plan.tier, 'metadata'); assert.deepEqual(plan.changed_fields, ['title']);
  assert.equal(plan.required_sources.length, 0); assert.equal(plan.baselines.length, 0);
  assert.equal(plan.required_cards[0].reading, 'quote'); assert.ok(Object.isFrozen(plan.baseline.meta));
  assert.equal(JSON.stringify(f.job), ledgers); assert.equal(readFileSync(join(f.root, '01-Cards/a.md'), 'utf8'), before);
  assert.throws(() => review(f,draft,[]), {code:'MISSING_REVIEW_CHECK'});
  deliver(f, plan.draft, {end:25});
  const result = review(f, draft, [quote(draft, draft.ref, '自由市场在信息透明时降低成本')]);
  assert.equal(result.tier, 'metadata'); assert.equal(result.checks[0].ref, draft.ref);
  assert.equal(Object.keys(f.job.review_evidence).length, 0);
});

test('navigation requires evidence from both actual endpoints and preserves draft dependencies', t => {
  const f = fixture(t), target = f.stage({id:'b', title:'信息服务的固定成本'});
  const draft = f.stage({action:'link', link:{target:'b',type:'contrast',basis:'navigation',note:'把竞争前提与信息服务成本放在一起比较。'}});
  const plan = buildConstructionReview(f.root, f.job, draft);
  assert.equal(plan.tier,'navigation'); assert.equal(plan.required_sources.length,0);
  assert.match(plan.instructions[0], /导航关系不是已证实/);
  assert.equal(plan.required_cards[1].ref,'01-Cards/b.md');assert.equal(plan.required_cards[1].prefer_baseline,true);
  deliver(f, plan.draft); deliver(f, plan.required_cards[1].alternatives[0]);
  const a = quote(draft, draft.ref, '信息透明时降低成本'), b = quote(draft, target.ref, '信息服务有固定成本');
  assert.throws(() => review(f, draft, [a]), {code:'MISSING_REVIEW_CHECK'});
  const result = review(f,draft,[a,b]);
  assert.deepEqual(result.dependencies, [{id:'b',ref:target.ref,revision:target.revision,draft:true}]);
  f.stage({id:'b', title:'再次修订的信息服务'});
  assert.throws(() => review(f, draft, [a,b]), {code:'STALE_EVIDENCE'});
});

test('a bad target draft does not block navigation supported by the unchanged formal target', t => {
  const f=fixture(t);
  const result=new HarnessGateway(f.root).stageUnoKnowledge({task:'job-b0',key:'bad-b',action:'patch',id:'b',
    revision:unoRevision(f.root,'01-Cards/b.md'),body:'草稿独有的新断言。',boundary:''});
  assert.equal(result.staged,false);
  const draft=f.stage({action:'link',link:{target:'b',type:'contrast',basis:'navigation',note:'比较信息服务成本与透明条件。'}});
  const plan=buildConstructionReview(f.root,f.job,draft), target=plan.required_cards[1];
  assert.equal(target.draft,false);assert.equal(target.alternatives.length,1);
  deliver(f,plan.draft);deliver(f,target,{evidence:true});
  const checks=[quote(draft,draft.ref,'信息透明时降低成本'),quote(draft,target.ref,'信息服务有固定成本')];
  const approved=review(f,draft,checks);
  assert.deepEqual(approved.dependencies,[{id:'b',ref:'01-Cards/b.md',revision:target.revision,draft:false}]);
  assert.throws(()=>review(f,draft,[checks[0],quote(draft,target.ref,'草稿独有的新断言')]),{code:'UNDELIVERED_EVIDENCE'});
  assert.throws(()=>review(f,draft,[checks[0],quote(draft,target.alternatives[0].ref,'草稿独有的新断言')]),{code:'STALE_EVIDENCE'});
});

test('source-asserted relation changes also lock the chosen endpoint version', t => {
  const f=fixture(t), targetDraft=f.stage({id:'b',title:'信息服务草稿'});
  const draft=f.stage({action:'link',link:{target:'b',type:'contrast',basis:'source',note:'主张原文给出比较，需要核对原句。'}});
  const plan=buildConstructionReview(f.root,f.job,draft);deliver(f,plan.draft);deliver(f,sourceItem(f),{evidence:true});
  const sourceCheck=quote(draft,'03-Archive/source.md','自由市场仅在信息透明时降低成本。');
  assert.equal(review(f,draft,[sourceCheck]).dependencies[0].draft,false);
  deliver(f,plan.required_cards[1].alternatives[0]);
  const selected=review(f,draft,[sourceCheck,quote(draft,targetDraft.ref,'信息服务有固定成本')]);
  assert.equal(selected.dependencies[0].draft,true);assert.equal(selected.dependencies[0].revision,targetDraft.revision);
});

test('unchanged formal endpoint stays a version dependency, even outside writable scope', t => {
  const f=fixture(t), draft=f.stage({action:'link',link:{target:'c',type:'analogy',basis:'navigation',note:'比较两个信息约束下的使用条件。'}});
  const plan=buildConstructionReview(f.root,f.job,draft);
  deliver(f,plan.draft);deliver(f,plan.required_cards[1]);
  const result=review(f,draft,[quote(draft,draft.ref,'信息透明时降低成本'),quote(draft,'01-Cards/c.md','信息服务有固定成本')]);
  assert.deepEqual(result.dependencies,[{id:'c',ref:'01-Cards/c.md',revision:unoRevision(f.root,'01-Cards/c.md'),draft:false}]);
});

test('body, summary, boundary, sources and source-asserted relations escalate despite a claimed tier', async t => {
  const cases = [
    {body:'甲作者：自由市场在信息透明时降低成本。😀\n反例：市场势力可能阻止降价。'},
    {summary:'对原结论的更强摘要'}, {boundary:'一项新的适用范围'}, {sources:['03-Archive/source.md#source-b']},
    {action:'link',link:{target:'b',type:'contrast',basis:'source',note:'主张材料已经作出明确比较。'}},
  ];
  for (const args of cases) await t.test(Object.keys(args)[0], tt => {
    const f=fixture(tt), draft=f.stage({...args, tier:'metadata'}), plan=buildConstructionReview(f.root,f.job,draft);
    assert.equal(plan.tier,'content');assert.equal(plan.required_cards[0].reading,'full');
    deliver(f,plan.draft);
    assert.throws(()=>review(f,draft,[]),{code:'MISSING_REVIEW_CHECK'});
    deliver(f,sourceItem(f),{evidence:true});
    const result=review(f,draft,[quote(draft,'03-Archive/source.md','自由市场仅在信息透明时降低成本。')]);
    assert.equal(result.checks[0].quote,'自由市\n场仅在信息透明时降低成本。');
    assert.equal(result.checks[0].match_kind,'layout-equivalent');
  });
});

test('body diff uses Unicode positions and retains complete changed span', t => {
  const f=fixture(t), draft=f.stage({body:'😀甲作者：自由市场在信息透明时降低成本。\n反例：市场势力可能阻止降价。'});
  const diff=buildConstructionReview(f.root,f.job,draft).changes.body;
  assert.deepEqual(diff.before,{start:0,end:0,text:''}); assert.deepEqual(diff.after,{start:0,end:1,text:'😀'});
});

test('merge demands both frozen originals, preserved source anchors and current merged body', t => {
  const f=fixture(t), {draft,plan,checks}=mergeReady(f);
  assert.equal(plan.tier,'merge');assert.equal(plan.baselines.length,2);
  assert.deepEqual(plan.preservation.semantic_checks,['conditions','author_attribution','counterevidence','source_anchors']);
  assert.equal(review(f,draft,checks).tier,'merge');
  delete f.job.review_evidence['01-Cards/b.md'];
  assert.throws(()=>review(f,draft,checks),{code:'STALE_EVIDENCE'});
  deliver(f,plan.baselines[1],{evidence:true,end:12});
  assert.throws(()=>review(f,draft,checks),/交付/);
});

test('merge cannot claim success with quotes only from unchanged target or without merged result', t => {
  const f=fixture(t), {draft,checks}=mergeReady(f);
  assert.throws(()=>review(f,draft,checks.filter(row=>row.ref!=='01-Cards/b.md')),{code:'MISSING_REVIEW_CHECK'});
  assert.throws(()=>review(f,draft,checks.filter(row=>row.ref!==draft.ref)),{code:'MISSING_REVIEW_CHECK'});
});

test('a corrupted staged merge that loses an original anchor cannot pass', t => {
  const f=fixture(t), {draft}=mergeReady(f);
  const {ref,revision,body,...meta}=draft;
  meta.card.sources=meta.card.sources.filter(source=>!source.endsWith('#source-b'));
  meta.source_bindings=meta.source_bindings.filter(source=>!source.ref.endsWith('#source-b'));
  writeFileSync(join(f.root,ref),unoMarkdown(meta,body));
  const current=readDraft(f.root,'job-b0','a'), plan=buildConstructionReview(f.root,f.job,current);
  assert.deepEqual(plan.preservation.missing_source_anchors,['03-Archive/source.md#source-b']);
  assert.throws(()=>review(f,current,[]),{code:'MISSING_SOURCE_ANCHOR'});
});

test('missing or stale formal baseline and merge baseline fail closed', async t => {
  for (const which of ['missing','stale','merge']) await t.test(which,tt=>{
    const f=fixture(tt), draft=which==='merge' ? mergeReady(f).draft : f.stage({title:'新标题'});
    const path=join(f.root,which==='merge'?'01-Cards/b.md':'01-Cards/a.md');
    if(which==='missing')unlinkSync(path);else writeFileSync(path,readFileSync(path,'utf8')+'\n外部新内容');
    assert.throws(()=>buildConstructionReview(f.root,f.job,draft),{code:which==='missing'?'MISSING_BASELINE':'REVISION_CONFLICT'});
  });
});

test('source versions and anchors remain protected even for a metadata-only proposal', t => {
  const f=fixture(t), draft=f.stage({title:'新标题'}), path=join(f.root,'03-Archive/source.md');
  writeFileSync(path,readFileSync(path,'utf8')+'\n来源新增内容');
  assert.throws(()=>buildConstructionReview(f.root,f.job,draft),{code:'REVISION_CONFLICT'});
});

test('author/previous session, undelivered intervals, negation edits and unrelated refs cannot satisfy checks', t => {
  const f=fixture(t), draft=f.stage({title:'新标题'}), plan=buildConstructionReview(f.root,f.job,draft);
  const check=quote(draft,draft.ref,'自由市场在信息透明时降低成本');
  deliver(f,plan.draft,{session:'old-reviewer'});
  assert.throws(()=>review(f,draft,[check]),{code:'STALE_EVIDENCE'});
  deliver(f,plan.draft,{end:3});
  assert.throws(()=>review(f,draft,[check]),{code:'UNDELIVERED_EVIDENCE'});
  deliver(f,plan.draft);
  assert.throws(()=>review(f,draft,[{...check,quote:'自由市场不在信息透明时降低成本'}]),{code:'UNDELIVERED_EVIDENCE'});
  assert.throws(()=>review(f,draft,[{...check,ref:'01-Cards/c.md'}]),{code:'INVALID_SOURCE'});
});

test('unchanged body hash alone cannot approve an unseen newer metadata revision', t => {
  const f=fixture(t), draft=f.stage({title:'新标题'}), plan=buildConstructionReview(f.root,f.job,draft);
  f.job.review_evidence[draft.ref]={revision:sha(draft.body),session_id:f.job.session_id,intervals:[[0,Array.from(draft.body).length]]};
  assert.throws(()=>review(f,draft,[quote(draft,draft.ref,'信息透明时降低成本')]),{code:'STALE_EVIDENCE'});
  deliver(f,plan.draft);
  assert.equal(review(f,draft,[quote(draft,draft.ref,'信息透明时降低成本')]).tier,'metadata');
});

test('mechanical schema migration does not hide changed semantic origin, boundary or unknown fields', t => {
  const f=fixture(t), file=join(f.root,'01-Cards/a.md'), original=parseCardFile(file);
  const legacy={...original.meta,type:'claim'}; delete legacy.schema; delete legacy.generated_by;
  writeFileSync(file,unoMarkdown(legacy,original.body));
  const draft=f.stage({title:'新标题'}), plan=buildConstructionReview(f.root,f.job,draft);
  assert.equal(plan.tier,'metadata');assert.ok(plan.mechanical_fields.includes('schema'));assert.ok(plan.mechanical_fields.includes('generated_by'));
  // Use a separate real baseline rather than mutating the helper's frozen input.
  const b=parseCardFile(join(f.root,'01-Cards/b.md'));
  writeFileSync(join(f.root,'01-Cards/b.md'),unoMarkdown({...b.meta,origin:'system'},b.body));
  const systemDraft=f.stage({id:'b',title:'系统卡改标题'});
  assert.equal(systemDraft.card.origin,'system','metadata editing must preserve the real origin');
  assert.equal(buildConstructionReview(f.root,f.job,systemDraft).tier,'metadata');
  // Simulate an anomalous persisted proposal, independently of the now-correct
  // Gateway behavior. Actual origin changes must still escalate the review.
  const {ref,revision,body,...meta}=systemDraft;
  meta.card={...meta.card,origin:'document'};
  writeFileSync(join(f.root,ref),unoMarkdown(meta,body));
  const changedOrigin=readDraft(f.root,'job-b0','b');
  const escalated=buildConstructionReview(f.root,f.job,changedOrigin);
  assert.equal(escalated.tier,'content');assert.ok(escalated.changed_fields.includes('origin'));
});

test('reported issues can defer semantic approval; helper does not manufacture a successful review', t => {
  const f=fixture(t), draft=f.stage({body:'有争议的新解释。'});
  const result=review(f,draft,[],{issues:[{id:'a',detail:'缺少作者原文，不能通过。'}]});
  assert.equal(result.tier,'content');assert.equal(result.checks.length,0);
  assert.equal(result.semantic_review,'reviewer_judgment_required');assert.equal(f.job.reviewed,undefined);
});

test('legacy construction and compile preserve the original validation contract', t => {
  const f=fixture(t), draft=f.stage({title:'新标题'});
  for(const job of [{...f.job,construction_profile:undefined},{...f.job,mode:'compile'}]) {
    assert.equal(buildConstructionReview(f.root,job,draft),null);
    assert.equal(validateConstructionReview(f.root,job,{note:'old',checks:[]},[draft]).size,0);
  }
});

test('caller-supplied tier or modified draft structure cannot replace current persisted proposal', t => {
  const f=fixture(t), draft=f.stage({body:'实际正文已经改变。'});
  assert.throws(()=>buildConstructionReview(f.root,f.job,{...draft,body:'旧正文',tier:'metadata'}),{code:'REVISION_CONFLICT'});
  f.stage({title:'第二版草稿'});
  assert.throws(()=>buildConstructionReview(f.root,f.job,draft),{code:'REVISION_CONFLICT'});
});
