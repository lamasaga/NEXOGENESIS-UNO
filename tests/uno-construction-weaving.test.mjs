import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unoMarkdown } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { defaultConstructionControls } from '../packages/nexogenesis-tools/lib/construction-controls.js';
import { inspectRelationWeaving, LEGACY_RELATION_WEAVING_CONTRACT, planRelationWeavingRound,
  relationWeavingCandidatePool, relationWeavingEnabled, RELATION_WEAVING_CONTRACT,
  RELATION_WEAVING_ENDPOINT_RETRIEVAL, RELATION_WEAVING_FOCUS_SELECTION } from '../packages/nexogenesis-tools/lib/uno/construction-weaving.js';

function fixture(t, contract = RELATION_WEAVING_CONTRACT) {
  const root = mkdtempSync(join(tmpdir(), 'uno-weaving-')); mkdirSync(join(root, '01-Cards'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (id, { relations = [], title = `知识 ${id}`, summary = `${id} 的机制与成立条件`,
    body = `${id} 描述同一问题中的机制、条件与边界。`, domains = [], sources = [] } = {}) =>
    writeFileSync(join(root, '01-Cards', `${id}.md`), unoMarkdown({ schema: 'uno-card-v4', id,
      title, summary, type: 'mechanism', lifecycle: 'active', domains, sources, relations }, `## 核心思想\n\n${body}`));
  const job = { id: 'job-random-seed-1', construction_controls: defaultConstructionControls('connections'), requested_card_ids: [], domain: '', type: '',
    construction_query: '', requirements: { construction_controls: defaultConstructionControls('connections') }, relation_weaving: { contract, rounds: [] } };
  return { root, write, job };
}

test('new relation discovery randomly freezes one unreviewed card regardless of topology', t => {
  const f = fixture(t);
  f.write('connected-a', { relations: [{ target: 'connected-b', type: 'contrast', note: '同一问题的不同条件。', basis: 'navigation' }] });
  f.write('connected-b'); f.write('isolated-c'); f.write('isolated-d');
  assert.equal(relationWeavingEnabled(f.job), true);
  const first = inspectRelationWeaving(f.root, f.job), repeated = inspectRelationWeaving(f.root, f.job);
  assert.equal(first.contract, RELATION_WEAVING_CONTRACT); assert.equal(first.phase, 'random');
  assert.equal(first.focus.ids.length, 1); assert.deepEqual(repeated.focus.ids, first.focus.ids, '恢复时随机结果必须稳定');
  assert.equal(first.focus_selection, RELATION_WEAVING_FOCUS_SELECTION);
  assert.equal(first.counts.unreviewed, 4); assert.equal(first.counts.isolated, 2);
  f.job.relation_weaving.rounds.push({ focus_ids: first.focus.ids, focus_fingerprint: first.focus.fingerprint,
    status: 'reviewed-independent', published: [] });
  const second = inspectRelationWeaving(f.root, f.job);
  assert.notDeepEqual(second.focus.ids, first.focus.ids); assert.equal(second.counts.unreviewed, 3);
});

test('endpoint retrieval searches all cards and ranks semantic evidence instead of main-graph position', t => {
  const f = fixture(t); f.job.requested_card_ids = ['focus'];
  f.write('focus', { title: '央行数字货币的发行与现金回收', summary: '数字货币发行、现金回收与货币总量约束',
    body: '央行数字货币发行时等额回收现金，维持货币总量并改变清算方式。', sources: ['材料-货币'] });
  f.write('semantic-best', { title: '数字货币清算机制', summary: '数字货币清算与现金替代',
    body: '数字货币改变清算结构，并讨论发行与现金替代条件。', sources: ['材料-货币'] });
  f.write('main-a', { title: '土地财政', body: '土地供应和地方财政推动城市投资。',
    relations: [{ target: 'main-b', type: 'supplement', note: '补充城市投资条件。', basis: 'navigation' }] });
  f.write('main-b', { title: '城市投资', body: '地方政府通过基础设施投资推动城市发展。' });
  const diagnosis = inspectRelationWeaving(f.root, f.job);
  assert.deepEqual(diagnosis.focus.ids, ['focus']);
  const pool = relationWeavingCandidatePool(f.root, f.job, diagnosis);
  assert.equal(pool.weaving.endpoint_retrieval, RELATION_WEAVING_ENDPOINT_RETRIEVAL);
  assert.equal(pool.candidates[0].id, 'focus'); assert.equal(pool.candidates[0].required, true);
  assert.equal(pool.candidates[1].id, 'semantic-best');
  assert.match(pool.candidates[1].retrieval.why, /共享|语义/);
  const plan = planRelationWeavingRound(pool, f.job);
  assert.equal(plan.kind, 'host-planned-random-relation-discovery');
  assert.match(plan.notice, /全部有效卡片中检索/); assert.ok(plan.packages[0].card_ids.includes('semantic-best'));
});

test('a deferred random focus retries untried retrieved endpoints once, then advances', t => {
  const f = fixture(t); f.job.requested_card_ids = ['focus'];
  f.write('focus', { title: '平台治理机制', body: '平台治理通过规则、审核、责任和激励约束交易风险。', sources: ['平台材料'] });
  for (let i = 0; i < 12; i++) f.write(`candidate-${i}`, { title: `平台治理候选 ${i}`,
    body: `平台规则审核责任激励与交易风险机制 ${i}。`, sources: ['平台材料'] });
  let diagnosis = inspectRelationWeaving(f.root, f.job), first = relationWeavingCandidatePool(f.root, f.job, diagnosis);
  const firstEndpoints = first.candidates.filter(row => row.id !== 'focus').map(row => row.id);
  f.job.relation_weaving.rounds.push({ round: 1, focus_fingerprint: diagnosis.focus.fingerprint, focus_ids: ['focus'],
    candidate_ids: first.candidates.map(row => row.id), status: 'deferred', published: [] });
  diagnosis = inspectRelationWeaving(f.root, f.job); assert.deepEqual(diagnosis.focus.ids, ['focus']);
  const second = relationWeavingCandidatePool(f.root, f.job, diagnosis);
  assert.equal(second.weaving.attempt, 2);
  assert.ok(second.candidates.filter(row => row.id !== 'focus').every(row => !firstEndpoints.includes(row.id)));
  f.job.relation_weaving.rounds.push({ round: 2, focus_fingerprint: diagnosis.focus.fingerprint, focus_ids: ['focus'],
    candidate_ids: second.candidates.map(row => row.id), status: 'deferred-exhausted', published: [] });
  diagnosis = inspectRelationWeaving(f.root, f.job); assert.notDeepEqual(diagnosis.focus?.ids, ['focus']);
});

test('no retrieved endpoint produces an auditable no-selection wave without a model package', t => {
  const f = fixture(t); f.job.requested_card_ids = ['focus'];
  f.write('focus', { title: '完全独特对象', body: '甲乙丙丁戊己庚辛。' });
  f.write('other', { title: '无关材料', body: '量子颜色音乐节奏。' });
  const diagnosis = inspectRelationWeaving(f.root, f.job), pool = relationWeavingCandidatePool(f.root, f.job, diagnosis);
  const plan = planRelationWeavingRound(pool, f.job);
  assert.equal(plan.packages.length, 0); assert.match(plan.notice, /不调用模型/);
});

test('legacy relation weaving retains isolated-then-island ordering for existing tasks', t => {
  const f = fixture(t, LEGACY_RELATION_WEAVING_CONTRACT); f.job.requested_card_ids = ['e'];
  f.write('a', { relations: [{ target: 'b', type: 'contrast', note: '同一问题的不同条件。', basis: 'navigation' }] }); f.write('b');
  f.write('c', { relations: [{ target: 'd', type: 'supplement', note: '补充另一项成立条件。', basis: 'navigation' }] }); f.write('d'); f.write('e');
  let diagnosis = inspectRelationWeaving(f.root, f.job);
  assert.equal(diagnosis.phase, 'isolated'); assert.deepEqual(diagnosis.focus.ids, ['e']);
  f.job.relation_weaving.rounds.push({ focus_fingerprint: diagnosis.focus.fingerprint, reviewed_fingerprints: [], status: 'reviewed-independent' });
  diagnosis = inspectRelationWeaving(f.root, f.job);
  assert.equal(diagnosis.phase, 'island'); assert.deepEqual(diagnosis.focus.ids, ['c', 'd']);
});
