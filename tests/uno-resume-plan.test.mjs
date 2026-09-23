import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_WORKFLOW } from '../packages/nexogenesis-tools/lib/uno/book-agent.js';
import { CONSTRUCTION_WORKFLOW } from '../packages/nexogenesis-tools/lib/uno/construction-workflow.js';
import { armResumeGuard, computeResumePlan, resumeStateFingerprint, settleResumeGuard } from '../packages/nexogenesis-web-host/lib/resume-plan.js';

const book = overrides => ({id:'book',mode:'compile',workflow:BOOK_WORKFLOW,status:'paused',phase:'read',book_units:[{ref:'u1',title:'第一单元',chars:20}],book_outcomes:{},book_focus_refs:['u1'],unit_work:{u1:{phase:'generate',source_revision:'r1'}},sources:[],failures:[],calls:[],receipts:[],...overrides});

test('legacy summary-evidence stop gets a bounded isolation path even after a prior no-progress retry',()=>{
 const job=book({compile_isolation:'compile-isolation-v1',last_failure:{code:'UNDELIVERED_EVIDENCE',retryable:true},
   unit_work:{u1:{phase:'check',references:[{id:'target',delivery:'summary'}],cards:[{id:'candidate',relations:[{target:'target'}]}]}}});
 armResumeGuard(job,computeResumePlan(null,job));settleResumeGuard(job);
 const before=JSON.stringify(job),plan=computeResumePlan(null,job);
 assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'保留问题并继续编译');assert.equal(JSON.stringify(job),before);
 const unavailable=computeResumePlan(null,book({last_failure:{code:'UNDELIVERED_EVIDENCE',retryable:true}}));
 assert.equal(unavailable.kind,'decision');assert.deepEqual(unavailable.actions.map(a=>a.id),['defer-unit']);
});

test('settled main line offers an explicit single deferred retry instead of a generic resume',()=>{
 const job=book({status:'partial',phase:'done',book_focus_refs:['u2'],book_units:[{ref:'u1',title:'延期章节'},{ref:'u2',title:'留池章节'}],
   book_outcomes:{u1:{status:'deferred'},u2:{status:'quarantined'}},unit_work:{u1:{phase:'deferred'},u2:{phase:'quarantined'}}});
 const plan=computeResumePlan(null,job);assert.equal(plan.kind,'decision');assert.deepEqual(plan.actions.map(a=>a.id),['retry-deferred-unit']);
 assert.match(plan.actions[0].label,/延期章节/);
});

test('content rejection has an explicit defer decision for both current and legacy checkpoints without mutation',()=>{
  for(const failure of [{code:'MODEL_CONTENT_REJECTED',message:'内容审核拦截',retryable:false},
    {code:'UNIT_COMPILE_STOPPED',message:'400 The request was rejected because it was considered high risk',retryable:true}]){
    const job=book({last_failure:failure}),before=JSON.stringify(job),plan=computeResumePlan(null,job);
    assert.equal(plan.kind,'decision');assert.match(plan.reason,/供应商的内容安全审核/);
    assert.deepEqual(plan.actions.map(item=>item.id),['defer-unit']);assert.equal(plan.primary,undefined);
    assert.equal(JSON.stringify(job),before);
  }
});

test('legacy missing-note checkpoint offers retained review only for recoverable nonempty candidates',()=>{
 const make = response => book({last_failure:{code:'UNIT_COMPILE_STOPPED',message:'旧制卡错误',retryable:false},unit_work:{u1:{phase:'generate',last_response:{phase:'generate',text:JSON.stringify(response)}}}});
 const input={cards:[{id:'safe',title:'知识对象',body:'完整正文'}]},job=make(input),before=JSON.stringify(job);
 const plan=computeResumePlan(null,job);assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'审核已保留候选并继续');assert.equal(JSON.stringify(job),before);
 for(const response of [{cards:[]},{cards:[{id:'safe'}]},{cards:[...input.cards,...input.cards]},{cards:input.cards,note:'已有说明'},{cards:input.cards,note:{}}])assert.equal(computeResumePlan(null,make(response)).kind,'decision');
 for(const code of ['CARD_RETIRED','REVISION_CONFLICT','UNIT_CARD_REPAIR_EXHAUSTED'])assert.notEqual(computeResumePlan(null,{...job,last_failure:{code,retryable:false}}).kind,'resume');
 assert.notEqual(computeResumePlan(null,{...job,workflow:'uno-unit-compile-v2'}).kind,'resume');
 assert.notEqual(computeResumePlan(null,{...job,book_outcomes:{u1:{status:'deferred'}}}).kind,'resume');
 armResumeGuard(job,plan);settleResumeGuard(job);assert.notEqual(computeResumePlan(null,job).kind,'resume');
});

test('resume plan distinguishes transport retry, semantic decision, domain review and completed range',()=>{
  const empty=computeResumePlan(null,book({last_failure:{code:'MODEL_EMPTY_RESPONSE',message:'空正文',retryable:true}}));
  assert.equal(empty.kind,'resume');assert.equal(empty.primary.label,'重新请求当前单元');
  const semantic=computeResumePlan(null,book({last_failure:{code:'UNIT_CARD_REPAIR_EXHAUSTED',message:'修订耗尽',retryable:false},
    compile_isolation:'compile-isolation-v1',unit_work:{u1:{phase:'check',cards:[{id:'c1'}],pending_issues:{c1:['仍未通过']},repair_counts:{c1:{card:2}}}}}));
  assert.equal(semantic.kind,'resume');assert.equal(semantic.primary.id,'resume');assert.equal(semantic.primary.label,'保留问题并继续编译');
  const review=computeResumePlan(null,book({status:'review',phase:'domain_review'}));assert.equal(review.kind,'review');
  const done=computeResumePlan(null,book({status:'partial',phase:'done',book_outcomes:{u1:{status:'processed'}},sources:[{incomplete:true}]}));
  assert.equal(done.kind,'blocked');assert.match(done.reason,/缺失正文|未提取正文/);
});

test('isolated repair refreshes changed relation evidence instead of offering a blind retry',()=>{
  const plan=computeResumePlan(null,book({operation:'isolated-card-repair',last_failure:{code:'UNDELIVERED_EVIDENCE',message:'新增或改变关系前须读回目标卡当前完整正文：target',retryable:true}}));
  assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'读取最新目标卡并继续');
  assert.match(plan.reason,/最新完整正文/);assert.doesNotMatch(plan.reason,/重试当前检查点/);
});

test('resume plan blocks construction conflicts while allowing a real paused checkpoint',()=>{
  const base={id:'construct',mode:'construct',workflow:CONSTRUCTION_WORKFLOW,status:'paused',phase:'read',batch_index:0,batches:[['a']],calls:[],receipts:[],failures:[]};
  assert.equal(computeResumePlan(null,base).kind,'resume');
  const blocked=computeResumePlan(null,{...base,scope_conflicts:[{id:'a',code:'CARD_RETIRED'}]});
  assert.equal(blocked.kind,'blocked');assert.match(blocked.reason,/版本冲突|退役/);
});

test('a retained construction relation repair resumes at preflight and verification without regenerating prior stages',()=>{
  const focus='focus',target='target',job={id:'construct-repair',mode:'construct',workflow:'uno-construction-v1',status:'failed',phase:'repairing',
    batch_index:1,batches:[[focus,target],[focus,target]],calls:[],receipts:[],failures:[],scope_conflicts:[],
    last_error:{code:'CONSTRUCTION_DECISION_PREFLIGHT',message:`${focus}：移除或改写关系前，关系另一端也必须属于策略已选择范围。`},
    construction_plan:{packages:[{card_ids:[focus,target]},{card_ids:[focus,target]}]},direct_work:{1:{
      review:{reviews:[{id:focus,decision:'reject',note:'方向反了',issues:['修正方向']},{id:target,decision:'approve',note:'只读',issues:[]}]},
      repair:{decisions:[{id:focus,status:'proposed',note:'方向已修正',changes:{relations:[{target,type:'supplement',note:'本卡补充目标卡',basis:'navigation'}]},evidence:[]}],note:'局部修复'}
    }}};
  const plan=computeResumePlan(null,job);
  assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'应用已保存修复并复核');assert.match(plan.primary.effect,/不重新调用作者/);
  job.direct_work[1].repair_staged=true;
  assert.equal(computeResumePlan(null,job).kind,'blocked');
});

test('unsent construction context overflow can rebuild the checkpoint once',()=>{
  const job={id:'construct-context',mode:'construct',workflow:'uno-construction-v1',status:'failed',phase:'reviewing',role:'reviewer',batch_index:0,
    batches:[['a','b']],calls:[],receipts:[],failures:[],last_error:{code:'CONSTRUCTION_CONTEXT_LIMIT',message:'建构审核上下文超过限制，未发送。'}};
  const plan=computeResumePlan(null,job);
  assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'精简当前上下文并继续');assert.match(plan.primary.effect,/尚未发送/);
  armResumeGuard(job,plan);settleResumeGuard(job);
  assert.equal(computeResumePlan(null,job).kind,'blocked');
});

test('construction response contract failure offers local format recovery instead of ending the task',()=>{
  const job={id:'construct-review-contract',mode:'construct',workflow:'uno-construction-v1',status:'failed',phase:'reviewing',role:'reviewer',batch_index:4,
    batches:[['focus','endpoint']],calls:[],receipts:[],failures:[],scope_conflicts:[],
    last_error:{code:'CONSTRUCTION_REVIEW_CONTRACT',message:'建构审核返回格式未能安全恢复。'}};
  const plan=computeResumePlan(null,job);
  assert.equal(plan.kind,'resume');assert.equal(plan.primary.label,'修复审核格式并继续');
  assert.match(plan.primary.effect,/不重新发送卡片正文/);
});

test('no-progress guard ignores bookkeeping but blocks the same ineffective checkpoint',()=>{
  const job=book({last_failure:{code:'MODEL_EMPTY_RESPONSE',message:'空正文',retryable:true}}),plan=computeResumePlan(null,job);
  const before=resumeStateFingerprint(job);armResumeGuard(job,plan);job.version=99;job.updated_at='later';job.detail='重新进入循环';
  assert.equal(resumeStateFingerprint(job),before);assert.equal(settleResumeGuard(job),true);assert.equal(job.last_resume.status,'no_progress');
  const stopped=computeResumePlan(null,job);assert.equal(stopped.kind,'decision');assert.deepEqual(stopped.actions.map(row=>row.id),['defer-unit']);
});

test('an exhausted deferred unit never falls back to generic resume at book end',()=>{
  const job=book({status:'partial',phase:'done',book_outcomes:{u1:{status:'deferred'}},book_focus_refs:[],
    compile_isolation:'compile-isolation-v1',unit_work:{u1:{phase:'deferred',cards:[{id:'c1'}],pending_issues:{c1:['仍未通过']},repair_counts:{c1:{card:2}}}}});
  const plan=computeResumePlan(null,job);
  assert.equal(plan.kind,'decision');assert.deepEqual(plan.actions.map(row=>row.id),['quarantine-candidates','discard-candidates']);assert.match(plan.reason,/建议保留到未组织池/);
});
