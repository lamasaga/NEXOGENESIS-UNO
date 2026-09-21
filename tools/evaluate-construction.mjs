#!/usr/bin/env node
/** Deterministic, synthetic-fixture evaluation. This script never calls a model or a service. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { resolveCardTarget } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';
import { loadCards, traceCardSources } from '../packages/nexogenesis-tools/lib/cards.js';
import { collectThinkingContext, THINKING_ROUTES } from '../packages/nexogenesis-web-host/lib/thinking-routes.js';
import { buildQuickRequest, QUICK_THINKING_SYSTEM } from '../packages/nexogenesis-web-host/lib/quick-thinking.js';

const fixturePath=fileURLToPath(new URL('../tests/fixtures/construction-effects/cases.json',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n','utf8');
export const constructionFixtures=JSON.parse(readFileSync(fixturePath,'utf8'));

function publish(gateway,root,task,ids) {
  const reviews=Object.fromEntries(ids.map(id=>{const draft=readDraft(root,task,id);if(draft?.state!=='pending')throw Error('Fixture draft rejected: '+id+' '+JSON.stringify(draft?.errors));return [id,{revision:draft.revision,issues:[]}];}));
  return gateway.publishUnoKnowledge({task,key:task+'-publish',ids,reviews});
}
function snapshot(root,spec,sourceRefs) {
  const all=loadCards(root,{includeInactive:true}),active=loadCards(root);
  const cards=[...all].map(([id,card])=>({id,title:card.meta.title,body:card.body,body_sha256:hash(card.body),sources:card.meta.sources??[],relations:card.meta.relations??[],lifecycle:card.meta.lifecycle??'active',superseded_by:card.meta.superseded_by??null}));
  const context=collectThinkingContext(root,spec.query,spec.route);
  const request=buildQuickRequest([],spec.question,context,{provider:'evaluation-not-selected',model:'evaluation-not-selected'},spec.route);
  return {active_ids:[...active.keys()],cards,aliases:Object.fromEntries(spec.cards.map(card=>[card.id,resolveCardTarget(root,card.id)])),
    source_hashes:Object.fromEntries(Object.values(sourceRefs).map(ref=>[ref,hash(readFileSync(join(root,ref)))])),
    traces:Object.fromEntries([...active.keys()].map(id=>[id,traceCardSources(root,id,{limit:12})])),
    query:spec.query,route:spec.route,question:spec.question,context,
    request:{system:request.system,messages:request.messages,tools:request.tools,maxTokens:request.maxTokens}};
}
export function assessConstructionCase(spec,before,after,historyPreserved=true) {
  const checks=[];const check=(id,passed,detail)=>checks.push({id,passed:Boolean(passed),detail});
  const beforeCards=new Map(before.cards.map(card=>[card.id,card])),afterCards=new Map(after.cards.map(card=>[card.id,card]));
  const actualContext=new Map(after.context.map(card=>[card.id,card]));
  check('source-bytes-preserved',JSON.stringify(before.source_hashes)===JSON.stringify(after.source_hashes),'Every original synthetic source keeps its SHA-256.');
  check('source-bindings-retained',before.cards.every(card=>{
    const target=afterCards.get(after.aliases[card.id]);return target&&card.sources.every(ref=>target.sources.includes(ref));
  }),'Every original source reference remains bound to its surviving semantic object.');
  check('production-prompt-keeps-evidence-boundary',after.request.system.includes('关系只是检索线索，不能据此认定因果、反驳或类比已经成立。'),'Actual buildQuickRequest retains the relation/evidence distinction; model compliance is not inferred.');
  if(spec.id==='duplicate-merge'){
    const {canonical,retired}=spec.expected,merged=afterCards.get(canonical),old=afterCards.get(retired);
    check('duplicate-object-consolidated',after.active_ids.includes(canonical)&&!after.active_ids.includes(retired)&&old?.lifecycle==='superseded'&&after.aliases[retired]===canonical,'Only this fixture-defined duplicate object is consolidated; card count is not a general quality score.');
    check('old-body-and-history-preserved',old?.body===beforeCards.get(retired)?.body&&historyPreserved,'Retired body and exact pre-merge versions remain recoverable.');
    check('independent-observations-retained',spec.expected.required_markers.every(text=>merged?.body.includes(text)),'Both windows, observed numbers, and the alternative explanation survive the merge.');
    check('one-current-object-in-retrieval',actualContext.has(canonical)&&!actualContext.has(retired)&&before.context.some(card=>card.id===retired),'Current retrieval avoids returning two copies of this same object.');
    check('both-sources-traceable',(after.traces[canonical]?.anchors?.length??0)>=2,'Both source anchors can be resolved through the real source-tracing function.');
  }else{
    const {seed,neighbor}=spec.expected,item=actualContext.get(neighbor),links=item?.links??[];
    check('previously-unretrieved-neighbor-found',!before.context.some(card=>card.id===neighbor)&&Boolean(item),'A low lexical-match candidate enters actual route context after navigation.');
    check('independent-objects-and-content-preserved',[seed,neighbor].every(id=>after.active_ids.includes(id)&&after.aliases[id]===id&&afterCards.get(id)?.body===beforeCards.get(id)?.body),'Distinct viewpoints/cases retain their own IDs and full bodies.');
    check('navigation-not-source-proof',links.some(link=>link.from===seed&&link.to===neighbor&&link.basis==='navigation'&&link.role.includes('不是原作者论证或已验证推断')),'The retrieved link is explicitly model-organized navigation, not source-authored inference.');
    const evidenceText=JSON.stringify(after.context);
    check('qualifications-visible-to-answer',spec.expected.required_markers.every(text=>evidenceText.includes(text)),'Attribution and the decisive conditions occur in the actual delivered excerpts.');
  }
  return {passed:checks.every(item=>item.passed),checks};
}

export function evaluateConstructionCase(spec,root,{interventions=spec.interventions}={}) {
  if(existsSync(root))throw Error('Evaluation library must not already exist: '+root);
  mkdirSync(join(root,'03-Archive'),{recursive:true});const gateway=new HarnessGateway(root),sourceRefs={};
  for(const [id,body] of Object.entries(spec.sources)){const ref=`03-Archive/synthetic-${id}.md`;sourceRefs[id]=ref;writeFileSync(join(root,ref),'# 合成评测资料：非真实研究\n\n'+body+'\n','utf8');}
  const seedTask='fixture-seed';
  for(const card of spec.cards)gateway.stageUnoKnowledge({task:seedTask,key:'seed-'+card.id,...card,sources:card.sources.map(id=>sourceRefs[id])});
  publish(gateway,root,seedTask,spec.cards.map(card=>card.id));
  const originalBytes=Object.fromEntries(spec.cards.map(card=>[card.id,readFileSync(join(root,'01-Cards',card.id+'.md'))]));
  const before=snapshot(root,spec,sourceRefs),receipts=[];
  for(const [index,action] of interventions.entries()){
    const task='fixture-intervention-'+index,{merge,...input}=action;
    const staged=gateway.stageUnoKnowledge({task,key:task+'-stage',...input,revision:unoRevision(root,`01-Cards/${input.id}.md`),
      ...(merge?{merge:merge.map(id=>({id,revision:unoRevision(root,`01-Cards/${id}.md`)}))}:{})});
    receipts.push({staged,published:publish(gateway,root,task,[input.id])});
  }
  const after=snapshot(root,spec,sourceRefs);
  const historyPreserved=Object.entries(originalBytes).every(([id,bytes])=>{
    if(after.cards.find(card=>card.id===id)?.body_sha256===before.cards.find(card=>card.id===id)?.body_sha256&&after.aliases[id]===id)return true;
    const file=join(root,'03-Archive/card-history',id,hash(bytes)+'.md');return existsSync(file)&&readFileSync(file).equals(bytes);
  });
  return {id:spec.id,purpose:spec.purpose,root,intervention:interventions,
    review_mode:'Fixture-declared edits and approvals through real Harness; no autonomous model construction or semantic review tested.',
    before,after,receipts,...assessConstructionCase(spec,before,after,historyPreserved)};
}

/** Exactly two prepared requests; no network transport or credentials are included. */
export function prepareConstructionAnswerPlan(result) {
  const order=[['A','after'],['B','before']];
  return {schema:'uno-construction-answer-plan-v1',provider_requests:2,executed:false,
    controls:{same_model_required:true,same_parameters_required:true,history:[],tools:[],intent_routing:'frozen to isolate retrieval effects',batch_caveat:'Three independent cases per request save calls, but this is not three independent statistical trials.'},
    requests:order.map(([id,condition])=>({id,request:{
      system:QUICK_THINKING_SYSTEM+'\n本次是三道相互独立的合成案例。每题只能使用该题附带的材料，不混用来源或把合成例子当现实事实。按各题思考路线回答，不评价测试设计。仅输出 JSON：{"answers":[{"case_id":"...","answer":"回答正文"}]}。',
      messages:[{role:'user',content:[{type:'text',text:JSON.stringify(result.cases.map(item=>({case_id:item.id,route:THINKING_ROUTES[item[condition].route].guidance,question:item[condition].question,evidence:item[condition].context.map(({kind,...card})=>card)})))}]}],
      tools:[],maxTokens:4000}})),
    execution_note:'Root must use its existing shared request ledger and budgeted transport, freeze the same model/options, dispatch each item once with no automatic retries, and retain exact responses/usage. This file does not authorize or perform calls.'};
}

export function runConstructionEvaluation({outputRoot}) {
  const parent=resolve(outputRoot);mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'construction-effects-'));
  const cases=constructionFixtures.cases.map(spec=>evaluateConstructionCase(spec,join(directory,'libraries',spec.id)));
  const result={schema:'uno-construction-effects-v1',created_at:new Date().toISOString(),fixture_sha256:hash(readFileSync(fixturePath)),
    provenance:constructionFixtures.provenance,model_requests:0,
    claims:{deterministic_retrieval_tested:true,autonomous_construction_quality_tested:false,answer_quality_tested:false,relation_count_is_quality_metric:false},
    passed:cases.every(item=>item.passed),cases};
  writeJson(join(directory,'effects.json'),result);
  writeJson(join(directory,'answer-plan.json'),prepareConstructionAnswerPlan(result));
  writeJson(join(directory,'answer-review-private.json'),{condition_key:{A:'after',B:'before'},rubric:constructionFixtures.cases.map(spec=>({case_id:spec.id,...spec.answer_rubric})),
    instructions:'Keep this file away from the answering model. Blind-review A/B for supported claims, missing decisive conditions, author attribution, causal overstatement and real card citations; unblind only after recording judgments. Do not award quality for length, card count or link count.'});
  return {directory,result};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw Error('Use --output <temporary evaluation output directory>; no model calls are made.');
  const {directory,result}=runConstructionEvaluation({outputRoot:process.argv[index+1]});
  console.log(JSON.stringify({directory,passed:result.passed,cases:result.cases.map(item=>({id:item.id,passed:item.passed,checks:item.checks})),model_requests:0,answer_quality_tested:false},null,2));
  if(!result.passed)process.exitCode=1;
}
