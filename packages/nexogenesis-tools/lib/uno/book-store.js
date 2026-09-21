import { BOOK_CARD_LIMITS as LIMITS, LEGACY_BOOK_CARD_LIMITS as LEGACY_LIMITS, BOOK_CARD_LABELS, BOOK_CARD_RELATIONS } from './book-card-contract.js';
/** Book compilation writes: no drafts, semantic review stages or material settlement. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { loadCards, parseCardFile, invalidateKnowledgeSnapshot } from '../cards.js';
import { auditCardBodyStructure } from '../harness/knowledge-quality.js';
import { safeCardId, displayType } from '../uno-contract.js';
import { LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT, cardTypesForClassificationContract, domainCatalogRows, validateCardClassification } from './card-classification.js';
import { listDomainsV2 } from './knowledge.js';
import { sha, unoPath, unoRevision, unoMarkdown, unoCardRef, transaction, expect, readUnoReceipt } from '../harness/uno-storage.js';
import { BOOK_WORKFLOW, isBookWorkflow, inspectBookUnit } from './book-sources.js';
export { BOOK_WORKFLOW, prepareBookSource, readBookUnit } from './book-sources.js';

const RELATIONS = new Set(BOOK_CARD_RELATIONS);
const safeJobId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, ...(details ? { details } : {}) }); };
const count = text => Array.from(text).length;
const unique = rows => [...new Set(rows)];

function persistedJob(root, id) {
  if (!safeJobId(id)) fail('INVALID_ARGUMENTS', '图书任务 ID 无效。');
  const file = unoPath(root, `.nexogenesis/uno-jobs/${id}.json`);
  if (!existsSync(file)) fail('TASK_STOPPED', '当前知识库不存在该图书任务。');
  const job = JSON.parse(readFileSync(file, 'utf8'));
  if (job.id !== id || !isBookWorkflow(job.workflow)) fail('SCOPE_VIOLATION', '任务不是可恢复的图书编译协议。');
  return job;
}

function authorize(job, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || job.session_id !== sessionId) fail('STALE_CONTEXT', '写入会话不是任务当前上下文。');
  if (job.status !== 'running' || job.pause_requested || job.end_requested || job.cancel_requested)
    fail('TASK_STOPPED', '图书任务已暂停或结束，未执行写入。');
}

export function bookOperationKey(jobId, operationId) {
  if (!safeJobId(jobId) || !safeJobId(operationId)) fail('INVALID_ARGUMENTS', '任务及 operation_id 须为 1–100 位英文、数字、短横线或下划线。');
  return `book-cards-v1:${jobId}:${operationId}`;
}

function covered(reading, revision, sessionId, start, end) {
  if (!reading || reading.revision !== revision || reading.session_id !== sessionId || !Array.isArray(reading.intervals)) return false;
  let cursor = start;
  for (const interval of [...reading.intervals].filter(row => Array.isArray(row) && row.length === 2
    && Number.isInteger(row[0]) && Number.isInteger(row[1]) && row[0] >= 0 && row[1] >= row[0]).sort((a, b) => a[0] - b[0])) {
    if (interval[0] > cursor) break;
    cursor = Math.max(cursor, interval[1]);
    if (cursor >= end) return true;
  }
  return false;
}

function sourceSpan(root, job, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.ref !== 'string') fail('INVALID_SOURCE', '来源必须包含真实原文 ref。');
  const row = inspectBookUnit(root, job, input.ref), total = count(row.body);
  const start = input.start ?? 0, end = input.end ?? total;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total)
    fail('INVALID_SOURCE', '来源范围须为原文内的非空 Unicode 区间。');
  if (!covered(job.book_reads?.[input.ref], row.revision, job.session_id, start, end))
    fail('UNDELIVERED_EVIDENCE', '引用范围尚未交付当前上下文，或来源版本已经变化：' + input.ref);
  return { ref: input.ref, start, end, revision: row.revision, content_revision: row.content_revision,
    source_ref: row.meta.source_ref, title: row.meta.title, locator: row.meta.locator, unit: 'Unicode characters' };
}

function metadataStrings(value, name, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > LEGACY_LIMITS.tags || value.some(item => typeof item !== 'string' || !item.trim() || item.length > LEGACY_LIMITS.tag))
    fail('INVALID_ARGUMENTS', name + ' 须为非空文字数组，每项最多 200 字符。');
  if (required && !value.length) fail('INVALID_ARGUMENTS', name + ' 不能为空。');
  return unique(value.map(item => item.trim()));
}

function v3Classification(root, job, card) {
  if (!Array.isArray(card.domains)) fail('INVALID_ARGUMENTS', 'domains 必须是数组；没有合适领域时使用空数组。');
  const frozen = Array.isArray(job.domain_catalog) ? job.domain_catalog : [];
  const checked = validateCardClassification(card, frozen, cardTypesForClassificationContract(job.card_classification ?? LEGACY_SINGLE_TYPE_CLASSIFICATION_CONTRACT));
  if (checked.issues.length) fail(checked.issues[0].code, checked.issues[0].message);
  const live = new Map(domainCatalogRows(listDomainsV2(root)).map(domain => [domain.id, domain]));
  for (const id of checked.domains) {
    const expected = frozen.find(domain => domain.id === id), actual = live.get(id);
    if (!actual) fail('INVALID_DOMAIN', '领域已不存在，未保存：' + id);
    if (expected?.revision && actual.revision !== expected.revision) fail('DOMAIN_CATALOG_CHANGED', '领域定义已变化，请新建任务或重新选择领域：' + id);
  }
  return checked;
}

function combineRelations(input, existing, cardId, available) {
  if (input === undefined) return existing;
  if (!Array.isArray(input) || input.length > LIMITS.relations) fail('INVALID_ARGUMENTS', 'relations 须为数组，最多 64 项。');
  const result = existing.map(row => ({ ...row }));
  for (const relation of input) {
    if (!relation || !safeCardId(relation.target) || relation.target === cardId || !available.has(relation.target)
      || !RELATIONS.has(relation.type)) fail('INVALID_RELATION', '关系类型或端点无效：' + (relation?.target ?? ''));
    if (typeof relation.note !== 'string' || !relation.note.trim() || relation.note.length > LIMITS.relationNote)
      fail('INVALID_RELATION', '关系需要具体说明，最多 3000 字符。');
    if (relation.basis !== undefined && !['source', 'navigation'].includes(relation.basis)) fail('INVALID_RELATION', '关系 basis 只能是 source 或 navigation。');
    const previous = result.find(row => row.target === relation.target && row.type === relation.type);
    if (previous) {
      const previousBasis = previous.basis ?? (previous.origin === 'navigation' ? 'navigation' : 'source');
      if (relation.basis && relation.basis !== previousBasis) fail('RELATION_PROVENANCE_CONFLICT', '不可把已有来源关系静默改成导航关系，或反向改写。');
      // Keep provenance and any old relation fields; the caller can clarify its note.
      previous.note = relation.note.trim();
    } else {
      const basis = relation.basis ?? 'source';
      result.push({ target: relation.target, type: relation.type, note: relation.note.trim(), basis,
        origin: basis === 'source' ? 'document' : 'navigation' });
    }
  }
  return result;
}

export function saveBookCards(root, { job_id, session_id, operation_id, cards, check_only = false, collect_errors = false }) {
  const key = bookOperationKey(job_id, operation_id), initial = persistedJob(root, job_id);
  const modernClassification = initial.workflow === BOOK_WORKFLOW;
  if (!Array.isArray(cards) || !cards.length || cards.length > LIMITS.cards) fail('INVALID_ARGUMENTS', '单元提交需包含 1–100 张卡片。');
  if (Buffer.byteLength(JSON.stringify(cards)) > 2 * 1024 * 1024) fail('INVALID_ARGUMENTS', '卡片提交超过 2 MiB。');
  const input = { job_id, operation_id, cards };
  // Receipt replay is read-only, including after a pause or context handoff.
  if (!check_only && readUnoReceipt(root, key)) {
    if (initial.session_id !== session_id && !(initial.sessions ?? []).includes(session_id)) fail('STALE_CONTEXT', '回执不属于当前任务会话。');
    return transaction(root, key, input, () => { throw Error('历史回执不应重新执行写入。'); });
  }
  authorize(initial, session_id);
  const plan = () => {
    const job = persistedJob(root, job_id); authorize(job, session_id);
    invalidateKnowledgeSnapshot(root);
    const catalog = loadCards(root, { includeInactive: true }), ids = new Set();
    for (const card of cards) {
      if (!card || !safeCardId(card.id) || ids.has(card.id)) fail('INVALID_ARGUMENTS', '卡片 ID 无效或同批重复。');
      ids.add(card.id);
    }
    const available = new Set([...catalog].filter(([, row]) => !['superseded', 'archived'].includes(row.meta.lifecycle)).map(([id]) => id));
    for (const id of ids) available.add(id);
    const writes = new Map(), publication = [], allSources = [], errors = [], warnings = [];
    for (const card of cards) {
     try {
      if (typeof card.title !== 'string' || !card.title.trim() || /[\r\n\x00]/.test(card.title) || card.title.length > LIMITS.title)
        fail('INVALID_ARGUMENTS', '卡片标题须为 1–400 字符单行文字。');
      if (typeof card.body !== 'string' || !card.body.trim() || count(card.body) > LIMITS.body) fail('INVALID_ARGUMENTS', '卡片正文为空或超过 12 万字符。');
      if (card.summary !== undefined && (typeof card.summary !== 'string' || !card.summary.trim() || card.summary.length > LIMITS.summary))
        fail('INVALID_ARGUMENTS', '摘要须为 1–4000 字符。');
      const old = catalog.get(card.id);
      let tags, classification;
      if (modernClassification) {
        if (card.tags !== undefined || card.topics !== undefined) fail('LEGACY_CLASSIFICATION_FIELD', '新版卡片只使用 type 与 domains，不得输出 tags 或 topics。');
        classification = v3Classification(root, job, card);
        if (!classification.domains.length) warnings.push({ card_id: card.id, code: 'DOMAIN_UNASSIGNED', message: '当前没有合适的既有领域，已允许保存并记录为待组织。' });
      } else {
        tags = metadataStrings(card.tags, 'tags', { required: true });
        if (!tags.some(tag => BOOK_CARD_LABELS.includes(tag))) fail('INVALID_TYPE', 'tags 至少包含一个知识类型：概念、观点、机制、模型、方法、现象、案例、实体。');
      }
      if (old && ['superseded', 'archived'].includes(old.meta.lifecycle)) fail('CARD_RETIRED', '已退役卡片不能通过普通编译复活：' + card.id);
      const bodyType = modernClassification ? classification.type : (card.type ?? old?.meta.type ?? displayType(card));
      const bodyErrors = auditCardBodyStructure(bodyType, card.body);
      if (bodyErrors.length) fail('INVALID_CARD_STRUCTURE', bodyErrors.join('；'));
      const ref = old ? unoCardRef(root, old) : `01-Cards/${card.id}.md`, current = unoRevision(root, ref);
      if (old) {
        if (card.revision !== current) fail('REVISION_CONFLICT', '旧卡版本已经变化，或未提供当前 revision：' + card.id, { id: card.id, revision: current });
        if (!covered(job.book_card_reads?.[card.id], current, job.session_id, 0, count(old.body)))
          fail('UNDELIVERED_EVIDENCE', '修改旧卡前须读回当前完整正文：' + card.id);
      } else if (current !== null || card.revision != null) fail('REVISION_CONFLICT', '新卡 ID 对应文件已存在，或错误携带旧版本。');
      expect(root, { [ref]: card.revision ?? null });
      if (!Array.isArray(card.sources) || !card.sources.length || card.sources.length > LIMITS.sources) fail('INVALID_SOURCE', '卡片必须引用 1–128 个本任务原文区间。');
      const spans = card.sources.map(source => sourceSpan(root, job, source));
      allSources.push(...spans.map(row => row.ref));
      const sources = unique([...(old?.meta.sources ?? []), ...spans.map(row => `${row.ref}#char-${row.start}-${row.end}`)]);
      const spanMap = new Map([...(old?.meta.source_spans ?? []), ...spans].map(row => [JSON.stringify([row.ref, row.start, row.end]), row]));
      const relations = combineRelations(card.relations, old?.meta.relations ?? [], card.id, available);
      for (const relation of card.relations ?? []) {
        const previous = old?.meta.relations?.find(row => row.target === relation.target && row.type === relation.type);
        const previousBasis = previous?.basis ?? (previous?.origin === 'navigation' ? 'navigation' : 'source');
        const unchanged = previous && previous.note === relation.note.trim() && (!relation.basis || relation.basis === previousBasis);
        if (unchanged || ids.has(relation.target)) continue;
        const target = catalog.get(relation.target), targetRevision = unoRevision(root, unoCardRef(root, target));
        if (!covered(job.book_card_reads?.[relation.target], targetRevision, job.session_id, 0, count(target.body)))
          fail('UNDELIVERED_EVIDENCE', '新增或改变关系前须读回目标卡当前完整正文：' + relation.target);
      }
      const now = new Date().toISOString(), date = now.slice(0, 10);
      const metadata = { ...(old?.meta ?? {}), schema: modernClassification ? 'uno-card-v4' : 'uno-card-v3', id: card.id, title: card.title.trim(),
        type: bodyType, ...(modernClassification ? { domains: classification.domains } : { tags }), summary: card.summary?.trim() ?? old?.meta.summary ?? Array.from(card.body.trim()).slice(0, 240).join(''),
        sources, source_spans: [...spanMap.values()], relations, lifecycle: old?.meta.lifecycle ?? 'active',
        origin: old?.meta.origin ?? 'document', maturity: old?.meta.maturity ?? 'growing',
        generated_by: job.workflow, created: old?.meta.created ?? date, updated: date,
        compile_job_id: job_id, compile_operation_id: operation_id, compile_receipt_key: key,
        compile_job_ids: unique([...(old?.meta.compile_job_ids ?? []), ...(old?.meta.compile_job_id ? [old.meta.compile_job_id] : []), job_id]) };
      if (modernClassification) { delete metadata.tags; delete metadata.topics; }
      const markdown = unoMarkdown(metadata, card.body), revision = sha(markdown);
      if (old) {
        const historyRef = `03-Archive/card-history/${card.id}/${current}.md`, prior = readFileSync(unoPath(root, ref));
        if (existsSync(unoPath(root, historyRef)) && !readFileSync(unoPath(root, historyRef)).equals(prior))
          fail('HISTORY_CONFLICT', '历史版本路径已存在不同内容，未覆盖：' + historyRef);
        writes.set(historyRef, prior);
      }
      writes.set(ref, markdown);
      publication.push({ id: card.id, ref, revision, previous_revision: current, source_refs: unique(spans.map(row => row.ref)),
        type: bodyType, domains: modernClassification ? classification.domains : (old?.meta.domains ?? []) });
     } catch(error) { error.card_id = card.id; if (check_only && collect_errors) errors.push({card_id:card.id,code:error.code,message:error.message}); else throw error; }
    }
    return { writes, errors, result: { summary: `图书编译保存 ${cards.length} 张卡片`, job_id, session_id, operation_id,
      card_ids: publication.map(row => row.id), revisions: Object.fromEntries(publication.map(row => [row.id, row.revision])),
       source_refs: unique(allSources), warnings, publication: { cards: publication },
      notice: '收据确认授权范围、版本与实际保存；不代表来源理解或语义质量认证。' } };
  };
  if (check_only) { const checked = plan(); return collect_errors ? {accepted:!checked.errors.length,errors:checked.errors} : { accepted: true }; }
  return transaction(root, key, input, plan);
}

/** Rebuild a task's visible results from Markdown, independent of a task counter. */
export function listBookJobCards(root, jobId) {
  if (!safeJobId(jobId)) fail('INVALID_ARGUMENTS', '图书任务 ID 无效。');
  invalidateKnowledgeSnapshot(root);
  return [...loadCards(root, { includeInactive: true })].filter(([, card]) => card.meta.compile_job_id === jobId
    || card.meta.compile_job_ids?.includes(jobId)).map(([id, card]) => ({ id, title: card.meta.title,
      ref: unoCardRef(root, card), revision: unoRevision(root, unoCardRef(root, card)),
      lifecycle: card.meta.lifecycle, source_refs: unique((card.meta.source_spans ?? []).map(row => row.ref)),
      operation_id: card.meta.compile_operation_id, receipt_key: card.meta.compile_receipt_key }));
}

function archiveBookDescriptor(job, source) {
  if (typeof source !== 'string' || !source.startsWith('00-Inbox/')) fail('SCOPE_VIOLATION', '只能归档本任务选定的 Inbox 原书。');
  const matches = (job.sources ?? []).filter(book => book.original_source === source);
  if (matches.length !== 1) fail('SCOPE_VIOLATION', '原书未唯一绑定到本任务，未执行归档。');
  const book = matches[0];
  if (!/^[a-f0-9]{64}$/.test(book.source_revision ?? '') || typeof book.source_ref !== 'string'
    || !book.source_ref.startsWith(`03-Archive/books/${book.source_revision}/`))
    fail('STALE_EVIDENCE', '本书不可变归档定位或原件版本无效。');
  return book;
}

/** Complete books leave Inbox only after their exact original already exists in
 * the immutable archive. Removal and its receipt share one recoverable commit. */
export function archiveCompletedBook(root, { job_id, source, review }) {
  const initial = persistedJob(root, job_id), book = archiveBookDescriptor(initial, source);
  unoPath(root, source); // Reject traversal and links before deriving any action.
  const key = `book-archive-v1:${job_id}:${sha(source).slice(0, 32)}`;
  const input = { job_id, source, source_ref: book.source_ref, source_revision: book.source_revision };
  const previous = readUnoReceipt(root, key);
  if (previous) {
    // Replaying a completed archive is read-only, including after the host has
    // marked the job complete. A replacement Inbox file is never removed.
    if (previous.accepted !== true || previous.archived !== true || previous.job_id !== job_id || previous.source !== source
      || previous.source_ref !== book.source_ref || previous.source_revision !== book.source_revision)
      fail('INVALID_RECEIPT', '历史归档收据与本任务原书不一致。');
    if (unoRevision(root, book.source_ref) !== book.source_revision) fail('STALE_EVIDENCE', '已归档原件缺失或被改写，不能沿用归档成功声明。');
    if (unoRevision(root, source) !== null) fail('ARCHIVE_SOURCE_REAPPEARED', 'Inbox 的同名路径重新出现文件，已保全；旧归档回执不授权删除该文件。');
    return transaction(root, key, input, () => { throw Error('历史归档回执不应重新执行删除。'); });
  }
  return transaction(root, key, input, () => {
    // Recovery runs before this plan, so a crash after removal but before the
    // receipt can restore the original and retry the same atomic transaction.
    const job = persistedJob(root, job_id), current = archiveBookDescriptor(job, source);
    if (review === undefined) authorize(job, job.session_id);
    else {
      if (!['completed','partial','ended','review','paused'].includes(job.status) || !['done','ended','domain_review'].includes(job.phase))
        fail('TASK_STOPPED', '归档复核只适用于已结束阅读且不在运行的任务。');
      if (!review || typeof review.note !== 'string' || !review.note.trim()
        || review.job_revision !== unoRevision(root, `.nexogenesis/uno-jobs/${job_id}.json`)
        || review.source_revision !== current.source_revision || review.extraction_revision !== current.extraction_revision)
        fail('REVISION_CONFLICT', '归档复核必须绑定当前任务、原件与提取版本。');
    }
    if (current.source_ref !== book.source_ref || current.source_revision !== book.source_revision)
      fail('REVISION_CONFLICT', '等待归档期间任务绑定的原书版本发生变化。');
    const gapsReviewed = review && Array.isArray(review.reviewed_warnings) && current.warnings?.length > 0
      && JSON.stringify(review.reviewed_warnings) === JSON.stringify(current.warnings);
    if ((current.incomplete !== false && !gapsReviewed) || !Array.isArray(current.units) || !current.units.length)
      fail('BOOK_INCOMPLETE', '原书提取不完整或没有授权正文，继续保留 Inbox 原件。');
    for (const unit of current.units) {
      const outcome = job.book_outcomes?.[unit.ref];
      if (outcome?.status !== 'processed') fail('BOOK_INCOMPLETE', '该书仍有未处理或延期的原文，继续保留 Inbox 原件。', { ref: unit.ref });
      const actual = inspectBookUnit(root, job, unit.ref), total = count(actual.body);
      if ((actual.meta.incomplete === true && !gapsReviewed) || outcome.revision !== actual.revision || outcome.delivered_chars !== total)
        fail('BOOK_INCOMPLETE', '原文的提取完整性、版本或完整递送记录尚未通过，继续保留 Inbox 原件。', { ref: unit.ref });
    }
    if (unoRevision(root, current.source_ref) !== current.source_revision)
      fail('STALE_EVIDENCE', '不可变归档原件缺失或版本变化，未移除 Inbox 原件。');
    const inboxRevision = unoRevision(root, source);
    if (inboxRevision === null) fail('SOURCE_MISSING', 'Inbox 原件已不存在，且没有本次归档收据；不能推定已归档。');
    if (inboxRevision !== current.source_revision) fail('REVISION_CONFLICT', 'Inbox 原件已变化，新版本已保全，未执行归档移除。');
    expect(root, { [source]: current.source_revision, [current.source_ref]: current.source_revision });
    const result = { summary: `完成图书归档：${current.title ?? source}`,
      job_id, source, source_ref: current.source_ref, source_revision: current.source_revision,
      archived: true, inbox_removed: true, unit_count: current.units.length, card_ids: [],
      ...(review ? { review, extraction_incomplete: current.incomplete === true } : {}),
      notice: 'Inbox 原件与既有不可变归档版本一致；仅移除已处理的 Inbox 条目，原书内容和知识卡保持不变。' };
    job.archives = [...(job.archives ?? []).filter(row => row.key !== key), { ...result, key }];
    if (review) job.detail = `已复核原文提取警告并完成归档；Inbox 条目已移除，不可变原件保留在 ${current.source_ref}。`;
    job.version = (job.version ?? 0) + 1; job.updated_at = new Date().toISOString();
    return { writes: new Map([[source, null], [`.nexogenesis/uno-jobs/${job_id}.json`, JSON.stringify(job)]]), result };
  });
}

/** Remove a byte-identical Inbox copy that appeared after a completed archive.
 * This is deliberately separate from archive receipt replay: a different file
 * under the old name remains protected, while an explicit request can clean up
 * only the exact version already preserved in the immutable archive. */
export function reconcileArchivedBookInboxCopy(root, { job_id, source, request_id }) {
  if (typeof request_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(request_id))
    fail('INVALID_ARGUMENTS', '清理已归档副本需要有效的请求标识。');
  const job = persistedJob(root, job_id), book = archiveBookDescriptor(job, source);
  const archiveKey = `book-archive-v1:${job_id}:${sha(source).slice(0, 32)}`;
  const archived = readUnoReceipt(root, archiveKey);
  if (!archived || archived.accepted !== true || archived.archived !== true || archived.job_id !== job_id
    || archived.source !== source || archived.source_ref !== book.source_ref || archived.source_revision !== book.source_revision)
    fail('INVALID_RECEIPT', '找不到与当前任务、路径和原件版本一致的完成归档收据。');
  const key = `book-archive-copy-v1:${job_id}:${sha(source).slice(0, 24)}:${request_id}`;
  const input = { job_id, source, source_ref: book.source_ref, source_revision: book.source_revision, request_id };
  if (readUnoReceipt(root,key)) return transaction(root,key,input,()=>{ throw Error('历史副本清理回执不应重新执行删除。'); });
  if (unoRevision(root, book.source_ref) !== book.source_revision)
    fail('STALE_EVIDENCE', '不可变归档原件缺失或版本变化，未清理 Inbox 副本。');
  const inboxRevision = unoRevision(root, source);
  if (inboxRevision === null) fail('SOURCE_MISSING', 'Inbox 中没有需要清理的同名副本。');
  if (inboxRevision !== book.source_revision)
    fail('REVISION_CONFLICT', 'Inbox 同名文件不是已归档版本，已保全且未执行清理。');
  return transaction(root, key, input, () => {
    expect(root, { [source]: book.source_revision, [book.source_ref]: book.source_revision });
    return { writes: new Map([[source, null]]), result: {
      summary: `清理已归档图书的 Inbox 重复副本：${book.title ?? source}`,
      job_id, source, source_ref: book.source_ref, source_revision: book.source_revision,
      archived: true, inbox_removed: true, duplicate_reconciled: true, card_ids: [],
      notice: 'Inbox 副本与完成归档收据及不可变原件逐字节一致；仅移除重复条目，归档原书与知识卡保持不变。'
    } };
  });
}

function verifyPublishedVersion(root, jobId, receipt, row) {
  if (!row || !safeCardId(row.id) || typeof row.ref !== 'string' || !row.ref.startsWith('01-Cards/')
    || !/^[a-f0-9]{64}$/.test(row.revision) || receipt.revisions?.[row.id] !== row.revision
    || !Array.isArray(row.source_refs) || !row.source_refs.length)
    fail('INVALID_RECEIPT', '收据中的卡片版本或来源字段无效。');
  const candidates = [row.ref, `03-Archive/card-history/${row.id}/${row.revision}.md`];
  const versionRef = candidates.find(ref => unoRevision(root, ref) === row.revision);
  if (!versionRef) fail('MISSING_PUBLICATION', '找不到收据对应的已保存卡片版本：' + row.id);
  const { meta } = parseCardFile(unoPath(root, versionRef));
  if (meta.id !== row.id || meta.compile_job_id !== jobId || meta.compile_receipt_key !== receipt.key
    || meta.compile_operation_id !== receipt.operation_id
    || row.source_refs.some(ref => !(meta.source_spans ?? []).some(span => span.ref === ref)))
    fail('INVALID_RECEIPT', '卡片的任务、操作或来源标记与收据不一致：' + row.id);
  return { ...row, version_ref: versionRef, current_revision: unoRevision(root, row.ref),
    receipt_key: receipt.key, operation_id: receipt.operation_id, at: receipt.at };
}

/** Read-only reconciliation after a crash between the knowledge transaction and
 * the host's job save. The host persists the mutated job. Old successful writes
 * remain evidenced by their immutable card-history versions after later edits. */
export function reconcileBookReceipts(root, job) {
  if (!safeJobId(job?.id) || job.workflow !== BOOK_WORKFLOW) fail('INVALID_ARGUMENTS', '只能核对新图书编译任务的收据。');
  const directory = unoPath(root, '.nexogenesis/uno-receipts'), recovered = [], versions = [], issues = [], found = new Set();
  const prefix = `book-cards-v1:${job.id}:`;
  const linked=new Map();
  for(const link of job.repair_receipts??[]){
    try {
    const child=persistedJob(root,link.job_id),origin=child.repair_origin;
    if(origin?.parent_job_id!==job.id||origin.unit_ref!==link.unit_ref||origin.item_key!==link.item_key
      ||!job.unit_work?.[link.unit_ref]?.isolation?.items?.[link.item_key])fail('INVALID_RECEIPT','修复收据的原任务范围不匹配。');
    linked.set(link.key,child.id);
    }catch(error){issues.push({key:link.key,code:error.code??'INVALID_RECEIPT',detail:error.message});}
  }
  for (const name of existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) : []) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(unoPath(root, `.nexogenesis/uno-receipts/${name}`), 'utf8')); }
    catch { continue; } // Unrelated legacy receipts are not this job's authority.
    if (typeof receipt?.key !== 'string' || (!receipt.key.startsWith(prefix)&&!linked.has(receipt.key))) continue;
    found.add(receipt.key);
    try {
      const owner=linked.get(receipt.key)??job.id;
      if (receipt.accepted !== true || receipt.job_id !== owner || receipt.key !== bookOperationKey(owner, receipt.operation_id)
        || name !== sha(receipt.key) + '.json' || !Array.isArray(receipt.publication?.cards) || !receipt.publication.cards.length
        || !Array.isArray(receipt.card_ids) || new Set(receipt.card_ids).size !== receipt.card_ids.length
        || receipt.publication.cards.length !== receipt.card_ids.length
        || receipt.publication.cards.some(row => !receipt.card_ids.includes(row.id)))
        fail('INVALID_RECEIPT', '持久收据的任务、路径或卡片列表无效。');
      const verified = receipt.publication.cards.map(row => verifyPublishedVersion(root, owner, receipt, row));
      const sourceRefs = unique(verified.flatMap(row => row.source_refs));
      if (!Array.isArray(receipt.source_refs) || sourceRefs.length !== new Set(receipt.source_refs).size
        || sourceRefs.some(ref => !receipt.source_refs.includes(ref))) fail('INVALID_RECEIPT', '收据汇总来源与逐卡来源不一致。');
      recovered.push(receipt); versions.push(...verified);
    } catch (error) { issues.push({ key: receipt.key, code: error.code ?? 'INVALID_RECEIPT', detail: error.message }); }
  }
  for (const entry of [...(job.receipts ?? []),...(job.repair_receipts??[])]) if (typeof entry?.key === 'string' && (entry.key.startsWith(prefix)||linked.has(entry.key)) && !found.has(entry.key)&&!issues.some(issue=>issue.key===entry.key))
    issues.push({ key: entry.key, code: 'MISSING_RECEIPT', detail: '任务记录中的写入收据文件缺失或无法解析，未计入已确认成果。' });
  recovered.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.key.localeCompare(b.key));
  const results = {};
  for (const id of unique(versions.map(row => row.id))) {
    const rows = versions.filter(row => row.id === id), previousRevisions = new Set(rows.map(row => row.previous_revision).filter(Boolean));
    const newest = rows.find(row => row.revision === row.current_revision)
      ?? rows.filter(row => !previousRevisions.has(row.revision)).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0]
      ?? rows.at(-1);
    results[id] = { id, ref: newest.ref, latest_revision: newest.revision, current_revision: newest.current_revision,
      latest_receipt_key: newest.receipt_key, latest_operation_id: newest.operation_id,
      receipt_keys: unique(rows.map(row => row.receipt_key)), source_refs: unique(rows.flatMap(row => row.source_refs)) };
  }
  job.receipts = recovered;
  job.touched = Object.keys(results);
  job.book_card_results = results;
  job.book_receipt_issues = issues;
  return { recovered_receipts: recovered.length, card_ids: job.touched, results, issues };
}
