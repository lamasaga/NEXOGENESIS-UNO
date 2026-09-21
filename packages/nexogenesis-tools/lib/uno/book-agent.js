export { BOOK_WORKFLOW } from './book-sources.js';
import { BOOK_WORKFLOW } from './book-sources.js';
export function bookResumeState(job) {
  if (['completed', 'ended'].includes(job.status) || job.end_requested)
    return { available: false, reason: '本次编译已结束。' };
  const progress = bookProgress(job);
  if (job.phase !== 'done' || progress.pending || progress.deferred || job.failures?.length)
    return { available: true, reason: '' };
  return { available: false, reason: progress.extraction_incomplete.length
    ? '可读单元已全部处理。请先核对原件中未提取正文的页面；如有实质内容，补充可读材料后新建编译。直接继续不会补出缺失正文。'
    : progress.quarantined ? '编译主线已处理完毕。隔离的问题保留在未组织池，请逐项修复，不需要重编已完成单元。'
    : job.book_receipt_issues?.length ? '本轮执行已结束，成果收据仍需核对；重复编译不能代替收据核验。'
    : '本轮没有可继续的阅读单元。领域组织待办已保留，不需要重复编译原文。' };
}
export function bookProgress(job) {
  const units = job.book_units ?? [], outcomes = job.book_outcomes ?? {}, focus = new Set(job.book_focus_refs ?? []);
  return { workflow: BOOK_WORKFLOW, id: job.id, status: job.status, total_units: units.length,
    processed: units.filter(u => outcomes[u.ref]?.status === 'processed').length, deferred: units.filter(u => outcomes[u.ref]?.status === 'deferred').length,
    quarantined: units.filter(u => outcomes[u.ref]?.status === 'quarantined').length,
    pending: units.filter(u => !outcomes[u.ref]).length, focus: units.filter(u => focus.has(u.ref)).map(u => ({ ref: u.ref, title: u.title, locator: u.locator, chars: u.chars, chapter_index: u.chapter_index, part: u.part, parts: u.parts, continuation: u.continuation, outcome: outcomes[u.ref]?.status ?? null })),
    touched_cards: job.touched?.length ?? 0, checkpoint: job.checkpoint ?? '', advance_requested: !!job.book_advance_requested, finish_requested: !!job.finish_requested,
    extraction_incomplete: (job.sources ?? []).filter(source => source.incomplete === true).map(source => source.source ?? source.source_ref),
    reminder: 'processed 是作者结算并已核对递送与收据；不证明语义质量。deferred 不计完成。' };
}
