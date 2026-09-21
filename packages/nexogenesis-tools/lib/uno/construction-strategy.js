import { createHash } from 'node:crypto';
import { loadCards } from '../cards.js';
import { unoCardRef, unoRevision } from '../harness/uno-storage.js';

export const STRATEGY_CONSTRUCTION_PROFILE = 'strategy-driven-v2';
export const STRATEGY_CONSTRUCTION_WORKFLOW = 'uno-construction-v1';
export const CONSTRUCTION_STRATEGY_CONTRACT = 'construction-strategy-v1';
export const CONSTRUCTION_REVIEW_POLICY = 'construction-review-v2';
export const CONSTRUCTION_CANDIDATE_LIMIT = 32;
export const CONSTRUCTION_SELECTION_LIMIT = 24;
export const CONSTRUCTION_PACKAGE_LIMIT = 6;

const normalized = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const words = value => new Set([...segmenter.segment(normalized(value).toLowerCase())]
  .filter(row => row.isWordLike && row.segment.length > 1).map(row => row.segment));
const overlap = (left, right) => [...left].reduce((total, word) => total + Number(right.has(word)), 0);
const stringArray = (value, name, { maximum = 24, allowEmpty = true } = {}) => {
  if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > maximum
    || value.some(item => typeof item !== 'string' || !item.trim())) throw Error(`${name}无效。`);
  return [...new Set(value.map(item => item.trim()))];
};

function candidateRow(root, id, card, { required = false, query = new Set() } = {}) {
  const title = words(card.meta.title);
  const searchable = words([card.meta.title, card.meta.type, ...(card.meta.domains ?? []), card.meta.summary,
    card.body.slice(0, 1800)].join(' '));
  const related = (card.meta.relations ?? []).filter(row => row?.target && row?.type).slice(0, 8)
    .map(row => ({ target: row.target, type: row.type, basis: row.basis ?? (row.origin === 'navigation' ? 'navigation' : 'source') }));
  return { id, title: card.meta.title ?? id, type: card.meta.type, domains: card.meta.domains ?? [],
    summary: normalized(card.meta.summary).slice(0, 600), sources: (card.meta.sources ?? []).slice(0, 8),
    existing_relations: related, revision: unoRevision(root, unoCardRef(root, card)), required,
    title_words: title, searchable, query_score: overlap(query, title) * 5 + overlap(query, searchable) };
}

const publicCandidate = ({ title_words, searchable, query_score, ...row }) => row;

/** Build the same frozen candidate shape for an explicit retrieval result. */
export function constructionCandidateRows(root, ids, { required_ids = [] } = {}) {
  const cards = loadCards(root, { includeInactive: false }), required = new Set(required_ids);
  return [...new Set(ids)].map(id => {
    const card = cards.get(id);
    if (!card || card.meta.type === 'domain') return null;
    return publicCandidate(candidateRow(root, id, card, { required: required.has(id) }));
  }).filter(Boolean);
}

/**
 * Deterministic recall only. The model makes the actual construction selection.
 * Explicit user cards are mandatory anchors and can never be displaced by rank.
 */
export function constructionCandidatePool(root, { notes = '', card_ids, domain = '', type = '', requirements = {} } = {}) {
  const cards = loadCards(root, { includeInactive: false });
  const explicit = Array.isArray(card_ids) ? [...new Set(card_ids)] : [];
  const query = words([notes, requirements?.construction_query, requirements?.long_term].filter(Boolean).join(' '));
  const rows = [...cards].filter(([, card]) => card.meta.type !== 'domain'
    && (!domain || (card.meta.domains ?? []).includes(domain)) && (!type || card.meta.type === type))
    .map(([id, card]) => candidateRow(root, id, card, { required: explicit.includes(id), query }));
  if (explicit.some(id => !rows.some(row => row.id === id))) throw Error('用户指定卡片不存在、已退役或不属于当前领域与类型范围。');
  const required = rows.filter(row => row.required).sort((a, b) => explicit.indexOf(a.id) - explicit.indexOf(b.id));
  const explicitIds = new Set(required.map(row => row.id));
  const anchorWords = new Set(required.flatMap(row => [...row.searchable]));
  const anchorSources = new Set(required.flatMap(row => row.sources));
  const anchorDomains = new Set(required.flatMap(row => row.domains));
  const anchorTargets = new Set(required.flatMap(row => row.existing_relations.map(relation => relation.target)));
  const score = row => row.query_score
    + overlap(anchorWords, row.title_words) * 4
    + overlap(anchorWords, row.searchable)
    + row.sources.filter(source => anchorSources.has(source)).length * 12
    + row.domains.filter(id => anchorDomains.has(id)).length * 3
    + Number(anchorTargets.has(row.id) || row.existing_relations.some(relation => explicitIds.has(relation.target))) * 24;
  const ranked = rows.filter(row => !row.required).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const selected = [...required, ...ranked.slice(0, Math.max(0, CONSTRUCTION_CANDIDATE_LIMIT - required.length))];
  if (!selected.length && rows.length) selected.push(...rows.slice(0, CONSTRUCTION_CANDIDATE_LIMIT));
  return { contract: CONSTRUCTION_STRATEGY_CONTRACT, query: normalized(notes), domain, type,
    scope_count: rows.length, allowed_operations: requirements?.construction_controls?.allowed ?? [],
    candidates: selected.map(publicCandidate),
    inventory_revision: hash(rows.map(row => [row.id, row.revision]).sort(([a], [b]) => a.localeCompare(b))) };
}

function strategyText(value, name, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum) throw Error(`建构策略缺少有效的${name}。`);
  return value.trim();
}

export function validateConstructionStrategy(value, pool) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('建构策略响应必须是 JSON 对象。');
  const raw = value.strategy, selection = value.selection;
  if (!raw || !selection || typeof raw !== 'object' || typeof selection !== 'object') throw Error('建构策略响应缺少 strategy 或 selection。');
  const strategy = {
    goal: strategyText(raw.goal, '目标'),
    expected_improvement: strategyText(raw.expected_improvement, '预期改善'),
    operations: stringArray(raw.operations, '策略操作', { maximum: 12, allowEmpty: true }),
    decision_rules: stringArray(raw.decision_rules, '判断规则', { maximum: 16, allowEmpty: false }),
    evidence_requirements: stringArray(raw.evidence_requirements, '证据要求', { maximum: 16, allowEmpty: false }),
    stop_conditions: stringArray(raw.stop_conditions, '停止条件', { maximum: 16, allowEmpty: false })
  };
  if (strategy.operations.some(operation => !(pool.allowed_operations ?? []).includes(operation))) throw Error('建构策略包含用户未授权的操作。');
  const byId = new Map(pool.candidates.map(row => [row.id, row]));
  const selectedRows = selection.selected;
  const selectionLimit = pool.weaving?.selection_limit ?? CONSTRUCTION_SELECTION_LIMIT;
  if (!Array.isArray(selectedRows) || selectedRows.length > selectionLimit) throw Error(`选卡结果最多 ${selectionLimit} 张。`);
  const selected = selectedRows.map(row => {
    if (!row || typeof row !== 'object' || !byId.has(row.id)) throw Error('选卡结果包含候选池之外的卡片。');
    return { id: row.id, role: strategyText(row.role, '卡片角色', 80), reason: strategyText(row.reason, '选卡理由', 1200),
      required_evidence: stringArray(row.required_evidence ?? [], '卡片证据要求', { maximum: 12, allowEmpty: true }) };
  });
  if (new Set(selected.map(row => row.id)).size !== selected.length) throw Error('选卡结果包含重复卡片。');
  const selectedIds = new Set(selected.map(row => row.id));
  for (const anchor of pool.candidates.filter(row => row.required)) if (!selectedIds.has(anchor.id)) throw Error('策略不能丢弃用户明确选择的卡片：' + anchor.id);
  const excluded = Array.isArray(selection.excluded) ? selection.excluded.map(row => {
    if (!row || !byId.has(row.id) || selectedIds.has(row.id)) throw Error('排除项无效或与选卡结果冲突。');
    return { id: row.id, reason: strategyText(row.reason, '排除理由', 1000) };
  }) : [];
  if (new Set(excluded.map(row => row.id)).size !== excluded.length) throw Error('排除项包含重复卡片。');
  const packages = [];
  const seen = new Set();
  if (selected.length) {
    if (!Array.isArray(selection.packages) || !selection.packages.length) throw Error('选卡结果缺少工作包。');
    for (const [index, item] of selection.packages.entries()) {
      const ids = stringArray(item?.card_ids, '工作包卡片', { maximum: CONSTRUCTION_PACKAGE_LIMIT, allowEmpty: false });
      if (ids.some(id => !selectedIds.has(id) || seen.has(id))) throw Error('工作包只能各包含一次已选卡片。');
      ids.forEach(id => seen.add(id));
      packages.push({ id: `group-${index + 1}`, goal: strategy.goal, card_ids: ids,
        purpose: strategyText(item.purpose, '工作包目的', 1200), reason: strategyText(item.reason ?? item.purpose, '工作包理由', 1200), status: 'pending' });
    }
    if (seen.size !== selected.length) throw Error('每张已选卡片必须且只能进入一个工作包。');
  }
  if (pool.weaving && packages.length > 1) throw Error('关系编织每轮只能产生一个小型工作包。');
  return { version: STRATEGY_CONSTRUCTION_PROFILE, contract: CONSTRUCTION_STRATEGY_CONTRACT,
    strategy, selection: { anchors: pool.candidates.filter(row => row.required).map(row => row.id), selected, excluded, packages },
    goal: strategy.goal, kind: 'model-strategy', scope_count: pool.scope_count, inventory_revision: pool.inventory_revision,
    candidate_count: pool.candidates.length, packages, skipped: [],
    unselected: pool.candidates.filter(row => !selectedIds.has(row.id)).map(row => row.id),
    ...(pool.weaving ? { weaving: pool.weaving } : {}),
    notice: '候选池由宿主有界召回；模型负责制定策略并选择工作卡。未入选内容尚未检查。' };
}

export function constructionStrategyFingerprint(plan) {
  return hash({ contract: plan.contract, strategy: plan.strategy, selection: plan.selection,
    inventory_revision: plan.inventory_revision });
}
