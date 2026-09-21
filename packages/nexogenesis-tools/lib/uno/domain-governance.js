import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadCards, parseCardFile } from '../cards.js';
import { safeId } from '../uno-contract.js';
import { listDomainsV2 } from './knowledge.js';
import { validateDomainDefinition } from './domain-contract.js';
import { domainAncestors, domainCatalogRows, MAX_CARD_DOMAINS, normalizeDomainIds, validateCardClassification } from './card-classification.js';
import { expect, sha, transaction, unoCardRef, unoMarkdown, unoPath, unoRevision } from '../harness/uno-storage.js';

export const DOMAIN_GOVERNANCE_CONTRACT = 'domain-governance-v1';
export const DOMAIN_CHECKPOINT = Object.freeze({ effective_units: 10, unassigned_cards: 20, batch_cards: 20 });
const STATE_REF = '.nexogenesis/domain-governance/state.json';

const now = () => new Date().toISOString();
const unique = values => [...new Set((values ?? []).filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
const activeCard = card => card?.meta?.type !== 'domain' && !['archived', 'superseded'].includes(card?.meta?.lifecycle);

function emptyState() {
  return { schema: DOMAIN_GOVERNANCE_CONTRACT, revision: 0, unassigned: {}, proposals: {}, updated_at: now() };
}

export function readDomainGovernanceState(root) {
  const path = unoPath(root, STATE_REF);
  if (!existsSync(path)) return emptyState();
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.schema !== DOMAIN_GOVERNANCE_CONTRACT || typeof value.unassigned !== 'object' || typeof value.proposals !== 'object') return emptyState();
    return value;
  } catch { return emptyState(); }
}

export function saveDomainGovernanceState(root, state) {
  const path = unoPath(root, STATE_REF), temp = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  const value = { ...state, schema: DOMAIN_GOVERNANCE_CONTRACT, revision: (state.revision ?? 0) + 1, updated_at: now() };
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8'); renameSync(temp, path); return value;
}

function sourceGroups(card) {
  return unique((card.meta.sources ?? []).map(source => String(source?.ref ?? source).split('#')[0]));
}

function unassignedEntry(root, id, card, previous = {}, context = {}) {
  const ref = unoCardRef(root, card), revision = unoRevision(root, ref);
  return {
    card_id: id, card_revision: revision, reason: context.reason ?? previous.reason ?? 'NO_MATCHING_DOMAIN',
    candidate_domains: unique(context.candidate_domains ?? previous.candidate_domains),
    source_groups: unique([...(previous.source_groups ?? []), ...sourceGroups(card), ...(context.source_groups ?? [])]),
    organization_signals: unique(context.organization_signals ?? previous.organization_signals).slice(0, 12),
    status: 'open', created_at: previous.created_at ?? now(), last_evaluated_at: now(),
    ...(context.job_id ? { job_id: context.job_id } : {}), ...(context.unit_ref ? { unit_ref: context.unit_ref } : {})
  };
}

/** Rebuildable projection: Markdown cards and formal domains remain the semantic truth. */
export function synchronizeUnassignedPool(root, { card_ids, ...context } = {}) {
  const state = readDomainGovernanceState(root), cards = loadCards(root, { includeInactive: true });
  const ids = card_ids ? unique(card_ids) : [...cards.keys()];
  for (const id of ids) {
    const card = cards.get(id);
    if (!activeCard(card) || normalizeDomainIds(card.meta.domains).length) delete state.unassigned[id];
    else state.unassigned[id] = unassignedEntry(root, id, card, state.unassigned[id], context);
  }
  return saveDomainGovernanceState(root, state);
}

function tokens(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const words = text.match(/[a-z]+(?:[-'][a-z]+)*|\d+(?:\.\d+)?|[\p{Script=Han}]+/gu) ?? [];
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))] : [word]));
}

function domainText(domain) {
  return [domain.id, domain.title, domain.summary, ...(domain.core_questions ?? []), ...(domain.includes ?? []), ...(domain.excludes ?? []), domain.body].join('\n');
}

export function rankDomainCandidates(root, cardIds, limit = 8) {
  const cards = loadCards(root), domains = listDomainsV2(root).filter(domain => !['retired','archived'].includes(domain.lifecycle)), capped = Math.max(1, Math.min(8, Number(limit) || 8));
  const indexed = domains.map(domain => ({ domain, words: tokens(domainText(domain)) }));
  return Object.fromEntries(unique(cardIds).map(id => {
    const card = cards.get(id); if (!activeCard(card)) return [id, []];
    if (domains.length <= capped) return [id, domains.map(domain => domain.id)];
    const cardWords = tokens([card.meta.title, card.meta.summary, card.body].join('\n'));
    return [id, indexed.map(({ domain, words }) => ({ id: domain.id, score: [...cardWords].reduce((n, word) => n + (words.has(word) ? 1 : 0), 0) }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, capped).map(row => row.id)];
  }));
}

export function buildDomainGovernancePackage(root, cardIds, { limit = DOMAIN_CHECKPOINT.batch_cards } = {}) {
  const state = synchronizeUnassignedPool(root, { card_ids: cardIds }), cards = loadCards(root), domains = listDomainsV2(root).filter(domain => !['retired','archived'].includes(domain.lifecycle));
  const ids = unique(cardIds).filter(id => state.unassigned[id] && activeCard(cards.get(id))).slice(0, limit);
  const candidates = rankDomainCandidates(root, ids);
  const fullIds = new Set(ids.slice(0, 3));
  if (ids.length > 3) fullIds.add(ids.at(-1));
  if (ids.length > 4) fullIds.add(ids[Math.floor(ids.length / 2)]);
  return {
    contract: DOMAIN_GOVERNANCE_CONTRACT,
    cards: ids.map(id => { const card = cards.get(id), ref = unoCardRef(root, card); return {
      id, title: card.meta.title ?? id, type: card.meta.type, summary: card.meta.summary ?? Array.from(card.body).slice(0, 480).join(''), relations: card.meta.relations ?? [],
      source_groups: state.unassigned[id].source_groups, revision: unoRevision(root, ref), candidate_domain_ids: candidates[id] ?? [],
      ...(fullIds.has(id) ? { body: card.body, delivery: 'full' } : { delivery: 'summary' })
    }; }),
    domains: domains.map(domain => ({ id: domain.id, title: domain.title, summary: domain.summary ?? '',
      core_questions: domain.core_questions ?? [], includes: domain.includes ?? [], excludes: domain.excludes ?? [],
      parents: domain.parents ?? [], representative_card_ids: domain.representative_card_ids ?? [], revision: domain.revision })),
    card_revisions: Object.fromEntries(ids.map(id => [id, state.unassigned[id].card_revision])),
    domain_revisions: Object.fromEntries(domains.map(domain => [domain.id, domain.revision]))
  };
}

export function ensureDomainCheckpointState(job) {
  job.domain_governance ??= { contract: DOMAIN_GOVERNANCE_CONTRACT, effective_units_since_checkpoint: 0,
    unassigned_card_ids: [], checkpoints: [], pending_proposals: [], status: 'collecting' };
  return job.domain_governance;
}

export function recordDomainUnit(job, { unit_ref, card_ids = [], unassigned_card_ids = [] }) {
  const state = ensureDomainCheckpointState(job);
  state.recorded_units ??= [];
  if (state.recorded_units.includes(unit_ref)) return state;
  state.recorded_units.push(unit_ref);
  if (card_ids.length) state.effective_units_since_checkpoint++;
  state.unassigned_card_ids = unique([...state.unassigned_card_ids, ...unassigned_card_ids]);
  return state;
}

export function bootstrapDomainGovernanceJob(root, job) {
  const state = ensureDomainCheckpointState(job);
  for (const [unitRef, outcome] of Object.entries(job.book_outcomes ?? {})) {
    if (outcome?.status !== 'processed' || state.recorded_units?.includes(unitRef)) continue;
    const cardIds = unique(outcome.card_ids), pool = synchronizeUnassignedPool(root, { card_ids:cardIds, job_id:job.id, unit_ref:unitRef });
    recordDomainUnit(job, { unit_ref:unitRef, card_ids:cardIds, unassigned_card_ids:cardIds.filter(id => pool.unassigned[id]) });
  }
  return state;
}

export function domainCheckpointDue(job, { book_end = false } = {}) {
  const state = ensureDomainCheckpointState(job), pending = state.unassigned_card_ids.length;
  if (!pending) return null;
  if (pending >= DOMAIN_CHECKPOINT.unassigned_cards) return 'unassigned-card-threshold';
  if (state.effective_units_since_checkpoint >= DOMAIN_CHECKPOINT.effective_units) return 'effective-unit-threshold';
  // A new domain needs at least three members. With no formal catalog, a
  // one- or two-card book-end call cannot either assign or propose anything.
  if (book_end && ((job.domain_catalog?.length ?? 0) > 0 || state.effective_units_since_checkpoint >= 3 || pending >= 10)) return 'book-end';
  return null;
}

export function recordDomainCheckpoint(job, { reason, card_ids, proposal_ids = [], assigned = [] }) {
  const state = ensureDomainCheckpointState(job);
  state.checkpoints.push({ at: now(), reason, card_ids: unique(card_ids), proposal_ids: unique(proposal_ids), assigned: unique(assigned) });
  state.effective_units_since_checkpoint = 0;
  state.unassigned_card_ids = state.unassigned_card_ids.filter(id => !card_ids.includes(id));
  state.status = proposal_ids.length ? 'review' : 'collecting';
  return state;
}

export function validateDomainGovernanceResult(value, pack) {
  if (!value || !Array.isArray(value.assignments) || !Array.isArray(value.proposals) || !Array.isArray(value.unassigned)) throw new Error('领域治理响应缺少 assignments、proposals 或 unassigned。');
  const cards = new Set(pack.cards.map(card => card.id)), cardRows = new Map(pack.cards.map(card => [card.id, card])), domains = new Set(pack.domains.map(domain => domain.id)), seen = new Set();
  const assignments = value.assignments.map(row => {
    if (!cards.has(row.card_id) || seen.has(row.card_id)) throw new Error('领域挂靠引用未知或重复卡片。'); seen.add(row.card_id);
    const selected = normalizeDomainIds(row.domains), candidates = new Set(cardRows.get(row.card_id).candidate_domain_ids ?? []);
    if (!selected.length || selected.length > MAX_CARD_DOMAINS || selected.some(id => !domains.has(id) || !candidates.has(id))) throw new Error('领域挂靠只能选择该卡候选列表中的 1–3 个既有领域。');
    for (const id of selected) { const ancestors=domainAncestors(pack.domains,id); if(selected.some(other=>other!==id&&ancestors.has(other))) throw new Error('领域挂靠不能同时选择父领域和子领域。'); }
    return { card_id: row.card_id, domains: selected, reason: String(row.reason ?? '').trim() };
  });
  const proposalIds=new Set(),newDomainIds=new Set();
  const proposals = value.proposals.map(row => {
    validateDomainDefinition(row); if (domains.has(row.id)) throw new Error('新领域 ID 已存在。');
    if(newDomainIds.has(row.id))throw new Error('一次领域治理不能重复提出同一领域 ID。');newDomainIds.add(row.id);
    const members = unique(row.member_card_ids); if (members.length < 3 || members.some(id => !cards.has(id) || seen.has(id))) throw new Error('新领域提案至少需要 3 张本批未处置卡片。');
    members.forEach(id => seen.add(id));
    const parents = unique(row.parents); if (parents.some(id => !domains.has(id))) throw new Error('领域父级必须来自当前正式目录。');
    const proposalId=row.proposal_id && safeId(row.proposal_id) ? row.proposal_id : `domain-${sha(row.id + members.join('|')).slice(0, 16)}`;
    if(proposalIds.has(proposalId))throw new Error('领域提案 ID 不能重复。');proposalIds.add(proposalId);
    const whyNew=String(row.why_new ?? '').trim(),alternative=String(row.alternative ?? '').trim();if(!whyNew||!alternative)throw new Error('领域提案必须说明新建理由和不建域时的替代处理。');
    return { proposal_id: proposalId,
      kind: 'create', id: row.id, title: row.title.trim(), summary: row.summary.trim(), core_questions: unique(row.core_questions),
      includes: unique(row.includes), excludes: unique(row.excludes), parents, representative_card_ids: unique(row.representative_card_ids).filter(id => members.includes(id)).slice(0, 5),
      member_card_ids: members, closest_domains: unique(row.closest_domains).filter(id => domains.has(id)), why_new: whyNew, alternative };
  });
  const unassigned = value.unassigned.map(row => {
    if (!cards.has(row.card_id) || seen.has(row.card_id)) throw new Error('未组织清单引用未知或重复卡片。'); seen.add(row.card_id);
    return { card_id: row.card_id, reason: String(row.reason ?? '边界尚不稳定').trim() };
  });
  if (seen.size !== cards.size) throw new Error('领域治理响应没有逐张处置本批卡片。');
  return { assignments, proposals, unassigned };
}

export function persistDomainProposals(root, proposals, pack, { job_id, checkpoint_reason } = {}) {
  const state = readDomainGovernanceState(root);
  for (const proposal of proposals) state.proposals[proposal.proposal_id] = { ...proposal, status: 'proposed', job_id,
    checkpoint_reason, card_revisions: Object.fromEntries(proposal.member_card_ids.map(id => [id, pack.card_revisions[id]])),
    domain_revisions: pack.domain_revisions, created_at: now(), updated_at: now() };
  return saveDomainGovernanceState(root, state);
}

export function settleDomainProposals(root, proposalIds, status, note = '') {
  const state = readDomainGovernanceState(root);
  for (const id of unique(proposalIds)) if (state.proposals[id]) state.proposals[id] = { ...state.proposals[id], status, note, updated_at: now() };
  return saveDomainGovernanceState(root, state);
}

/** Atomic formal-domain creation plus membership assignment. Only HarnessGateway calls this writer. */
export function applyDomainGovernance(root, input, completion) {
  const assignments = (input.assignments ?? []).map(row => ({ card_id: row.card_id, domains: normalizeDomainIds(row.domains) }));
  const creates = input.create_domains ?? [];
  return transaction(root, input.key, input, () => {
    const cards = loadCards(root, { includeInactive: true }), existingDomains = listDomainsV2(root), existing = new Map(existingDomains.map(domain => [domain.id, domain]));
    const created = new Map(); for (const domain of creates) { validateDomainDefinition(domain); if (existing.has(domain.id) || created.has(domain.id)) throw new Error('领域 ID 已存在或重复：' + domain.id); created.set(domain.id, domain); }
    const knownIds = new Set([...existing.keys(), ...created.keys()]);
    for (const domain of creates) if (unique(domain.parents).some(parent => parent === domain.id || !knownIds.has(parent))) throw new Error('领域父级不存在或指向自身：' + domain.id);
    const ancestryCatalog = [...existingDomains, ...creates.map(domain => ({ id: domain.id, parents: unique(domain.parents) }))];
    for (const domain of creates) if (domainAncestors(ancestryCatalog, domain.id).has(domain.id)) throw new Error('领域层级形成循环：' + domain.id);
    const expected = {};
    for (const [id, revision] of Object.entries(input.expected_cards ?? {})) { const card = cards.get(id); if (!card) throw new Error('领域治理卡片不存在：' + id); expected[unoCardRef(root, card)] = revision; }
    for (const [id, revision] of Object.entries(input.expected_domains ?? {})) { const domain = existing.get(id); if (!domain) throw new Error('领域定义已不存在：' + id); expected[domain.ref] = revision; }
    expect(root, expected);
    const writes = new Map(), changedCards = [];
    for (const assignment of assignments) {
      const card = cards.get(assignment.card_id); if (!activeCard(card)) throw new Error('只能挂靠当前有效卡片：' + assignment.card_id);
      if (!assignment.domains.length || assignment.domains.length > MAX_CARD_DOMAINS || assignment.domains.some(id => !knownIds.has(id))) throw new Error('领域挂靠必须选择 1–3 个有效领域。');
      for (const id of assignment.domains) { const ancestors = domainAncestors(ancestryCatalog, id); if (assignment.domains.some(other => other !== id && ancestors.has(other))) throw new Error('同一卡片不能同时挂靠父领域和子领域。'); }
      const classification = validateCardClassification({ type: card.meta.type, domains: assignment.domains }, ancestryCatalog);
      if (classification.issues.length) throw new Error(`卡片 ${assignment.card_id} 的领域挂靠无法通过分类校验：${classification.issues.map(issue => issue.message).join('；')}`);
      const ref = unoCardRef(root, card), current = readFileSync(unoPath(root, ref)), version = sha(current);
      const historyRef = `03-Archive/card-history/${assignment.card_id}/${version}.md`; if (!existsSync(unoPath(root, historyRef))) writes.set(historyRef, current);
      // Membership governance changes only domains. Existing metadata, including
      // legacy tags/topics, remains byte-for-value compatible until a separately
      // reviewed migration changes it.
      writes.set(ref, unoMarkdown({ ...card.meta, domains: classification.domains, updated: new Date().toISOString().slice(0, 10) }, card.body)); changedCards.push(assignment.card_id);
    }
    for (const domain of creates) {
      const ref = `01-Cards/_meta/domains/${domain.id}.md`;
      writes.set(ref, unoMarkdown({ schema:'uno-domain-v2', kind:'uno-domain-index', id:domain.id, title:domain.title, summary:domain.summary,
        core_questions:unique(domain.core_questions), includes:unique(domain.includes), excludes:unique(domain.excludes), parents:unique(domain.parents),
        representative_card_ids:unique(domain.representative_card_ids), lifecycle:'active', relations:[] }, domain.body ?? ''));
    }
    if(completion)return completion({writes,changedCards});
    return { writes, result: { summary:`领域治理：新建 ${creates.length} 个领域，挂靠 ${changedCards.length} 张卡片`, card_ids:changedCards,
      domain_ids:creates.map(domain => domain.id), publication:{cards:changedCards,domains:creates.map(domain=>domain.id)} } };
  });
}
