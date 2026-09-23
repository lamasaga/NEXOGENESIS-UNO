import { isDeepStrictEqual } from 'node:util';

export const RELATION_EVIDENCE_SCOPE = 'UNIT_RELATION_EVIDENCE_SCOPE';

export function relationEvidenceIssues(cards = [], references = []) {
  const full = new Map(references.filter(card => card.delivery !== 'summary').map(card => [card.id, card]));
  const delivered = new Set([...cards.map(card => card.id), ...full.keys()]);
  const normalize = relation => ({...relation, basis:relation.basis ?? 'source'});
  return cards.flatMap(card => {
    const existing = full.get(card.id)?.relations ?? [];
    const targets = [...new Set((card.relations ?? []).filter(relation => !delivered.has(relation.target)
      && !existing.some(old => isDeepStrictEqual(normalize(old), normalize(relation)))).map(relation => relation.target))];
    return targets.length ? [{code:RELATION_EVIDENCE_SCOPE, card_id:card.id, target_ids:targets,
      message:`关系目标未完整交付，不能依据摘要或未提供的正文建立关系：${targets.join('、')}。候选和关系保留，待独立核对。`}] : [];
  });
}

export function workRelationEvidenceIssues(work) {
  if (!work) return [];
  const references = [...(work.references ?? []), ...Object.values(work.card_collisions ?? {})
    .filter(row => row.applied && ['reuse','revise'].includes(row.action)).map(row => row.existing)];
  return relationEvidenceIssues(work.cards, references).filter(issue => !work.published?.[issue.card_id]
    && !Object.values(work.isolation?.items ?? {}).some(item => item.status === 'open' && item.card_id === issue.card_id));
}
