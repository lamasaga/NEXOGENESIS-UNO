import { existsSync, readFileSync } from 'node:fs';
import { loadCards } from '../cards.js';
import { safeCardId } from '../uno-contract.js';
import { listDomainsV2 } from './knowledge.js';
import { applyDomainGovernance, readDomainGovernanceState, synchronizeUnassignedPool } from './domain-governance.js';
import { validateDomainDefinition } from './domain-contract.js';
import { expect, readUnoReceipt, sha, transaction, unoCardRef, unoMarkdown, unoPath, unoRevision } from '../harness/uno-storage.js';

const STATE_REF = '.nexogenesis/domain-governance/state.json';
const sourceRef = value => String(value?.ref ?? value ?? '').split('#')[0];
const uniqueText = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];

export function listUnassignedCards(root) {
  const state = readDomainGovernanceState(root), cards = loadCards(root), inbound = new Map();
  for (const [sourceId, card] of cards) for (const relation of card.meta.relations ?? []) {
    if (typeof relation?.target !== 'string') continue;
    inbound.set(relation.target, [...(inbound.get(relation.target) ?? []), sourceId]);
  }
  return [...cards].filter(([id, card]) => state.unassigned[id] && !(card.meta.domains ?? []).length).map(([id, card]) => {
    const entry = state.unassigned[id];
    return {
      id,
      title: String(card.meta.title ?? id),
      type: String(card.meta.type ?? 'unknown'),
      summary: String(card.meta.summary ?? card.body.slice(0, 480)),
      excerpt: card.body.replace(/[#>*_`\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220),
      sources: (card.meta.sources ?? []).map(sourceRef),
      source_groups: entry.source_groups ?? (card.meta.sources ?? []).map(sourceRef),
      reason: entry.reason ?? '尚未归入正式领域。',
      candidate_domains: entry.candidate_domains ?? [],
      organization_signals: entry.organization_signals ?? [],
      created_at: entry.created_at ?? null,
      last_evaluated_at: entry.last_evaluated_at ?? null,
      revision: unoRevision(root, unoCardRef(root, card)),
      inbound_relation_count: (inbound.get(id) ?? []).length,
      outbound_relation_count: (card.meta.relations ?? []).length,
      updated: String(card.meta.updated ?? '')
    };
  }).sort((left, right) => String(right.last_evaluated_at ?? right.updated).localeCompare(String(left.last_evaluated_at ?? left.updated)) || left.title.localeCompare(right.title, 'zh-CN'));
}

/** Remove one unassigned card and clean its structural references atomically. */
export function deleteUnassignedCard(root, input) {
  const id = String(input?.card_id ?? ''), expected = String(input?.expected_revision ?? '');
  if (!safeCardId(id) || input?.confirm_id !== id || !/^[0-9a-f]{64}$/i.test(expected)) throw new Error('删除确认、卡片 ID 或版本无效。');
  const previous=readUnoReceipt(root,input.key);
  if(previous){if(previous.input_hash!==sha(JSON.stringify(input)))throw Object.assign(new Error('同一批次不能改写为其他内容。'),{code:'IDEMPOTENCY_CONFLICT'});return previous;}
  const cards = loadCards(root, { includeInactive: true }), target = cards.get(id);
  if (!target || ['archived', 'superseded'].includes(target.meta.lifecycle)) throw new Error('卡片不存在或已经退出使用。');
  if ((target.meta.domains ?? []).length) throw new Error('这里只能直接删除未组织池中的卡片。');
  const currentState = readDomainGovernanceState(root);
  if (!currentState.unassigned[id]) throw new Error('这张卡片不在正式未组织池中，请刷新后重试。');
  const targetRef = unoCardRef(root, target), stateRevision = unoRevision(root, STATE_REF);
  return transaction(root, input.key, input, () => {
    expect(root, { [targetRef]: expected, [STATE_REF]: stateRevision });
    const writes = new Map(), original = readFileSync(unoPath(root, targetRef)), archivedRef = `03-Archive/deleted-cards/${id}/${expected}.md`;
    if (!existsSync(unoPath(root, archivedRef))) writes.set(archivedRef, original);
    writes.set(targetRef, null);

    const changedCards = [];
    for (const [sourceId, card] of cards) {
      if (sourceId === id) continue;
      const before = card.meta.relations ?? [], relations = before.filter(relation => relation?.target !== id);
      if (relations.length === before.length) continue;
      const ref = unoCardRef(root, card), revision = unoRevision(root, ref), history = `03-Archive/card-history/${sourceId}/${revision}.md`;
      if (!existsSync(unoPath(root, history))) writes.set(history, readFileSync(unoPath(root, ref)));
      writes.set(ref, unoMarkdown({ ...card.meta, relations, updated: new Date().toISOString().slice(0, 10) }, card.body));
      changedCards.push(sourceId);
    }

    const changedDomains = [];
    for (const domain of listDomainsV2(root)) {
      if (!(domain.representative_card_ids ?? []).includes(id)) continue;
      const history = `03-Archive/domain-history/${domain.id}/${domain.revision}.md`;
      if (!existsSync(unoPath(root, history))) writes.set(history, readFileSync(unoPath(root, domain.ref)));
      const { body, ref, revision, ...meta } = domain;
      writes.set(ref, unoMarkdown({ ...meta, representative_card_ids: domain.representative_card_ids.filter(cardId => cardId !== id) }, body));
      changedDomains.push(domain.id);
    }

    const state = readDomainGovernanceState(root);
    delete state.unassigned[id];
    for (const proposal of Object.values(state.proposals)) if ((proposal.member_card_ids ?? []).includes(id)) {
      proposal.status = 'invalidated';
      proposal.note = `成员卡 ${id} 已由用户删除。`;
      proposal.updated_at = new Date().toISOString();
    }
    writes.set(STATE_REF, JSON.stringify({ ...state, revision: (state.revision ?? 0) + 1, updated_at: new Date().toISOString() }, null, 2));
    return { writes, result: {
      operator: 'harness.delete_unassigned_card',
      summary: `已删除未组织卡片 ${id}，并清理 ${changedCards.length} 条入边来源和 ${changedDomains.length} 个领域导航引用。`,
      card_id: id,
      archived_ref: archivedRef,
      changed_card_ids: changedCards,
      changed_domain_ids: changedDomains,
      reason: String(input.reason ?? '').trim() || '用户在未组织池中直接删除。'
    } };
  });
}

/** Explicit manual governance: create one durable domain with this card as its first member. */
export function createDomainFromUnassignedCard(root, input) {
  const cardId=String(input?.card_id??''),expected=String(input?.expected_revision??''),definition=input?.domain??{};
  if(!safeCardId(cardId)||!/^[0-9a-f]{64}$/i.test(expected))throw new Error('卡片 ID 或版本无效。');
  const title=String(definition.title??'').trim(),summary=String(definition.summary??'').trim();
  const domain={id:String(definition.id??'').trim()||`domain-${sha(`${cardId}\0${title}`).slice(0,16)}`,title,summary,
    core_questions:uniqueText(definition.core_questions),includes:uniqueText(definition.includes),excludes:uniqueText(definition.excludes),
    parents:[],representative_card_ids:[cardId]};
  validateDomainDefinition(domain);
  if(title.length>100||summary.length>1000||['core_questions','includes','excludes'].some(key=>domain[key].length>12||domain[key].some(value=>value.length>500)))
    throw new Error('领域名称、摘要或边界说明过长。');
  if(['其他','综合','未分类','其它'].includes(title.replace(/\s+/g,'')))throw new Error('领域名称必须表达稳定问题空间，不能使用“其他”“综合”或“未分类”。');
  const cards=loadCards(root,{includeInactive:true}),card=cards.get(cardId);
  if(!card||['archived','superseded'].includes(card.meta.lifecycle))throw new Error('这张卡片不存在或已经退出使用。');
  if(title.normalize('NFKC')===String(card.meta.title??'').trim().normalize('NFKC'))throw new Error('领域名称不能直接复用卡片标题，请概括可容纳更多卡片的稳定问题空间。');
  const governanceInput={key:input.key,assignments:[{card_id:cardId,domains:[domain.id]}],create_domains:[domain],expected_cards:{[cardId]:expected},expected_domains:{}};
  const previous=readUnoReceipt(root,input.key);
  if(previous){if(previous.input_hash!==sha(JSON.stringify(governanceInput)))throw Object.assign(new Error('同一批次不能改写为其他内容。'),{code:'IDEMPOTENCY_CONFLICT'});return previous;}
  const state=readDomainGovernanceState(root);
  if(!state.unassigned[cardId]||(card.meta.domains??[]).length)throw new Error('这张卡片已不在正式未组织池中，请刷新后重试。');
  if(listDomainsV2(root).some(item=>item.title.trim().normalize('NFKC')===title.normalize('NFKC')))throw new Error('已有同名领域，请改为挂靠既有领域或调整名称。');
  const receipt=applyDomainGovernance(root,governanceInput);
  if(readDomainGovernanceState(root).unassigned[cardId])synchronizeUnassignedPool(root,{card_ids:[cardId]});
  return receipt;
}
