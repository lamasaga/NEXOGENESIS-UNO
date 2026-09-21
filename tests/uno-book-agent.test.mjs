import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serializeCard } from '../packages/nexogenesis-tools/lib/cards.js';
import { buildUnitRequest, unitReferences, parseUnitJSON, recoverGeneratedCardPrefix,
 recoverUnitJSONTrailingClosers } from '../packages/nexogenesis-web-host/lib/unit-card-request.js';
import { sameBookUnitSource } from '../packages/nexogenesis-tools/lib/uno/book-paths.js';
const job={model_selection:{provider:'test',model:'test'},notes:'保留论证与例外',compile_profile:'unit-cards-v3',workflow:'uno-unit-compile-v3',domain_catalog:[]};
const unit={ref:'unit.md',body:'字'.repeat(60000),meta:{title:'第一章',locator:'第1-30页'}};

test('admission rules reach generation, continuation and the separate supplement and gap routes',()=>{
 const source={...unit,body:'全书分为两篇十二章，依次介绍各章主题。'};
 const cases=[
  ['generate',{}],
  ['generate',{previous_truncated:true,completed_cards:[{id:'done',title:'已保留对象'}]}],
  ['supplement',{coverage_issues:['补全全书章节路线图'],existing_cards:[]}],
  ['check',{review_scope:{kind:'gap',card_ids:[]},supplied_cards:[],coverage_issues:['补全全书章节路线图']}]
 ];
 for(const [phase,context] of cases){
  const req=buildUnitRequest(job,source,[],phase,context);
  assert.match(req.system,/成卡资格先于类型/);
  assert.match(req.system,/目录、全书路线图、章节主题拼盘/);
  assert.match(req.system,/不按序言、导读、后记或附录的位置排除实质知识/);
  assert.match(req.system,/没有合适领域不构成拒绝理由/);
  assert.match(req.system,/返回 cards=\[\]/);
  assert.match(req.system,/basis=navigation 也不豁免/);
  assert.ok(req.unit_context.other_chars<60000);
  assert.equal(req.unit_context.source_chars,phase==='supplement'?0:source.body.length);
 }
 const gap=buildUnitRequest(job,source,[],'check',cases[3][1]);
 assert.match(gap.system,/不构成有效知识遗漏/);
 assert.match(gap.system,/审核只返回 checked_ids、issues、unit_issues/);
});
test('admission review and scoped repair keep their source-free and same-card contracts',()=>{
 const candidate={id:'roadmap',title:'全书路线图',type:'model',domains:[],body:'全书分两篇十二章。',sources:[{ref:'unit.md'}],relations:[]};
 const issues=['正文仅列各章主题，没有独立知识对象；不能用改名、更换 type 或补空话修复。'];
 const review=buildUnitRequest(job,unit,[],'check',{supplied_cards:[candidate],relation_targets:[],review_scope:{kind:'cards',card_ids:['roadmap']}});
 assert.match(review.system,/成卡资格也属于本卡内容检查/);
 assert.match(review.system,/不能仅凭标题/);
 assert.match(review.system,/supplied_cards 为空不构成遗漏/);
 assert.match(review.system,/message 只描述正文对象及证据/);
 assert.match(review.system,/basis=navigation 也不豁免/);
 for(const phase of ['repair','verify','relation-repair','relation-verify']){
  const req=buildUnitRequest(job,unit,[] ,phase,{supplied_card:candidate,issues,related_cards:[{...candidate,id:'topic'}]});
  assert.equal(req.unit_context.source_chars,0);assert.equal(req.messages.length,1);
  assert.ok(!JSON.stringify(req).includes(unit.body));
  if(phase.startsWith('relation-')){
   assert.match(req.system,/不扩大检查或修改范围/);
   assert.match(req.system,/basis=navigation 也不豁免/);
  }else{
   assert.match(req.system,/无法有据修复时保留原内容/);
   assert.match(req.system,/同 ID 的完整 card/);
   assert.ok(!req.system.includes('返回 cards=[]'));
  }
 }
});
test('source and other context have independent Unicode limits, not a shared 128 KB byte cap',()=>{
 const req=buildUnitRequest(job,unit,[],'generate');assert.equal(req.unit_context.source_chars,60000);assert.ok(Buffer.byteLength(JSON.stringify(req))>128000);assert.equal(req.messages.length,2);
 assert.equal(req.maxTokens,65536);assert.equal(req.reasoningEffort,'low');
 assert.throws(()=>buildUnitRequest(job,{...unit,body:unit.body+'字'},[],'generate'),/60001/);
 assert.throws(()=>buildUnitRequest({...job,notes:'字'.repeat(60000)},unit,[],'generate'),/其余上下文/);
});
test('new provider-aware jobs may use a larger frozen input and output budget',()=>{
 const expanded={...job,workflow_limits:{source_chars:90000,context_chars:90000,output_tokens:{generate:98304,check:16384}},workflow_reasoning:{generate:'low',check:'off'}};
 const large={...unit,body:'字'.repeat(90000)};
 const generated=buildUnitRequest(expanded,large,[],'generate');
 assert.equal(generated.unit_context.source_chars,90000);assert.equal(generated.maxTokens,98304);
 assert.throws(()=>buildUnitRequest(expanded,{...large,body:large.body+'字'},[],'generate'),/90001\/90000/);
 const checked=buildUnitRequest(expanded,unit,[],'check',{supplied_cards:[],relation_targets:[],review_scope:{kind:'cards',card_ids:[]}});
 assert.equal(checked.maxTokens,16384);
});
test('fixed workflow reasoning and continuation manifest do not inherit chat settings',()=>{
 const configured={...job,model_selection:{provider:'test',model:'test',reasoningEffort:'max'}};
 const generated=buildUnitRequest(configured,{...unit,body:'完整原文'},[],'generate',{previous_truncated:true,completed_cards:[{id:'done',title:'已完成',type:'model',summary:'摘要',relations:[]}]});
 const context=JSON.parse(generated.messages[0].content[0].text.split('\n').slice(1).join('\n'));
 assert.equal(generated.reasoningEffort,'low');assert.equal(generated.maxTokens,65536);assert.equal(context.completed_cards[0].id,'done');assert.match(generated.system,/只返回尚未输出的剩余卡片/);
 assert.equal(buildUnitRequest(configured,unit,[],'check',{supplied_cards:[],relation_targets:[],review_scope:{kind:'cards',card_ids:[]}}).reasoningEffort,'off');
 assert.equal(buildUnitRequest(configured,unit,[],'repair',{supplied_card:{id:'x',title:'x',body:'b'},issues:['x']}).reasoningEffort,'low');
 assert.equal(buildUnitRequest(configured,unit,[],'verify',{supplied_card:{id:'x',title:'x',body:'b'},issues:['x']}).reasoningEffort,'off');
});
test('reference pack sends three complete cards and five compact navigation rows',t=>{
 const root=mkdtempSync(join(tmpdir(),'uno-reference-pack-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'01-Cards'));
  for(let i=0;i<10;i++)writeFileSync(join(root,'01-Cards',`card-${i}.md`),serializeCard({id:`card-${i}`,title:i===9?'人口结构旧卡':`制度机制 ${i}`,type:'model',domains:[],metadata:{summary:i===9?'人口结构摘要':`制度机制摘要 ${i}`},relations:[],sources:i===9?['unit.md#char-0-10']:[],maturity:'growing',lifecycle:'active',origin:'user',created:'2026-09-18',updated:'2026-09-18',body:i===9?'## 核心思想\n\n人口结构旧卡。\n\n## 关键组件\n\n人口。\n\n## 结构关系或因果链条\n\n人口影响供给。\n\n## 失效边界\n\n仅限测试。\n\n## 来源与证据边界\n\n合成测试。':`## 核心思想\n\n制度机制 ${i} 的完整正文。\n\n## 关键组件\n\n约束与行动。\n\n## 结构关系或因果链条\n\n约束影响行动。\n\n## 失效边界\n\n仅限测试。\n\n## 来源与证据边界\n\n合成测试。`}), 'utf8');
  const refs=unitReferences(root,{ref:'unit.md',meta:{title:'制度机制'},body:'制度机制约束行动'},job);
  assert.equal(refs.length,8);assert.equal(refs.filter(card=>card.delivery==='full').length,3);assert.equal(refs.filter(card=>card.delivery==='summary').length,5);
  assert.equal(refs[0].id,'card-9','同一原文单元的旧卡必须优先于普通文本相似卡');
 assert.ok(refs.filter(card=>card.delivery==='full').every(card=>typeof card.body==='string'));assert.ok(refs.filter(card=>card.delivery==='summary').every(card=>!Object.hasOwn(card,'body')&&card.summary&&Array.isArray(card.relations)));
});

test('same book unit identity survives Archive to Buffer layout changes, but never version or part changes',()=>{
 const base='a'.repeat(64)+'/'+'b'.repeat(64)+'/units/c0001-p001.md',oldRef='03-Archive/books/'+base,newRef='05-Buffer/books/'+base;
 assert.equal(sameBookUnitSource(oldRef,newRef),true);
 assert.equal(sameBookUnitSource(oldRef,newRef.replace('p001','p002')),false);
 assert.equal(sameBookUnitSource(oldRef,newRef.replace('b'.repeat(64),'c'.repeat(64))),false);
 assert.equal(sameBookUnitSource(oldRef,newRef.replace('a'.repeat(64),'c'.repeat(64))),false);
 assert.equal(sameBookUnitSource('03-Archive/other.md','05-Buffer/other.md'),false);
});
test('truncated JSON recovery keeps only complete leading cards',()=>{
 const first={id:'first',title:'完整卡',type:'model',body:'完整正文'};
 assert.deepEqual(recoverGeneratedCardPrefix('{"cards":['+JSON.stringify(first)+',{"id":"second","title":"未完成卡","body":"正文被截'),[first]);
 assert.deepEqual(recoverGeneratedCardPrefix('{"note":"先说明","cards":['+JSON.stringify(first)+',{"id":"second"'),[first]);
 assert.deepEqual(recoverGeneratedCardPrefix('前缀 {"cards":['+JSON.stringify(first)),[]);
});
test('JSON parsing accepts fences without inventing missing cards or masking malformed output',()=>{
 assert.deepEqual(parseUnitJSON('```json\n{"cards":[]}\n```'),{cards:[]});assert.throws(()=>parseUnitJSON('{"cards":['),/已收到模型响应，但输出不符合 JSON 对象格式/);
});

test('JSON parsing recovers literal quotes inside a returned string and still rejects broader corruption',()=>{
 const response='{"cards":[],"note":"政策以"十一五"考核为背景，并保留"原话"。"}';
 assert.deepEqual(parseUnitJSON(response),{cards:[],note:'政策以"十一五"考核为背景，并保留"原话"。'});
 assert.throws(()=>parseUnitJSON('{"cards":[] "note":"缺少逗号"}'),/已收到模型响应，但输出不符合 JSON 对象格式/);
 assert.throws(()=>parseUnitJSON('{"cards":[],"note":"截断'),/已收到模型响应，但输出不符合 JSON 对象格式/);
});

test('generation JSON recovery removes only a unique suffix of unmatched closing containers',()=>{
 const expected={cards:[{id:'kept',body:'正文中的 ]} 保持原样'}],note:'完整响应'};
 const recovered=recoverUnitJSONTrailingClosers(JSON.stringify(expected)+']}');
 assert.deepEqual(recovered?.value,expected);assert.equal(recovered?.removed,']}');
 assert.equal(recovered?.contract,'unit-json-trailing-closers-v1');
 assert.equal(recoverUnitJSONTrailingClosers('{"cards":['),null);
 assert.equal(recoverUnitJSONTrailingClosers('{"cards":[]} 后续说明}'),null);
 assert.equal(recoverUnitJSONTrailingClosers('{"cards":[]} {"note":"第二个对象"}}'),null);
});

test('requests carry approved body sections and exclude transport version hashes',()=>{
 const card={id:'old',revision:'secret-version-hash',body:'完整正文',type:'model',domains:[]};
 const request=buildUnitRequest(job,unit,[card],'generate');
 const repair=buildUnitRequest(job,unit,[card],'repair',{supplied_card:card,issues:['保持边界'],relation_targets:[card]});
 assert.equal(repair.unit_context.source_chars,0);assert.ok(!JSON.stringify(repair).includes('secret-version-hash'));assert.ok(!repair.system.includes('完整正文写法示例'));
 assert.deepEqual(Object.keys(JSON.parse(repair.messages[0].content[0].text.split('\n').slice(1).join('\n'))).sort(),['issues','phase','supplied_card']);
 assert.ok(!JSON.stringify(request).includes('secret-version-hash'));
 assert.match(request.system,/model: ## 核心思想 → ## 关键组件/);
 assert.match(request.system,/完整卡片写法示例/);
 assert.equal(card.revision,'secret-version-hash');
});

test('routine card review carries candidates and relation targets without repeating source text',()=>{
 const candidate={id:'candidate',revision:'candidate-secret',title:'候选机制',type:'model',domains:[],body:'候选正文',summary:'候选摘要',sources:[{ref:'unit.md'}],relations:[{target:'target',type:'supplement',note:'补充目标',basis:'source'}]};
 const target={id:'target',revision:'target-secret',title:'目标机制',type:'model',domains:[],body:'目标正文',summary:'目标摘要',sources:[{ref:'old.md'}],relations:[]};
 const request=buildUnitRequest({...job,notes:'OLD_NOTE_SENTINEL'},unit,[target],'check',{supplied_cards:[candidate],relation_targets:[target],review_scope:{kind:'cards',card_ids:['candidate']},note:'OLD_NOTE_SENTINEL'});
 const context=JSON.parse(request.messages[0].content[0].text.split('\n').slice(1).join('\n'));
 assert.equal(request.messages.length,1);assert.equal(request.unit_context.source_chars,0);assert.equal(request.maxTokens,8192);
 assert.deepEqual(context.review_scope,{kind:'cards',card_ids:['candidate']});assert.equal(context.supplied_cards[0].id,'candidate');assert.equal(context.relation_targets[0].id,'target');
 assert.ok(!JSON.stringify(request).includes(unit.body));assert.ok(!JSON.stringify(request).includes('OLD_NOTE_SENTINEL'));assert.ok(!JSON.stringify(request).includes('candidate-secret'));assert.ok(!JSON.stringify(request).includes('target-secret'));
 assert.match(request.system,/不得声称核验来源忠实度、整章覆盖/);assert.match(request.system,/unit_issues 必须为空/);
});

