import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadCards, parseCardFile } from '../cards.js';
import { safeCardId } from '../uno-contract.js';
import { expect, sha, transaction, unoCardRef, unoMarkdown, unoPath, unoRevision } from '../harness/uno-storage.js';

const uuid = /^[a-z0-9-]{8,80}$/i;
const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const noteBase = id => `01-Cards/_meta/reader-notes/${sha(id)}`;
export const readerBody = body => body.replace(/(?:<!--|&lt;!--|&#60;!--)\s*unit\s*:[\s\S]*?(?:-->|--&gt;|--&#62;)/gi, '');

export function readReaderNotes(root, id) {
  if (!safeCardId(id)) throw new Error('卡片标识无效。');
  const base = noteBase(id), dir = unoPath(root, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[a-z0-9-]{8,80}\.md$/i.test(name)).map(name => {
    const ref = `${base}/${name}`, { meta, body } = parseCardFile(unoPath(root, ref));
    if (meta.kind !== 'uno-reader-note-v1' || meta.card_id !== id) throw new Error('个人笔记归属不一致。');
    return { id: meta.note_id, text: body, anchor: meta.anchor ?? null, created_at: meta.created_at,
      updated_at: meta.updated_at, author: 'user', revision: unoRevision(root, ref) };
  }).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Explicit human edits; preserves every source, relation and classification field. */
export function writeReaderEntry(root, input) {
  if (input?.author !== 'user' || !safeCardId(input.card_id) || !revision(input.expected_revision)) throw new Error('卡片标识、作者或版本无效。');
  if (!['body', 'note'].includes(input.operation)) throw new Error('编辑操作无效。');
  const text = input.text;
  if (typeof text !== 'string' || !text.trim() || text.length > (input.operation === 'body' ? 200000 : 20000) || /\x00/.test(text)) throw new Error('请填写有效内容，正文最多 20 万字符，笔记最多 2 万字符。');
  if (input.operation === 'note' && (!uuid.test(input.note_id ?? '') || !(input.expected_note_revision === null || revision(input.expected_note_revision)))) throw new Error('笔记标识或版本无效。');
  return transaction(root, input.key, input, () => {
    const card = loadCards(root, { includeInactive: true }).get(input.card_id);
    if (!card || ['archived', 'superseded'].includes(card.meta.lifecycle)) throw new Error('卡片不存在或已退役，不能编辑。');
    const ref = unoCardRef(root, card);
    expect(root, { [ref]: input.expected_revision });
    const writes = new Map(), now = new Date().toISOString();
    let target, markdown;
    if (input.operation === 'body') {
      target = ref;
      markdown = unoMarkdown({ ...card.meta, updated: now.slice(0, 10), user_edited_at: now, last_edited_by: 'user' }, text);
    } else {
      target = `${noteBase(input.card_id)}/${input.note_id}.md`;
      expect(root, { [target]: input.expected_note_revision });
      const previous = existsSync(unoPath(root, target)) ? parseCardFile(unoPath(root, target)) : null;
      if (previous && (previous.meta.card_id !== input.card_id || previous.meta.note_id !== input.note_id)) throw new Error('笔记归属不一致。');
      let anchor = previous?.meta.anchor ?? null;
      if (!previous && input.anchor != null) {
        const a = input.anchor, body = readerBody(card.body);
        if (typeof a.block !== 'string' || !a.block || a.block.length > 30000 || !Number.isInteger(a.block_start) || a.block_start < 0 || body.slice(a.block_start, a.block_start + a.block.length) !== a.block || typeof a.quote !== 'string' || !a.quote.trim() || a.quote.length > 10000 || !Number.isInteger(a.start) || a.start < 0 || !Number.isInteger(a.end) || a.end <= a.start || a.end - a.start !== a.quote.length) throw new Error('引用段落已变化，请重新划选。');
        anchor = { block: a.block, block_start: a.block_start, quote: a.quote, start: a.start, end: a.end,
          before: body.slice(Math.max(0, a.block_start - 80), a.block_start), after: body.slice(a.block_start + a.block.length, a.block_start + a.block.length + 80) };
      }
      markdown = unoMarkdown({ kind: 'uno-reader-note-v1', card_id: input.card_id, note_id: input.note_id, author: 'user', anchor,
        source_revision: previous?.meta.source_revision ?? input.expected_revision, created_at: previous?.meta.created_at ?? now, updated_at: now }, text.trim());
    }
    const before = unoRevision(root, target);
    if (before) {
      const history = input.operation === 'body' ? `03-Archive/card-history/${input.card_id}/${before}.md` : `03-Archive/reader-note-history/${sha(input.card_id)}/${input.note_id}/${before}.md`;
      if (!existsSync(unoPath(root, history))) writes.set(history, readFileSync(unoPath(root, target)));
    }
    writes.set(target, markdown);
    return { writes, result: { operator: 'harness.write_reader_entry', summary: input.operation === 'body' ? '用户保存卡片正文' : '用户保存个人笔记',
      card_id: input.card_id, note_id: input.note_id ?? null, ref: target, revision: sha(markdown), author: 'user' } };
  });
}
