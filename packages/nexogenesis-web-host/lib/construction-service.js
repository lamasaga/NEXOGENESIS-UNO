import { randomUUID, createHash } from 'node:crypto';
import { loadCards, parseCardFile } from '../../nexogenesis-tools/lib/cards.js';
import { HarnessGateway } from '../../nexogenesis-tools/lib/harness/gateway.js';
import { unoCardRef, unoRevision, unoPath, readUnoUnit } from '../../nexogenesis-tools/lib/harness/uno-storage.js';
import { listDomainsV2 } from '../../nexogenesis-tools/lib/uno/knowledge.js';
import { retrievalQueryTokens } from '../../nexogenesis-tools/lib/graph-ops.js';
import { readDraft, validateSource } from '../../nexogenesis-tools/lib/uno/drafts.js';
import { inspectBookUnit } from '../../nexogenesis-tools/lib/uno/book-sources.js';
import { isBookMaterialPath } from '../../nexogenesis-tools/lib/uno/book-paths.js';
import { assertConstructionDraft } from '../../nexogenesis-tools/lib/uno/construction-permissions.js';
import { saveCompileJob, readCompileJob } from '../../nexogenesis-tools/lib/uno/state.js';
import { bindProviderBudgetSession, getProviderBudget } from '../../nexogenesis-tools/lib/uno/request-budget.js';
import { assertBoundedModel, budgetStopCode } from './uno-orchestration.js';
import { broadcastGraphEvent } from './events-bus.js';
import { settleResumeGuard } from './resume-plan.js';

export const CONSTRUCTION_REPAIR_SCOPE_CONTRACT = 'construction-repair-endpoint-scope-v1';
import { domainCatalogRows } from '../../nexogenesis-tools/lib/uno/card-classification.js';
import { constructionCandidatePool, constructionStrategyFingerprint, validateConstructionStrategy,
  STRATEGY_CONSTRUCTION_PROFILE, STRATEGY_CONSTRUCTION_WORKFLOW } from '../../nexogenesis-tools/lib/uno/construction-strategy.js';
import { inspectRelationWeaving, planRelationWeavingRound, relationWeavingCandidatePool, relationWeavingEnabled,
  RELATION_WEAVING_CONTRACT, RELATION_WEAVING_MAX_FOCUS_ATTEMPTS } from '../../nexogenesis-tools/lib/uno/construction-weaving.js';
import { buildConstructionAuthorRequest, buildConstructionResponseRecoveryRequest, buildConstructionReviewRequest, buildConstructionStrategyRequest,
  constructionJSONRecovery, normalizeConstructionReviewResponse, parseConstructionJSON,
  validateConstructionAuthorResponse, validateConstructionReviewResponse } from './construction-request.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relationKey = row => JSON.stringify([row?.target, row?.type, row?.note ?? '', row?.basis ?? (row?.origin === 'navigation' ? 'navigation' : 'source')]);
const taskOf = (job, index = job.batch_index ?? 0) => `${job.id}-b${index}`;
const requestStage = (job, stage) => `batch-${job.batch_index}-${stage}-resume-${job.resume_round ?? 0}`;
const clone = value => JSON.parse(JSON.stringify(value));
const CONSTRUCTION_SOURCE_EXCERPT_LIMIT = 5000;
const CONSTRUCTION_SOURCE_WINDOW = 1200;
const CONSTRUCTION_SOURCE_MAX_WINDOWS = 5;
const randomRelationWeaving = job => job?.relation_weaving?.contract === RELATION_WEAVING_CONTRACT;
const compactWeavingDiagnosis = value => ({ contract: value.contract, phase: value.phase, counts: value.counts,
  main_component: value.main_component ? { size: value.main_component.size, fingerprint: value.main_component.fingerprint } : null,
  focus_selection: value.focus_selection,
  topology_fingerprint: value.topology_fingerprint });

function rememberResponseRecovery(root, jobId, phase, text, recovery) {
  if (!recovery) return;
  const saved = readCompileJob(root, jobId);
  const call = [...(saved.calls ?? [])].reverse().find(row => row.phase === phase && row.status === 'completed' && row.response === text);
  if (call && JSON.stringify(call.response_recovery) !== JSON.stringify(recovery)) {
    call.response_recovery = recovery;
    saveCompileJob(root, saved);
  }
}

function parseResponse(root, jobId, phase, text) {
  const value = parseConstructionJSON(text), recovery = constructionJSONRecovery(value);
  rememberResponseRecovery(root, jobId, phase, text, recovery);
  return value;
}

function retainedContractResponse(job, phase) {
  const failure = job.direct_work?.[job.batch_index]?.response_contract_failures?.[phase];
  if (!failure || failure.resolved || !failure.call_id) return null;
  return job.calls?.find(row => row.id === failure.call_id && row.status === 'completed')?.response ?? null;
}

function validateLocalStageResponse(root, jobId, phase, text, kind, ids) {
  let value = parseResponse(root, jobId, phase, text);
  if (kind === 'review') {
    const normalized = normalizeConstructionReviewResponse(value);
    value = normalized.value;
    const result = validateConstructionReviewResponse(value, ids);
    if (normalized.changes.length) rememberResponseRecovery(root, jobId, phase, text,
      { contract: 'construction-review-normalize-v1', changes: normalized.changes });
    return result;
  }
  return validateConstructionAuthorResponse(value, ids);
}

export const isStrategyConstruction = job => job?.mode === 'construct'
  && job.construction_profile === STRATEGY_CONSTRUCTION_PROFILE && job.workflow === STRATEGY_CONSTRUCTION_WORKFLOW;

function activeJob(root, id, signal) {
  signal.throwIfAborted();
  const job = readCompileJob(root, id);
  if (!isStrategyConstruction(job) || job.status !== 'running' || job.pause_requested || job.end_requested)
    throw Object.assign(new Error('任务已停止或不属于策略建构协议。'), { code: 'CONSTRUCTION_STOPPED' });
  return job;
}

async function runRequest(ctx, root, initial, request, signal, { role, packageId, stageId, stageLimit = 1, reviewReserve } = {}) {
  let job = activeJob(root, initial.id, signal);
  assertBoundedModel(job, job.model_selection, ctx);
  bindProviderBudgetSession(root, { jobId: job.id, sessionId: job.session_id, packageId, role, stageId, stageLimit, reviewReserve });
  const call = { id: randomUUID(), phase: request.nexoPrompt.phase, role, batch: job.batch_index,
    ...(request.nexoPrompt.weaving_round ? { weaving_round: request.nexoPrompt.weaving_round } : {}),
    ...(request.nexoPrompt.recovery_for ? { recovery_for: request.nexoPrompt.recovery_for } : {}),
    status: 'running', started_at: new Date().toISOString(), context: request.construction_context };
  job.calls.push(call); saveCompileJob(root, job);
  broadcastGraphEvent(job.owner_session_id ?? job.session_id, { type: 'work.updated', payload: { workflow: 'construct', job_id: job.id, phase: job.phase, role } });
  let text = '', finish;
  try {
    for await (const chunk of ctx.get('llm').stream({ ...request, sessionId: job.session_id, signal,
      nexoPrompt: { ...request.nexoPrompt, root } })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'usage') call.usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    activeJob(root, job.id, signal);
    if (finish?.kind !== 'stop') throw Object.assign(new Error(`模型响应未完整结束：${finish?.kind ?? '连接中断'}。`),
      { code: ['max-tokens', 'length'].includes(finish?.kind) ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_RESPONSE_INCOMPLETE', partialResponse: text });
    if (!text.trim()) throw Object.assign(new Error('模型没有返回可解析的建构响应。'), { code: 'MODEL_EMPTY_RESPONSE' });
    call.status = 'completed'; return text;
  } catch (error) { call.status = signal.aborted ? 'cancelled' : 'failed'; call.error = error.message; throw error; }
  finally {
    call.finished_at = new Date().toISOString(); call.response = text;
    job = readCompileJob(root, initial.id);
    const index = job.calls.findIndex(row => row.id === call.id);
    if (index >= 0) job.calls[index] = call;
    saveCompileJob(root, job);
    broadcastGraphEvent(job.owner_session_id ?? job.session_id, { type: 'work.updated', payload: { workflow: 'construct', job_id: job.id, phase: job.phase, role } });
  }
}

async function validateStageResponse(ctx, root, initial, pack, signal, { phase, kind, text, ids }) {
  try { return validateLocalStageResponse(root, initial.id, phase, text, kind, ids); }
  catch (error) {
    if (!['INVALID_GENERATION_RESPONSE', 'CONSTRUCTION_AUTHOR_CONTRACT', 'CONSTRUCTION_REVIEW_CONTRACT'].includes(error?.code)) throw error;
    let job = activeJob(root, initial.id, signal), work = job.direct_work[job.batch_index] ??= {};
    const call = [...(job.calls ?? [])].reverse().find(row => row.phase === phase && row.status === 'completed' && row.response === text);
    work.response_contract_failures ??= {};
    const previous = work.response_contract_failures[phase];
    work.response_contract_failures[phase] = { contract: 'construction-response-recovery-v1', kind,
      call_id: call?.id ?? previous?.call_id ?? null, error: error.message, attempts: previous?.attempts ?? 0, resolved: false,
      at: new Date().toISOString() };
    job.detail = `${kind === 'review' ? '建构审核' : '建构执行'}返回格式不完整，正在进行一次局部格式恢复。`;
    saveCompileJob(root, job);
    const recoveryText = await runRequest(ctx, root, job,
      buildConstructionResponseRecoveryRequest(job, { failedPhase: phase, response: text, error: error.message, ids, kind }), signal,
      { role: kind === 'review' ? 'reviewer' : 'author', packageId: `batch-${job.batch_index}`,
        stageId: requestStage(job, `${phase}-response-recovery`), stageLimit: 1 });
    let recovered;
    try { recovered = validateLocalStageResponse(root, initial.id, 'construction-response-recovery', recoveryText, kind, ids); }
    catch (recoveryError) {
      job = activeJob(root, initial.id, signal); work = job.direct_work[job.batch_index] ??= {};
      work.response_contract_failures ??= {};
      const failure = work.response_contract_failures[phase] ?? {};
      work.response_contract_failures[phase] = { ...failure, attempts: (failure.attempts ?? 0) + 1,
        recovery_error: recoveryError.message, resolved: false, at: new Date().toISOString() };
      saveCompileJob(root, job);
      const code = kind === 'review' ? 'CONSTRUCTION_REVIEW_CONTRACT' : 'CONSTRUCTION_AUTHOR_CONTRACT';
      throw Object.assign(new Error(`${kind === 'review' ? '建构审核' : '建构执行'}返回格式未能安全恢复；已保留原响应，可从当前检查点仅重试格式恢复。`), { code });
    }
    job = activeJob(root, initial.id, signal); work = job.direct_work[job.batch_index] ??= {};
    work.response_contract_failures ??= {}; work.response_recoveries ??= {};
    const failure = work.response_contract_failures[phase] ?? {};
    work.response_contract_failures[phase] = { ...failure, attempts: (failure.attempts ?? 0) + 1, resolved: true,
      resolved_at: new Date().toISOString() };
    work.response_recoveries[phase] = { contract: 'construction-response-recovery-v1', kind,
      source_call_id: failure.call_id ?? null, recovered_call_id: [...job.calls].reverse().find(row => row.phase === 'construction-response-recovery')?.id ?? null };
    job.detail = `${kind === 'review' ? '审核' : '执行'}返回格式已恢复，继续当前建构工作包。`;
    saveCompileJob(root, job);
    return recovered;
  }
}

function claimTerms(card) {
  const weights = new Map(), add = (value, weight) => {
    for (const term of retrievalQueryTokens(String(value ?? ''))) {
      if (term.length < 2 || term.length > 12) continue;
      weights.set(term, Math.max(weights.get(term) ?? 0, weight));
    }
  };
  add(card.title, 12); add(card.summary, 8); add(card.boundary, 6);
  add(String(card.body ?? '').replace(/^#{1,6}\s+.*$/gmu, ' ').slice(0, 12000), 3);
  return [...weights].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length
    || left[0].localeCompare(right[0], 'zh-CN')).slice(0, 80);
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 80) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function rangeChars(ranges) { return ranges.reduce((total, range) => total + range.end - range.start, 0); }

function omittedRanges(start, end, delivered) {
  const omitted = []; let cursor = start;
  for (const range of delivered) {
    if (range.start > cursor) omitted.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) omitted.push({ start: cursor, end });
  return omitted;
}

function evidenceWindows(chars, requestedStart, requestedEnd, cards) {
  const length = requestedEnd - requestedStart;
  if (length <= CONSTRUCTION_SOURCE_EXCERPT_LIMIT) return [{ start: requestedStart, end: requestedEnd }];
  const source = chars.slice(requestedStart, requestedEnd).join(''), candidates = [];
  for (const card of cards) for (const [term, weight] of claimTerms(card)) {
    let from = 0;
    for (let occurrence = 0; occurrence < 4; occurrence++) {
      const codeUnitAt = source.indexOf(term, from); if (codeUnitAt < 0) break;
      const at = Array.from(source.slice(0, codeUnitAt)).length;
      const nearby = chars.slice(requestedStart + Math.max(0, at - 240), requestedStart + Math.min(length, at + Array.from(term).length + 520)).join('');
      const qualifier = /反例|不适用|仅限|除非|但是|然而|前提|条件|限制|边界|失效/u.test(nearby) ? 8 : 0;
      candidates.push({ card_id: card.id, at: requestedStart + at, term, score: weight * Math.min(6, term.length) + qualifier });
      from = codeUnitAt + term.length;
    }
  }
  candidates.sort((left, right) => right.score - left.score || right.term.length - left.term.length || left.at - right.at);
  const chosen = [], coveredCards = new Set(), ordered = [];
  for (const card of cards) {
    const match = candidates.find(row => row.card_id === card.id);
    if (match) { ordered.push(match); coveredCards.add(card.id); }
  }
  for (const candidate of candidates) if (!ordered.includes(candidate)) ordered.push(candidate);
  for (const candidate of ordered) {
    if (chosen.length >= CONSTRUCTION_SOURCE_MAX_WINDOWS) break;
    const termLength = Array.from(candidate.term).length;
    let start = Math.max(requestedStart, candidate.at - 320);
    let end = Math.min(requestedEnd, Math.max(candidate.at + termLength + 520, start + CONSTRUCTION_SOURCE_WINDOW));
    if (end - start > CONSTRUCTION_SOURCE_WINDOW) end = start + CONSTRUCTION_SOURCE_WINDOW;
    if (end === requestedEnd) start = Math.max(requestedStart, end - CONSTRUCTION_SOURCE_WINDOW);
    const next = mergeRanges([...chosen, { start, end }]);
    if (rangeChars(next) > CONSTRUCTION_SOURCE_EXCERPT_LIMIT) continue;
    if (chosen.some(range => candidate.at >= range.start && candidate.at < range.end)) continue;
    chosen.splice(0, chosen.length, ...next);
  }
  return chosen;
}

function sourceExcerpt(root, ref, cards) {
  const [file, anchor = ''] = ref.split('#');
  const source = isBookMaterialPath(file) && file.includes('/units/')
    ? inspectBookUnit(root, { book_units: [{ ref: file }] }, file).body
    : file.startsWith('05-Buffer/') ? readUnoUnit(root, file).body : parseCardFile(unoPath(root, file)).body;
  const chars = Array.from(source);
  const range = /^char-(\d+)-(\d+)$/.exec(anchor);
  let requestedStart = 0, requestedEnd = chars.length;
  if (range) {
    requestedStart = Math.max(0, Math.min(chars.length, Number(range[1])));
    requestedEnd = Math.max(requestedStart, Math.min(chars.length, Number(range[2])));
  }
  if (anchor) {
    const marker = '^' + anchor, at = source.indexOf(marker);
    if (!range && at >= 0) {
      const unicodeAt = Array.from(source.slice(0, at)).length;
      requestedStart = Math.max(0, unicodeAt - 1200);
      requestedEnd = Math.min(chars.length, unicodeAt + 3600);
    }
  }
  const delivered = evidenceWindows(chars, requestedStart, requestedEnd, cards);
  const fragments = delivered.map(row => chars.slice(row.start, row.end).join(''));
  const text = fragments.map((fragment, index) => `【来源 Unicode 字符 ${delivered[index].start}–${delivered[index].end}】\n${fragment}`).join('\n[…未交付区间…]\n');
  const deliveredChars = rangeChars(delivered);
  return { text, delivered_ranges: delivered, omitted_ranges: omittedRanges(requestedStart, requestedEnd, delivered),
    delivered_chars: deliveredChars, total: chars.length, complete: deliveredChars === requestedEnd - requestedStart,
    selection_method: delivered.length && deliveredChars < requestedEnd - requestedStart ? 'claim-aligned-windows-v1'
      : delivered.length ? 'complete-requested-range' : 'no-claim-aligned-window',
    matched_card_ids: cards.map(card => card.id), requested_range: { start: requestedStart, end: requestedEnd } };
}

function evidenceFor(root, job, pack) {
  const formal = loadCards(root, { includeInactive: true }), task = taskOf(job), cards = [], sourceRows = [], sourceSeen = new Set();
  for (const id of pack.card_ids) {
    const draft = readDraft(root, task, id), original = formal.get(id);
    if (!original) throw Error('策略选择的卡片已经退役或不存在：' + id);
    const meta = draft?.card ?? original.meta, body = draft?.body ?? original.body;
    cards.push({ id, revision: draft?.revision ?? unoRevision(root, unoCardRef(root, original)), formal_revision: unoRevision(root, unoCardRef(root, original)),
      draft: Boolean(draft), title: meta.title, type: meta.type, domains: meta.domains ?? [], summary: meta.summary ?? '', boundary: meta.boundary ?? '',
      sources: meta.sources ?? [], relations: meta.relations ?? [], body });
    if (!pack.weaving) for (const ref of meta.sources ?? []) sourceSeen.add(ref);
  }
  for (const ref of sourceSeen) {
    const sourceCards = cards.filter(card => card.sources.includes(ref));
    try { const binding = validateSource(root, ref); sourceRows.push({ ref, revision: binding.revision, ...sourceExcerpt(root, ref, sourceCards) }); }
    catch (error) { sourceRows.push({ ref, unavailable: true, error: error.message }); }
  }
  const domains = listDomainsV2(root).filter(row => cards.some(card => card.domains.includes(row.id)))
    .map(row => ({ id: row.id, title: row.title, summary: row.summary, revision: row.revision, body: row.body }));
  return { cards, sources: sourceRows, domains, source_chars: sourceRows.reduce((total, row) => total + (row.delivered_chars ?? 0), 0) };
}

function normalizePlanPackages(root, plan) {
  const cards = loadCards(root, { includeInactive: true }), packages = [];
  for (const modelPack of plan.packages) {
    let ids = [], size = 0;
    const flush = () => { if (ids.length) packages.push({ ...modelPack, id: `group-${packages.length + 1}`, card_ids: ids }), ids = [], size = 0; };
    for (const id of modelPack.card_ids) {
      const length = Array.from(cards.get(id)?.body ?? '').length;
      if (ids.length && (ids.length >= 6 || size + length > 36000)) flush();
      ids.push(id); size += length;
    }
    flush();
  }
  plan.packages = packages;
  plan.selection.packages = packages.map(({ card_ids, purpose, reason }) => ({ card_ids, purpose, reason }));
  return plan;
}

function sourceEvidenceValid(decision, evidence, refs) {
  return decision.evidence.some(row => refs.has(row.ref) && evidence.sources.some(source => source.ref === row.ref
    && typeof source.text === 'string' && source.text.includes(row.quote)));
}

function prepareDecisions(root, job, pack, response, evidence) {
  const formal = loadCards(root, { includeInactive: true }), task = taskOf(job), prepared = [], issues = [];
  const allowedDomains = new Set(listDomainsV2(root).map(row => row.id));
  const weavingFocus = new Set(pack.weaving?.focus_ids ?? []);
  const weavingWriter = pack.weaving ? response.decisions.find(row => row.status === 'proposed' && weavingFocus.has(row.id))?.id : null;
  for (const decision of response.decisions) {
    if (decision.status !== 'proposed') continue;
    const old = formal.get(decision.id), current = readDraft(root, task, decision.id), before = current?.card ?? old?.meta;
    if (!old || !before) throw Error('建构对象不存在：' + decision.id);
    try {
      if (pack.weaving && (!weavingFocus.has(decision.id) || decision.id !== weavingWriter))
        throw Error('关系发现每轮只修改当前焦点卡；候选端点保持只读且不做对称回写。');
      const changes = clone(decision.changes), keys = Object.keys(changes), domainOnly = keys.length === 1 && keys[0] === 'domains';
      if (keys.includes('domains')) {
        if (!Array.isArray(changes.domains) || changes.domains.length > 3 || changes.domains.some(id => !allowedDomains.has(id))) throw Error('领域修改包含不存在或过多的领域。');
        if (!domainOnly) throw Error('领域归属必须与正文、关系和合并分开处理。');
      }
      if (changes.sources) {
        const known = new Set(evidence.sources.map(row => row.ref));
        if (!Array.isArray(changes.sources) || changes.sources.some(ref => !known.has(ref))) throw Error('建构不能引入本工作包未提供的来源。');
      }
      if (changes.relations) {
        if (!Array.isArray(changes.relations)) throw Error('relations 必须是修改后的完整数组。');
        const selected = new Set(pack.allowed_card_ids ?? pack.card_ids), beforeRelations = new Set((before.relations ?? []).map(relationKey)), afterRelations = new Set(changes.relations.map(relationKey));
        for (const relation of before.relations ?? []) if (!afterRelations.has(relationKey(relation)) && !selected.has(relation.target))
          throw Error('移除或改写关系前，关系另一端也必须属于策略已选择范围。');
        for (const relation of changes.relations) {
          const basis = relation?.basis ?? (relation?.origin === 'navigation' ? 'navigation' : 'source');
          const changed = !beforeRelations.has(relationKey(relation));
          if (changed && !selected.has(relation?.target)) throw Error('新建或修改关系只能指向策略已选择的卡片。');
          if (changed && !Object.hasOwn(relation, 'basis')) throw Error('新增或修改关系必须明确 basis。');
          if (!['source', 'navigation'].includes(basis)) throw Error('关系 basis 无效。');
          if (pack.weaving && changed && basis !== 'navigation')
            throw Error('关系编织只依据两端完整卡片建立 navigation 关系；来源关系须在独立来源核验中确认。');
          if (basis === 'source' && changed) {
            const refs = new Set([...(before.sources ?? []), ...(changes.sources ?? [])]);
            if (!sourceEvidenceValid(decision, evidence, refs)) throw Error('新增 source 关系缺少本次实际交付的绑定来源原句。若只依据两端卡片，改为 navigation 并保留证据边界，或删除该关系。');
          }
        }
      }
      if (keys.some(key => ['title', 'summary', 'boundary', 'type', 'body', 'merge'].includes(key))) {
        const refs = new Set(changes.sources ?? before.sources ?? []);
        if (!sourceEvidenceValid(decision, evidence, refs)) throw Error('正文、分类或合并修改缺少本次实际交付的可定位来源原句。');
      }
      if (changes.merge) {
        if (!Array.isArray(changes.merge) || changes.merge.some(item => !item || !pack.card_ids.includes(item.id) || item.id === decision.id)) throw Error('合并对象必须属于当前冻结工作包。');
        changes.merge = changes.merge.map(item => {
          const target = formal.get(item.id); if (!target) throw Error('合并对象已经不存在：' + item.id);
          return { id: item.id, revision: unoRevision(root, unoCardRef(root, target)) };
        });
      }
      prepared.push({ decision, changes, revision: current?.revision ?? unoRevision(root, unoCardRef(root, old)) });
    } catch (error) {
      issues.push({ id: decision.id, issues: [error.message] });
    }
  }
  return { prepared, issues };
}

function stageDecisions(root, job, pack, response, evidence, round) {
  const gateway = new HarnessGateway(root), task = taskOf(job), receipts = [], preflight = prepareDecisions(root, job, pack, response, evidence);
  if (preflight.issues.length) throw Object.assign(new Error(preflight.issues.map(row => `${row.id}：${row.issues.join('；')}`).join('；')),
    { code: 'CONSTRUCTION_DECISION_PREFLIGHT', issues: preflight.issues });
  for (const { decision, changes, revision } of preflight.prepared) {
    const key = `${task}:direct-${round}-${decision.id}-${digest(changes).slice(0, 20)}`;
    const receipt = gateway.stageUnoKnowledge({ task, key, operation_id: key.split(':').at(-1), action: 'patch', id: decision.id, revision, ...changes });
    receipts.push(receipt);
  }
  return receipts;
}

function mergeAuthorRepair(author, repair, ids) {
  const selected = new Set(ids), repaired = new Map(repair.decisions.map(row => [row.id, row]));
  return { decisions: author.decisions.map(row => selected.has(row.id) ? repaired.get(row.id) : row),
    note: [author.note, repair.note].filter(Boolean).join(' ') };
}

function subsetAuthorResponse(author, ids) {
  const selected = new Set(ids);
  return { decisions: author.decisions.filter(row => selected.has(row.id)), note: author.note };
}

function subsetReviewResponse(review, ids) {
  const selected = new Set(ids);
  return { reviews: review.reviews.filter(row => selected.has(row.id)), note: review.note };
}

function deferPreflightIssues(author, issues) {
  const byId = new Map(issues.map(row => [row.id, row.issues]));
  return { decisions: author.decisions.map(row => byId.has(row.id) ? { id: row.id, status: 'deferred', changes: {}, evidence: [],
    note: `确定性预检仍未通过，未暂存：${byId.get(row.id).join('；')}` } : row), note: author.note };
}

async function resolveAuthorPreflight(ctx, root, job, pack, author, evidence, signal) {
  let work = job.direct_work[job.batch_index];
  if (work.effective_author) return work.effective_author;
  let effective = author, preflight = prepareDecisions(root, job, pack, effective, evidence);
  if (preflight.issues.length) {
    work.preflight_issues = preflight.issues;
    const ids = preflight.issues.map(row => row.id), repairPack = { ...pack, card_ids: ids, purpose: '只修复确定性预检指出的问题' };
    if (pack.weaving) {
      work.preflight_unresolved = preflight.issues;
      effective = deferPreflightIssues(effective, preflight.issues);
      preflight = prepareDecisions(root, job, pack, effective, evidence);
    } else if (work.preflight_repair || getProviderBudget(root, job.id).remaining >= 2) {
      job.phase = 'repairing'; job.role = 'author'; job.detail = `第 ${job.batch_index + 1} 个工作包预检发现 ${ids.length} 张问题卡，正在执行唯一一次局部修复。`; saveCompileJob(root, job);
      let repair = work.preflight_repair;
      if (!repair) {
        const repairEvidence = evidenceFor(root, job, repairPack);
        const phase = 'construction-repair';
        const text = retainedContractResponse(job, phase) ?? await runRequest(ctx, root, job,
          buildConstructionAuthorRequest(job, repairPack, repairEvidence, { repair_issues: preflight.issues }), signal,
          { role: 'author', packageId: `batch-${job.batch_index}`, stageId: `batch-${job.batch_index}-preflight-repair`, stageLimit: 1 });
        repair = await validateStageResponse(ctx, root, job, repairPack, signal, { phase, kind: 'author', text, ids });
        job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].preflight_repair = repair; saveCompileJob(root, job);
        work = job.direct_work[job.batch_index];
      }
      effective = mergeAuthorRepair(author, repair, ids);
      work.repair_used = true;
      preflight = prepareDecisions(root, job, pack, effective, evidence);
    }
    if (preflight.issues.length) {
      work.preflight_unresolved = preflight.issues;
      effective = deferPreflightIssues(effective, preflight.issues);
    }
  }
  work.effective_author = effective;
  saveCompileJob(root, job);
  return effective;
}

function reviewMaterial(root, job, pack, author, evidence) {
  const formal = loadCards(root, { includeInactive: true }), task = taskOf(job);
  const usedEvidence = new Map();
  for (const decision of author.decisions) for (const row of decision.evidence ?? []) {
    const source = evidence.sources.find(item => item.ref === row.ref);
    if (!source) continue;
    if (source.unavailable || typeof source.text !== 'string') {
      usedEvidence.set(row.ref, { ref: row.ref, unavailable: true, error: source.error }); continue;
    }
    const at = source.text.indexOf(row.quote), start = Math.max(0, at - 600), end = Math.min(source.text.length, at + row.quote.length + 600);
    const prior = usedEvidence.get(row.ref) ?? { ref: row.ref, revision: source.revision, excerpts: [] };
    const excerpt = at >= 0 ? source.text.slice(start, end) : row.quote;
    if (!prior.excerpts.includes(excerpt)) prior.excerpts.push(excerpt);
    usedEvidence.set(row.ref, prior);
  }
  const reviewCardIds = [...new Set([...(pack.card_ids ?? []), ...(pack.reference_card_ids ?? [])])];
  return { author_decisions: author.decisions, cards: reviewCardIds.map(id => {
    const original = formal.get(id), draft = readDraft(root, task, id);
    return { id, before: { meta: original.meta, body: original.body, revision: unoRevision(root, unoCardRef(root, original)) },
      draft: draft ? { revision: draft.revision, state: draft.state, errors: draft.errors } : null };
  }), sources: [...usedEvidence.values()], domains: author.decisions.some(row => Object.hasOwn(row.changes ?? {}, 'domains')) ? evidence.domains : [] };
}

function applyReviews(root, job, pack, author, review) {
  const task = taskOf(job), authorById = new Map(author.decisions.map(row => [row.id, row]));
  job.reviewed ??= {}; job.construction_results ??= {}; job.construction_results[job.batch_index] ??= {};
  job.issues = (job.issues ?? []).filter(issue => issue.batch !== job.batch_index);
  for (const row of review.reviews) {
    const draft = readDraft(root, task, row.id), authored = authorById.get(row.id), issues = row.decision === 'reject' ? [...row.issues] : [];
    if (draft && authored?.status === 'proposed' && draft.state !== 'pending') issues.push(...(draft.errors ?? ['草稿没有通过确定性检查。']));
    if (draft && authored?.status === 'proposed') job.reviewed[row.id] = { revision: draft.revision, note: row.note, issues,
      session_id: job.session_id, direct_review: true, changed_fields: Object.keys(authored.changes), dependencies: [] };
    job.construction_results[job.batch_index][row.id] = { id: row.id,
      status: row.decision === 'reject' ? 'deferred' : authored.status === 'proposed' ? 'approved' : authored.status,
      note: row.note, kind: 'direct-independent-review', source_verified: authored.evidence.length > 0 };
    job.issues.push(...issues.map(detail => ({ id: row.id, detail, batch: job.batch_index, status: 'open' })));
  }
}

function publishApproved(root, job, pack) {
  const gateway = new HarnessGateway(root), task = taskOf(job), published = [], receipts = [];
  for (const id of pack.card_ids) {
    const draft = readDraft(root, task, id), review = job.reviewed?.[id];
    if (draft?.state === 'published') { published.push(id); continue; }
    if (!draft || review?.revision !== draft.revision || review.issues?.length || draft.state !== 'pending') continue;
    const original = loadCards(root, { includeInactive: true }).get(id);
    const domainOnly = assertConstructionDraft(job, draft, original)?.domainOnly;
    const key = `${task}:publish-direct-${id}-${draft.revision.slice(0, 20)}`;
    const receipt = gateway[domainOnly ? 'publishUnoDomainAssignments' : 'publishUnoKnowledge']({ task, key, ids: [id], reviews: { [id]: review } });
    receipts.push(receipt); published.push(id);
  }
  job.receipts.push(...receipts.filter(receipt => !job.receipts.some(row => row.key === receipt.key)));
  return published;
}

function appendConstructionWave(job, constructionPlan) {
  const start = job.batches.length;
  const packages = constructionPlan.packages.map((pack, offset) => ({ ...pack, id: `group-${start + offset + 1}`,
    strategy: constructionPlan.strategy, selection: constructionPlan.selection.selected,
    ...(constructionPlan.weaving ? { weaving: constructionPlan.weaving } : {}) }));
  if (!job.construction_plan) {
    job.construction_plan = { ...constructionPlan, packages, selection: { ...constructionPlan.selection,
      packages: packages.map(({ card_ids, purpose, reason }) => ({ card_ids, purpose, reason })) },
      ...(constructionPlan.weaving ? { waves: [{ strategy: constructionPlan.strategy, selection: constructionPlan.selection,
        weaving: constructionPlan.weaving }] } : {}) };
  } else {
    job.construction_plan.packages.push(...packages);
    const selected = new Map((job.construction_plan.selection?.selected ?? []).map(row => [row.id, row]));
    for (const row of constructionPlan.selection.selected) if (!selected.has(row.id)) selected.set(row.id, row);
    job.construction_plan.selection.selected = [...selected.values()];
    job.construction_plan.selection.packages = job.construction_plan.packages.map(({ card_ids, purpose, reason }) => ({ card_ids, purpose, reason }));
    job.construction_plan.unselected = constructionPlan.unselected;
    job.construction_plan.candidate_count = Math.max(job.construction_plan.candidate_count ?? 0, constructionPlan.candidate_count ?? 0);
    if (constructionPlan.weaving) (job.construction_plan.waves ??= []).push({ strategy: constructionPlan.strategy,
      selection: constructionPlan.selection, weaving: constructionPlan.weaving });
  }
  job.scope = [...new Set([...(job.scope ?? []), ...constructionPlan.selection.selected.map(row => row.id)])];
  job.batches.push(...packages.map(row => row.card_ids));
  job.batch_index = start;
  return packages;
}

function rememberEmptyWeavingWave(job, plan) {
  job.relation_weaving ??= { contract: RELATION_WEAVING_CONTRACT, rounds: [] };
  if (!job.relation_weaving.rounds.some(row => row.round === plan.weaving.round)) {
    const exhausted = (plan.weaving.attempt ?? 1) >= RELATION_WEAVING_MAX_FOCUS_ATTEMPTS;
    job.relation_weaving.rounds.push({ round: plan.weaving.round, phase: plan.weaving.phase,
      focus_ids: plan.weaving.focus_ids, focus_fingerprint: plan.weaving.focus_fingerprint,
      attempt: plan.weaving.attempt ?? 1, candidate_ids: plan.weaving.focus_ids,
      topology_before: plan.weaving.topology_fingerprint, status: exhausted ? 'deferred-exhausted' : 'no-selection',
      published: [], at: new Date().toISOString() });
  }
}

async function plan(ctx, root, job, signal) {
  const weaving = relationWeavingEnabled(job), diagnosis = weaving ? inspectRelationWeaving(root, job) : null;
  if (weaving) {
    job.relation_weaving ??= { contract: RELATION_WEAVING_CONTRACT, rounds: [] };
    job.relation_weaving.last_diagnosis = compactWeavingDiagnosis(diagnosis);
    if (!diagnosis.focus) {
      job.status = (job.completed_batches ?? []).some(row => row.pending) ? 'partial' : 'completed';
      job.phase = 'done'; job.remaining_units = 0;
      job.detail = randomRelationWeaving(job)
        ? '本轮已随机抽样并检查当前范围内全部有效卡片；端点均由全库内容检索产生，未为增加关系数量强造联系。'
        : diagnosis.counts.isolated || diagnosis.counts.islands
        ? '本轮已检查所有未处理的孤立卡与知识岛；证据不足而保留独立的对象仍保留在图中。'
        : '当前范围已没有待处理的孤立卡或与主图断开的知识岛。';
      saveCompileJob(root, job); return job;
    }
  }
  const pool = weaving ? relationWeavingCandidatePool(root, job, diagnosis) : constructionCandidatePool(root, {
    notes: String(job.construction_query ?? '').trim() || job.notes, card_ids: job.requested_card_ids,
    domain: job.domain, type: job.type, requirements: job.requirements });
  let constructionPlan, strategyCandidates, strategyResponse;
  if (weaving) {
    constructionPlan = planRelationWeavingRound(pool, job);
    strategyCandidates = pool.candidates;
  } else {
    const request = buildConstructionStrategyRequest(job, pool, domainCatalogRows(listDomainsV2(root)));
    const retained = [...(job.calls ?? [])].reverse().find(row => row.phase === 'construction-strategy'
      && row.status === 'completed' && row.response?.trim());
    const text = retained?.response ?? await runRequest(ctx, root, job, request, signal, { role: 'select', packageId: 'strategy',
      stageId: `strategy-v2-r${job.resume_round ?? 0}`, stageLimit: 1, reviewReserve: 0 });
    const value = parseResponse(root, job.id, 'construction-strategy', text);
    constructionPlan = validateConstructionStrategy(value, request.delivered_pool);
    strategyCandidates = request.delivered_pool.candidates;
    strategyResponse = value;
  }
  constructionPlan = normalizePlanPackages(root, constructionPlan);
  constructionPlan.fingerprint = constructionStrategyFingerprint(constructionPlan);
  job = activeJob(root, job.id, signal);
  if (strategyResponse) job.strategy_response = strategyResponse;
  job.strategy_candidates = strategyCandidates;
  const packages = appendConstructionWave(job, constructionPlan);
  job.phase = packages.length ? 'authoring' : weaving ? 'strategy_pending' : 'done'; job.role = packages.length ? 'author' : 'select';
  if (!packages.length) {
    if (weaving) { rememberEmptyWeavingWave(job, constructionPlan); job.detail = randomRelationWeaving(job)
      ? '本轮随机焦点没有召回达到候选闸门的全库端点；未调用模型，也未据此宣称该卡必然独立，已转向下一项。'
      : '当前结构焦点没有选出可信端点，已保留独立并转向下一项。'; }
    else { job.status = 'partial'; job.detail = '策略规划没有选出具有充分依据的建构对象；候选与原始策略响应已保留。'; }
  } else job.detail = weaving
    ? randomRelationWeaving(job)
      ? `关系发现第 ${constructionPlan.weaving.round} 轮已冻结：随机抽取 1 张焦点卡，并从全库检索 ${packages[0].card_ids.length - 1} 张候选端点。`
      : `关系编织第 ${constructionPlan.weaving.round} 轮已冻结：围绕 ${constructionPlan.weaving.phase === 'isolated' ? '孤立卡' : '知识岛'}选择 ${packages[0].card_ids.length} 张卡。`
    : `策略已冻结：选择 ${job.scope.length} 张卡片，分为 ${job.batches.length} 个工作包。`;
  saveCompileJob(root, job); return job;
}

async function executePackage(ctx, root, job, signal) {
  const pack = job.construction_plan.packages[job.batch_index], evidence = evidenceFor(root, job, pack);
  job.direct_work ??= {}; let work = job.direct_work[job.batch_index] ??= {};
  job.phase = 'authoring'; job.role = 'author'; job.detail = `正在执行第 ${job.batch_index + 1}/${job.batches.length} 个建构工作包。`; saveCompileJob(root, job);
  let author = work.author;
  if (!author) {
    const phase = 'construction-author';
    const text = retainedContractResponse(job, phase) ?? await runRequest(ctx, root, job,
      buildConstructionAuthorRequest(job, pack, evidence), signal, { role: 'author', packageId: `batch-${job.batch_index}`,
        stageId: requestStage(job, 'author'), stageLimit: pack.weaving ? 1 : 2, reviewReserve: pack.weaving ? 1 : 2 });
    author = await validateStageResponse(ctx, root, job, pack, signal, { phase, kind: 'author', text, ids: pack.card_ids });
    job = activeJob(root, job.id, signal); job.direct_work ??= {}; (job.direct_work[job.batch_index] ??= {}).author = author; saveCompileJob(root, job);
  }
  work.author = author;
  author = await resolveAuthorPreflight(ctx, root, job, pack, author, evidence, signal);
  job = activeJob(root, job.id, signal); job.direct_work ??= {}; work = job.direct_work[job.batch_index] ??= work;
  const initialAuthor = author;
  if (!pack.weaving && !work.author_staged) {
    stageDecisions(root, activeJob(root, job.id, signal), pack, author, evidence, 'author');
    job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].author_staged = true; saveCompileJob(root, job);
  }
  job = activeJob(root, job.id, signal); job.phase = 'reviewing'; job.role = 'reviewer'; saveCompileJob(root, job);
  let review = job.direct_work[job.batch_index].review;
  if (!review) {
    const phase = 'construction-review';
    const text = retainedContractResponse(job, phase) ?? await runRequest(ctx, root, job,
      buildConstructionReviewRequest(job, pack, reviewMaterial(root, job, pack, author, evidence)), signal,
      { role: 'reviewer', packageId: `batch-${job.batch_index}`, stageId: requestStage(job, 'review'), stageLimit: 1 });
    review = await validateStageResponse(ctx, root, job, pack, signal, { phase, kind: 'review', text, ids: pack.card_ids });
    job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].review = review; saveCompileJob(root, job);
  }
  if (!pack.weaving) { applyReviews(root, job, pack, author, review); saveCompileJob(root, job); }
  const initialReview = review;
  const rejected = review.reviews.filter(row => row.decision === 'reject').map(row => row.id);
  let repairAuthor = null, verification = null, repairPack = null, repairEvidence = null;
  if (rejected.length && !job.direct_work[job.batch_index].repair_used
    && (job.direct_work[job.batch_index].repair || getProviderBudget(root, job.id).remaining >= 2)) {
    const referenceCardIds = pack.card_ids.filter(id => !rejected.includes(id));
    repairPack = { ...pack, card_ids: rejected, allowed_card_ids: pack.card_ids,
      reference_card_ids: referenceCardIds, purpose: '只修复独立审核指出的问题' };
    repairEvidence = evidenceFor(root, job, { ...repairPack, card_ids: [...rejected, ...referenceCardIds] });
    const repairIssues = review.reviews.filter(row => rejected.includes(row.id)).map(row => ({ id: row.id, issues: row.issues }));
    job.phase = 'repairing'; job.role = 'author'; saveCompileJob(root, job);
    repairAuthor = job.direct_work[job.batch_index].repair;
    if (!repairAuthor) {
      const phase = 'construction-repair';
      const text = retainedContractResponse(job, phase) ?? await runRequest(ctx, root, job,
        buildConstructionAuthorRequest(job, repairPack, repairEvidence, { repair_issues: repairIssues }), signal,
        { role: 'author', packageId: `batch-${job.batch_index}`, stageId: requestStage(job, 'repair'), stageLimit: 1 });
      repairAuthor = await validateStageResponse(ctx, root, job, repairPack, signal, { phase, kind: 'author', text, ids: rejected });
      job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].repair = repairAuthor; saveCompileJob(root, job);
    }
    if (pack.weaving) {
      const preflight = prepareDecisions(root, job, repairPack, repairAuthor, repairEvidence);
      if (preflight.issues.length) {
        job.direct_work[job.batch_index].repair_preflight_issues = preflight.issues;
        repairAuthor = deferPreflightIssues(repairAuthor, preflight.issues);
        job.direct_work[job.batch_index].effective_repair = repairAuthor;
        saveCompileJob(root, job);
      }
    }
    job.direct_work[job.batch_index].repair_used = true;
    if (!pack.weaving && !job.direct_work[job.batch_index].repair_staged) {
      stageDecisions(root, activeJob(root, job.id, signal), repairPack, repairAuthor, repairEvidence, 'repair');
      job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].repair_staged = true; saveCompileJob(root, job);
    }
    job = activeJob(root, job.id, signal); job.phase = 'verifying'; job.role = 'reviewer'; saveCompileJob(root, job);
    verification = job.direct_work[job.batch_index].verification;
    if (!verification) {
      const phase = 'construction-verify';
      const text = retainedContractResponse(job, phase) ?? await runRequest(ctx, root, job,
        buildConstructionReviewRequest(job, repairPack, reviewMaterial(root, job, repairPack, repairAuthor, repairEvidence), { repair: true }), signal,
        { role: 'reviewer', packageId: `batch-${job.batch_index}`, stageId: requestStage(job, 'verify'), stageLimit: 1 });
      verification = await validateStageResponse(ctx, root, job, repairPack, signal, { phase, kind: 'review', text, ids: rejected });
      job = activeJob(root, job.id, signal); job.direct_work[job.batch_index].verification = verification; saveCompileJob(root, job);
    }
    if (!pack.weaving) { applyReviews(root, job, repairPack, repairAuthor, verification); saveCompileJob(root, job); }
  }
  if (pack.weaving) {
    const approvedIds = new Set(initialReview.reviews.filter(row => row.decision === 'approve').map(row => row.id));
    let settledAuthor = initialAuthor;
    if (repairAuthor && verification) {
      settledAuthor = mergeAuthorRepair(initialAuthor, repairAuthor, rejected);
      for (const row of verification.reviews) if (row.decision === 'approve') approvedIds.add(row.id); else approvedIds.delete(row.id);
    }
    const approvedProposals = { decisions: settledAuthor.decisions.filter(row => approvedIds.has(row.id) && row.status === 'proposed'), note: settledAuthor.note };
    if (!job.direct_work[job.batch_index].author_staged && approvedProposals.decisions.length) {
      job = activeJob(root, job.id, signal); job.phase = 'publishing'; job.role = 'author'; saveCompileJob(root, job);
      stageDecisions(root, activeJob(root, job.id, signal), pack, approvedProposals, evidence, 'settled');
      job = activeJob(root, job.id, signal); job.role = 'reviewer'; job.direct_work[job.batch_index].author_staged = true; saveCompileJob(root, job);
    }
    const initiallySettled = initialReview.reviews.filter(row => !rejected.includes(row.id)).map(row => row.id);
    if (rejected.length) {
      if (initiallySettled.length) applyReviews(root, job, pack, subsetAuthorResponse(initialAuthor, initiallySettled), subsetReviewResponse(initialReview, initiallySettled));
      const finalRejectedAuthor = repairAuthor ?? subsetAuthorResponse(initialAuthor, rejected);
      const finalRejectedReview = verification ?? subsetReviewResponse(initialReview, rejected);
      applyReviews(root, job, repairPack ?? { ...pack, card_ids: rejected }, finalRejectedAuthor, finalRejectedReview);
    } else applyReviews(root, job, pack, initialAuthor, initialReview);
    job.direct_work[job.batch_index].settled_author = settledAuthor;
    saveCompileJob(root, job);
  }
  job = activeJob(root, job.id, signal); job.phase = 'publishing'; job.role = 'reviewer'; saveCompileJob(root, job);
  const published = publishApproved(root, job, pack), pending = pack.card_ids.filter(id => job.construction_results[job.batch_index]?.[id]?.status === 'deferred').length;
  job.completed_batches ??= []; job.completed_batches.push({ index: job.batch_index, published, pending, at: new Date().toISOString() });
  pack.status = pending ? 'deferred' : 'completed';
  if (pack.weaving) {
    job.relation_weaving ??= { contract: RELATION_WEAVING_CONTRACT, rounds: [] };
    if (!job.relation_weaving.rounds.some(row => row.batch_index === job.batch_index)) {
      const after = inspectRelationWeaving(root, job);
      const attempt = pack.weaving.attempt ?? 1;
      const roundStatus = published.length ? 'published' : pending
        ? (attempt >= RELATION_WEAVING_MAX_FOCUS_ATTEMPTS ? 'deferred-exhausted' : 'deferred') : 'reviewed-independent';
      const settled = new Set(pack.card_ids.filter(id => job.construction_results[job.batch_index]?.[id]?.status !== 'deferred'));
      const settledFocus = new Set((pack.weaving.focus_ids ?? []).filter(id => settled.has(id)));
      const candidateIds = new Set(pack.card_ids);
      const settledAuthor = job.direct_work?.[job.batch_index]?.settled_author;
      const relationEndpointIds = randomRelationWeaving(job) && published.length
        ? [...new Set((settledAuthor?.decisions ?? []).filter(decision => published.includes(decision.id))
          .flatMap(decision => decision.changes?.relations ?? []).map(relation => relation.target)
          .filter(id => candidateIds.has(id) && !settledFocus.has(id)))] : [];
      const reviewedFingerprints = randomRelationWeaving(job) ? [] : [...after.isolated_targets, ...after.island_targets]
        .filter(target => target.ids.some(id => settledFocus.has(id))).map(target => target.fingerprint);
      job.relation_weaving.rounds.push({ round: pack.weaving.round, batch_index: job.batch_index,
        phase: pack.weaving.phase, attempt, candidate_ids: pack.card_ids,
        focus_ids: pack.weaving.focus_ids, focus_fingerprint: pack.weaving.focus_fingerprint,
        ...(relationEndpointIds.length ? { relation_endpoint_ids: relationEndpointIds } : {}),
        topology_before: pack.weaving.topology_fingerprint, topology_after: after.topology_fingerprint,
        reviewed_fingerprints: reviewedFingerprints,
        status: roundStatus, published,
        ...(pending ? { issues: (job.issues ?? []).filter(row => row.batch === job.batch_index).map(row => ({ id: row.id, detail: row.detail })) } : {}),
        at: new Date().toISOString() });
      job.relation_weaving.last_diagnosis = compactWeavingDiagnosis(after);
    }
  }
  job.phase = 'batch_done'; job.detail = `第 ${job.batch_index + 1} 个工作包已结算：发布 ${published.length} 张，保留或延期 ${pack.card_ids.length - published.length} 张。`;
  if (pack.weaving && pending) job.detail += (pack.weaving.attempt ?? 1) < RELATION_WEAVING_MAX_FOCUS_ATTEMPTS
    ? ' 当前候选关系未通过；下一轮将为同一结构焦点更换尚未尝试的端点。'
    : ' 当前结构焦点已完成两组有界尝试，待办保留，主线继续处理下一项。';
  saveCompileJob(root, job); return job;
}

export async function executeStrategyConstruction(ctx, root, initial, controller) {
  const signal = controller.signal, id = initial.id;
  const timer = setTimeout(() => controller.abort(new Error('本执行时段达到 30 分钟，已请求暂停。')), 30 * 60 * 1000);
  try {
    let job = readCompileJob(root, id);
    if (!isStrategyConstruction(job)) throw Error('此服务只处理 strategy-driven-v2 建构任务。');
    job.status = 'running'; delete job.error_code; delete job.last_error; saveCompileJob(root, job);
    const weaving = relationWeavingEnabled(job);
    while (true) {
      signal.throwIfAborted(); job = activeJob(root, id, signal);
      if (!job.construction_plan || job.phase === 'strategy_pending') {
        if (weaving && getProviderBudget(root, id).remaining < 2) {
          job.status = 'paused'; job.detail = '剩余额度不足以启动下一轮关系编织的执行与独立审核，当前图状态和已检查焦点已保留。';
          saveCompileJob(root, job); return;
        }
        job = await plan(ctx, root, job, signal);
        if (job.phase === 'done') return;
        if (job.phase === 'strategy_pending') {
          if (!job.continuous) {
            job.status = 'paused'; job.relation_weaving.needs_replan = true;
            job.detail += ' 本次只处理一个结构焦点；继续后会重新扫描当前图。'; saveCompileJob(root, job); return;
          }
          continue;
        }
      }
      job = await executePackage(ctx, root, activeJob(root, id, signal), signal);
      const last = job.batch_index + 1 >= job.batches.length;
      if (!last && (job.stop_after_batch || job.continuous === false)) {
        job.status = 'paused'; job.remaining_units = job.batches.slice(job.batch_index + 1).flat().length;
        job.detail += ' 剩余工作包已保留，可从下一组继续。'; saveCompileJob(root, job); return;
      }
      if (!last) {
        job.batch_index++; job.phase = 'authoring'; job.role = 'author'; saveCompileJob(root, job); continue;
      }
      if (weaving) {
        const diagnosis = inspectRelationWeaving(root, job); job.relation_weaving.last_diagnosis = compactWeavingDiagnosis(diagnosis);
        if (!diagnosis.focus) {
          job.status = (job.completed_batches ?? []).some(row => row.pending) ? 'partial' : 'completed';
          job.phase = 'done'; job.remaining_units = 0;
          job.detail = job.status === 'completed'
            ? randomRelationWeaving(job)
              ? '本轮关系发现已随机检查完当前范围的有效卡片；候选端点来自全库检索，没有按图位置强造关系。'
              : '本轮关系编织已检查完当前范围的孤立卡与知识岛；没有为连通率强造关系。'
            : '关系编织已检查完当前范围；仍有明确延期或审核未通过项。';
          saveCompileJob(root, job); return;
        }
        const remaining = randomRelationWeaving(job) ? diagnosis.counts.unreviewed
          : diagnosis.counts.unreviewed_isolated + diagnosis.counts.unreviewed_islands;
        if (job.stop_after_batch || !job.continuous) {
          job.status = 'paused'; job.remaining_units = remaining; job.relation_weaving.needs_replan = true;
          job.detail += ` 当前图重新扫描后还有 ${remaining} 个结构焦点；继续时从新图选择下一小组。`;
          saveCompileJob(root, job); return;
        }
        if (getProviderBudget(root, id).remaining < 2) {
          job.status = 'paused'; job.remaining_units = remaining; job.relation_weaving.needs_replan = true;
          job.detail = '本轮小组已结算；剩余额度不足以启动下一轮执行与独立审核，继续时重新扫描当前图。';
          saveCompileJob(root, job); return;
        }
        job.phase = 'strategy_pending'; job.role = 'select'; job.relation_weaving.needs_replan = false;
        saveCompileJob(root, job); continue;
      }
      job.status = (job.completed_batches ?? []).some(row => row.pending) ? 'partial' : 'completed'; job.phase = 'done'; job.remaining_units = 0;
      job.detail = job.status === 'completed' ? '建构策略中的工作包已经全部完成。' : '建构工作包已经结算；仍有明确延期或审核未通过项。';
      saveCompileJob(root, job); return;
    }
  } catch (error) {
    const job = readCompileJob(root, id), budget = budgetStopCode(error), stopped = signal.aborted || error.code === 'CONSTRUCTION_STOPPED';
    job.status = stopped || budget ? 'paused' : 'failed'; job.error_code = budget ?? error.code ?? null;
    job.last_error = { code: job.error_code, message: error.message, at: new Date().toISOString(), phase: job.phase, role: job.role, batch: job.batch_index };
    job.detail = error.message; saveCompileJob(root, job);
  } finally {
    clearTimeout(timer);
    try { const job = readCompileJob(root, id); if (settleResumeGuard(job)) saveCompileJob(root, job); } catch {}
    try { broadcastGraphEvent(initial.owner_session_id ?? initial.session_id, { type: 'graph_changed', data: {} }); } catch {}
  }
}
