import test from 'node:test';
import assert from 'node:assert/strict';
import { relationEvidenceIssues } from '../packages/nexogenesis-tools/lib/uno/compile-reference-scope.js';
import { canIsolateFailure } from '../packages/nexogenesis-tools/lib/uno/compile-isolation.js';
import { classifyCompileFailure } from '../packages/nexogenesis-web-host/lib/compile-recovery.js';

test('only complete candidates or complete references grant new relation authority',()=>{
 const relation={target:'target',type:'supplement',note:'依据',basis:'source'},card={id:'focus',relations:[relation]};
 assert.equal(relationEvidenceIssues([card],[{id:'target',delivery:'summary'}]).length,1);
 assert.deepEqual(relationEvidenceIssues([card,{id:'target'}],[]),[]);
 assert.deepEqual(relationEvidenceIssues([card],[{id:'target',delivery:'full'}]),[]);
 assert.deepEqual(relationEvidenceIssues([card],[{id:'focus',delivery:'full',relations:[relation]}]),[]);
 assert.equal(relationEvidenceIssues([{...card,relations:[{...relation,note:'改变原意'}]}],[{id:'focus',delivery:'full',relations:[relation]}]).length,1);
});

test('missing evidence and state conflicts never become blanket automatic quarantine or blind retry',()=>{
 for(const code of ['UNDELIVERED_EVIDENCE','REVISION_CONFLICT','STALE_EVIDENCE','CARD_RETIRED']){
  assert.equal(canIsolateFailure({code}),false);assert.equal(classifyCompileFailure({code}).retryable,false);
 }
 for(const code of ['UNO_PROVIDER_BUDGET','TASK_STOPPED','MODEL_CONTENT_REJECTED'])assert.equal(canIsolateFailure({code}),false);
});
