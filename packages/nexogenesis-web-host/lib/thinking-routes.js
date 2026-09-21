import { selectPassages } from '../../nexogenesis-tools/lib/runtime/text-edits.js';
import { listDomainsV2 } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { scanCards } from "../../nexogenesis-tools/lib/cards.js";
import { HttpError } from "./rpc.js";
import { searchKnowledge, resolveCardTarget } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { displayType } from '../../nexogenesis-tools/lib/uno-contract.js';

// Each route changes evidence selection, as well as the short answer guidance.
export const THINKING_ROUTES = {
  explain: {
    label: "解释原因", preferred_types: ["mechanism", "model"],
    relations: ["supplement", "specialization", "example", "boundary", "background", "based-on", "influences"],
    guidance: "解释现象如何产生，比较相关机制和替代解释，说明成立条件。相关、先后和关系连线不自动证明因果。",
  },
  compare: {
    label: "比较选项", preferred_types: ["method", "model", "case"],
    relations: ["contrast", "challenge", "boundary", "conflicts-with"],
    guidance: "在共同标准下比较双方的收益、代价和适用条件，保留资料不对称。有明确目标才作条件化推荐；没有资料的一方不得编造。",
  },
  challenge: {
    label: "检验主张", preferred_types: ["conflict", "claim"],
    relations: ["contrast", "challenge", "boundary", "conflicts-with"],
    guidance: "先准确理解主张与依据，再检查最强挑战、隐含假设和适用范围。候选反例未必真的反驳主张；没搜到反例不代表没有反例。",
  },
  analogize: {
    label: "寻找类比", preferred_types: ["case", "mechanism", "model"],
    relations: ["analogy", "example", "application", "example-of"],
    guidance: "寻找机制、激励或过程可对应的案例，解释对应点和不能对应的条件。表面相似不是有效类比，只迁移有依据的启发。",
  },
  trace: {
    label: "追溯变化", preferred_types: ["case", "phenomenon", "entity"],
    relations: ["background", "precedes", "influences"],
    guidance: "按实际事件时间整理阶段与转折，区分发表时间、发生时间和因果。没有明确日期的材料保留未知，不用卡片更新时间代替事件日期。",
  },
  synthesize: {
    label: "综合判断", preferred_types: ["claim", "method", "model"],
    relations: ["boundary", "contrast", "background", "related", "conflicts-with"],
    guidance: "围绕用户目标综合事实、解释和约束，直接回答，给出最影响结论的条件与缺口。区分来源事实和本次推断，不硬套行动计划或完整报告。",
  },
};

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stop = new Set("为什么 为何 怎么 如何 怎样 什么 是否 一个 一种 这个 那个 哪个 哪种 一定 必然 可以 应该 没有 进行 问题 比较 对比 区别 还是 有何 以及 对于 通过 因为 所以 the and what why how does this that from with which versus".split(" "));
function terms(value) {
  return [...new Set([...segmenter.segment(String(value).toLowerCase())]
    .filter(p => p.isWordLike && p.segment.length > 0 && !stop.has(p.segment)).map(p => p.segment))].slice(0, 40);
}
const list = value => Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
const RELATIONS = new Set(["specialization", "supplement", "challenge", "example", "application", "related", "contrast", "analogy", "boundary", "background", "supports", "extends", "based-on", "example-of", "conflicts-with", "involves", "part-of", "applies-to", "influences", "precedes", "characterizes", "attributed-to"]);
const sort = (a, b) => b.score - a.score || a.id.localeCompare(b.id);

/** One cached Markdown snapshot; bounded local selection, no model or knowledge writes. */
function collectCardContext(root, query, route = "synthesize") {
  if (!Object.hasOwn(THINKING_ROUTES, route)) throw new HttpError(400, "请选择有效的思考路线。");
  const definition = THINKING_ROUTES[route], tokens = terms(query);
  const { cards } = scanCards(root);
  const searchable = new Map();
  for (const [id, card] of cards) {
    if (!card.body?.trim() || card.meta.type === "domain") continue;
    searchable.set(id, { card, title: String(card.meta.title ?? id).toLowerCase(),
      type: displayType(card.meta).toLowerCase(), domains:list(card.meta.domains).map(t=>t.toLowerCase()),
      body: card.body.toLowerCase() });
  }
  const rank = (words) => [...searchable].map(([id, c]) => {
    let score = 0;
    for (const word of words) score += (c.title.includes(word) ? 5 : 0)
      + (c.type.includes(word) ? 3 : 0) + (c.domains.some(t => t.includes(word)) ? 2 : 0) + (c.body.includes(word) ? 1 : 0);
    return { id, score };
  }).filter(c => c.score > 0).sort(sort);
  const direct = rank(tokens);
  for(const item of searchKnowledge(root,{query:tokens.join(' '),kind:'card',limit:12}).items){
    if(!tokens.length||!searchable.has(item.id))continue;
    const existing=direct.find(c=>c.id===item.id);if(existing)existing.score+=item.score;else direct.push({id:item.id,score:item.score});
  }
  direct.sort(sort);
  if (!direct.length) return [];
  const selected = new Map(), links = new Map();
  const add = (candidate, purpose) => {
    if (!candidate || selected.size >= 9) return;
    const item = selected.get(candidate.id) ?? { id: candidate.id, purposes: [] };
    if (!item.purposes.includes(purpose)) item.purposes.push(purpose);
    selected.set(item.id, item);
  };
  // Comparison must give each explicit subject its own retrieval opportunity.
  if (route === "compare") {
    const parts = query.split(/\n/u)[0].split(/(?:\s+vs\.?\s+|\s+versus\s+|还是|相比|与|和)/iu).slice(0, 2);
    if (parts.length === 2) for (const part of parts) add(rank(terms(part))[0], "比较对象");
    for (const c of direct.filter(c => query.toLowerCase().includes(searchable.get(c.id).title)).slice(0, 2)) add(c, "明确提到的对象");
  }
  for (const c of direct.slice(0, 3)) add(c, "直接相关");
  const seedIds = new Set([...selected.keys(), ...direct.slice(0, 4).map(c => c.id)]);
  const neighbors = new Map();
  // Read both directions for discovery, but preserve original direction and meaning.
  for (const [from, item] of searchable) for (const original of Array.isArray(item.card.meta.relations) ? item.card.meta.relations : []) {
    const relation=original&&{...original,target:resolveCardTarget(root,original.target)??original.target};
    if (!relation || !RELATIONS.has(relation.type) || !searchable.has(relation.target)
      || from === relation.target || typeof relation.note !== "string" || !relation.note.trim()) continue;
    const id = seedIds.has(from) ? relation.target : seedIds.has(relation.target) ? from : null;
    if (!id) continue;
    const link = { from, to: relation.target, type: relation.type, reason: relation.note.slice(0, 240), basis: relation.basis ?? (relation.origin==='navigation'?'navigation':'source'), role: relation.origin==='navigation'||relation.basis==='navigation' ? "模型整理的阅读导航，不是原作者论证或已验证推断" : "来源联系的检索线索，尚需结合正文判断" };
    if (!links.has(id)) links.set(id, []);
    if (links.get(id).length < 2) links.get(id).push(link);
    const priority = definition.relations.includes(relation.type);
    const score = (priority ? 20 : 1) + (direct.find(c => c.id === id)?.score ?? 0) * 0.1;
    if (score > (neighbors.get(id)?.score ?? -1)) neighbors.set(id, { id, score, priority });
  }
  for (const c of [...neighbors.values()].filter(c => c.priority).sort(sort).slice(0, 3)) add(c, "路线所需的关系线索");
  const focused = direct.map(c => ({ ...c, score: c.score + (definition.preferred_types.includes(searchable.get(c.id).type) ? 4 : 0) })).sort(sort);
  for (const c of focused.slice(0, 7)) add(c, "路线相关资料");
  for (const c of [...neighbors.values()].sort(sort).slice(0, 3)) add(c, "邻近资料");
  const result = [];
  let remaining = 16500;
  for (const item of selected.values()) {
    const { card } = searchable.get(item.id), body = card.body.trim();
    const sources = list(card.meta.sources);
    const boundary=String(card.meta.boundary??body.match(/(?:^|\n)#{1,4}\s*(?:边界[^\n]*|适用[^\n]*|限制[^\n]*)\n+([\s\S]*?)(?=\n#{1,4} |$)/)?.[1]??'');
    const packet = { ...item, title: String(card.meta.title ?? item.id).slice(0, 160), kind: "read",
      type:displayType(card.meta), domains:list(card.meta.domains).slice(0,3),
      summary: card.meta.summary, quality_notes: card.meta.quality_notes, ...selectPassages(body,tokens,1800),
      boundary: boundary.slice(0,800), boundary_truncated: boundary.length>800,
      sources: sources.slice(0, 4).map(s => s.slice(0, 300)),
      sources_truncated: sources.length > 4 || sources.some(s => s.length > 300),
      links: links.get(item.id) ?? [] };
    const size = JSON.stringify(packet).length;
    if (size > remaining) continue;
    remaining -= size; result.push(packet);
  }
  return result;
}

export function collectThinkingContext(root,query,route='synthesize') {
  const cards=collectCardContext(root,query,route);
  const found=searchKnowledge(root,{query,kind:'buffer',limit:4});
  let remaining=22000-JSON.stringify(cards).length;
  for(const item of found.items){const packet={id:'buffer:'+item.ref+':'+item.offset,title:item.title+' · '+item.locator,kind:'read',type:'source',domains:[],purposes:['Buffer 稀疏检索'],text:item.text,truncated:true,sources:[item.source+'；'+item.locator],links:[],buffer_ref:item.ref,offset:item.offset};const size=JSON.stringify(packet).length;if(size>remaining)break;remaining-=size;cards.push(packet);}
  const domains=listDomainsV2(root),chosenIds=new Set(cards.map(c=>c.id));
  const relevant=domains.filter(d=>[...scanCards(root).cards].some(([id,c])=>chosenIds.has(id)&&(c.meta.domains??[]).includes(d.id))).slice(0,2);
  for(const d of relevant){const packet={id:'domain:'+d.id,title:d.title,kind:'read',type:'domain',domains:[d.id],purposes:['领域背景与边界'],text:[d.summary,d.body.slice(0,600)].filter(Boolean).join('\n'),truncated:d.body.length>600,sources:[d.ref],links:(d.relations??[]).map(r=>({from:'domain:'+d.id,to:'domain:'+r.target,type:r.type,reason:r.note}))};const size=JSON.stringify(packet).length;if(size<=remaining){remaining-=size;cards.push(packet);}}
  return cards;
}
