import {prepareSourceFixture} from './fixtures/uno-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { unoMarkdown,readUnoUnit,sha } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { runConstructionTool,batchTask,constructionSnapshot } from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { readCompileJob,saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { loadCards } from '../packages/nexogenesis-tools/lib/cards.js';
import { initializeProviderBudget,getProviderBudget } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';
import { finalizeConstructionBatch } from '../packages/nexogenesis-web-host/lib/construction-host.js';
import { bindWorkflowBudget,requestBoundedRepair,handoffAtAuthorBudget } from '../packages/nexogenesis-web-host/lib/uno-orchestration.js';
import { resumeUnfinishedBatch } from '../packages/nexogenesis-tools/lib/uno/recovery.js';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'uno-bounded-review-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'00-Inbox'));const body='作者将工资调整视为一种可能机制。\n\n本案例只有12个观察值，不能推出普遍规律。';
  writeFileSync(join(root,'00-Inbox/chapter.md'),body);
  const gateway=new HarnessGateway(root),prepared={fingerprint:sha(body),material_kind:'book',classification_reason:'明确章节',chapters:[{title:'样例章',locator:'第1章',text:body}],assets:[],warnings:[],format:'md'};
  const material=prepareSourceFixture(root,{source:'00-Inbox/chapter.md',prepared}),ref=material.units[0].ref;
  const job={id:'bounded-review',status:'running',workflow:'uno-compile-v3',orchestration_profile:'bounded-workflow-v1',mode:'construct',phase:'read',role:'author',
    session_id:'author',sessions:['author'],batches:[['a']],batch_index:0,calls:[],budget:{calls:20},sources:[material],touched:[],receipts:[],outcomes:{},issues:[],reviewed:{},requirements:{preferences:{delivery:'auto'}}};
  saveCompileJob(root,job);initializeProviderBudget(root,job.id,{limit:20});bindWorkflowBudget(root,job);
  const tool=(name,args={})=>runConstructionTool(root,job,name,args);
  const draft=(id='a')=>tool('compile_edit',{operation_id:'create-'+id,id,title:'样例中工资调整的限定',summary:'作者提出可能机制而非普遍定律。',body:'作者将工资调整视为一种可能机制。本案例只有12个观察值，不能推出普遍规律。',boundary:'仅用于样例，不能外推。',type:'mechanism',domains:[],sources:[ref]});
  const enterReview=()=>{job.handoff_requested=false;job.phase='organize';job.role='reviewer';job.session_id='reviewer';job.sessions.push('reviewer');saveCompileJob(root,job);bindWorkflowBudget(root,job);};
  const checks=id=>[{id,claim:'不能将样例推广为普遍规律',ref,quote:'本案例只有12个观察值，不能推出普遍规律。'}];
  const review=id=>tool('compile_review',{ids:[id],material_refs:[ref],note:'核对作者身份、观察数量、限定与本章去向。',checks:checks(id)});
  return {root,body,job,ref,tool,draft,enterReview,checks,review};
}

test('new workflow last source settlement and final review hand off without extra finish calls',t=>{
  const f=fixture(t);f.tool('compile_read_material',{ref:f.ref});f.draft();
  f.tool('compile_read_card',{id:'a'});const settled=f.tool('compile_finish',{phase:'organize',summary:'机制和限制已有承载'});
  assert.equal(settled.end_turn,true);assert.equal(f.job.handoff_requested,true);f.enterReview();
  f.tool('compile_read_card',{id:'a'});f.tool('compile_read_material',{ref:f.ref});const result=f.review('a');
  assert.equal(result.end_turn,true);assert.equal(f.job.finish_requested,true);assert.equal(f.job.reviewed.a.checks[0].source_revision,sha(f.body));
  finalizeConstructionBatch(f.root,f.job);assert.equal(loadCards(f.root).size,1);assert.equal(f.job.completed_batches[0].pending,0);
});

test('generic approval, invented quotes and unread matching locations cannot pass',t=>{
  const f=fixture(t);f.draft();f.enterReview();f.tool('compile_read_card',{id:'a'});
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'全部通过'}),/checks/);
  f.tool('compile_read_material',{ref:f.ref,limit:5});
  const before=readFileSync(join(f.root,'.nexogenesis/uno-jobs/bounded-review.json'),'utf8');
  assert.throws(()=>f.review('a'),/实际交付/);
  assert.equal(readFileSync(join(f.root,'.nexogenesis/uno-jobs/bounded-review.json'),'utf8'),before);
  f.tool('compile_read_material',{ref:f.ref});
  assert.throws(()=>f.tool('compile_review',{ids:['a'],note:'核对',checks:[{...f.checks('a')[0],quote:'这是根本不存在的原句'}]}),/实际交付/);
  assert.equal(f.job.reviewed.a,undefined);
});

test('source changes after reading invalidate quotations before any approval is saved',t=>{
  const f=fixture(t);f.draft();f.enterReview();f.tool('compile_read_card',{id:'a'});f.tool('compile_read_material',{ref:f.ref});
  const unit=readUnoUnit(f.root,f.ref);writeFileSync(join(f.root,unit.physical_ref),unoMarkdown(unit.meta,f.body+'\n新条件。'));
  assert.throws(()=>f.review('a'),/版本已变化/);assert.equal(f.job.reviewed.a,undefined);
});

test('reviewer cannot rewrite and objections may be recorded without false supporting quotations',t=>{
  const f=fixture(t);f.draft();f.enterReview();f.tool('compile_read_card',{id:'a'});
  assert.throws(()=>f.tool('compile_edit',{operation_id:'reviewer-edit',action:'patch',id:'a',summary:'偷偷修订'}),/只核验/);
  f.tool('compile_review',{ids:['a'],note:'摘要过度外推，交回作者',issues:[{id:'a',detail:'摘要应保留作者身份'}]});
  assert.equal(f.job.reviewed.a.issues.length,1);assert.equal(loadCards(f.root).size,0);
});

test('only one automatic repair is allowed and its scope excludes already approved objects',t=>{
  const f=fixture(t);f.draft('a');f.draft('b');f.enterReview();f.job.finish_requested=true;
  f.job.reviewed={a:{revision:readDraft(f.root,batchTask(f.job),'a').revision,issues:['限定遗漏']},b:{revision:readDraft(f.root,batchTask(f.job),'b').revision,issues:[]}};
  assert.equal(requestBoundedRepair(f.root,f.job),true);assert.deepEqual(f.job.repair_ids,['a']);
  assert.throws(()=>f.tool('compile_edit',{id:'b',operation_id:'outside-repair',action:'patch',summary:'不该改'}),/只处理审核/);
  f.job.role='reviewer';f.job.finish_requested=true;assert.equal(requestBoundedRepair(f.root,f.job),false);
});

test('budget boundary can send saved drafts to review but never mark missing source outcomes complete',t=>{
  const f=fixture(t);f.draft();const used=getProviderBudget(f.root,f.job.id).used;
  assert.equal(handoffAtAuthorBudget(f.root,f.job,{code:'UNO_STAGE_BUDGET'}),true);
  assert.equal(f.job.outcomes[f.ref],undefined);
  assert.equal(getProviderBudget(f.root,f.job.id).used,used);assert.equal(f.job.handoff_requested,true);
  f.job.pause_requested=true;assert.equal(handoffAtAuthorBudget(f.root,f.job,{code:'UNO_STAGE_BUDGET'}),false);
});

test('failed reviewed draft resumes with an author, never a read-only reviewer repair loop',t=>{
  const f=fixture(t);f.draft();f.enterReview();f.tool('compile_read_card',{id:'a'});
  f.tool('compile_review',{ids:['a'],note:'有内容错误',issues:[{id:'a',detail:'遗漏适用条件'}]});
  f.job.outcomes[f.ref]={status:'source_only',reason:'样例',card_ids:[],content_revision:sha(f.body),batch:0};
  finalizeConstructionBatch(f.root,f.job);assert.equal(resumeUnfinishedBatch(f.root,f.job),true);
  assert.equal(f.job.role,'author');assert.deepEqual(f.job.repair_ids,['a']);assert.equal(f.job.needs_fresh_context,true);
});


test('task status uses the same provider ledger even when native steps include rejected attempts',t=>{
  const f=fixture(t);f.job.calls=[{status:'failed'},{status:'cancelled'}];
  const current=constructionSnapshot(f.root,f.job);
  assert.equal(current.remaining_calls,20);assert.equal(current.request_budget.used,0);
  assert.equal(f.tool('compile_checkpoint',{note:'仅保存进度'}).remaining_calls,20);
  assert.match(current.token_usage_note,/外发前预留账本/);
  delete f.job.orchestration_profile;
  assert.equal(constructionSnapshot(f.root,f.job).remaining_calls,18,'Historical profile retains its existing counter');
});
