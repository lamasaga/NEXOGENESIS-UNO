import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {unoMarkdown,unoRevision,readUnoReceipt,sha} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {readDraft} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {parseCardFile} from '../packages/nexogenesis-tools/lib/cards.js';
import {scheduleBatches,runConstructionTool} from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import {constructReviewPending,pendingBatches} from '../packages/nexogenesis-tools/lib/uno/recovery.js';
import {inspectConstructScope,reconcileConstructScope} from '../packages/nexogenesis-tools/lib/uno/construct-consistency.js';
import {planConstruction,recordConstructionConclusions,constructionConclusion} from '../packages/nexogenesis-tools/lib/uno/construction-plan.js';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'uno-construct-consistency-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'01-Cards'));mkdirSync(join(root,'03-Archive'));
  writeFileSync(join(root,'03-Archive/source.md'),unoMarkdown({title:'合成来源'},'对象甲与对象庚的机制相同；合并必须保留条件与边界。'));
  const ids=['a','b','c','d','e','f','g'],path=id=>join(root,'01-Cards',id+'.md');
  const meta=id=>({schema:'uno-card-v4',id,title:'合成卡'+id,summary:'包含具体条件和机制',type:'mechanism',domains:[],sources:['03-Archive/source.md'],boundary:'仅限合成条件',lifecycle:'active',relations:[]});
  for(const id of ids)writeFileSync(path(id),unoMarkdown(meta(id),'正文'+id+'：条件成立时机制才有效。'));
  const job={id:'consistency',workflow:'uno-compile-v3',mode:'construct',construct_contract:'scoped-review-v1',status:'running',phase:'read',role:'author',session_id:'author',batches:scheduleBatches(root,ids,'construct'),batch_index:0,scope:ids,receipts:[],reviewed:{},issues:[],touched:[],calls:[],budget:{calls:20},completed_batches:[]};
  const gateway=new HarnessGateway(root),task='consistency-b0',publishKey=task+':publish:merge-a-g';
  function stageMerge(){const a=runConstructionTool(root,job,'compile_read_card',{id:'a'}),g=runConstructionTool(root,job,'compile_read_card',{id:'g'});return runConstructionTool(root,job,'compile_edit',{operation_id:'merge-a-g',id:'a',action:'patch',revision:a.revision,body:'正文保留对象a与g的条件及机制。',merge:[{id:'g',revision:g.revision}]});}
  function publish(){const draft=readDraft(root,task,'a'),receipt=gateway.publishUnoKnowledge({task,key:publishKey,ids:['a'],reviews:{a:{revision:draft.revision,issues:[],note:'合成审核记录'}}});job.receipts.push(receipt);return receipt;}
  function retire(id='g',target='a',lifecycle='superseded'){const old=readFileSync(path(id),'utf8');const match=old.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);writeFileSync(path(id),unoMarkdown({...meta(id),lifecycle,...(target?{superseded_by:target}:{})},match[2]));}
  return {root,job,path,meta,gateway,task,publishKey,stageMerge,publish,retire};
}

test('seven-card cross-batch merge resolves the later retired ID only after publication; frozen scope is retained',t=>{
  const f=fixture(t);assert.deepEqual(f.job.batches,[['a','b','c','d','e','f'],['g']]);
  assert.equal(f.stageMerge().accepted,true);assert.deepEqual(inspectConstructScope(f.root,f.job,1).active_ids,['g']);
  assert.deepEqual(constructReviewPending(f.root,f.job,1).map(row=>row.id),['g']);
  const pendingRevision=readDraft(f.root,f.task,'a').revision,receipt=f.publish(),before=JSON.stringify(f.job.batches),state=reconcileConstructScope(f.root,f.job,1);
  assert.equal(receipt.publication.cards[0].draft_revision,pendingRevision);
  assert.equal(receipt.publication.retirements[0].id,'g');assert.equal(receipt.publication.retirements[0].revision,unoRevision(f.root,'01-Cards/g.md'));
  assert.deepEqual(state.active_ids,[]);assert.equal(state.resolved[0].id,'g');assert.equal(state.resolved[0].redirect,'a');assert.deepEqual(state.blocked,[]);
  assert.equal(JSON.stringify(f.job.batches),before);assert.deepEqual(constructReviewPending(f.root,f.job,1),[]);
  f.job.completed_batches=[{index:1,pending:1}];assert.deepEqual(pendingBatches(f.root,f.job),[]);
});

test('ordinary writes to superseded or archived cards fail with redirect and cannot create drafts or receipts',t=>{
  const f=fixture(t);f.retire();const before=readFileSync(f.path('g'),'utf8');
  for(const action of ['patch','write','link','unlink']){
    const key='blocked-'+action,input={task:'test',key,id:'g',action,revision:unoRevision(f.root,'01-Cards/g.md'),...(action==='patch'?{title:'不应复活'}:action==='write'?{body:'不应复活'}:{link:{target:'a',type:'supplement',note:'合成关系',basis:'navigation'}})};
    assert.throws(()=>f.gateway.stageUnoKnowledge(input),error=>error.code==='CARD_RETIRED'&&error.details.redirect==='a');assert.equal(readUnoReceipt(f.root,key),null);
  }
  assert.equal(readFileSync(f.path('g'),'utf8'),before);assert.equal(readDraft(f.root,'test','g'),null);
  f.retire('g',null,'archived');assert.throws(()=>f.gateway.stageUnoKnowledge({task:'test',key:'archived-patch',id:'g',action:'patch',revision:unoRevision(f.root,'01-Cards/g.md'),title:'不复活'}),error=>error.code==='CARD_RETIRED'&&error.details.redirect===null);
});

test('successful historical operation replay remains idempotent even if its base card was subsequently retired',t=>{
  const f=fixture(t),input={task:'old',key:'old-title',id:'g',action:'patch',revision:unoRevision(f.root,'01-Cards/g.md'),title:'旧成功草稿'};
  const first=f.gateway.stageUnoKnowledge(input);f.retire();const before=readFileSync(f.path('g'),'utf8');
  assert.deepEqual(f.gateway.stageUnoKnowledge(input),first);assert.equal(readFileSync(f.path('g'),'utf8'),before);
  assert.throws(()=>f.gateway.stageUnoKnowledge({...input,key:'new-title'}),error=>error.code==='CARD_RETIRED');
});

test('explicit restore remains a separate deliberate action for a retired card',t=>{
  const f=fixture(t),bytes=readFileSync(f.path('g')),version=sha(bytes),history=join(f.root,'03-Archive/card-history/g');mkdirSync(history,{recursive:true});writeFileSync(join(history,version+'.md'),bytes);f.retire();
  const result=f.gateway.stageUnoKnowledge({task:'restore',key:'explicit-restore',action:'restore',id:'g',version,revision:unoRevision(f.root,'01-Cards/g.md')});
  assert.equal(result.accepted,true);assert.equal(readDraft(f.root,'restore','g').card.lifecycle,'active');assert.match(readFileSync(f.path('g'),'utf8'),/lifecycle: superseded/);
});

test('ordinary edits preserve an existing system origin through staging and publication',t=>{
  const f=fixture(t);writeFileSync(f.path('a'),unoMarkdown({...f.meta('a'),origin:'system'},'明确标记为系统推断的合成卡，不能改成文献观点。'));
  const task='origin-preservation';f.gateway.stageUnoKnowledge({task,key:'origin-title',id:'a',action:'patch',revision:unoRevision(f.root,'01-Cards/a.md'),title:'更准确的合成标题'});
  const draft=readDraft(f.root,task,'a');assert.equal(draft.card.origin,'system');
  f.gateway.publishUnoKnowledge({task,key:'origin-publish',ids:['a'],reviews:{a:{revision:draft.revision,issues:[],note:'只改标题，保留系统推断身份'}}});
  assert.match(readFileSync(f.path('a'),'utf8'),/origin: system/);
});

test('failed publication or an unconfirmed external retirement does not clear later work, even with unchanged review',t=>{
  const f=fixture(t);f.stageMerge();f.retire('g','b');
  assert.throws(()=>f.publish(),error=>error.code==='REVISION_CONFLICT');assert.equal(readUnoReceipt(f.root,f.publishKey),null);
  f.job.reviewed.g={unchanged:true,revision:unoRevision(f.root,'01-Cards/g.md'),issues:[]};
  const state=inspectConstructScope(f.root,f.job,1);assert.deepEqual(state.resolved,[]);assert.equal(state.blocked[0].code,'RETIREMENT_UNCONFIRMED');
  const pending=constructReviewPending(f.root,f.job,1);assert.equal(pending[0].id,'g');assert.equal(pending[0].reviewed,false);assert.equal(pending[0].blocked,true);
});

test('source content, redirect, missing retired file and concurrent target retirement invalidate completion proof',t=>{
  const f=fixture(t);f.stageMerge();f.publish();const source=readFileSync(f.path('g'),'utf8'),target=readFileSync(f.path('a'),'utf8');
  writeFileSync(f.path('g'),source+'\n外部增加内容。');assert.equal(inspectConstructScope(f.root,f.job,1).blocked[0].code,'RETIREMENT_CHANGED');
  writeFileSync(f.path('g'),source.replace('superseded_by: a','superseded_by: b'));assert.equal(inspectConstructScope(f.root,f.job,1).blocked[0].code,'RETIREMENT_CHANGED');
  rmSync(f.path('g'));assert.equal(inspectConstructScope(f.root,f.job,1).blocked[0].code,'CARD_MISSING');writeFileSync(f.path('g'),source);
  f.retire('a','b');assert.equal(inspectConstructScope(f.root,f.job,1).blocked[0].code,'RETIREMENT_UNCONFIRMED');
  writeFileSync(f.path('a'),target);assert.equal(inspectConstructScope(f.root,f.job,1).resolved.length,1);
  rmSync(f.path('a'));assert.equal(inspectConstructScope(f.root,f.job,1).blocked[0].code,'RETIREMENT_TARGET_MISSING');
});

test('missing actual receipt cannot be replaced by a task JSON copy; task-copy loss can recover via published draft key',t=>{
  const f=fixture(t);f.stageMerge();f.publish();const actualPath=join(f.root,'.nexogenesis/uno-receipts',sha(f.publishKey)+'.json'),bytes=readFileSync(actualPath);
  f.job.receipts=[];assert.equal(inspectConstructScope(f.root,f.job,1).resolved.length,1);
  f.job.receipts=[JSON.parse(bytes)];rmSync(actualPath);assert.deepEqual(inspectConstructScope(f.root,f.job,1).resolved,[]);
  writeFileSync(actualPath,bytes);assert.equal(inspectConstructScope(f.root,f.job,1).resolved.length,1);
});

test('legacy publication receipts resolve only with published merge draft and unchanged historical base',t=>{
  const f=fixture(t);f.stageMerge();const receipt=f.publish(),actualPath=join(f.root,'.nexogenesis/uno-receipts',sha(f.publishKey)+'.json');
  delete receipt.publication;writeFileSync(actualPath,JSON.stringify(receipt));f.job.receipts=[receipt];
  const proof=inspectConstructScope(f.root,f.job,1);assert.equal(proof.resolved.length,1);assert.equal(proof.resolved[0].legacy,true);
  const history=join(f.root,'03-Archive/card-history/g',proof.resolved[0].previous_revision+'.md');writeFileSync(history,'历史损坏');
  assert.deepEqual(inspectConstructScope(f.root,f.job,1).resolved,[]);assert.equal(constructReviewPending(f.root,f.job,1)[0].blocked,true);
});

test('one publication cannot both retire and write the same ID; conflict leaves all original cards unchanged',t=>{
  const f=fixture(t);f.stageMerge();const before=readFileSync(f.path('g'),'utf8');
  f.gateway.stageUnoKnowledge({task:f.task,key:'edit-g',id:'g',action:'patch',revision:unoRevision(f.root,'01-Cards/g.md'),title:'本组另改g'});
  const reviews=Object.fromEntries(['a','g'].map(id=>[id,{revision:readDraft(f.root,f.task,id).revision,issues:[]}]));
  assert.throws(()=>f.gateway.publishUnoKnowledge({task:f.task,key:'conflicting-publish',ids:['a','g'],reviews}),error=>error.code==='MERGE_PUBLICATION_CONFLICT');
  assert.equal(readUnoReceipt(f.root,'conflicting-publish'),null);assert.equal(readFileSync(f.path('g'),'utf8'),before);
});

test('direction-driven no-change conclusions resolve only current versions and dependencies, without claiming factual verification',t=>{
  const f=fixture(t);f.job.construction_profile='direction-driven-v1';f.job.construction_plan=planConstruction(f.root,{notes:'检查适用边界',card_ids:['a']});f.job.batches=[['a']];
  runConstructionTool(f.root,f.job,'compile_read_card',{id:'a'});recordConstructionConclusions(f.root,f.job,[{id:'a',status:'unchanged',note:'当前边界说明完整，无需修订'}]);
  assert.equal(constructionConclusion(f.root,f.job,'a').source_verified,false);assert.deepEqual(constructReviewPending(f.root,f.job),[]);
  writeFileSync(join(f.root,'03-Archive/source.md'),readFileSync(join(f.root,'03-Archive/source.md'),'utf8')+'\n新增条件');
  assert.equal(constructionConclusion(f.root,f.job,'a'),null);assert.equal(constructReviewPending(f.root,f.job)[0].id,'a');
});

test('factual audits still require independent unchanged review and explicit deferral remains pending',t=>{
  const f=fixture(t);f.job.construction_profile='direction-driven-v1';f.job.construction_plan=planConstruction(f.root,{notes:'事实核验',card_ids:['a']});f.job.batches=[['a']];
  runConstructionTool(f.root,f.job,'compile_read_card',{id:'a'});recordConstructionConclusions(f.root,f.job,[{id:'a',status:'unchanged',note:'作者认为无需修改'}]);
  assert.equal(f.job.construction_plan.kind,'factual-audit');assert.equal(constructReviewPending(f.root,f.job)[0].id,'a');
  f.job.construction_plan=planConstruction(f.root,{notes:'检查边界',card_ids:['a']});recordConstructionConclusions(f.root,f.job,[{id:'a',status:'deferred',note:'尚缺明确边界证据'}]);
  const pending=constructReviewPending(f.root,f.job);assert.equal(pending[0].deferred,true);assert.equal(pending[0].reviewed,false);assert.match(pending[0].issues[0],/尚缺/);
});

test('factual recovery requires all source bindings, including an uncited source, and rejects old approvals without bindings',t=>{
  const f=fixture(t),refs=['03-Archive/source.md','03-Archive/second.md'];
  writeFileSync(join(f.root,refs[1]),unoMarkdown({title:'第二来源'},'第二来源保留了独立限定条件。'));
  writeFileSync(f.path('a'),unoMarkdown({...f.meta('a'),sources:refs},'两个来源共同限定的合成判断。'));
  f.job.construction_profile='direction-driven-v1';f.job.construction_plan=planConstruction(f.root,{notes:'事实核验',card_ids:['a']});f.job.batches=[['a']];
  const bindings=refs.map(ref=>({ref,revision:unoRevision(f.root,ref),content_revision:sha(parseCardFile(join(f.root,ref)).body)}));
  f.job.reviewed.a={unchanged:true,revision:unoRevision(f.root,'01-Cards/a.md'),session_id:'reviewer',issues:[],checks:[{ref:refs[0],source_revision:bindings[0].content_revision}],source_bindings:bindings};
  assert.deepEqual(constructReviewPending(f.root,f.job),[]);
  delete f.job.reviewed.a.source_bindings;assert.equal(constructReviewPending(f.root,f.job)[0].code,'SOURCE_REVIEW_STALE');
  f.job.reviewed.a.source_bindings=bindings;
  writeFileSync(join(f.root,refs[1]),unoMarkdown({title:'第二来源'},'第二来源撤回了限定条件。'));
  let pending=constructReviewPending(f.root,f.job);assert.equal(pending[0].code,'SOURCE_REVIEW_STALE');assert.equal(pending[0].needs_review,true);
  rmSync(join(f.root,refs[1]));pending=constructReviewPending(f.root,f.job);assert.equal(pending[0].code,'SOURCE_REVIEW_STALE');
});
