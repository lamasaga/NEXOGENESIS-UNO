import { BOOK_CARD_RELATIONS } from '../../nexogenesis-tools/lib/uno/book-card-contract.js';
import { cardBodyStructureFacts } from '../../nexogenesis-tools/lib/harness/knowledge-quality.js';

export const ROUTINE_REVIEW_GOVERNANCE = 'routine-review-governance-v2';

const DOMAIN_JUDGMENT = /\bdomains?\b|领域/iu;
const ENUM_ALLEGATION = /关系类型不合法|不在允许(?:的)?枚举|不是允许(?:的)?关系类型/iu;
const ENUM_DEPENDENT = /合法类型|允许(?:的)?关系类型|允许枚举/iu;
const SOURCE_BINDING = /来源不在本任务图书范围内|必须引用\s*1[–-]128\s*个本任务原文区间/iu;
const SKELETON_ALLEGATION = /正文骨架|四段式|Markdown|标题|小节|骨架层级/iu;
const MARKDOWN_HIERARCHY_ALLEGATION = /(?:独立|额外|多余|新增|夹入|保留)[^。！？；]{0,24}(?:小节|标题|分类层|骨架层级)|(?:小节|标题|分类层|骨架层级)[^。！？；]{0,24}(?:独立|额外|多余|新增|夹入)/iu;
const AFFIRMATIVE_RELATION = /^(?:该)?关系(?:已经|已)?成立[：:，。；\s]/iu;
const ACTIONABLE_RELATION_DEFECT = /但|不过|然而|仍|尚|不成立|错误|缺少|需要|需|应(?:改|删|补|反转)|删除|移除|改为|反转/iu;

const relationTypesFor = (cards, issue) => {
  const card=cards.get(issue.id),targets=new Set(issue.related_card_ids??[]);
  return (card?.relations??[]).filter(relation=>targets.has(relation.target)).map(relation=>relation.type);
};

function removeFalseEnumClaim(issue,cards){
  if(issue.kind!=='relation'||!ENUM_ALLEGATION.test(issue.message))return {issue,changes:[]};
  const types=relationTypesFor(cards,issue);
  if(!types.length||types.some(type=>!BOOK_CARD_RELATIONS.includes(type)))return {issue,changes:[]};
  const sentences=String(issue.message).split(/(?<=[。！？；])/u).map(row=>row.trim()).filter(Boolean);
  const kept=sentences.filter(sentence=>!ENUM_ALLEGATION.test(sentence)&&!ENUM_DEPENDENT.test(sentence));
  if(!kept.length)return {issue:null,changes:[`discarded-false-relation-enum:${issue.id}`]};
  return {issue:{...issue,message:kept.join('')},changes:[`removed-false-relation-enum:${issue.id}`]};
}

function removeFalseHeadingClaim(issue,cards){
  if(issue.kind!=='card'||!SKELETON_ALLEGATION.test(issue.message)||!MARKDOWN_HIERARCHY_ALLEGATION.test(issue.message))return {issue,changes:[]};
  const card=cards.get(issue.id),facts=cardBodyStructureFacts(card?.type,card?.body);
  if(!card||!facts.exact)return {issue,changes:[]};
  return {issue:null,changes:[`discarded-false-markdown-hierarchy:${issue.id}`]};
}

function removeAffirmativeRelationResult(issue){
  if(issue.kind!=='relation'||!AFFIRMATIVE_RELATION.test(issue.message)||ACTIONABLE_RELATION_DEFECT.test(issue.message))return {issue,changes:[]};
  return {issue:null,changes:[`discarded-affirmative-relation-result:${issue.id}`]};
}

/** Routine model review does not govern domain fit or host-bound source refs. */
export function governRoutineReviewIssues(issues,cardsInput){
  const cards=cardsInput instanceof Map?cardsInput:new Map((cardsInput??[]).map(card=>[card.id,card]));
  const accepted=[],changes=[];
  for(const original of issues??[]){
    if(original.kind==='card'&&DOMAIN_JUDGMENT.test(original.message)){
      changes.push(`discarded-domain-fit:${original.id}`);continue;
    }
    if(original.kind==='card'&&SOURCE_BINDING.test(original.message)){
      changes.push(`discarded-host-source:${original.id}`);continue;
    }
    const headingGoverned=removeFalseHeadingClaim(original,cards);changes.push(...headingGoverned.changes);
    if(!headingGoverned.issue)continue;
    const affirmativeGoverned=removeAffirmativeRelationResult(headingGoverned.issue);changes.push(...affirmativeGoverned.changes);
    if(!affirmativeGoverned.issue)continue;
    const governed=removeFalseEnumClaim(affirmativeGoverned.issue,cards);changes.push(...governed.changes);
    if(governed.issue)accepted.push(governed.issue);
  }
  return {issues:accepted,changes};
}

export function bindCurrentUnitSources(cards,unitRef,referenceIds=[]){
  const oldIds=new Set(referenceIds),changes=[];
  const result=(cards??[]).map(card=>{
    if(oldIds.has(card.id)){
      const sources=Array.isArray(card.sources)?card.sources.filter(source=>source&&typeof source.ref==='string'):[];
      if(sources.some(source=>source.ref===unitRef))return card;
      changes.push(`added-current-source:${card.id}`);return {...card,sources:[...sources,{ref:unitRef}]};
    }
    const exact=Array.isArray(card.sources)&&card.sources.length===1&&card.sources[0]?.ref===unitRef;
    if(exact)return card;
    changes.push(`bound-current-source:${card.id}`);return {...card,sources:[{ref:unitRef}]};
  });
  return {cards:result,changes};
}
