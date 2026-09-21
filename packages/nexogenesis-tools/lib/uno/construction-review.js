import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { loadCards, parseCardFile } from '../cards.js';
import { unoPath, unoRevision, unoCardRef, sha, readUnoUnit } from '../harness/uno-storage.js';
import { readDraft, validateSource } from './drafts.js';
import { executionError } from './execution-contract.js';
import { locateQuote } from './quote-locator.js';
import {listDomainsV2} from './knowledge.js';

export const CONSTRUCTION_REVIEW_PROFILE = 'direction-driven-v1';
export const usesConstructionReview = job => job.mode === 'construct' && job.construction_profile === CONSTRUCTION_REVIEW_PROFILE;
const METADATA = new Set(['title', 'type', 'domains']);
const SET_FIELDS = new Set(['domains', 'sources']);
const chars = text => Array.from(text);
const unique = values => [...new Set(values)];
const taskOf = job => `${job.id}-b${job.batch_index ?? 0}`;
const fail = (code, message, details) => { throw executionError(code, message, details); };

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameField(key, before, after) {
  if (SET_FIELDS.has(key)) return isDeepStrictEqual(unique(before ?? []).sort(), unique(after ?? []).sort());
  if (key === 'relations') return !relationChanges(before, after).added.length && !relationChanges(before, after).removed.length;
  return isDeepStrictEqual(before, after);
}
function sameRows(a, b) { return isDeepStrictEqual(a, b); }
function relationChanges(before = [], after = []) {
  // Compare records, including note/basis/origin, rather than the requested action.
  return {added:after.filter(row => !before.some(old => sameRows(old, row))),
    removed:before.filter(row => !after.some(next => sameRows(row, next)))};
}
function isNavigation(row) {
  return row?.basis === 'navigation' && (!row.origin || row.origin === 'navigation')
    || row?.basis === undefined && row?.origin === 'navigation';
}
function mechanicalChange(key, before, after, oldCard, newCard) {
  // These are exact, deterministic conversions stageKnowledge currently makes.
  // An origin change from system to document or an unknown field is NOT ignored.
  return key === 'schema' && after === 'uno-card-v4'
    || key === 'generated_by' && after === 'uno-classification-v1'
    || key === 'lifecycle' && before === undefined && after === 'active'
    || key === 'origin' && before === undefined && after === 'document'
    || ['relations', 'domains'].includes(key) && before === undefined && Array.isArray(after) && !after.length;
}
function bodyDifference(before, after) {
  const a = chars(before), b = chars(after);
  let start = 0, tail = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (tail < a.length - start && tail < b.length - start && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
  return {changed:before !== after, offset_unit:'Unicode characters',
    before:{start, end:a.length - tail, text:a.slice(start, a.length - tail).join('')},
    after:{start, end:b.length - tail, text:b.slice(start, b.length - tail).join('')},
    notice:'这是共同前后缀之间的完整变更区间，可能包含未改动的中间文字；不是逐句语义判断。'};
}
function formalSnapshot(root, id, ref, expected) {
  if (typeof ref !== 'string' || !/^01-Cards\/.+\.md$/.test(ref) || typeof expected !== 'string')
    fail('INVALID_BASELINE', '建构审核必须绑定存在的正式卡及其冻结版本。', {id});
  const path = unoPath(root, ref), revision = unoRevision(root, ref);
  if (!existsSync(path)) fail('MISSING_BASELINE', '建构原卡不存在，不能用新稿充当冻结基线。', {id, ref});
  if (revision !== expected) fail('REVISION_CONFLICT', '建构原卡版本已变化，须重建当前差异。', {id, ref});
  const parsed = parseCardFile(path);
  if (parsed.meta.id !== id || unoRevision(root, ref) !== revision)
    fail('REVISION_CONFLICT', '建构基线身份或版本不一致。', {id, ref});
  return {id, ref, revision, content_revision:sha(parsed.body), meta:parsed.meta, body:parsed.body};
}
function currentDraft(root, job, proposed) {
  if (!proposed?.card?.id || proposed.task !== taskOf(job)) fail('INVALID_DRAFT', '只能审核当前批次的建构草稿。');
  const draft = readDraft(root, taskOf(job), proposed.card.id);
  if (!draft || draft.revision !== proposed.revision || !isDeepStrictEqual(draft, proposed))
    fail('REVISION_CONFLICT', '建构草稿已变化，不能用旧或自行拼装的草稿审核。');
  if (draft.state === 'published') fail('INVALID_DRAFT', '已发布草稿不进入本次改动审核。');
  return draft;
}
function endpoint(root, job, id, cards) {
  const card = cards.get(id);
  if (!card) fail('CARD_NOT_FOUND', '关系端点不存在，不能审核导航联系。', {id});
  const ref = unoCardRef(root, card), draft = readDraft(root, taskOf(job), id);
  const alternatives = draft && draft.state !== 'published' ? [{id, ref:draft.ref, revision:draft.revision,
    content_revision:sha(draft.body), meta:draft.card, body:draft.body, draft:true, reading:'quote'}] : [];
  return {...formalSnapshot(root, id, ref, unoRevision(root, ref)), draft:false, reading:'quote',
    prefer_baseline:true, view:'baseline', alternatives};
}

/** Read-only. Snapshots are version-bound, but building them NEVER records delivery or approval. */
export function buildConstructionReview(root, job, proposed) {
  if (!usesConstructionReview(job)) return null;
  const draft = currentDraft(root, job, proposed), id = draft.card.id;
  if (!job.scope?.includes(id)) fail('WRITE_SCOPE', '建构草稿不在授权范围中。', {id});
  const baseline = formalSnapshot(root, id, draft.base_ref, draft.base_revision);
  const mergeBaselines = (draft.merges ?? []).map(item => {
    if (item.id === id || !job.scope.includes(item.id)) fail('WRITE_SCOPE', '合并对象必须是另一张已授权卡。', {id:item.id});
    return formalSnapshot(root, item.id, item.ref, item.revision);
  });
  if (new Set(mergeBaselines.map(row => row.id)).size !== mergeBaselines.length) fail('INVALID_DRAFT', '合并对象重复。');
  const changed = Object.keys({...baseline.meta, ...draft.card}).filter(key => !sameField(key, baseline.meta[key], draft.card[key]));
  const mechanical = changed.filter(key => mechanicalChange(key, baseline.meta[key], draft.card[key], baseline.meta, draft.card));
  const semantic = changed.filter(key => !mechanical.includes(key));
  const relations = relationChanges(baseline.meta.relations, draft.card.relations);
  const relationRows = [...relations.added, ...relations.removed];
  const body = bodyDifference(baseline.body, draft.body);
  const contentChanged = body.changed || semantic.some(key => !METADATA.has(key) && key !== 'relations')
    || relationRows.some(row => !isNavigation(row));
  const tier = mergeBaselines.length ? 'merge' : contentChanged ? 'content' : relationRows.length ? 'navigation' : 'metadata';
  const sources = unique(draft.card.sources ?? []), requiredSources = [];
  for (const ref of sources) {
    const binding = draft.source_bindings?.find(row => row.ref === ref), current = validateSource(root, ref);
    if (!binding || !isDeepStrictEqual(binding, current)) fail('REVISION_CONFLICT', '草稿绑定的来源版本或锚点已变化。', {ref});
    let row = requiredSources.find(item => item.ref === current.file);
    if (!row) { row = {ref:current.file, revision:current.revision, anchors:[]}; requiredSources.push(row); }
    row.anchors.push(ref);
  }
  const sourceChanges = {added:sources.filter(ref => !(baseline.meta.sources ?? []).includes(ref)),
    removed:(baseline.meta.sources ?? []).filter(ref => !sources.includes(ref))};
  const lostSources = unique([baseline, ...mergeBaselines].flatMap(row => row.meta.sources ?? [])).filter(ref => !sources.includes(ref));
  const draftCard = {id, ref:draft.ref, revision:draft.revision, content_revision:sha(draft.body), meta:draft.card,
    body:draft.body, draft:true, reading:['content', 'merge'].includes(tier) ? 'full' : 'quote'};
  const cards = loadCards(root, {includeInactive:true});
  const navigationTargets = unique(relationRows.filter(isNavigation).map(row => row.target));
  const dependencyTargets = unique([...navigationTargets, ...relations.added.map(row => row.target)]).filter(target => target !== id);
  const requiredCards = [draftCard, ...dependencyTargets.map(target => ({...endpoint(root, job, target, cards),
    support_required:navigationTargets.includes(target)}))];
  const dependencies = requiredCards.filter(item => item.id !== id).map(({id,ref,revision,draft}) => ({id,ref,revision,draft}));
  const requirements = {
    metadata:'标题、单一主类型和领域归属须受当前卡片正文支持；领域相近不等于同一知识对象。',
    navigation:'每条变化联系须核对两端正文中的具体用途；导航关系不是已证实的因果、反驳或类比。',
    content:'独立核对当前完整草稿；正文、摘要、边界或来源关系的具体改动须有绑定来源原句，保留作者归属、数字、成立条件和反证。',
    merge:'完整比较合并前各卡与当前草稿。逐项保全条件、作者立场、反证和来源锚点，不能因标题相近删去独立知识；不能保全就列 issues。',
  };
  return freeze({kind:'uno-construction-review', profile:CONSTRUCTION_REVIEW_PROFILE, id, tier,
    revision:draft.revision, baseline, draft:draftCard,
    changed_fields:[...semantic, ...(body.changed ? ['body'] : []), ...(mergeBaselines.length ? ['merges'] : [])],
    mechanical_fields:mechanical,
    changes:{metadata:Object.fromEntries(changed.map(key => [key, {before:baseline.meta[key] ?? null, after:draft.card[key] ?? null}])),
      body, sources:sourceChanges, relations, merges:mergeBaselines.map(({id, ref, revision}) => ({id, ref, revision}))},
    required_cards:requiredCards, dependencies,
    required_sources:['content', 'merge'].includes(tier) ? requiredSources : [],
    baselines:tier === 'merge' ? [baseline, ...mergeBaselines].map(row => ({...row, reading:'full'})) : [],
    preservation:{source_anchors_preserved:!lostSources.length, missing_source_anchors:lostSources,
      semantic_checks:tier === 'merge' ? ['conditions', 'author_attribution', 'counterevidence', 'source_anchors'] : []},
    instructions:unique([requirements[tier], ...(semantic.some(key => METADATA.has(key)) && tier !== 'metadata' ? [requirements.metadata] : []),
      ...(navigationTargets.length && tier !== 'navigation' ? [requirements.navigation] : [])]),
    notice:'程序只核对真实差异、版本、交付区间和引文位置；引文存在不等于语义正确或保全通过。首包未实际交付前不得登记阅读。关系目标默认为正式版本；如明确依据 alternatives 中的草稿，须读该版本并在 checks.ref 引用其实际路径。'});
}

function readingFor(job, item) {
  const exactSession = row => row?.session_id === job.session_id && job.session_id;
  const card = job.review_reads?.[item.id], evidence = job.review_evidence?.[item.ref];
  if (exactSession(card) && card.revision === item.revision) return card;
  // Body identity alone must not authorize a newer metadata proposal that has
  // never been delivered. Baselines/sources are separately frozen by version.
  if (exactSession(evidence) && (evidence.revision === item.revision
    || !item.draft && evidence.revision === item.content_revision)) return evidence;
  return null;
}
function intervals(row, total) {
  const result = [];
  for (const span of [...(row?.intervals ?? [])].filter(span => Array.isArray(span) && span.length === 2
    && Number.isInteger(span[0]) && Number.isInteger(span[1]) && span[0] >= 0 && span[1] >= span[0] && span[1] <= total).sort((a,b) => a[0]-b[0])) {
    const previous = result.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else result.push([...span]);
  }
  return result;
}
function sourceSnapshot(root, source) {
  const unit = source.ref.startsWith('05-Buffer/') ? readUnoUnit(root, source.ref) : parseCardFile(unoPath(root, source.ref));
  const revision = source.ref.startsWith('05-Buffer/') ? sha(unit.body) : unoRevision(root, source.ref);
  if (revision !== source.revision) fail('REVISION_CONFLICT', '审核读取期间来源已变化。', {ref:source.ref});
  return {...source, body:unit.body, content_revision:sha(unit.body)};
}
function assertFull(job, item) {
  const row = readingFor(job, item), total = chars(item.body).length, ranges = intervals(row, total);
  if (!row || total && !(ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === total))
    fail('UNDELIVERED_EVIDENCE', '须在当前审核会话完整读回本版本：'+item.ref);
}

/**
 * Checks retain the existing {id,claim,ref,quote} contract. The caller persists the
 * returned receipts with the exact draft revision; this function writes nothing.
 * Compile and old construction profiles deliberately keep their existing checks.
 */
export function validateConstructionReview(root, job, args, drafts) {
  if (!usesConstructionReview(job) || !args.note) return new Map();
  if (job.role !== 'reviewer' || !job.session_id) fail('WRONG_ROLE', '建构改动须由独立审核会话核对。');
  const ids = args.ids ?? drafts.map(d => d.card.id), checks = args.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 24) fail('INVALID_ARGUMENTS', '审核 checks 最多 24 项。');
  const byId = new Map(drafts.map(d => [d.card.id, d])), plans = new Map(), verified = new Map();
  for (const id of ids) if (byId.has(id)) plans.set(id, buildConstructionReview(root, job, byId.get(id)));
  for (const check of checks) {
    const plan = check && plans.get(check.id);
    if (!plan) fail('INVALID_ARGUMENTS', 'checks 只能核对本次审核的建构草稿 ID。');
    for (const key of ['claim', 'quote']) if (typeof check[key] !== 'string' || !check[key].trim() || chars(check[key]).length > 600)
      fail('INVALID_ARGUMENTS', `审核 ${key} 必须为 1–600 字符的具体内容。`);
    let item = [...plan.required_cards.flatMap(row => [row, ...(row.alternatives ?? [])]), ...plan.baselines].find(row => row.ref === check.ref);
    let kind = item ? (item.draft ? 'draft' : plan.baselines.some(row => row.ref === item.ref) ? 'baseline' : 'card') : 'source';
    if (!item) {
      const source = plan.required_sources.find(row => row.ref === check.ref);
      if (!source) fail('INVALID_SOURCE', '审核引用必须属于本次差异所需的草稿、两端卡片、合并基线或绑定来源。');
      item = sourceSnapshot(root, source);
    }
    const reading = readingFor(job, item);
    if (!reading) fail('STALE_EVIDENCE', '审核引文所在版本尚未交付给当前独立审核会话。', {ref:item.ref});
    const match = locateQuote(item.body, check.quote, {intervals:intervals(reading, chars(item.body).length)});
    if (!match) fail('UNDELIVERED_EVIDENCE', '审核原句不在实际交付区间中，或改动了原句内容。', {ref:item.ref});
    verified.set(check.id, [...(verified.get(check.id) ?? []), {claim:check.claim.trim(), ref:item.ref,
      revision:item.revision, content_revision:item.content_revision, kind, ...match}]);
  }
  const result = new Map();
  for (const [id, plan] of plans) {
    const issues = (args.issues ?? []).filter(row => row.id === id), evidence = verified.get(id) ?? [];
    if(!issues.length&&job.construction_controls&&plan.changed_fields.includes('domains')){
      const draft=byId.get(id);
      for(const domainId of draft.card.domains){
        const domain=listDomainsV2(root).find(row=>row.id===domainId),reading=job.review_domain_reads?.[domainId];
        if(!domain||draft.domain_revisions?.[domainId]!==domain.revision||reading?.session_id!==job.session_id||reading.revision!==domain.revision||!reading.intervals?.some(([start,end])=>start===0&&end>=Array.from(domain.body).length))fail('DOMAIN_REVIEW_REQUIRED','请完整读取当前领域定义后再审核归属：'+domainId);
      }
    }
    const dependencies = plan.required_cards.filter(item => item.id !== id).map(item => {
      const selected = [item, ...(item.alternatives ?? [])].filter(option => evidence.some(row => row.ref === option.ref));
      if (selected.length > 1) fail('AMBIGUOUS_EVIDENCE', '关系审核须明确依据端点的正式版本或草稿版本，不能混用。', {id,target:item.id});
      const chosen = selected[0] ?? item;
      return {id:chosen.id, ref:chosen.ref, revision:chosen.revision, draft:chosen.draft};
    });
    if (!issues.length) {
      if (byId.get(id).state !== 'pending') fail('INVALID_DRAFT', '基础校验未通过的建构草稿不能审核通过。', {id});
      if (!plan.preservation.source_anchors_preserved) fail('MISSING_SOURCE_ANCHOR', '建构不能丢失原卡或合并卡的来源锚点。', {id});
      const has = ref => evidence.some(row => row.ref === ref);
      if (['metadata', 'navigation'].includes(plan.tier) && !has(plan.draft.ref))
        fail('MISSING_REVIEW_CHECK', '标题、分类或导航改动须给出当前卡片正文支持。', {id});
      for (const item of plan.required_cards) {
        if (item.reading === 'full') assertFull(job, item);
        if (item.support_required && ![item, ...(item.alternatives ?? [])].some(option => has(option.ref)))
          fail('MISSING_REVIEW_CHECK', '导航改动须给出关系另一端的正文支持。', {id, target:item.id});
      }
      if (['content', 'merge'].includes(plan.tier) && !evidence.some(row => row.kind === 'source'))
        fail('MISSING_REVIEW_CHECK', '内容或合并改动须给出精确的绑定来源原句。', {id});
      if (plan.tier === 'merge') {
        for (const item of plan.baselines) {
          assertFull(job, item);
          if (!has(item.ref)) fail('MISSING_REVIEW_CHECK', '合并须逐卡核对旧知识的保全依据。', {id, baseline:item.id});
        }
        if (!has(plan.draft.ref)) fail('MISSING_REVIEW_CHECK', '合并须在新稿中指明保全后的内容。', {id});
      }
    }
    result.set(id, {tier:plan.tier, revision:plan.revision, baseline_revision:plan.baseline.revision,
      baseline_ref:plan.baseline.ref, changed_fields:plan.changed_fields,
      dependencies,
      source_anchors_preserved:plan.preservation.source_anchors_preserved,
      checked_revisions:unique(evidence.map(row => `${row.ref}\0${row.revision}`)).map(value => {
        const [ref, revision] = value.split('\0'); return {ref, revision};
      }), checks:evidence, session_id:job.session_id,
      semantic_review:'reviewer_judgment_required'});
  }
  return result;
}
