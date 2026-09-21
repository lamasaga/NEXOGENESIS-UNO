import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConstructionControls,validateConstructionControls,constructionGoal} from '../packages/nexogenesis-tools/lib/construction-controls.js';
import {HarnessGateway} from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import {unoMarkdown,unoRevision} from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import {saveCompileJob,readCompileJob} from '../packages/nexogenesis-tools/lib/uno/state.js';
import {runConstructionTool} from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import {readDraft} from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import {loadCards} from '../packages/nexogenesis-tools/lib/cards.js';
import {writeDomainFixture} from './fixtures/domain.mjs';
import {planConstruction} from '../packages/nexogenesis-tools/lib/uno/construction-plan.js';
import {readPreferences,savePreferences,freezePreferences} from '../packages/nexogenesis-tools/lib/uno/preferences.js';
import {stageToolNames} from '../packages/nexogenesis-tools/lib/uno/prompt-orchestration.js';

function fixture(t,primary='connections'){
  const root=mkdtempSync(join(tmpdir(),'uno-controls-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'01-Cards'));mkdirSync(join(root,'03-Archive'));
  writeFileSync(join(root,'03-Archive/source.md'),unoMarkdown({title:'合成来源'},'信息透明时竞争影响价格。'));
  for(const id of ['a','b','outside'])writeFileSync(join(root,'01-Cards',id+'.md'),unoMarkdown({id,title:'信息条件 '+id,summary:'条件说明',type:'claim',domains:[],boundary:'信息透明时',sources:['03-Archive/source.md'],relations:[],lifecycle:'active',origin:'document'},'信息透明时竞争影响价格。'));
  writeDomainFixture(root,'economics','经济机制');
  const controls=defaultConstructionControls(primary),job={id:'job',mode:'construct',workflow:'uno-compile-v3',construction_profile:'direction-driven-v1',construction_controls:controls,orchestration_profile:'bounded-workflow-v1',status:'running',role:'author',session_id:'author',scope:['a','b'],batches:[['a','b']],batch_index:0,receipts:[],touched:[],reviewed:{},issues:[],calls:[],budget:{calls:20},requirements:{preferences:{delivery:'auto'}}};
  saveCompileJob(root,job);const gateway=new HarnessGateway(root);let n=0;
  const stage=(args={})=>gateway.stageUnoKnowledge({task:'job-b0',key:'stage-'+(++n),id:'a',action:'patch',revision:readDraft(root,'job-b0','a')?.revision??unoRevision(root,'01-Cards/a.md'),...args});
  return {root,job,gateway,stage,save:()=>saveCompileJob(root,job)};
}
test('new contract rejects unsupported operations and ambiguous primary focus',()=>{
  assert.throws(()=>validateConstructionControls({...defaultConstructionControls(),allowed:['domain_split']}),/尚不支持/);
  assert.throws(()=>validateConstructionControls({...defaultConstructionControls('domains'),primary:'cards'}),/主要侧重/);
  assert.ok(constructionGoal(defaultConstructionControls('connections')).includes('联系'));
});
test('relationship-only permission is enforced inside Gateway even without the model tool wrapper',t=>{
  const f=fixture(t),before=readFileSync(join(f.root,'01-Cards/a.md'));
  assert.throws(()=>f.stage({body:'未经授权改写正文'}),/card_edit/);
  assert.throws(()=>f.stage({domains:['economics']}),/domain_assign/);
  assert.throws(()=>f.stage({id:'outside',revision:unoRevision(f.root,'01-Cards/outside.md'),title:'越界'}),/冻结范围/);
  f.stage({action:'link',link:{target:'b',type:'contrast',basis:'navigation',note:'比较信息条件'}});
  assert.equal(readDraft(f.root,'job-b0','a').body,loadCards(f.root).get('a').body);
  assert.deepEqual(readFileSync(join(f.root,'01-Cards/a.md')),before);
});
test('add, update and remove relations are distinct permissions',t=>{
  const f=fixture(t);f.job.construction_controls.allowed=['relation_add'];f.save();
  const link={target:'b',type:'contrast',basis:'navigation',note:'比较信息条件'};
  f.stage({action:'link',link});
  assert.throws(()=>f.stage({action:'link',link:{...link,note:'改写用途'}}),/relation_update/);
  assert.throws(()=>f.stage({action:'unlink',link}),/relation_remove/);
});
test('diagnosis provides no edit tool and Gateway rejects all staging including no-op',t=>{
  const f=fixture(t);f.job.construction_controls.allowed=[];f.save();
  assert.equal(stageToolNames(f.job).has('compile_edit'),false);
  assert.throws(()=>f.stage({}),/只诊断/);
});
test('published drafts are checked against frozen permissions again',t=>{
  const f=fixture(t,'cards');f.stage({body:'信息透明时竞争影响价格。保留独立条件。'});const draft=readDraft(f.root,'job-b0','a');
  f.job.construction_controls.allowed=['relation_add'];f.save();
  assert.throws(()=>f.gateway.publishUnoKnowledge({task:'job-b0',key:'publish',ids:['a'],reviews:{a:{revision:draft.revision,issues:[]}}}),/修订卡片/);
});
test('relationship-only publication preserves exact body without adding a boundary section',t=>{
  const f=fixture(t),before=loadCards(f.root).get('a').body;
  f.stage({action:'link',link:{target:'b',type:'contrast',basis:'navigation',note:'比较信息条件'}});
  const d=readDraft(f.root,'job-b0','a');
  f.gateway.publishUnoKnowledge({task:'job-b0',key:'relation-publish',ids:['a'],reviews:{a:{revision:d.revision,issues:[]}}});
  assert.equal(loadCards(f.root).get('a').body,before);
  assert.equal(loadCards(f.root).get('a').meta.relations.length,1);
});
test('domain-only drafts use independent governance and preserve body, history and publication receipt',t=>{
  const f=fixture(t,'domains'),before=loadCards(f.root).get('a').body;
  f.stage({domains:['economics']});const d=readDraft(f.root,'job-b0','a'),reviews={a:{revision:d.revision,issues:[]}};
  assert.throws(()=>f.gateway.publishUnoKnowledge({task:'job-b0',key:'wrong-path',ids:['a'],reviews}),/独立领域/);
  const receipt=f.gateway.publishUnoDomainAssignments({task:'job-b0',key:'domain-publish',ids:['a'],reviews});
  assert.equal(f.gateway.publishUnoDomainAssignments({task:'job-b0',key:'domain-publish',ids:['a'],reviews}).idempotent,true);
  assert.throws(()=>f.gateway.publishUnoDomainAssignments({task:'job-b0',key:'domain-publish',ids:['b'],reviews}),/不能更改/);
  assert.deepEqual(loadCards(f.root).get('a').meta.domains,['economics']);assert.equal(loadCards(f.root).get('a').body,before);
  assert.equal(readDraft(f.root,'job-b0','a').state,'published');assert.equal(receipt.publication.cards[0].draft_revision,d.revision);
  assert.equal(readFileSync(join(f.root,'03-Archive/card-history/a',d.base_revision+'.md'),'utf8').includes('信息透明'),true);
});
test('domain definition changes and stopped tasks reject governance without changing cards',t=>{
  const f=fixture(t,'domains');f.stage({domains:['economics']});const d=readDraft(f.root,'job-b0','a'),reviews={a:{revision:d.revision,issues:[]}};
  writeDomainFixture(f.root,'economics','新的领域边界');
  assert.throws(()=>f.gateway.publishUnoDomainAssignments({task:'job-b0',key:'domain-stale',ids:['a'],reviews}),/定义已变化/);
  f.job.status='paused';f.save();assert.throws(()=>f.gateway.publishUnoDomainAssignments({task:'job-b0',key:'domain-stop',ids:['a'],reviews}),/不能提交/);
  assert.deepEqual(loadCards(f.root).get('a').meta.domains,[]);
});
test('domain and content changes cannot be mixed in either order',t=>{
  const f=fixture(t,'comprehensive');f.stage({domains:['economics']});
  assert.throws(()=>f.stage({body:'改正文'}),/独立治理/);
  const g=fixture(t,'comprehensive');g.stage({body:'改正文'});assert.throws(()=>g.stage({domains:['economics']}),/独立治理/);
});
test('author must read current domain definition before staging through the model tool',t=>{
  const f=fixture(t,'domains');runConstructionTool(f.root,f.job,'compile_read_card',{id:'a'});
  const args={operation_id:'assign',action:'patch',id:'a',revision:unoRevision(f.root,'01-Cards/a.md'),domains:['economics']};
  assert.throws(()=>runConstructionTool(f.root,f.job,'compile_edit',args),/完整读取当前领域/);
  runConstructionTool(f.root,f.job,'compile_task',{view:'domains',id:'economics'});
  assert.equal(runConstructionTool(f.root,f.job,'compile_edit',args).staged,true);
});
test('controls participate in cache identity and broad focus yields bounded candidates',t=>{
  const f=fixture(t);const notes=constructionGoal(f.job.construction_controls);
  const a=planConstruction(f.root,{notes,requirements:{construction_controls:f.job.construction_controls}});
  const b=planConstruction(f.root,{notes,requirements:{construction_controls:{...f.job.construction_controls,allowed:[]}}});
  assert.notEqual(a.goal_key,b.goal_key);assert.ok(a.packages.length);assert.ok(a.packages.flatMap(p=>p.card_ids).length<=24);
});
test('long-term purpose and defaults persist but a frozen task remains independent',async t=>{
  const f=fixture(t);const saved=savePreferences(f.root,{...readPreferences(f.root),purpose:'比较产业政策',construction:defaultConstructionControls('domains')});
  const snapshot=await freezePreferences(f.root,{notes:'本次只看关系'},'unknown',f.root);
  savePreferences(f.root,{...saved,purpose:'研究其他问题',construction:defaultConstructionControls('cards')});
  assert.match(snapshot.long_term,/比较产业政策/);assert.equal(snapshot.preferences.construction.primary,'domains');
  assert.equal(readCompileJob(f.root,'job').construction_controls.primary,'connections');
});
