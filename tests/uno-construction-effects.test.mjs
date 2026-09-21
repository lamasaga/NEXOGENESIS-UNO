import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructionFixtures, evaluateConstructionCase, prepareConstructionAnswerPlan } from '../tools/evaluate-construction.mjs';

function root(t){const directory=mkdtempSync(join(tmpdir(),'uno-effects-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return join(directory,'library');}
for(const spec of constructionFixtures.cases)test(spec.id+' preserves useful evidence through Harness and actual thinking retrieval',t=>{
  const result=evaluateConstructionCase(spec,root(t));assert.equal(result.passed,true,JSON.stringify(result.checks.filter(check=>!check.passed)));
  assert.ok(result.before.context.length>0);assert.ok(result.after.context.length>0);assert.ok(result.receipts.every(row=>row.published));
});

test('duplicate merge oracle catches lost alternative explanations despite mechanically valid publication',t=>{
  const spec=constructionFixtures.cases.find(item=>item.id==='duplicate-merge'),interventions=structuredClone(spec.interventions);
  interventions[0].body='来源甲：甲港一年内登记申请者从10人变为14人；来源乙：乙湾两年内登记申请者从8人变为11人。两地结果证明提高报酬必然吸引新供给。';
  const result=evaluateConstructionCase(spec,root(t),{interventions});
  assert.equal(result.passed,false);assert.equal(result.checks.find(item=>item.id==='independent-observations-retained').passed,false);
  assert.equal(result.checks.find(item=>item.id==='source-bytes-preserved').passed,true);
});

test('counterexample oracle catches navigation falsely labeled as source-authored proof',t=>{
  const spec=constructionFixtures.cases.find(item=>item.id==='counterexample-navigation'),interventions=structuredClone(spec.interventions);
  interventions[0].link.basis='source';const result=evaluateConstructionCase(spec,root(t),{interventions});
  assert.equal(result.passed,false);assert.equal(result.checks.find(item=>item.id==='navigation-not-source-proof').passed,false);
});

test('viewpoint oracle rejects merging different authors even when all source files survive',t=>{
  const spec=constructionFixtures.cases.find(item=>item.id==='viewpoint-conflict');
  const result=evaluateConstructionCase(spec,root(t),{interventions:[{action:'patch',id:'qinghe-view',merge:['beichen-view'],body:spec.cards.map(card=>card.body).join('\n\n')}]});
  assert.equal(result.passed,false);assert.equal(result.checks.find(item=>item.id==='independent-objects-and-content-preserved').passed,false);
  assert.equal(result.checks.find(item=>item.id==='source-bindings-retained').passed,true);
});

test('prepared answer comparison has exactly two anonymous requests and no answer key leakage',t=>{
  const spec=constructionFixtures.cases[0],result=evaluateConstructionCase(spec,root(t)),plan=prepareConstructionAnswerPlan({cases:[result]});
  assert.equal(plan.provider_requests,2);assert.equal(plan.executed,false);assert.equal(plan.requests.length,2);
  assert.equal(plan.requests[0].request.system,plan.requests[1].request.system);
  for(const item of plan.requests){assert.deepEqual(item.request.tools,[]);assert.equal(item.request.messages.length,1);assert.equal('model' in item.request,false);assert.equal('apiKey' in item.request,false);assert.doesNotMatch(JSON.stringify(item.request),/answer_rubric|required_markers|condition_key/);}
});
