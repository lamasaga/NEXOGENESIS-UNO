import { parseCardFile } from '../cards.js';
import { readUnoUnit, unoPath, unoRevision, sha } from '../harness/uno-storage.js';
import { executionError } from './execution-contract.js';
import { locateQuote } from './quote-locator.js';

/** A checked quotation is a locator, never a programmatic proof of its meaning. */
export function validateReviewChecks(root, job, args, drafts) {
  if (job.orchestration_profile !== 'bounded-workflow-v1' || !args.note) return new Map();
  const checks = args.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 24) throw executionError('INVALID_ARGUMENTS', '审核 checks 最多 24 项，每项为 {id,claim,ref,quote}。');
  const ids = args.ids ?? drafts.map(d => d.card.id), byId = new Map(drafts.map(d => [d.card.id,d]));
  const result = new Map();
  for (const check of checks) {
    if (!check || !ids.includes(check.id) || !byId.has(check.id)) throw executionError('INVALID_ARGUMENTS', 'checks 只能核对本次审核的草稿 ID。');
    for (const key of ['claim','quote']) if (typeof check[key] !== 'string' || !check[key].trim() || Array.from(check[key]).length > 600)
      throw executionError('INVALID_ARGUMENTS', `审核 ${key} 必须为 1–600 字符的具体内容。`);
    const draft = byId.get(check.id), ref = check.ref;
    if (typeof ref !== 'string' || !(draft.card.sources ?? []).some(source => source.split('#')[0] === ref)
      || !/^(05-Buffer|03-Archive)\/.+\.md$/.test(ref))
      throw executionError('INVALID_SOURCE', '审核证据须引用当前草稿已绑定的原文或聚合来源文件。');
    const unit = ref.startsWith('05-Buffer/') ? readUnoUnit(root,ref) : parseCardFile(unoPath(root,ref));
    const reading = job.review_evidence?.[ref];
    if (!reading || ![sha(unit.body),unoRevision(root,ref)].includes(reading.revision))
      throw executionError('STALE_EVIDENCE', '审核原句所在来源尚未在当前审核上下文交付，或来源版本已变化。');
    // Prefer a matching occurrence inside a delivered interval; a later occurrence
    // must not be credited merely because the file's opening was read.
    const match=locateQuote(unit.body,check.quote,{intervals:reading.intervals??[]});
    if (!match) throw executionError('UNDELIVERED_EVIDENCE', '审核原句不在实际交付过的来源区间中；请读取正确位置或修正引用。');
    const entry = {claim:check.claim.trim(),ref,...match,source_revision:sha(unit.body)};
    result.set(check.id,[...(result.get(check.id) ?? []),entry]);
  }
  for (const id of ids) {
    if (!byId.has(id) || (args.issues ?? []).some(issue => issue.id === id)) continue;
    if (!result.get(id)?.length) throw executionError('MISSING_REVIEW_CHECK', '通过草稿须给出至少一项具体关键命题及来源原句 checks；有未解决问题应明确列入 issues：'+id);
  }
  return result;
}
