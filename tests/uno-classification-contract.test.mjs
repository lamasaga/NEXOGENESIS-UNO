import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_CLASSIFICATION_CONTRACT, CARD_TYPES, CARD_TYPE_PRECEDENCE, LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT, cardTypesForClassificationContract, classificationContractForJob, classificationWorkflowSummary, validateCardClassification, classificationInstructions, classificationReviewInstructions } from '../packages/nexogenesis-tools/lib/uno/card-classification.js';
import { auditCardBodyStructure } from '../packages/nexogenesis-tools/lib/harness/knowledge-quality.js';
import { buildUnitRequest } from '../packages/nexogenesis-web-host/lib/unit-card-request.js';
import { TYPES } from '../packages/nexogenesis-tools/lib/uno/knowledge.js';

const catalog=[
 {id:'finance',title:'金融',summary:'金融制度与资源配置',parents:[]},
 {id:'venture-capital',title:'风险投资',summary:'风险投资契约与组织',parents:['finance']},
 {id:'corporate-governance',title:'公司治理',summary:'控制、监督与激励',parents:[]}
];
const job={compile_profile:'unit-cards-v3',workflow:'uno-unit-compile-v3',card_classification:CARD_CLASSIFICATION_CONTRACT,domain_catalog:catalog,model_selection:{provider:'test',model:'test'},notes:'保留条件'};
const unit={ref:'unit.md',body:'完整原文。',meta:{title:'章节',locator:'第1章'}};
const body='## 起点与条件\n存在可核对的制度条件。\n\n## 传导链条\n条件改变激励，激励改变行为。\n\n## 结果\n结果在限定范围内出现。\n\n## 失效边界\n条件不成立时不作推广。\n\n## 来源与证据边界\n只依据本单元。';
const card={id:'a',title:'制度激励机制',type:'mechanism',domains:['venture-capital'],body,summary:'制度条件经激励改变行为。',sources:[{ref:'unit.md'}],relations:[]};

test('classification contract accepts one type and specific existing domains',()=>{
 assert.deepEqual(CARD_TYPES,['conflict','entity','case','concept','method','mechanism','model','claim','phenomenon','undetermined']);
  assert.equal(CARD_TYPE_PRECEDENCE,CARD_TYPES);
  assert.deepEqual(TYPES.map(row=>row.id),CARD_TYPES);
 assert.deepEqual(validateCardClassification(card,catalog),{type:'mechanism',domains:['venture-capital'],issues:[]});
 assert.deepEqual(validateCardClassification({...card,domains:[]},catalog).issues,[]);
 assert.deepEqual(validateCardClassification({...card,type:'undetermined'},catalog).issues,[]);
});

test('task classification helpers preserve legacy tasks and describe the current strict order',()=>{
 assert.equal(classificationContractForJob({}),LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT);
 assert.equal(classificationContractForJob({card_classification:CARD_CLASSIFICATION_CONTRACT}),CARD_CLASSIFICATION_CONTRACT);
 assert.throws(()=>classificationContractForJob({card_classification:'unknown-v9'}),/未知卡片分类契约/);
 assert.throws(()=>cardTypesForClassificationContract('unknown-v9'),/未知卡片分类契约/);
 assert.doesNotMatch(classificationWorkflowSummary(LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT),/undetermined/);
 assert.match(classificationWorkflowSummary(CARD_CLASSIFICATION_CONTRACT),/conflict 争议 → entity 实体 → case 案例/);
 assert.match(classificationWorkflowSummary(CARD_CLASSIFICATION_CONTRACT),/phenomenon 必须有可观察对象与依据/);
});

test('undetermined has a complete reusable-unit body contract instead of an empty fallback',()=>{
 const undeterminedBody='## 知识对象\n本卡保存某项政策任务组合。\n\n## 核心内容\n记录任务的对象、范围与时间安排。\n\n## 依据\n依据来源中的正式任务表述。\n\n## 限制与边界\n这是计划而非已发生结果。\n\n## 来源与证据边界\n只证明文件如此安排，不证明已执行或有效。';
 assert.deepEqual(auditCardBodyStructure('undetermined',undeterminedBody),[]);
 assert.ok(auditCardBodyStructure('undetermined','## 核心内容\n只有一段。').some(issue=>issue.includes('知识对象')));
});

test('classification contract rejects invented, duplicate, excessive and parent-child domains',()=>{
 assert.ok(validateCardClassification({...card,type:['mechanism'],domains:['venture-capital']},catalog).issues.some(x=>x.code==='INVALID_TYPE'));
 assert.ok(validateCardClassification({...card,domains:['unknown']},catalog).issues.some(x=>x.code==='INVALID_DOMAIN'));
 assert.ok(validateCardClassification({...card,domains:['venture-capital','venture-capital']},catalog).issues.some(x=>x.code==='DUPLICATE_DOMAIN'));
 assert.ok(validateCardClassification({...card,domains:['finance','venture-capital']},catalog).issues.some(x=>x.code==='REDUNDANT_DOMAIN'));
 assert.ok(validateCardClassification({...card,domains:['a','b','c','d']},[...catalog,...['a','b','c','d'].map(id=>({id,parents:[]}))]).issues.some(x=>x.code==='TOO_MANY_DOMAINS'));
 assert.ok(validateCardClassification({...card,domains:['x'.repeat(101)]},catalog).issues.some(x=>x.code==='INVALID_DOMAINS'));
});

test('generation, review, repair and verify prompts carry explanations and examples without broad repair context',()=>{
 const generation=buildUnitRequest(job,unit,[],'generate');
 for(const phrase of ['【分类字段只有两个】','【必须依次执行的判定顺序】','conflict（争议）','method（方法）','mechanism（机制）','model（模型）','undetermined（未定）','正确示例：','错误示例：','完整卡片写法示例','undetermined: ## 知识对象'])assert.match(generation.system,new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 const review=buildUnitRequest(job,unit,[],'check',{supplied_cards:[card],relation_targets:[],review_scope:{kind:'cards',card_ids:['a']}});
 for(const phrase of ['【审核如何判定】','conflict → entity → case → concept → method → mechanism → model → claim → phenomenon → undetermined','不得用 phenomenon 收纳','正确审核示例：','错误审核示例：','domains 为空不是错误','undetermined: ## 知识对象'])assert.ok(review.system.includes(phrase));
 const diagnosis=buildUnitRequest(job,unit,[],'check',{supplied_cards:[card],relation_targets:[],review_scope:{kind:'relations',card_ids:['a']},repair_diagnosis:{contract:'isolated-repair-diagnosis-v1',status:'pending',card_id:'a',kind:'relation',original_issues:[],user_notes:''}});
 assert.ok(diagnosis.system.includes('不证明关系已经写入'));
 assert.ok(diagnosis.system.includes('必须输出“新增关系”的可执行问题'));
 const repair=buildUnitRequest(job,unit,[],'repair',{supplied_card:card,issues:['type 与正文骨架不符']});
 const verify=buildUnitRequest(job,unit,[],'verify',{supplied_card:card,issues:['type 与正文骨架不符']});
 for(const request of [repair,verify]){
  assert.equal(request.unit_context.source_chars,0);
  assert.ok(request.system.includes('正确示例：'));assert.ok(request.system.includes('错误示例：'));
  const context=JSON.parse(request.messages[0].content[0].text.split('\n').slice(1).join('\n'));
  assert.deepEqual(Object.keys(context).sort(),['issues','phase','supplied_card']);
 }
 assert.ok(repair.system.includes('局部返工示例：正确'));
 assert.ok(repair.system.includes('错误——顺便增加领域'));
 assert.ok(verify.system.includes('局部复核示例：正确'));
 assert.ok(verify.system.includes('错误——在没有原文'));
});

test('an empty frozen domain catalog never teaches the model to copy invented domain IDs',()=>{
 const request=buildUnitRequest({...job,domain_catalog:[]},unit,[],'generate');
 assert.ok(request.system.includes('当前知识库尚未建立领域目录'));
 assert.ok(request.system.includes('{"type":"mechanism","domains":[]}'));
 for(const invented of ['state-governance','venture-capital','corporate-governance','institutional-change'])assert.ok(!request.system.includes(invented));
});

test('an in-flight v3 job without a frozen classification field keeps the prior nine-type contract',()=>{
 const legacy=buildUnitRequest({...job,card_classification:undefined},unit,[],'generate');
 const legacyGuide=classificationInstructions(catalog,LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT);
 assert.ok(legacy.system.includes('concept/claim/mechanism/model/method/phenomenon/case/entity/conflict'));
 assert.ok(!legacy.system.includes('undetermined'));
 assert.ok(!legacy.system.includes('【必须依次执行的判定顺序】'));
 assert.ok(!legacyGuide.includes('undetermined'));
 assert.ok(validateCardClassification({...card,type:'undetermined'},catalog,cardTypesForClassificationContract(LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT)).issues.some(issue=>issue.code==='INVALID_TYPE'));
});

test('standalone documentation text and review text expose the same current field rules',()=>{
 const author=classificationInstructions(catalog),review=classificationReviewInstructions(catalog);
 for(const text of [author,review]){
  assert.ok(text.includes('type：单值'));assert.ok(text.includes('domains'));assert.ok(text.includes('不得用书名、作者、章节名'));
 }
 const empty=classificationInstructions([]);
 assert.ok(empty.includes('{"type":"mechanism","domains":[]}'));
 assert.ok(!empty.includes('state-governance'));
 assert.ok(!empty.includes('venture-capital'));
});
