import { safeId } from '../uno-contract.js';

export const DOMAIN_RELATION_TYPES = Object.freeze({ adjacent: '邻接', contrast: '对照', bridge: '桥接' });
export const activeDomain = domain => domain && !['retired', 'archived', 'superseded'].includes(domain.lifecycle);
const text = value => typeof value === 'string' && !!value.trim();

export function validateDomainDefinition(domain) {
  if (!domain || !safeId(domain.id) || !text(domain.title)) throw new Error('领域提案需要安全 ID 和名称。');
  if (!text(domain.summary)) throw new Error('领域提案需要摘要。');
  for (const key of ['core_questions', 'includes', 'excludes']) {
    if (!Array.isArray(domain[key]) || !domain[key].length || !domain[key].every(text))
      throw new Error(`领域提案需要 ${key} 边界说明。`);
  }
}

export function validateDomainRelations(id, relations, domains, cards, previous = []) {
  if (!Array.isArray(relations)) throw new Error('领域 relations 必须是数组。');
  const seen = new Set();
  for (const relation of relations) {
    if (!relation || typeof relation !== 'object') throw new Error('领域关系格式无效。');
    const key = `${relation.type}:${relation.target}`;
    if (seen.has(key)) throw new Error('同一领域关系不可重复。');
    seen.add(key);
    // Historical entries remain readable; only new or changed relations adopt the full contract.
    if (previous.some(old => JSON.stringify(old) === JSON.stringify(relation))) continue;
    if (!Object.hasOwn(DOMAIN_RELATION_TYPES, relation.type) || relation.target === id || !activeDomain(domains.get(relation.target)))
      throw new Error('领域关系需要有效的领域端点、类型 adjacent/contrast/bridge，不能指向自身或退役领域。');
    if (relation.basis !== 'navigation') throw new Error('领域关系 basis 必须是 navigation，不能充当论证依据。');
    for (const field of ['note', 'use_when', 'limits']) if (!text(relation[field])) throw new Error(`领域关系需要 ${field}。`);
    const anchors = relation.anchor_card_ids ?? [];
    if (!Array.isArray(anchors) || anchors.length > 6 || new Set(anchors).size !== anchors.length)
      throw new Error('领域关系可选 0–6 张不重复的锚点卡。');
    for (const anchor of anchors) {
      const card = cards.get(anchor);
      if (!card || card.meta.type === 'domain' || !(card.meta.domains ?? []).some(d => d === id || d === relation.target))
        throw new Error('领域关系锚点必须是任一端领域内的有效知识卡。');
    }
  }
}
