import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCurrentUnitSources, governRoutineReviewIssues } from '../packages/nexogenesis-web-host/lib/compile-review-governance.js';

const cards=[
  {id:'case-card',domains:[],sources:[],relations:[{target:'claim-card',type:'example',note:'实例',basis:'source'}]},
  {id:'claim-card',domains:[],sources:[{ref:'old.md'}],relations:[]},
];

test('routine governance retains concrete admission and book-outline relation findings',()=>{
 const issues=[
  {id:'case-card',kind:'card',related_card_ids:[],message:'正文仅列各章主题，没有独立知识对象；不能用改名、更换 type 或补空话修复。'},
  {id:'case-card',kind:'relation',related_card_ids:['claim-card'],message:'supplement 仅以“本卡展开大纲第十章”为由，两端没有具体知识补充关系，应删除此关系。'}
 ];
 const result=governRoutineReviewIssues(issues,cards);
 assert.deepEqual(result.issues,issues);assert.deepEqual(result.changes,[]);
});

test('routine review discards domain-fit governance and false illegal-enum findings',()=>{
  const result=governRoutineReviewIssues([
    {id:'case-card',kind:'card',related_card_ids:[],message:'domain 与正文长期问题空间不匹配，应更换领域。'},
    {id:'case-card',kind:'relation',related_card_ids:['claim-card'],message:'关系类型不合法：example不是允许的关系类型。若保留此语义，应改用合法类型或删除。'},
  ],cards);
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(result.changes,['discarded-domain-fit:case-card','discarded-false-relation-enum:case-card']);
});

test('routine review keeps an independent direction finding after removing a false enum sentence',()=>{
  const result=governRoutineReviewIssues([
    {id:'case-card',kind:'relation',related_card_ids:['claim-card'],message:'关系类型不合法：example不是允许的关系类型。关系方向与两端内容相反，应删除反向重复关系。'},
  ],cards);
  assert.equal(result.issues.length,1);
  assert.equal(result.issues[0].message,'关系方向与两端内容相反，应删除反向重复关系。');
});

test('routine review discards a claimed extra heading that the Markdown tree proves does not exist',()=>{
  const claim={id:'claim-with-four-sections',type:'claim',body:'## 一句话主张\n权利与责任相互约束。\n\n## 依据\n责任必须受到规制。责任可按容斥原理表述，实例只用于说明。\n\n## 已知限制\n具体制度仍需分别核对。\n\n## 原文摘录\n材料明确并列讨论权利与责任。',domains:[],sources:[],relations:[]};
  const falseIssue={id:claim.id,kind:'card',related_card_ids:[],message:'正文骨架仍不符合 claim 的四段式要求：“## 依据”下继续保留“责任必须受到规制”“责任按容斥原理表述”等独立小节式要点，使四段之间夹入额外分类层。'};
  const result=governRoutineReviewIssues([falseIssue],[claim]);
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(result.changes,['discarded-false-markdown-hierarchy:claim-with-four-sections']);
});

test('routine review retains content findings and real extra Markdown headings',()=>{
  const base={id:'claim-card',type:'claim',body:'## 一句话主张\n结论。\n\n## 依据\n理由。\n\n## 已知限制\n边界。\n\n## 原文摘录\n引文。',domains:[],sources:[],relations:[]};
  const contentIssue={id:base.id,kind:'card',related_card_ids:[],message:'“依据”把互相冲突的理由并列为同一结论，需删除无法支持主张的一项。'};
  assert.deepEqual(governRoutineReviewIssues([contentIssue],[base]).issues,[contentIssue]);
  const extra={...base,body:base.body+'\n\n### 额外分类层\n不应存在。'};
  const hierarchyIssue={id:base.id,kind:'card',related_card_ids:[],message:'正文夹入了额外分类层，应移除该小节。'};
  assert.deepEqual(governRoutineReviewIssues([hierarchyIssue],[extra]).issues,[hierarchyIssue]);
});

test('a positive relation verdict cannot become a blocking issue',()=>{
  const affirmative={id:'case-card',kind:'relation',related_card_ids:['claim-card'],message:'关系成立：案例确实是该主张的具体实例，可以保留 example 关系。'};
  const actionable={id:'case-card',kind:'relation',related_card_ids:['claim-card'],message:'关系成立，但 note 仍把案例写成普遍机制，需要改写为具体实例。'};
  const result=governRoutineReviewIssues([affirmative,actionable],cards);
  assert.deepEqual(result.issues,[actionable]);
  assert.deepEqual(result.changes,['discarded-affirmative-relation-result:case-card']);
});

test('host binds a new card to the actual unit while preserving old-card provenance',()=>{
  const result=bindCurrentUnitSources(cards,'current.md',['claim-card']);
  assert.deepEqual(result.cards[0].sources,[{ref:'current.md'}]);
  assert.deepEqual(result.cards[1].sources,[{ref:'old.md'},{ref:'current.md'}]);
});
