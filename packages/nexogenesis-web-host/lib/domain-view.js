import { activeDomain, DOMAIN_RELATION_TYPES } from '../../nexogenesis-tools/lib/uno/domain-contract.js';

export function buildDomainEdges(domains) {
  const active = new Map(domains.filter(activeDomain).map(domain => [domain.id, domain])), edges = new Map();
  const add = (from, to, kind, fields = {}) => {
    if (from === to || !active.has(from) || !active.has(to)) return;
    const id = `domain-edge:${from}:${kind}:${to}`;
    edges.set(id, { ...fields, id, from:'domain:' + from, to:'domain:' + to, kind, relation_type:kind, bundle:'domains', basis:'navigation' });
  };
  for (const domain of active.values()) {
    for (const relation of domain.relations ?? []) if (relation && Object.hasOwn(DOMAIN_RELATION_TYPES, relation.type)) {
      const { note, use_when, limits, anchor_card_ids = [] } = relation;
      add(domain.id, relation.target, relation.type, { note, use_when, limits, anchor_card_ids:Array.isArray(anchor_card_ids) ? anchor_card_ids : [] });
    }
    for (const parent of domain.parents ?? []) add(parent, domain.id, 'domain-parent', { note:'上级领域包含此问题空间；不代表论证关系。' });
  }
  return [...edges.values()].sort((a,b) => a.id.localeCompare(b.id));
}

export function domainReadingDetail(domain, domains, cards, qualify = id => id) {
  const byId = new Map(domains.map(row => [row.id,row]));
  const cardLink = id => ({ id:qualify(id), title:cards.get(id)?.meta.title ?? id });
  const domainLink = id => ({ id:qualify('domain:' + id), title:byId.get(id)?.title ?? id });
  const nodeId = 'domain:' + domain.id;
  const relations = buildDomainEdges(domains).filter(edge => edge.kind !== 'domain-parent' && (edge.from === nodeId || edge.to === nodeId)).map(edge => {
    const incoming = edge.to === nodeId, target = (incoming ? edge.from : edge.to).slice(7);
    return { direction:incoming ? 'incoming' : 'outgoing', target:qualify('domain:' + target), target_title:byId.get(target)?.title ?? target,
      type:edge.kind, note:edge.note, use_when:edge.use_when, limits:edge.limits, basis:'navigation',
      anchors:edge.anchor_card_ids.filter(id => (cards.get(id)?.meta.domains ?? []).some(member => 'domain:' + member === edge.from || 'domain:' + member === edge.to)).map(cardLink) };
  });
  return { relations, domain_content:{
    core_questions:domain.core_questions ?? [], includes:domain.includes ?? [], excludes:domain.excludes ?? [],
    parents:(domain.parents ?? []).filter(id => activeDomain(byId.get(id))).map(domainLink),
    representative_cards:(domain.representative_card_ids ?? []).filter(id => cards.has(id)).map(cardLink),
    member_count:[...cards.values()].filter(card => card.meta.type !== 'domain' && (card.meta.domains ?? []).includes(domain.id)).length,
    missing_fields:['summary','core_questions','includes','excludes'].filter(field => !domain[field]?.length)
  } };
}
