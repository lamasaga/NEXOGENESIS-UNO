import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BOOK_WORKFLOW, prepareBookSource, readBookUnit, saveBookCards, listBookJobCards, bookOperationKey, reconcileBookReceipts, archiveCompletedBook, reconcileArchivedBookInboxCopy } from '../packages/nexogenesis-tools/lib/uno/book-store.js';
import { sha, unoPath, unoRevision, unoMarkdown, readUnoReceipt } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { parseCardFile, invalidateKnowledgeSnapshot } from '../packages/nexogenesis-tools/lib/cards.js';

function fixture(t, { text = '第一章\n\n甲😀乙，先描述前提，再说明作用机制。\n\n第二段给出例子与边界。', chapters, prepared: extra = {}, unit_char_limit } = {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'uno-book-store-'));
  t.after(() => { assert.ok(resolve(root).startsWith(parent + sep)); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, '00-Inbox')); mkdirSync(join(root, '.nexogenesis/uno-jobs'), { recursive: true });
  const source = '00-Inbox/合成图书.md'; writeFileSync(unoPath(root, source), text);
  const prepared = { fingerprint: sha(Buffer.from(text)), format: 'markdown', title: '合成图书',
    chapters: chapters ?? [{ title: '第一章', locator: '行 1–5', text }], warnings: [], ...extra };
  const info = prepareBookSource(root, { source, prepared, ...(unit_char_limit ? { unit_char_limit } : {}) });
  const job = { id: 'book-job', workflow: BOOK_WORKFLOW, status: 'running', session_id: 'session-a',
    sessions: ['session-a'], book_units: info.units, book_reads: {}, book_card_reads: {}, sources: [{ ...info, original_source: source }], book_outcomes: {} };
  const persist = () => writeFileSync(unoPath(root, '.nexogenesis/uno-jobs/book-job.json'), JSON.stringify(job));
  persist();
  const deliver = (unit = info.units[0], range = {}) => {
    const page = readBookUnit(root, job, { ref: unit.ref, ...range });
    const previous = job.book_reads[unit.ref];
    job.book_reads[unit.ref] = { revision: page.revision, session_id: job.session_id,
      intervals: [...(previous?.session_id === job.session_id ? previous.intervals : []), [page.offset, page.end]] };
    persist(); return page;
  };
  const card = (id = '机制', extra = {}) => ({ id, title: '有条件的机制', type:'model',domains: [], body:'## 核心思想\n原文描述了制度条件下的作用机制。\n\n## 关键组件\n制度约束行动者可选择的行为。\n\n## 结构关系或因果链条\n约束变化通过激励影响行动。\n\n## 失效边界\n只适用于来源限定的制度环境。\n\n## 来源与证据边界\n依据本单元的制度描述，不能从特定经验推广为普遍因果。',
    sources: [{ ref: info.units[0].ref }], relations: [], ...extra });
  const save = (cards, operation_id = 'save-one') => saveBookCards(root, { job_id: job.id, session_id: job.session_id, operation_id, cards });
  return { root, source, prepared, info, job, persist, deliver, card, save };
}

function markBookProcessed(f) {
  for (const unit of f.info.units) {
    const page = f.deliver(unit, { limit: 24000 });
    f.job.book_outcomes[unit.ref] = { status: 'processed', revision: page.revision, delivered_chars: page.total_chars,
      total_chars: page.total_chars, note: '已完整处理本单元，具体成果由本任务收据保存。', card_ids: [] };
  }
  f.persist();
}

test('book sources keep the Inbox and freeze distinct extraction versions with PDF locations and assets', t => {
  const f = fixture(t, { prepared: { format: 'pdf', chapters: [{ title: '甲章', locator: 'PDF physical pages 12–13', physical_pages: [12, 13], text: '同一原书的提取版本甲。' }],
    warnings: ['图片和表格需回查原书。'], assets: [{ name: 'figure.png', data: Buffer.from('synthetic-image').toString('base64'), mime: 'image/png', locator: 'PDF page 12', caption: '示意图' }] } });
  assert.ok(existsSync(unoPath(f.root, f.source)));
  const base = `05-Buffer/books/${f.info.source_revision}/${f.info.extraction_revision}`;
  assert.equal(f.info.storage_layout, 'buffer-book-units-v1');
  assert.equal(f.info.source_ref, `03-Archive/books/${f.info.source_revision}/original.md`);
  assert.equal(f.info.catalog_ref, base + '/catalog.md');
  assert.ok(f.info.units.every(unit => unit.ref.startsWith(base + '/units/')));
  assert.ok(f.info.assets.every(asset => asset.ref.startsWith(base + '/assets/')));
  assert.equal(existsSync(unoPath(f.root, `03-Archive/books/${f.info.source_revision}/${f.info.extraction_revision}`)), false);
  assert.equal(sha(readFileSync(unoPath(f.root, f.info.source_ref))), f.info.source_revision);
  const originalUnit = readFileSync(unoPath(f.root, f.info.units[0].ref));
  const next = prepareBookSource(f.root, { source: f.source, prepared: { ...f.prepared, chapters: [{ ...f.prepared.chapters[0], text: '同一原书的提取版本乙。' }] } });
  assert.equal(next.source_revision, f.info.source_revision);
  assert.notEqual(next.extraction_revision, f.info.extraction_revision);
  assert.notEqual(next.units[0].ref, f.info.units[0].ref);
  assert.deepEqual(readFileSync(unoPath(f.root, f.info.units[0].ref)), originalUnit);
  const page = f.deliver();
  assert.deepEqual(page.chapter_metadata.physical_pages, [12, 13]);
  assert.match(page.locator, /PDF physical pages 12–13/);
  assert.match(page.warnings[0], /图片/);
  assert.equal(readFileSync(unoPath(f.root, page.assets[0].ref), 'utf8'), 'synthetic-image');
  assert.deepEqual(prepareBookSource(f.root, { source: f.source, prepared: f.prepared }), f.info);
});

test('book chapter splitting bounds physical units and preserves chapter identity and every Unicode character', t => {
  const text = '甲'.repeat(15000) + '\n\n' + '乙😀'.repeat(8000) + '\n\n' + '丙'.repeat(90000);
  const f = fixture(t, { text });
  assert.ok(f.info.units.length > 1);
  assert.deepEqual(f.info.units.map(u => u.part), f.info.units.map((_, i) => i + 1));
  assert.ok(f.info.units.every(u => u.chapter_index === 0 && u.parts === f.info.units.length && u.chars <= 60000 && u.utf8_bytes <= 240000));
  assert.equal(f.info.units.map(u => parseCardFile(unoPath(f.root, u.ref)).body).join(''), text);
  assert.ok(f.info.warnings.some(row => row.includes('完整原文无删减')));
  const u = f.info.units[0], page = readBookUnit(f.root, f.job, { ref: u.ref, offset: 15003, limit: 3 });
  assert.equal(page.text, '😀乙😀'); assert.equal(page.end, 15006); assert.equal(page.next_offset, 15006);
});

test('book evidence rejects unknown refs, stale files and a changed original', t => {
  const f = fixture(t), ref = f.info.units[0].ref;
  assert.throws(() => readBookUnit(f.root, f.job, { ref: '03-Archive/other.md' }), { code: 'SCOPE_VIOLATION' });
  assert.throws(() => readBookUnit(f.root, f.job, { ref, offset: 1.5 }), { code: 'INVALID_ARGUMENTS' });
  writeFileSync(unoPath(f.root, ref), readFileSync(unoPath(f.root, ref), 'utf8') + '外部修改');
  assert.throws(() => readBookUnit(f.root, f.job, { ref }), { code: 'STALE_EVIDENCE' });
  assert.throws(() => prepareBookSource(f.root, { source: f.source, prepared: f.prepared }), { code: 'IMMUTABLE_SOURCE_CONFLICT' });
  writeFileSync(unoPath(f.root, f.source), '原件已变');
  assert.throws(() => prepareBookSource(f.root, { source: f.source, prepared: f.prepared }), { code: 'REVISION_CONFLICT' });
});

test('book writes require actual delivered source ranges in the current session', t => {
  const f = fixture(t), ref = f.info.units[0].ref;
  assert.throws(() => f.save([f.card()]), { code: 'UNDELIVERED_EVIDENCE' });
  f.deliver(undefined, { offset: 0, limit: 8 });
  assert.throws(() => f.save([f.card()]), { code: 'UNDELIVERED_EVIDENCE' });
  assert.throws(() => f.save([f.card('伪来源', { sources: [{ ref: '03-Archive/forged.md', start: 0, end: 2 }] })]), { code: 'SCOPE_VIOLATION' });
  const receipt = f.save([f.card('片段', { sources: [{ ref, start: 1, end: 8 }] })]);
  assert.deepEqual(receipt.source_refs, [ref]);
  const saved = parseCardFile(unoPath(f.root, '01-Cards/片段.md'));
  assert.ok(saved.meta.sources.includes(ref + '#char-1-8'));
  assert.equal(saved.meta.source_spans[0].end, 8);
  f.job.session_id = 'session-b'; f.job.sessions.push('session-b'); f.persist();
  assert.throws(() => f.save([f.card('新上下文', { sources: [{ ref, start: 1, end: 8 }] })], 'new-session'), { code: 'UNDELIVERED_EVIDENCE' });
  f.deliver(undefined, { offset: 1, limit: 7 });
  assert.deepEqual(f.save([f.card('新上下文', { sources: [{ ref, start: 1, end: 8 }] })], 'new-session').card_ids, ['新上下文']);
});

test('book writes combine adjacent delivered intervals without inventing evidence gaps', t => {
  const f = fixture(t), total = f.info.units[0].chars;
  f.deliver(undefined, { limit: 10 }); f.deliver(undefined, { offset: 11, limit: total - 11 });
  assert.throws(() => f.save([f.card()]), { code: 'UNDELIVERED_EVIDENCE' });
  f.deliver(undefined, { offset: 10, limit: 1 });
  assert.deepEqual(f.save([f.card()]).card_ids, ['机制']);
});

test('two independent libraries cannot share read authority, cards or receipts even for identical book refs', t => {
  const a = fixture(t), b = fixture(t);
  assert.equal(a.info.units[0].ref, b.info.units[0].ref);
  a.deliver(); const receipt = a.save([a.card()]);
  assert.throws(() => b.save([b.card()]), { code: 'UNDELIVERED_EVIDENCE' });
  assert.equal(existsSync(unoPath(b.root, '01-Cards/机制.md')), false);
  assert.equal(readUnoReceipt(b.root, receipt.key), null);
  assert.deepEqual(listBookJobCards(a.root, a.job.id).map(row => row.id), ['机制']);
  assert.deepEqual(listBookJobCards(b.root, b.job.id), []);
});

test('new cards and same-transaction relations commit together; invalid endpoint leaves no partial cards', t => {
  const f = fixture(t); f.deliver();
  const cards = [f.card('甲', { relations: [{ target: '乙', type: 'example', note: '乙记录该机制的一次具体事件。', basis: 'source' }] }), f.card('乙')];
  const receipt = f.save(cards);
  assert.deepEqual(receipt.card_ids, ['甲', '乙']);
  assert.equal(parseCardFile(unoPath(f.root, '01-Cards/甲.md')).meta.relations[0].target, '乙');
  for (const row of receipt.publication.cards) assert.equal(unoRevision(f.root, row.ref), row.revision);
  assert.throws(() => f.save([f.card('丙'), f.card('丁', { relations: [{ target: '幽灵', type: 'example', note: '不存在' }] })], 'bad-batch'), { code: 'INVALID_RELATION' });
  assert.equal(existsSync(unoPath(f.root, '01-Cards/丙.md')), false);
  assert.equal(readUnoReceipt(f.root, bookOperationKey(f.job.id, 'bad-batch')), null);
});

test('successful book operation replays its exact receipt across pause and resume, rejecting changed payload', t => {
  const f = fixture(t); f.deliver(); const cards = [f.card()], receipt = f.save(cards);
  const journal = readFileSync(unoPath(f.root, `06-Journal/${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  f.job.status = 'paused'; f.job.pause_requested = true; f.persist();
  assert.deepEqual(f.save(cards), receipt);
  assert.throws(() => f.save([f.card('other')]), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.save([f.card('other')], 'new-operation'), { code: 'TASK_STOPPED' });
  assert.equal(readFileSync(unoPath(f.root, `06-Journal/${new Date().toISOString().slice(0, 10)}.md`), 'utf8'), journal);
  f.job.status = 'running'; f.job.pause_requested = false; f.job.session_id = 'session-b'; f.job.sessions.push('session-b'); f.persist();
  assert.deepEqual(f.save(cards), receipt);
  assert.deepEqual(listBookJobCards(f.root, f.job.id).map(row => row.receipt_key), [receipt.key]);
});

test('old card updates require exact current revision and full card delivery while retaining historical source meaning', t => {
  const f = fixture(t); f.deliver(); mkdirSync(unoPath(f.root, '01-Cards'), { recursive: true });
  const ref = '01-Cards/旧卡.md', oldBody = '旧卡原有正文、反例与限定。';
  const oldMeta = { id: '旧卡', title: '旧标题', sources: ['Legacy source.pdf / Chapter 9'], tags: ['观点'], lifecycle: 'active',
    origin: 'system', maturity: 'growing', relations: [{ target: '目标', type: 'supports', note: '既有强关系原意', origin: 'document' }] };
  writeFileSync(unoPath(f.root, ref), unoMarkdown(oldMeta, oldBody));
  writeFileSync(unoPath(f.root, '01-Cards/目标.md'), unoMarkdown({ id: '目标', title: '目标', sources: ['legacy'], lifecycle: 'active' }, '目标正文'));
  invalidateKnowledgeSnapshot(f.root);
  let revision = unoRevision(f.root, ref);
  assert.throws(() => f.save([f.card('旧卡')]), { code: 'REVISION_CONFLICT' });
  assert.throws(() => f.save([f.card('旧卡', { revision })]), { code: 'UNDELIVERED_EVIDENCE' });
  f.job.book_card_reads['旧卡'] = { revision, session_id: f.job.session_id, intervals: [[0, Array.from(oldBody).length]] }; f.persist();
  writeFileSync(unoPath(f.root, ref), unoMarkdown(oldMeta, oldBody + '外部修订。'));
  assert.throws(() => f.save([f.card('旧卡', { revision })]), { code: 'REVISION_CONFLICT' });
  revision = unoRevision(f.root, ref); const prior = readFileSync(unoPath(f.root, ref));
  f.job.book_card_reads['旧卡'] = { revision, session_id: f.job.session_id, intervals: [[0, Array.from(oldBody + '外部修订。').length]] }; f.persist();
  f.save([f.card('旧卡', { revision })]);
  const updated = parseCardFile(unoPath(f.root, ref));
  assert.ok(updated.meta.sources.includes('Legacy source.pdf / Chapter 9'));
  assert.deepEqual(updated.meta.relations, oldMeta.relations);
  assert.equal(updated.meta.origin, 'system'); assert.equal(updated.meta.maturity, 'growing');
  assert.deepEqual(readFileSync(unoPath(f.root, `03-Archive/card-history/旧卡/${revision}.md`)), prior);
});

test('book write authority comes from persisted current task and cannot revive retired cards', t => {
  const f = fixture(t); f.deliver();
  assert.throws(() => saveBookCards(f.root, { job_id: f.job.id, session_id: 'impostor', operation_id: 'fake', cards: [f.card()] }), { code: 'STALE_CONTEXT' });
  f.job.workflow = 'uno-compile-v3'; f.persist();
  assert.throws(() => f.save([f.card()]), { code: 'SCOPE_VIOLATION' });
  f.job.workflow = BOOK_WORKFLOW; f.job.end_requested = true; f.persist();
  assert.throws(() => f.save([f.card()]), { code: 'TASK_STOPPED' });
  f.job.end_requested = false; f.persist();
  mkdirSync(unoPath(f.root, '01-Cards'), { recursive: true });
  writeFileSync(unoPath(f.root, '01-Cards/旧卡.md'), unoMarkdown({ id: '旧卡', lifecycle: 'superseded', superseded_by: '另卡' }, '退役原文'));
  invalidateKnowledgeSnapshot(f.root);
  assert.throws(() => f.save([f.card('旧卡')]), { code: 'CARD_RETIRED' });
});

test('book relation changes require delivered target content but preserving existing relations adds no reread requirement', t => {
  const f = fixture(t); f.deliver();
  f.save([f.card('目标')], 'seed-target');
  const relation = { target: '目标', type: 'contrast', note: '比较同一条件下的不同结果。', basis: 'navigation' };
  assert.throws(() => f.save([f.card('主卡', { relations: [relation] })]), { code: 'UNDELIVERED_EVIDENCE' });
  const target = parseCardFile(unoPath(f.root, '01-Cards/目标.md'));
  f.job.book_card_reads['目标'] = { revision: unoRevision(f.root, '01-Cards/目标.md'), session_id: f.job.session_id, intervals: [[0, Array.from(target.body).length]] }; f.persist();
  f.save([f.card('主卡', { relations: [relation] })]);
  const main = parseCardFile(unoPath(f.root, '01-Cards/主卡.md')), revision = unoRevision(f.root, '01-Cards/主卡.md');
  delete f.job.book_card_reads['目标'];
  f.job.book_card_reads['主卡'] = { revision, session_id: f.job.session_id, intervals: [[0, Array.from(main.body).length]] }; f.persist();
  f.save([f.card('主卡', { revision, relations: [relation] })], 'preserve-relation');
  assert.equal(parseCardFile(unoPath(f.root, '01-Cards/主卡.md')).meta.relations[0].basis, 'navigation');
  assert.throws(() => f.save(Array.from({length:101},(_,i)=>f.card('card'+i)), 'too-many'), { code: 'INVALID_ARGUMENTS' });
});

test('book receipt reconciliation closes the crash window and retains earlier writes and sources after a later revision', t => {
  const f = fixture(t, { chapters: [{ title: '甲章', locator: '第一章', text: '第一章的机制依据。' }, { title: '乙章', locator: '第二章', text: '第二章补充机制的适用条件。' }] });
  f.deliver();
  const first = f.save([f.card()]);
  // Simulate process exit after the atomic card save, before job.receipts/touched save.
  assert.equal(f.job.receipts, undefined);
  const jobPath = unoPath(f.root, '.nexogenesis/uno-jobs/book-job.json'), jobBefore = readFileSync(jobPath);
  const firstBytes = readFileSync(unoPath(f.root, '01-Cards/机制.md'));
  const result = reconcileBookReceipts(f.root, f.job);
  assert.equal(result.recovered_receipts, 1); assert.deepEqual(result.card_ids, ['机制']);
  assert.equal(f.job.receipts[0].key, first.key);
  assert.deepEqual(readFileSync(jobPath), jobBefore); // The host owns saving job state.
  assert.deepEqual(readFileSync(unoPath(f.root, '01-Cards/机制.md')), firstBytes);
  f.deliver(f.info.units[1]);
  const old = parseCardFile(unoPath(f.root, '01-Cards/机制.md'));
  f.job.book_card_reads['机制'] = { revision: first.revisions['机制'], session_id: f.job.session_id, intervals: [[0, Array.from(old.body).length]] }; f.persist();
  const second = f.save([f.card('机制', { revision: first.revisions['机制'], body: old.body + '\n\n第二章进一步限定了适用条件。', sources: [{ ref: f.info.units[1].ref }] })], 'enrich');
  f.job.receipts = []; f.job.touched = [];
  const both = reconcileBookReceipts(f.root, f.job);
  assert.equal(both.recovered_receipts, 2); assert.equal(both.issues.length, 0);
  assert.equal(both.results['机制'].latest_revision, second.revisions['机制']);
  assert.equal(both.results['机制'].latest_receipt_key, second.key);
  assert.deepEqual(new Set(both.results['机制'].source_refs), new Set(f.info.units.map(row => row.ref)));
  assert.ok(f.job.receipts.some(row => row.key === first.key));
});

test('book receipt reconciliation rejects fabricated summaries and never reads another library receipts', t => {
  const a = fixture(t), b = fixture(t); a.deliver();
  const receipt = a.save([a.card()]);
  b.job.receipts = [receipt]; b.job.touched = ['机制'];
  const isolated = reconcileBookReceipts(b.root, b.job);
  assert.equal(isolated.recovered_receipts, 0); assert.deepEqual(b.job.touched, []);
  assert.ok(isolated.issues.some(row => row.code === 'MISSING_RECEIPT'));
  const receiptPath = unoPath(a.root, `.nexogenesis/uno-receipts/${sha(receipt.key)}.json`);
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, publication: { cards: receipt.publication.cards.map(row => ({ ...row, source_refs: ['03-Archive/fabricated.md'] })) } }));
  const invalid = reconcileBookReceipts(a.root, a.job);
  assert.equal(invalid.recovered_receipts, 0); assert.deepEqual(a.job.touched, []);
  assert.equal(invalid.issues[0].code, 'INVALID_RECEIPT');
  assert.ok(existsSync(unoPath(a.root, '01-Cards/机制.md')));
});

test('completed book archive atomically removes Inbox, preserves original and cards, and replays after completion', t => {
  const f = fixture(t); f.deliver(); f.save([f.card()]); markBookProcessed(f);
  const original = readFileSync(unoPath(f.root, f.source)), cardBefore = readFileSync(unoPath(f.root, '01-Cards/机制.md'));
  const receipt = archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source });
  assert.equal(receipt.archived, true); assert.equal(receipt.inbox_removed, true);
  assert.equal(existsSync(unoPath(f.root, f.source)), false);
  assert.deepEqual(readFileSync(unoPath(f.root, f.info.source_ref)), original);
  assert.deepEqual(readFileSync(unoPath(f.root, '01-Cards/机制.md')), cardBefore);
  assert.deepEqual(readUnoReceipt(f.root, receipt.key), receipt);
  f.job.status = 'completed'; f.persist();
  assert.deepEqual(archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source }), receipt);
});

test('explicit archive review preserves ended status and gap records while moving a fully processed original', t => {
  const f = fixture(t, { prepared: { incomplete:true,warnings:['封面图无可提取正文'] } });
  markBookProcessed(f); f.job.status='ended';f.job.phase='ended';f.persist();
  const review={job_revision:unoRevision(f.root,'.nexogenesis/uno-jobs/book-job.json'),source_revision:f.info.source_revision,extraction_revision:f.info.extraction_revision,note:'复核源文件，两处缺口只有封面。',reviewed_warnings:f.info.warnings};
  assert.throws(()=>archiveCompletedBook(f.root,{job_id:f.job.id,source:f.source,review:{...review,job_revision:'0'.repeat(64)}}),{code:'REVISION_CONFLICT'});
  assert.throws(()=>archiveCompletedBook(f.root,{job_id:f.job.id,source:f.source,review:{...review,reviewed_warnings:[]}}),{code:'BOOK_INCOMPLETE'});
  const receipt=archiveCompletedBook(f.root,{job_id:f.job.id,source:f.source,review});
  assert.equal(existsSync(unoPath(f.root,f.source)),false);assert.equal(receipt.review.note,review.note);
  const saved=JSON.parse(readFileSync(unoPath(f.root,'.nexogenesis/uno-jobs/book-job.json'),'utf8'));
  assert.equal(saved.status,'ended');assert.equal(saved.sources[0].incomplete,true);assert.equal(saved.archives[0].key,receipt.key);
  assert.equal(unoRevision(f.root,f.info.source_ref),f.info.source_revision);
  assert.deepEqual(archiveCompletedBook(f.root,{job_id:f.job.id,source:f.source}),receipt);
});

test('provider-aware extraction may freeze a 90000-character physical unit', t => {
  const text='甲'.repeat(85000)+'\n\n'+'乙'.repeat(85000),f=fixture(t,{text,unit_char_limit:90000});
  assert.equal(f.info.units.length,2);assert.ok(f.info.units.every(unit=>unit.chars<=90000&&unit.utf8_bytes<=360000));
  const catalog=parseCardFile(unoPath(f.root,f.info.catalog_ref));assert.equal(catalog.meta.unit_segmentation.max_chars,90000);
  assert.equal(f.info.units.map(unit=>parseCardFile(unoPath(f.root,unit.ref)).body).join(''),text);
});

test('archive review cannot bypass unfinished units or authorize a running task', t => {
  for(const pending of [true,false]){
    const f=fixture(t);markBookProcessed(f);f.job.status=pending?'review':'running';f.job.phase=pending?'domain_review':'read';
    if(pending)delete f.job.book_outcomes[f.info.units[0].ref];f.persist();
    const review={job_revision:unoRevision(f.root,'.nexogenesis/uno-jobs/book-job.json'),source_revision:f.info.source_revision,extraction_revision:f.info.extraction_revision,note:'归档复核'};
    assert.throws(()=>archiveCompletedBook(f.root,{job_id:f.job.id,source:f.source,review}),{code:pending?'BOOK_INCOMPLETE':'TASK_STOPPED'});
    assert.ok(existsSync(unoPath(f.root,f.source)));
  }
});

test('unfinished, deferred, extraction-incomplete or stopped books keep their Inbox original', t => {
  for (const mode of ['pending', 'deferred', 'incomplete', 'paused', 'pause_requested', 'end_requested', 'cancel_requested', 'unproven']) {
    const f = fixture(t, mode === 'incomplete' ? { prepared: { incomplete: true } } : {});
    markBookProcessed(f);
    if (mode === 'pending') delete f.job.book_outcomes[f.info.units[0].ref];
    if (mode === 'deferred') f.job.book_outcomes[f.info.units[0].ref].status = 'deferred';
    if (mode === 'paused') f.job.status = 'paused';
    if (['pause_requested', 'end_requested', 'cancel_requested'].includes(mode)) f.job[mode] = true;
    if (mode === 'unproven') delete f.job.book_outcomes[f.info.units[0].ref].delivered_chars;
    f.persist();
    assert.throws(() => archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source }),
      { code: ['paused', 'pause_requested', 'end_requested', 'cancel_requested'].includes(mode) ? 'TASK_STOPPED' : 'BOOK_INCOMPLETE' }, mode);
    assert.equal(unoRevision(f.root, f.source), f.info.source_revision, mode);
  }
});

test('archive rejects changed originals, changed archives and sources outside the task', t => {
  const changed = fixture(t); markBookProcessed(changed);
  writeFileSync(unoPath(changed.root, changed.source), '用户的新原件版本');
  assert.throws(() => archiveCompletedBook(changed.root, { job_id: changed.job.id, source: changed.source }), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(unoPath(changed.root, changed.source), 'utf8'), '用户的新原件版本');
  const missingArchive = fixture(t); markBookProcessed(missingArchive);
  writeFileSync(unoPath(missingArchive.root, missingArchive.info.source_ref), '归档被外部改写');
  assert.throws(() => archiveCompletedBook(missingArchive.root, { job_id: missingArchive.job.id, source: missingArchive.source }), { code: 'STALE_EVIDENCE' });
  assert.ok(existsSync(unoPath(missingArchive.root, missingArchive.source)));
  assert.throws(() => archiveCompletedBook(changed.root, { job_id: changed.job.id, source: '00-Inbox/未选中的书.md' }), { code: 'SCOPE_VIOLATION' });
});

test('missing Inbox without archive receipt is not treated as successful archive', t => {
  const f = fixture(t); markBookProcessed(f);
  unlinkSync(unoPath(f.root, f.source));
  assert.throws(() => archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source }), { code: 'SOURCE_MISSING' });
  assert.equal(unoRevision(f.root, f.info.source_ref), f.info.source_revision);
});

test('archive resumes a crash after Inbox removal but before its receipt using transaction recovery', t => {
  const f = fixture(t); markBookProcessed(f);
  const original = readFileSync(unoPath(f.root, f.source));
  const key = `book-archive-v1:${f.job.id}:${sha(f.source).slice(0, 32)}`;
  const transactionRef = `.nexogenesis/uno-transactions/${sha(key)}.json`;
  mkdirSync(unoPath(f.root, '.nexogenesis/uno-transactions'), { recursive: true });
  writeFileSync(unoPath(f.root, transactionRef), JSON.stringify({ key, rows: [{ ref: f.source, before: original.toString('base64'), after: null }] }));
  unlinkSync(unoPath(f.root, f.source));
  const receipt = archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source });
  assert.equal(receipt.key, key); assert.equal(receipt.archived, true);
  assert.equal(existsSync(unoPath(f.root, f.source)), false);
  assert.equal(existsSync(unoPath(f.root, transactionRef)), false);
  assert.deepEqual(readFileSync(unoPath(f.root, f.info.source_ref)), original);
});

test('archive replay preserves a new file placed under the old Inbox name', t => {
  const f = fixture(t); markBookProcessed(f);
  const receipt = archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source });
  writeFileSync(unoPath(f.root, f.source), '后来放入的另一版本');
  assert.throws(() => archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source }), { code: 'ARCHIVE_SOURCE_REAPPEARED' });
  assert.equal(readFileSync(unoPath(f.root, f.source), 'utf8'), '后来放入的另一版本');
  assert.deepEqual(readUnoReceipt(f.root, receipt.key), receipt);
});

test('an explicit reconciliation removes only a byte-identical Inbox copy of a completed archive', t => {
  const f = fixture(t); markBookProcessed(f);
  const original = readFileSync(unoPath(f.root, f.source));
  const archived = archiveCompletedBook(f.root, { job_id: f.job.id, source: f.source });
  writeFileSync(unoPath(f.root, f.source), original);
  const cleaned = reconcileArchivedBookInboxCopy(f.root, { job_id: f.job.id, source: f.source, request_id: 'cleanup-1' });
  assert.equal(cleaned.duplicate_reconciled, true);
  assert.equal(existsSync(unoPath(f.root, f.source)), false);
  assert.equal(unoRevision(f.root, archived.source_ref), archived.source_revision);
  assert.deepEqual(reconcileArchivedBookInboxCopy(f.root, { job_id: f.job.id, source: f.source, request_id: 'cleanup-1' }), cleaned);
  writeFileSync(unoPath(f.root, f.source), '同名但内容不同的新材料');
  assert.throws(() => reconcileArchivedBookInboxCopy(f.root, { job_id: f.job.id, source: f.source, request_id: 'cleanup-2' }), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(unoPath(f.root, f.source), 'utf8'), '同名但内容不同的新材料');
});


// Persisted v2 jobs keep their original write contract; new v3 jobs never enter this branch.
test('a saved v2 task can still publish its legacy classification without changing the v3 default', t => {
  const f = fixture(t); f.job.workflow = 'uno-unit-compile-v2'; f.persist(); f.deliver();
  const legacy = f.card('legacy-v2', { domains: undefined, tags: ['机制'] });
  const receipt = f.save([legacy], 'legacy-v2-save');
  const saved = parseCardFile(unoPath(f.root, '01-Cards/legacy-v2.md'));
  assert.deepEqual(saved.meta.tags, ['机制']);
  assert.equal(saved.meta.schema, 'uno-card-v3');
  assert.deepEqual(receipt.card_ids, ['legacy-v2']);
});
