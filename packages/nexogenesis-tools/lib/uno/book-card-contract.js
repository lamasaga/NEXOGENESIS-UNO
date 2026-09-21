// Shared by model instructions and the write validator, not an alternative workflow.
import { CARD_CLASSIFICATION_CONTRACT, MAX_CARD_DOMAINS, cardTypesForClassificationContract, classificationInstructions } from './card-classification.js';
export const BOOK_CARD_LIMITS = Object.freeze({cards:100,title:400,body:120000,summary:4000,domains:MAX_CARD_DOMAINS,domain:100,relations:64,relationNote:3000,sources:128});
export const LEGACY_BOOK_CARD_LIMITS = Object.freeze({...BOOK_CARD_LIMITS,tags:64,tag:200});
export const BOOK_CARD_LABELS = Object.freeze(['概念','观点','机制','模型','方法','现象','案例','实体']); // v2 read/resume only
export const BOOK_CARD_RELATIONS = Object.freeze(['specialization','supplement','contrast','challenge','analogy','example','application']);
export function legacyBookCardRequirements(){
 const n=LEGACY_BOOK_CARD_LIMITS;
 return '程序验收上限：每次最多 '+n.cards+' 张；title 为非空单行且不超过 '+n.title+' 字符；body 非空且最多 '+n.body+' Unicode 字符；summary 如提供须非空且最多 '+n.summary+' 字符。tags 必填、最多 '+n.tags+' 项、每项非空且最多 '+n.tag+' 字符，至少包含 '+BOOK_CARD_LABELS.join('/')+' 之一。sources 必填 1–'+n.sources+' 个真实来源。relations 最多 '+n.relations+' 项，type 只能为 '+BOOK_CARD_RELATIONS.join('/')+'，note 必填且最多 '+n.relationNote+' 字符。不得自连或重复 id，不得凭空引用未提供的目标。';
}
export function bookCardRequirements(catalog=[],classificationContract=CARD_CLASSIFICATION_CONTRACT){
 const n=BOOK_CARD_LIMITS;
 const types=cardTypesForClassificationContract(classificationContract);
 return '程序验收上限：每次最多 '+n.cards+' 张；title 为非空单行且不超过 '+n.title+' 字符；body 非空且最多 '+n.body+' Unicode 字符；summary 如提供须非空且最多 '+n.summary+' 字符。type 必填且只能为 '+types.join('/')+'；domains 必须是数组，只能从本次领域目录选择，最多 '+n.domains+' 项，允许空数组。新卡不得输出 tags 或 topics。sources 必填 1–'+n.sources+' 个真实来源。relations 最多 '+n.relations+' 项，type 只能为 '+BOOK_CARD_RELATIONS.join('/')+'，note 必填且最多 '+n.relationNote+' 字符。不得自连或重复 id，不得凭空引用未提供的目标。\n'+classificationInstructions(catalog,classificationContract);
}
