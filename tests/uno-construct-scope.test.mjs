import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConstructCards, startUnoJob } from '../packages/nexogenesis-web-host/lib/uno-jobs.js';

const inventory = {
  types: [{id:'mechanism',label:'机制'},{id:'claim',label:'观点'}],
  domains: [{id:'institutions',title:'制度治理'}],
  cards: [
    {id: '既有金融卡', type:'claim', domains: ['institutions']},
    {id: 'chapter-new-one', type:'mechanism', domains: []},
    {id: 'chapter-new-two', type:'mechanism', domains: ['institutions']},
  ],
};
test('explicit construction scope selects only requested current cards and preserves caller order', () => {
  const selected = selectConstructCards(inventory, {notes: '', card_ids: ['chapter-new-two', 'chapter-new-one']});
  assert.deepEqual(selected.map(card => card.id), ['chapter-new-two', 'chapter-new-one']);
  assert.equal(inventory.cards.length, 3);
});
test('invalid or ambiguous explicit scope fails closed instead of constructing the entire library', () => {
  for (const ids of [[], null, 'chapter-new-one', ['missing'], ['chapter-new-one', 'chapter-new-one'], [42], ['../file']]) {
    assert.throws(() => selectConstructCards(inventory, {notes: '', card_ids: ids}), error => error.status === 400);
  }
  assert.throws(() => selectConstructCards(inventory, {notes: '', domain: 'institutions', card_ids: ['chapter-new-one']}), /类型与领域范围/);
});
test('existing type/domain or all-card selection remains available only when explicit IDs are absent', () => {
  assert.equal(selectConstructCards(inventory, {notes: ''}).length, 3);
  assert.deepEqual(selectConstructCards(inventory, {notes: '', domain: 'institutions'}).map(card => card.id), ['既有金融卡', 'chapter-new-two']);
  assert.deepEqual(selectConstructCards(inventory, {notes: '', type: 'mechanism'}).map(card => card.id), ['chapter-new-one', 'chapter-new-two']);
  assert.throws(() => selectConstructCards(inventory, {notes: '', domain: 'unknown'}), /范围/);
});
test('unknown execution profiles are rejected before native session or provider access', async () => {
  const ctx = new Proxy({}, {get() { throw new Error('unexpected host access'); }});
  for (const execution_profile of [null, '', 'evidence-pack-v2', {}, 1]) {
    await assert.rejects(startUnoJob(ctx, process.cwd(), {mode: 'compile', compile_profile:'unit-cards-v3', execution_profile}), error => error.status === 400);
  }
});
