import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unoMarkdown, unoRevision } from '../packages/nexogenesis-tools/lib/harness/uno-storage.js';
import { loadCards, invalidateKnowledgeSnapshot } from '../packages/nexogenesis-tools/lib/cards.js';
import { HarnessGateway } from '../packages/nexogenesis-tools/lib/harness/gateway.js';
import { readDraft } from '../packages/nexogenesis-tools/lib/uno/drafts.js';
import { saveCompileJob } from '../packages/nexogenesis-tools/lib/uno/state.js';
import { defaultConstructionControls } from '../packages/nexogenesis-tools/lib/construction-controls.js';
import { constructionCandidatePool, validateConstructionStrategy, STRATEGY_CONSTRUCTION_PROFILE,
  STRATEGY_CONSTRUCTION_WORKFLOW } from '../packages/nexogenesis-tools/lib/uno/construction-strategy.js';
import { buildConstructionAuthorRequest, buildConstructionReviewRequest, buildConstructionStrategyRequest, validateConstructionAuthorResponse,
  constructionJSONRecovery, CONSTRUCTION_STRATEGY_CONTEXT_LIMIT, parseConstructionJSON,
  normalizeConstructionReviewResponse, validateConstructionReviewResponse } from '../packages/nexogenesis-web-host/lib/construction-request.js';
import { computeResumePlan } from '../packages/nexogenesis-web-host/lib/resume-plan.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uno-strategy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '01-Cards'), { recursive: true });
  mkdirSync(join(root, '03-Archive'), { recursive: true });
  writeFileSync(join(root, '03-Archive/source.md'), unoMarkdown({ title: '来源' }, '来源说明财政扩张有条件，并记录通胀反例。'));
  const add = (id, title, summary = title) => writeFileSync(join(root, '01-Cards', id + '.md'), unoMarkdown({
    schema: 'uno-card-v4', id, title, summary, type: 'claim', domains: [], boundary: '仅限当前来源',
    sources: ['03-Archive/source.md'], relations: [], lifecycle: 'active'
  }, `${title}。正文保留成立条件、作者判断与反例。`));
  add('fiscal', '财政扩张的条件'); add('inflation', '通胀反例'); add('astronomy', '恒星分类');
  invalidateKnowledgeSnapshot(root);
  return { root };
}

const response = selected => ({
  strategy: { goal: '比较财政扩张与通胀反例', expected_improvement: '建立有边界的对照', operations: ['relation_add'],
    decision_rules: ['只有两端正文支持才建立关系'], evidence_requirements: ['核对卡片正文与来源'], stop_conditions: ['证据不足即延期'] },
  selection: { selected: selected.map(id => ({ id, role: id === 'fiscal' ? 'anchor' : 'counterexample', reason: '用于比较成立条件', required_evidence: ['正文条件'] })),
    excluded: [], packages: selected.length ? [{ card_ids: selected, purpose: '比较条件与反例', reason: '共同问题下的对照' }] : [] }
});

test('first strategy request keeps explicit cards as mandatory anchors and has no tools or history', t => {
  const controls=defaultConstructionControls('connections'),{ root } = fixture(t), pool = constructionCandidatePool(root, { notes: '比较财政扩张和通胀反例', card_ids: ['fiscal'],requirements:{construction_controls:controls} });
  assert.equal(pool.candidates.find(row => row.id === 'fiscal').required, true);
  assert.throws(() => validateConstructionStrategy(response(['inflation']), pool), /不能丢弃用户明确选择/);
  const plan = validateConstructionStrategy(response(['fiscal', 'inflation']), pool);
  assert.deepEqual(plan.selection.anchors, ['fiscal']);
  assert.deepEqual(plan.packages[0].card_ids, ['fiscal', 'inflation']);
  const job = { model_selection: { provider: 'test', model: 'test' }, construction_query: '比较财政扩张和通胀反例',
    construction_controls: controls, requirements: { long_term: '' } };
  const request = buildConstructionStrategyRequest(job, pool, []);
  assert.deepEqual(request.tools, []); assert.equal(request.messages.length, 1);
  assert.equal(request.nexoPrompt.phase, 'construction-strategy');
  assert.ok(request.construction_context.other_chars <= CONSTRUCTION_STRATEGY_CONTEXT_LIMIT);
  assert.equal(request.maxTokens, 16384);
  assert.match(request.messages[0].content[0].text, /比较财政扩张和通胀反例/);
  assert.ok(request.delivered_pool.candidates.length <= 32);
});

test('strategy request stays compact and uses the generated focus when direct notes are empty', t => {
  const { root } = fixture(t), controls = defaultConstructionControls('connections');
  for (let index = 0; index < 70; index++) {
    writeFileSync(join(root, '01-Cards', `extra-${index}.md`), unoMarkdown({ schema: 'uno-card-v4', id: `extra-${index}`,
      title: `财政扩张比较候选 ${index}`, summary: '候选摘要'.repeat(160), type: 'claim', domains: [], boundary: '仅限测试',
      sources: ['03-Archive/source.md'], relations: [], lifecycle: 'active' }, '财政扩张条件与通胀反例。'));
  }
  invalidateKnowledgeSnapshot(root);
  const pool = constructionCandidatePool(root, { notes: '发现已有知识之间有依据的联系', card_ids: ['fiscal'],
    requirements: { construction_controls: controls } });
  const request = buildConstructionStrategyRequest({ model_selection: { provider: 'test', model: 'test' }, construction_query: '',
    notes: '发现已有知识之间有依据的联系', construction_controls: controls, requirements: { long_term: '' } }, pool, []);
  const content = request.messages[0].content[0].text;
  assert.ok(request.construction_context.other_chars <= CONSTRUCTION_STRATEGY_CONTEXT_LIMIT);
  assert.ok(request.delivered_pool.candidates.length <= 32);
  assert.equal(request.delivered_pool.candidates[0].id, 'fiscal');
  assert.match(content, /"user_request":"发现已有知识之间有依据的联系"/);
});

test('construction response deterministically closes trailing containers and resumes without another strategy request', () => {
  const expected = response(['fiscal', 'inflation']), raw = JSON.stringify(expected).slice(0, -1);
  const parsed = parseConstructionJSON(raw);
  assert.deepEqual(parsed, expected);
  assert.deepEqual(constructionJSONRecovery(parsed), { contract: 'construction-json-tail-close-v1', appended: '}' });
  assert.throws(() => parseConstructionJSON('{"strategy":{} "selection":{}}'), /不符合 JSON 对象格式/);
  assert.throws(() => parseConstructionJSON('{"strategy":{"goal":"截断'), /不符合 JSON 对象格式/);
  const job = { mode: 'construct', workflow: STRATEGY_CONSTRUCTION_WORKFLOW, status: 'failed', phase: 'strategy_pending',
    role: 'select', batch_index: 0, calls: [{ phase: 'construction-strategy', status: 'completed', response: raw }],
    last_error: { code: 'INVALID_GENERATION_RESPONSE', message: '原响应已保留。' }, failures: [], completed_batches: [],
    reviewed: {}, scope_conflicts: [] };
  const plan = computeResumePlan('', job);
  assert.equal(plan.kind, 'resume'); assert.match(plan.reason, /复用原响应继续/);
});

test('a first-step strategy truncation can be explicitly retried before any knowledge write', () => {
  const job = { mode: 'construct', workflow: STRATEGY_CONSTRUCTION_WORKFLOW, status: 'failed', phase: 'strategy_pending',
    role: 'select', batch_index: 0, calls: [{ phase: 'construction-strategy', status: 'failed', response: '' }],
    last_error: { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型响应未完整结束：max-tokens。' }, failures: [],
    completed_batches: [], reviewed: {}, scope_conflicts: [] };
  const plan = computeResumePlan('', job);
  assert.equal(plan.kind, 'resume'); assert.match(plan.primary.label, /重新请求策略/);
});

test('author and reviewer responses must settle every selected card exactly once', () => {
  const ids = ['fiscal', 'inflation'];
  assert.throws(() => validateConstructionAuthorResponse({ decisions: [{ id: 'fiscal', status: 'unchanged', note: '保留', changes: {} }], note: 'x' }, ids), /全部卡片/);
  const author = validateConstructionAuthorResponse({ decisions: ids.map(id => ({ id, status: 'unchanged', note: '没有有据修改', changes: {}, evidence: [] })), note: '均保留' }, ids);
  assert.equal(author.decisions.length, 2);
  assert.throws(() => validateConstructionReviewResponse({ reviews: ids.map(id => ({ id, decision: 'reject', note: '有问题', issues: [] })), note: 'x' }, ids), /必须给出具体问题/);
  const normalized=normalizeConstructionReviewResponse({reviews:ids.map(id=>({id,decision:'approve',note:'通过'})),note:'通过'});
  assert.deepEqual(normalized.changes,['fiscal:issues=[]','inflation:issues=[]']);
  assert.equal(validateConstructionReviewResponse(normalized.value,ids).reviews.length,2);
});

test('author and reviewer requests define relation direction before a model spends a repair call', () => {
  const job={model_selection:{provider:'test',model:'test'},construction_controls:defaultConstructionControls('connections')};
  const pack={card_ids:['fiscal','inflation'],strategy:response(['fiscal','inflation']).strategy};
  const evidence={cards:[],sources:[],domains:[],source_chars:0};
  const author=buildConstructionAuthorRequest(job,pack,evidence);
  const review=buildConstructionReviewRequest(job,pack,{author_decisions:[],cards:[],sources:[],domains:[]});
  for(const request of [author,review]){
    assert.match(request.system,/supplement=当前卡补充目标卡/);
    assert.match(request.system,/example=当前卡是目标卡的实例/);
  }
});

test('independent construction review leaves output room for high-effort reasoning without adding a request', () => {
  const job = { model_selection: { provider: 'test', model: 'test', reasoningEffort: 'high' }, construction_controls: defaultConstructionControls('connections') };
  const pack = { id: 'group-1', card_ids: ['fiscal'], strategy: response(['fiscal']).strategy };
  const request = buildConstructionReviewRequest(job, pack, { before: [], after: [], author: { decisions: [] } });
  assert.equal(request.nexoPrompt.phase, 'construction-review');
  assert.equal(request.reasoningEffort, 'high');
  assert.equal(request.maxTokens, 16384);
  assert.equal(request.messages.length, 1);
  assert.match(request.system, /每张 note 用一到两句直接结论/);
});

test('relation-only direct patch is not rejected by unrelated legacy summary and boundary gaps', t => {
  const { root } = fixture(t), path = join(root, '01-Cards', 'fiscal.md');
  const old = loadCards(root, { includeInactive: true }).get('fiscal');
  writeFileSync(path, unoMarkdown({ ...old.meta, summary: undefined, boundary: undefined }, old.body));
  invalidateKnowledgeSnapshot(root);
  const job = { id: 'direct', mode: 'construct', workflow: STRATEGY_CONSTRUCTION_WORKFLOW,
    construction_profile: STRATEGY_CONSTRUCTION_PROFILE, construction_controls: defaultConstructionControls('connections'),
    construct_contract: 'scoped-review-v1', status: 'running', role: 'author', phase: 'authoring', session_id: 'owner',
    scope: ['fiscal', 'inflation'], batches: [['fiscal', 'inflation']], batch_index: 0, calls: [], receipts: [], issues: [], reviewed: {} };
  saveCompileJob(root, job);
  const gateway = new HarnessGateway(root), before = readFileSync(path, 'utf8'), beforeBody = loadCards(root).get('fiscal').body;
  const staged = gateway.stageUnoKnowledge({ task: 'direct-b0', key: 'direct-b0:relation', operation_id: 'relation', action: 'patch',
    id: 'fiscal', revision: unoRevision(root, '01-Cards/fiscal.md'), relations: [{ target: 'inflation', type: 'contrast',
      note: '通胀反例限定财政扩张主张的适用范围。', basis: 'navigation', origin: 'navigation' }] });
  assert.equal(staged.staged, true);
  const draft = readDraft(root, 'direct-b0', 'fiscal');
  assert.equal(draft.validation_scope, 'relations'); assert.deepEqual(draft.errors, []);
  const receipt = gateway.publishUnoKnowledge({ task: 'direct-b0', key: 'direct-b0:publish', ids: ['fiscal'],
    reviews: { fiscal: { revision: draft.revision, issues: [], note: '两端正文支持导航对照。' } } });
  assert.deepEqual(receipt.card_ids, ['fiscal']);
  const after = loadCards(root).get('fiscal');
  assert.equal(after.body, beforeBody); assert.equal(after.meta.boundary, undefined); assert.equal(after.meta.summary, undefined);
  assert.equal(after.meta.relations[0].basis, 'navigation'); assert.notEqual(readFileSync(path, 'utf8'), before);
});
