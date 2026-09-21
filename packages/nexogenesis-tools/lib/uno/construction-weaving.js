import { createHash } from 'node:crypto';
import { loadCards } from '../cards.js';
import { loadGraphOps } from '../graph-ops.js';
import { unoCardRef, unoRevision } from '../harness/uno-storage.js';
import { resolveCardTarget } from './knowledge.js';
import { constructionCandidatePool, constructionCandidateRows } from './construction-strategy.js';

export const LEGACY_RELATION_WEAVING_CONTRACT = 'incremental-relation-weaving-v1';
export const RELATION_WEAVING_CONTRACT = 'random-focus-semantic-retrieval-v2';
export const RELATION_WEAVING_FOCUS_SELECTION = 'job-seeded-random-without-replacement-v1';
export const RELATION_WEAVING_ENDPOINT_RETRIEVAL = 'all-cards-integration-candidates-v1';
export const RELATION_WEAVING_PACKAGE_LIMIT = 6;
export const RELATION_WEAVING_CANDIDATE_LIMIT = 6;
export const RELATION_WEAVING_MAX_FOCUS_ATTEMPTS = 2;

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyWeaving = job => job?.relation_weaving?.contract !== RELATION_WEAVING_CONTRACT;
const activeCard = card => card?.meta?.type !== 'domain'
  && !['archived', 'superseded'].includes(card?.meta?.lifecycle);

export function relationWeavingEnabled(job) {
  const controls = job?.construction_controls;
  if (!controls?.allowed?.includes('relation_add')) return false;
  return controls.primary === 'connections' || controls.primary === 'comprehensive'
    || controls.focuses?.includes('connections');
}

function scopedCards(cards, job) {
  return [...cards]
    .filter(([, card]) => activeCard(card)
      && (!job.domain || (card.meta.domains ?? []).includes(job.domain))
      && (!job.type || card.meta.type === job.type));
}

function componentRows(ids, adjacency, root, cards) {
  const pending = new Set(ids), components = [];
  while (pending.size) {
    const first = [...pending].sort((a, b) => a.localeCompare(b, 'zh-CN'))[0];
    const queue = [first], members = []; pending.delete(first);
    while (queue.length) {
      const id = queue.shift(); members.push(id);
      for (const neighbor of adjacency.get(id) ?? []) if (pending.delete(neighbor)) queue.push(neighbor);
    }
    members.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const memberSet = new Set(members), edges = members.flatMap(id => [...(adjacency.get(id) ?? [])]
      .filter(target => memberSet.has(target) && id.localeCompare(target, 'zh-CN') < 0).map(target => [id, target]));
    const revisions = members.map(id => [id, unoRevision(root, unoCardRef(root, cards.get(id)))]);
    components.push({ ids: members, size: members.length, edge_count: Math.trunc(members.reduce((total, id) => total + (adjacency.get(id)?.size ?? 0), 0) / 2),
      fingerprint: hash({ members: revisions, edges }) });
  }
  return components.sort((left, right) => right.size - left.size || right.edge_count - left.edge_count
    || left.ids[0].localeCompare(right.ids[0], 'zh-CN'));
}

/**
 * Structural diagnosis only. A component is a weak component over current
 * active Card relations; domain membership never connects Card nodes.
 */
function inspectLegacyRelationWeaving(root, job) {
  const allCards = loadCards(root, { includeInactive: true }), rows = scopedCards(allCards, job), map = new Map(rows);
  const ids = [...map.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const adjacency = new Map(ids.map(id => [id, new Set()]));
  for (const [id, card] of rows) for (const relation of card.meta.relations ?? []) {
    const target = resolveCardTarget(root, relation?.target, allCards);
    if (!target || target === id || !adjacency.has(target)) continue;
    adjacency.get(id).add(target); adjacency.get(target).add(id);
  }
  const components = componentRows(ids, adjacency, root, map);
  const main = components.find(component => component.size > 1) ?? null;
  const history = job?.relation_weaving?.rounds ?? [];
  const settledStatuses = new Set(['published', 'reviewed-independent', 'no-selection', 'deferred-exhausted']);
  const reviewed = new Set(history.flatMap(row => [settledStatuses.has(row?.status) ? row?.focus_fingerprint : null,
    ...(row?.reviewed_fingerprints ?? [])]).filter(Boolean));
  const requested = new Set(job?.requested_card_ids ?? []);
  const isolated = components.filter(component => component.size === 1).map(component => ({ ...component, kind: 'isolated',
    requested: requested.has(component.ids[0]), reviewed: reviewed.has(component.fingerprint) }))
    .sort((a, b) => Number(b.requested) - Number(a.requested) || a.ids[0].localeCompare(b.ids[0], 'zh-CN'));
  const islands = main ? components.filter(component => component !== main && component.size > 1).map(component => ({ ...component,
    kind: 'island', requested: component.ids.some(id => requested.has(id)), reviewed: reviewed.has(component.fingerprint) }))
    .sort((a, b) => Number(b.requested) - Number(a.requested) || a.size - b.size || a.ids[0].localeCompare(b.ids[0], 'zh-CN')) : [];
  const focus = isolated.find(component => !component.reviewed) ?? islands.find(component => !component.reviewed) ?? null;
  return { contract: LEGACY_RELATION_WEAVING_CONTRACT, phase: focus?.kind ?? 'done', focus,
    counts: { cards: ids.length, isolated: isolated.length, unreviewed_isolated: isolated.filter(row => !row.reviewed).length,
      components: components.length, islands: islands.length, unreviewed_islands: islands.filter(row => !row.reviewed).length,
      main_component_cards: main?.size ?? 0 },
    main_component: main ? { ids: main.ids, size: main.size, fingerprint: main.fingerprint } : null,
    isolated_targets: isolated.map(({ ids: memberIds, fingerprint, reviewed: done }) => ({ ids: memberIds, fingerprint, reviewed: done })),
    island_targets: islands.map(({ ids: memberIds, fingerprint, reviewed: done }) => ({ ids: memberIds, fingerprint, reviewed: done })),
    topology_fingerprint: hash(components.map(component => [component.ids, component.fingerprint])) };
}

/**
 * New relation discovery separates target sampling from endpoint retrieval.
 * The job id is the random seed: selection is random across jobs, but stable
 * across retries and process restarts. Topology is reported, never ranked.
 */
function inspectRandomRelationWeaving(root, job) {
  const allCards = loadCards(root, { includeInactive: true }), rows = scopedCards(allCards, job), map = new Map(rows);
  const ids = [...map.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const adjacency = new Map(ids.map(id => [id, new Set()]));
  for (const [id, card] of rows) for (const relation of card.meta.relations ?? []) {
    const target = resolveCardTarget(root, relation?.target, allCards);
    if (!target || target === id || !adjacency.has(target)) continue;
    adjacency.get(id).add(target); adjacency.get(target).add(id);
  }
  const components = componentRows(ids, adjacency, root, map), main = components.find(component => component.size > 1) ?? null;
  const isolated = components.filter(component => component.size === 1), islands = main
    ? components.filter(component => component !== main && component.size > 1) : [];
  const history = job?.relation_weaving?.rounds ?? [], settledStatuses = new Set(['published', 'reviewed-independent', 'no-selection', 'deferred-exhausted']);
  const reviewedIds = new Set(history.filter(row => settledStatuses.has(row?.status))
    .flatMap(row => [...(row.focus_ids ?? []), ...(row.status === 'published' ? row.relation_endpoint_ids ?? [] : [])]));
  const active = new Set(ids);
  const retry = [...history].reverse().find(row => row?.status === 'deferred'
    && (row.focus_ids ?? []).some(id => active.has(id) && !reviewedIds.has(id)));
  const requested = new Set((job?.requested_card_ids ?? []).filter(id => active.has(id)));
  const eligibleIds = requested.size ? ids.filter(id => requested.has(id)) : ids;
  const unreviewed = eligibleIds.filter(id => !reviewedIds.has(id));
  const randomPool = unreviewed;
  const focusId = retry?.focus_ids?.find(id => active.has(id) && !reviewedIds.has(id))
    ?? [...randomPool].sort((left, right) => hash([job.id, left]).localeCompare(hash([job.id, right])) || left.localeCompare(right, 'zh-CN'))[0]
    ?? null;
  const focus = focusId ? { ids: [focusId], kind: 'random-card', requested: requested.has(focusId),
    fingerprint: hash({ id: focusId, revision: unoRevision(root, unoCardRef(root, map.get(focusId))) }),
    random_rank: hash([job.id, focusId]) } : null;
  return { contract: RELATION_WEAVING_CONTRACT, phase: focus ? 'random' : 'done', focus,
    focus_selection: RELATION_WEAVING_FOCUS_SELECTION,
    counts: { cards: ids.length, eligible: eligibleIds.length, reviewed: eligibleIds.length - unreviewed.length, unreviewed: unreviewed.length,
      isolated: isolated.length, components: components.length, islands: islands.length, main_component_cards: main?.size ?? 0 },
    main_component: main ? { ids: main.ids, size: main.size, fingerprint: main.fingerprint } : null,
    inventory_revision: hash(ids.map(id => [id, unoRevision(root, unoCardRef(root, map.get(id)))])),
    topology_fingerprint: hash(components.map(component => [component.ids, component.fingerprint])) };
}

export function inspectRelationWeaving(root, job) {
  return legacyWeaving(job) ? inspectLegacyRelationWeaving(root, job) : inspectRandomRelationWeaving(root, job);
}

function representativeIds(focus, cards) {
  if (focus.kind === 'isolated') return [...focus.ids];
  return [...focus.ids].sort((left, right) => {
    const a = cards.get(left), b = cards.get(right);
    const aScore = (a?.meta?.relations?.length ?? 0) * 20 + (a?.meta?.sources?.length ?? 0) * 5 + Math.min(20, String(a?.body ?? '').length / 500);
    const bScore = (b?.meta?.relations?.length ?? 0) * 20 + (b?.meta?.sources?.length ?? 0) * 5 + Math.min(20, String(b?.body ?? '').length / 500);
    return bScore - aScore || left.localeCompare(right, 'zh-CN');
  }).slice(0, 3);
}

/** Build one small, model-adjudicated weaving wave around one structural focus. */
export function relationWeavingCandidatePool(root, job, diagnosis = inspectRelationWeaving(root, job)) {
  if (!diagnosis.focus) return null;
  if (!legacyWeaving(job)) {
    const focusId = diagnosis.focus.ids[0];
    const attempted = new Set((job.relation_weaving?.rounds ?? []).filter(row => row.focus_ids?.includes(focusId)
      && row.status === 'deferred').flatMap(row => row.candidate_ids ?? []).filter(id => id !== focusId));
    const retrieved = loadGraphOps(root).integrationCandidates(focusId, { limit: 12, issueScope: 'all-cards-relation-discovery' });
    const endpoints = (retrieved.nodes ?? []).filter(row => !attempted.has(row.id)).slice(0, RELATION_WEAVING_CANDIDATE_LIMIT - 1);
    const ids = [focusId, ...endpoints.map(row => row.id)];
    const endpointById = new Map(endpoints.map(row => [row.id, row]));
    const candidates = constructionCandidateRows(root, ids, { required_ids: [focusId] }).map(row => row.id === focusId ? row : ({
      ...row, retrieval: { score: endpointById.get(row.id)?.score ?? 0, why: endpointById.get(row.id)?.why ?? '',
        signals: endpointById.get(row.id)?.signals ?? {} }
    }));
    const previousAttempts = (job.relation_weaving?.rounds ?? []).filter(row => row.focus_ids?.includes(focusId) && row.status === 'deferred');
    return { contract: RELATION_WEAVING_CONTRACT,
      query: `为随机抽取的焦点卡 ${focusId} 从全部有效知识卡中检索最可能成立的关系端点。`,
      domain: job.domain, type: job.type, scope_count: diagnosis.counts.cards,
      allowed_operations: job.requirements?.construction_controls?.allowed ?? [], candidates,
      inventory_revision: diagnosis.inventory_revision,
      weaving: { contract: RELATION_WEAVING_CONTRACT,
        round: (job.relation_weaving?.rounds?.length ?? 0) + 1, phase: 'random',
        attempt: previousAttempts.length + 1, max_attempts: RELATION_WEAVING_MAX_FOCUS_ATTEMPTS,
        focus_ids: [focusId], focus_fingerprint: diagnosis.focus.fingerprint,
        focus_selection: RELATION_WEAVING_FOCUS_SELECTION,
        endpoint_retrieval: RELATION_WEAVING_ENDPOINT_RETRIEVAL,
        retrieval_candidate_total: retrieved.candidate_total ?? endpoints.length,
        retrieved_endpoints: endpoints.map(row => ({ id: row.id, score: row.score, why: row.why, signals: row.signals })),
        counts: diagnosis.counts, topology_fingerprint: diagnosis.topology_fingerprint,
        selection_limit: RELATION_WEAVING_PACKAGE_LIMIT,
        instruction: '本轮随机冻结一张尚未检查的焦点卡，再从全部有效知识卡中检索最可能成立的关系端点。拓扑只作统计，不参与端点排序。' } };
  }
  const cards = loadCards(root, { includeInactive: true }), anchors = representativeIds(diagnosis.focus, cards);
  const request = [String(job.construction_query ?? '').trim(), diagnosis.phase === 'isolated'
    ? '优先判断这一张完全没有卡间关系的知识卡能否与已有知识建立有依据的联系。'
    : '判断这个小型连通分量能否与主图建立有依据的桥接关系。'].filter(Boolean).join('\n');
  const base = constructionCandidatePool(root, { notes: request, card_ids: anchors, domain: job.domain, type: job.type,
    requirements: job.requirements });
  const focusIds = new Set(diagnosis.focus.ids), mainIds = new Set(diagnosis.main_component?.ids ?? []);
  const previousAttempts = (job.relation_weaving?.rounds ?? []).filter(row => row.focus_fingerprint === diagnosis.focus.fingerprint
    && row.status === 'deferred');
  const attemptedEndpoints = new Set(previousAttempts.flatMap(row => row.candidate_ids ?? []).filter(id => !focusIds.has(id)));
  const required = base.candidates.filter(row => anchors.includes(row.id));
  const rank = new Map(base.candidates.map((row, index) => [row.id, index]));
  const optional = base.candidates.filter(row => !anchors.includes(row.id) && !focusIds.has(row.id) && !attemptedEndpoints.has(row.id))
    .sort((a, b) => Number(mainIds.has(b.id)) - Number(mainIds.has(a.id))
      || rank.get(a.id) - rank.get(b.id) || a.id.localeCompare(b.id, 'zh-CN'));
  const candidates = [...required, ...optional.slice(0, Math.max(0, RELATION_WEAVING_CANDIDATE_LIMIT - required.length))];
  return { ...base, query: request, candidates, weaving: { contract: RELATION_WEAVING_CONTRACT,
    round: (job.relation_weaving?.rounds?.length ?? 0) + 1, phase: diagnosis.phase,
    attempt: previousAttempts.length + 1, max_attempts: RELATION_WEAVING_MAX_FOCUS_ATTEMPTS,
    focus_ids: diagnosis.focus.ids, focus_fingerprint: diagnosis.focus.fingerprint,
    counts: diagnosis.counts,
    topology_fingerprint: diagnosis.topology_fingerprint, selection_limit: RELATION_WEAVING_PACKAGE_LIMIT,
    instruction: '本轮只处理一个结构焦点；选择必要端点组成一个不超过 6 张卡的工作包。证据不足时保留独立并结束本轮，不为减少孤立或岛屿数量制造关系。' } };
}

/**
 * Relation weaving already has a deterministic strategy: one structural focus,
 * a small comparison pack and a fixed stop rule. A separate model planning call
 * would only restate that strategy, so the host freezes the wave directly and
 * leaves semantic relation adjudication to the author request.
 */
export function planRelationWeavingRound(pool, job) {
  if (!pool?.weaving || !pool.candidates?.length) throw Error('关系编织缺少可冻结的小型候选包。');
  const focus = new Set(pool.weaving.focus_ids ?? []), selected = pool.candidates.map(row => ({
    id: row.id,
    role: focus.has(row.id) ? 'anchor' : 'relation_endpoint',
    reason: focus.has(row.id) ? (pool.weaving.phase === 'random' ? '本轮以任务随机种子从尚未检查的有效卡片中抽取并冻结的焦点。' : '当前轮次的结构焦点。')
      : (row.retrieval?.why ? `全库关系候选检索：${row.retrieval.why}` : '宿主按正文、来源、既有关系与当前主图位置召回的只读比较端点。'),
    required_evidence: focus.has(row.id) ? ['核对焦点卡与候选端点的完整正文。'] : []
  }));
  if (pool.weaving.phase === 'random') {
    const focusId = pool.weaving.focus_ids[0], endpoints = selected.filter(row => !focus.has(row.id));
    const goal = '判断随机抽取的焦点卡能否与全库检索出的高可能候选建立一条有依据的关系。';
    const strategy = {
      goal, expected_improvement: '为随机焦点发现一条可信关系，或明确记录本轮全库检索没有产生足够可靠的端点。',
      operations: (job.construction_controls?.allowed ?? []).filter(id => id.startsWith('relation_')),
      decision_rules: ['焦点卡由可恢复的随机抽样确定，端点只按全库内容检索信号排序。', '拓扑位置不决定焦点优先级或端点优先级。', '只修改焦点卡，不做对称回写或批量补边。'],
      evidence_requirements: ['核对关系两端完整正文；检索得分只用于召回，不能代替关系成立证据。'],
      stop_conditions: ['没有检索端点或比较后没有可信关系时，记录本轮未建立关系并转向下一张随机焦点卡。']
    };
    const packages = endpoints.length ? [{ id: 'group-1', goal, card_ids: selected.map(row => row.id),
      purpose: '围绕随机焦点核对全库检索出的最可能关系端点。',
      reason: '焦点由任务种子随机抽取；端点由全库语义、来源、显式互指和关系兼容信号排序。', status: 'pending' }] : [];
    return { version: 'strategy-driven-v2', contract: 'construction-strategy-v1', strategy,
      selection: { anchors: [focusId], selected, excluded: [], packages: packages.map(({ card_ids, purpose, reason }) => ({ card_ids, purpose, reason })) },
      goal, kind: 'host-planned-random-relation-discovery', scope_count: pool.scope_count,
      inventory_revision: pool.inventory_revision, candidate_count: pool.candidates.length,
      packages, skipped: [], unselected: [], weaving: pool.weaving,
      notice: endpoints.length
        ? '本轮焦点由可恢复的随机抽样冻结；端点从全部有效卡片中检索，不按孤立卡、知识岛或主图排序。'
        : '本轮随机焦点没有召回达到候选闸门的端点，不调用模型，不据此声称该卡必然独立。' };
  }
  const phaseName = pool.weaving.phase === 'isolated' ? '完全孤立卡' : '非主图知识岛';
  const goal = `检查当前${phaseName}能否通过一条最有价值且有依据的关系接入更大的知识结构。`;
  const strategy = {
    goal,
    expected_improvement: '建立一条可信桥接关系，或明确记录本轮证据不足并保留独立。',
    operations: (job.construction_controls?.allowed ?? []).filter(id => id.startsWith('relation_')),
    decision_rules: ['只修改当前结构焦点中的至多一张卡，候选端点保持只读。', '不做对称回写，不批量补边。', '结构位置、同领域或标题相似都不构成关系证据。'],
    evidence_requirements: ['核对关系两端正文；source 关系还须提供本次交付来源中的精确原句。'],
    stop_conditions: ['找不到可信端点时保留独立并结束本轮。']
  };
  const pack = { id: 'group-1', goal, card_ids: selected.map(row => row.id),
    purpose: `围绕${phaseName}核对一个最小关系工作包。`, reason: '宿主按当前图结构和有界文本召回冻结；模型只判断是否存在可信关系。', status: 'pending' };
  return { version: 'strategy-driven-v2', contract: 'construction-strategy-v1', strategy,
    selection: { anchors: pool.candidates.filter(row => row.required).map(row => row.id), selected, excluded: [],
      packages: [{ card_ids: pack.card_ids, purpose: pack.purpose, reason: pack.reason }] },
    goal, kind: 'host-planned-relation-weaving', scope_count: pool.scope_count,
    inventory_revision: pool.inventory_revision, candidate_count: pool.candidates.length,
    packages: [pack], skipped: [], unselected: [], weaving: pool.weaving,
    notice: '关系编织由宿主直接冻结一个不超过 6 张卡的小包；模型判断关系并拟稿，不再另行调用模型制定同义策略。' };
}
