import {projectUnoMessages,assertUnoRequestBudget} from '../packages/nexogenesis-tools/lib/uno/request-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Context } from '../packages/nexogenesis-web-host/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm';
import { NexoModelAdapter } from '../packages/nexogenesis-web-host/lib/model-adapter.js';
import { initializeProviderBudget, raiseProviderBudget, replenishProviderBudget, getProviderBudget, bindProviderBudgetSession, reserveProviderRequest,
  settleProviderRequest, captureProviderRequestContext } from '../packages/nexogenesis-tools/lib/uno/request-budget.js';

const moduleUrl = new URL('../packages/nexogenesis-tools/lib/uno/request-budget.js', import.meta.url).href;
const options = (sessionId = 'author', extra = {}) => ({ sessionId, provider: 'nexo-deepseek', model: 'deepseek-v4-flash',
  reasoningEffort: 'off', messages: [{ role: 'user', content: [{ type: 'text', text: 'private-test-input' }] }], ...extra });
const collect = async iterator => { const chunks = []; for await (const item of iterator) chunks.push(item); return chunks; };
const answer = (usage = null) => new Response([
  { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, ...(usage ? [{ choices: [], usage }] : []), '[DONE]',
].map(v => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`).join(''));

function fixture(t, { limit = 20, imported = 0, role = 'author', stageLimit = 6, reserve = 3 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uno-provider-budget-')), jobId = 'job-a';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { get: name => name === 'sessions' ? { get: () => ({ header: { cwd: root } }) } : undefined,
    settings: { get: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash' }) },
    credentials: { resolve: async () => ({ value: 'synthetic-key-never-networked' }) } };
  initializeProviderBudget(root, jobId, { limit, alreadyUsed: imported, provenance: imported ? 'synthetic imported attempts' : null });
  const bind = (sessionId = role, nextRole = role, extra = {}) => bindProviderBudgetSession(root, {
    jobId, sessionId, packageId: 'batch-0', role: nextRole, stageId: `batch:0:role:${nextRole}:repair:0`, stageLimit,
    reviewReserve: reserve, ...extra,
  });
  bind();
  const file = join(root, '.nexogenesis/provider-request-budgets', jobId + '.json');
  return { root, jobId, ctx, bind, file, status: () => getProviderBudget(root, jobId), ledger: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('reservation is durable before fetch; reported usage and completed response retained without secrets', async t => {
  const f = fixture(t); let called = 0;
  const adapter = new NexoModelAdapter(f.ctx, async () => {
    called++; assert.equal(f.status().used, 1); assert.equal(f.ledger().requests[0].state, 'reserved');
    return answer({ prompt_tokens: 10, completion_tokens: 3, prompt_cache_hit_tokens: 4 });
  });
  const chunks = await collect(adapter.stream(options()));
  assert.equal(called, 1); assert.equal(chunks.at(-1).type, 'finish');
  assert.deepEqual(f.ledger().requests[0].usage, { status: 'reported', inputTokens: 6, outputTokens: 3, cacheReadTokens: 4 });
  assert.equal(f.ledger().requests[0].state, 'completed');
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /synthetic-key|private-test-input|authorization/);
});

test('global imported 14 of 20 cannot reset, repeat initialization preserves later attempts, raise only increases', t => {
  const f = fixture(t, { imported: 14 });
  const r = reserveProviderRequest(f.ctx, options()); settleProviderRequest(r, { state: 'failed' });
  assert.equal(f.status().used, 15);
  assert.equal(initializeProviderBudget(f.root, f.jobId, { limit: 20, alreadyUsed: 14, provenance: 'synthetic imported attempts' }).used, 15);
  assert.throws(() => initializeProviderBudget(f.root, f.jobId, { limit: 20 }), /重新初始化/);
  assert.throws(() => raiseProviderBudget(f.root, f.jobId, 19), /只能增加/);
  assert.equal(raiseProviderBudget(f.root, f.jobId, 21).remaining, 6);
  assert.equal(f.status().used, 15);
});

test('explicit resume restores one allowance without erasing usage or stacking repeated clicks', t => {
  const f=fixture(t,{limit:6,reserve:0,stageLimit:20});
  for(let n=0;n<6;n++){const request=reserveProviderRequest(f.ctx,options());settleProviderRequest(request,{state:'failed'});}
  assert.deepEqual({used:f.status().used,remaining:f.status().remaining},{used:6,remaining:0});
  assert.deepEqual({used:replenishProviderBudget(f.root,f.jobId,4).used,remaining:f.status().remaining},{used:6,remaining:4});
  assert.equal(replenishProviderBudget(f.root,f.jobId,4).limit,10);
  const next=reserveProviderRequest(f.ctx,options());settleProviderRequest(next,{state:'completed'});
  assert.equal(replenishProviderBudget(f.root,f.jobId,4).remaining,4);
  assert.equal(f.ledger().limit_changes.filter(row=>row.kind==='resume-allowance').length,2);
});

test('author stops before review reserve; reviewer can spend the last response and host can settle it', async t => {
  const f = fixture(t, { imported: 14 }); let sent = 0;
  const adapter = new NexoModelAdapter(f.ctx, async () => { sent++; return answer(); });
  for (let n = 0; n < 3; n++) await collect(adapter.stream(options()));
  await assert.rejects(collect(adapter.stream(options())), { code: 'UNO_REVIEW_RESERVE' });
  assert.equal(f.status().used, 17);
  f.bind('reviewer', 'reviewer', { stageLimit: 3 });
  for (let n = 0; n < 3; n++) await collect(adapter.stream(options('reviewer')));
  assert.equal(sent, 6); assert.equal(f.status().used, 20); assert.equal(f.status().remaining, 0);
  assert.equal(f.ledger().requests.at(-1).state, 'completed'); // Final response survives exhausted budget.
  await assert.rejects(collect(adapter.stream(options('reviewer'))), { code: 'UNO_PROVIDER_BUDGET' });
  assert.equal(sent, 6);
});

test('failure, retry, unknown usage and cancelled network attempts each consume one', async t => {
  const f = fixture(t, { reserve: 0 });
  const failure = new NexoModelAdapter(f.ctx, async () => new Response('', { status: 503 }));
  await assert.rejects(collect(failure.stream(options()))); await assert.rejects(collect(failure.stream(options())));
  const lost = new NexoModelAdapter(f.ctx, async () => { throw new TypeError('synthetic transport disconnect'); });
  await assert.rejects(collect(lost.stream(options())));
  const controller = new AbortController();
  const cancelled = new NexoModelAdapter(f.ctx, async () => { controller.abort(); throw controller.signal.reason; });
  await assert.rejects(collect(cancelled.stream(options('author', { signal: controller.signal }))));
  assert.equal(f.status().used, 4); assert.equal(f.status().unknownUsage, 4);
  assert.deepEqual(f.ledger().requests.map(r => r.state), ['failed', 'failed', 'failed', 'cancelled']);
});

test('already cancelled or invalid requests do not fetch or consume', async t => {
  const f = fixture(t); let sent = 0;
  const adapter = new NexoModelAdapter(f.ctx, async () => { sent++; return answer(); });
  await assert.rejects(collect(adapter.stream(options('author', { signal: AbortSignal.abort() }))));
  await assert.rejects(collect(adapter.stream(options('author', { reasoningEffort: 'unsupported' }))));
  assert.equal(sent, 0); assert.equal(f.status().used, 0);
});

test('actual native LlmRuntime preserves terminal budget code and excludes it from normal retries', async t => {
  const f = fixture(t, { stageLimit: 1, reserve: 0 }); let sent = 0;
  reserveProviderRequest(f.ctx, options());
  const runtime = new LlmRuntime(new Context());
  const dispose = runtime.registerAdapter(['nexo-deepseek'], new NexoModelAdapter(f.ctx, async () => { sent++; return answer(); }));
  t.after(dispose);
  const input = options('author', { messages: [createUserMessage({ content: [{ type: 'text', text: 'synthetic' }] })] });
  const chunks = await collect(runtime.stream(input));
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'UNO_STAGE_BUDGET');
  assert.match(chunks.at(-1).reason.failure.message, /^\[UNO_STAGE_BUDGET\]/);
  const policy = runtime.providerRetryPolicy('nexo-deepseek');
  assert.equal(policy.mode, 'normal'); assert.equal(policy.maxRetries, 2);
  assert.ok(!policy.retryableCodes.includes('UNO_STAGE_BUDGET'));
  assert.ok(!policy.retryableCodes.includes('UNO_PROVIDER_BUDGET'));
  assert.ok(!policy.retryableCodes.includes('UNO_REVIEW_RESERVE'));
  assert.equal(sent, 0); assert.equal(f.status().used, 1);
});

test('truncated network stream and consumer abandonment remain consumed without invented usage', async t => {
  const f = fixture(t);
  const partial = new NexoModelAdapter(f.ctx, async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  await assert.rejects(collect(partial.stream(options())), { code: 'TRANSPORT' });
  const abandoned = partial.stream(options()); await abandoned.next(); await abandoned.return();
  assert.equal(f.status().used, 2);
  assert.deepEqual(f.ledger().requests.map(r => r.state), ['failed', 'incomplete']);
  assert.equal(f.status().unknownUsage, 2);
});

test('session title and compaction count toward the same stage and cannot use protected reviewer calls', t => {
  const f = fixture(t, { imported: 14 });
  reserveProviderRequest(f.ctx, options('author', { purpose: 'session-title' }));
  reserveProviderRequest(f.ctx, options('author', { purpose: 'compaction' }));
  reserveProviderRequest(f.ctx, options());
  assert.throws(() => reserveProviderRequest(f.ctx, options('author', { purpose: 'compaction' })), { code: 'UNO_REVIEW_RESERVE' });
  assert.equal(f.status().current.stageUsed, 3);
  f.bind('reviewer', 'reviewer', { stageLimit: 4 });
  assert.throws(() => reserveProviderRequest(f.ctx, options('reviewer', { purpose: 'session-title' })), { code: 'UNO_REVIEW_RESERVE' });
  reserveProviderRequest(f.ctx, options('reviewer'));
  assert.equal(f.status().current.reviewReserve, 2);
});

test('reviewer auxiliary traffic also preserves review room inside the stage limit', t => {
  const f = fixture(t); f.bind('reviewer', 'reviewer', { stageLimit: 4 });
  reserveProviderRequest(f.ctx, options('reviewer', { purpose: 'session-title' }));
  assert.throws(() => reserveProviderRequest(f.ctx, options('reviewer', { purpose: 'compaction' })), { code: 'UNO_REVIEW_RESERVE' });
  for (let n = 0; n < 3; n++) reserveProviderRequest(f.ctx, options('reviewer'));
  assert.equal(f.status().current.stageUsed, 4);
});

test('same stage rebind and new session never reset stage attempts; global exhaustion wins', t => {
  const f = fixture(t, { limit: 5, stageLimit: 2, reserve: 0 });
  reserveProviderRequest(f.ctx, options()); reserveProviderRequest(f.ctx, options());
  f.bind('author-new');
  assert.throws(() => reserveProviderRequest(f.ctx, options('author-new')), { code: 'UNO_STAGE_BUDGET' });
  assert.throws(() => f.bind('author-new', 'author', { stageLimit: 3 }), /不能被重绑/);
  f.bind('reviewer', 'reviewer', { stageLimit: 3 });
  for (let n = 0; n < 3; n++) reserveProviderRequest(f.ctx, options('reviewer'));
  assert.throws(() => reserveProviderRequest(f.ctx, options('reviewer')), { code: 'UNO_PROVIDER_BUDGET' });
  assert.throws(() => reserveProviderRequest(f.ctx, options('author')), { code: 'UNO_PROVIDER_BUDGET' });
});

test('late old session/stage cannot dispatch; an already dispatched attempt settles against its original stage', t => {
  const f = fixture(t); const reservation = reserveProviderRequest(f.ctx, options());
  const captured = captureProviderRequestContext(f.ctx, options());
  f.bind('reviewer', 'reviewer', { stageLimit: 4 });
  assert.throws(() => reserveProviderRequest(f.ctx, options()), { code: 'UNO_BUDGET_STALE_STAGE' });
  assert.throws(() => reserveProviderRequest(f.ctx, options(), captured), { code: 'UNO_BUDGET_STALE_STAGE' });
  settleProviderRequest(reservation, { state: 'completed' });
  assert.equal(f.ledger().requests[0].role, 'author'); assert.equal(f.status().current.stageUsed, 0);
});

test('same-session stage change during credential await cannot silently charge the new role', async t => {
  const f = fixture(t); let resolveCredential, sent = 0;
  f.ctx.credentials.resolve = () => new Promise(resolve => { resolveCredential = resolve; });
	const adapter = new NexoModelAdapter(f.ctx, async () => { sent++; return answer(); });
	const pending = collect(adapter.stream(options()));
	f.bind('author', 'reviewer', { stageLimit: 4 });
	while(!resolveCredential)await new Promise(resolve=>setImmediate(resolve));
	resolveCredential({ value: 'synthetic-key-never-networked' });
  await assert.rejects(pending, { code: 'UNO_BUDGET_STALE_STAGE' });
  assert.equal(sent, 0); assert.equal(f.status().used, 0);
});

test('missing index for bounded job fails closed while a legacy task stays unchanged', async t => {
  const f = fixture(t), jobDir = join(f.root, '.nexogenesis/uno-jobs'); mkdirSync(jobDir, { recursive: true });
  const job = { id: 'unbound', mode: 'construct', workflow: 'uno-compile-v3', orchestration_profile: 'bounded-workflow-v1', session_id: 'unbound', sessions: ['unbound'] };
  writeFileSync(join(jobDir, 'unbound.json'), JSON.stringify(job));
  let sent = 0; const adapter = new NexoModelAdapter(f.ctx, async () => { sent++; return answer(); });
  await assert.rejects(collect(adapter.stream(options('unbound'))), { code: 'UNO_BUDGET_UNBOUND' });
  delete job.orchestration_profile; writeFileSync(join(jobDir, 'unbound.json'), JSON.stringify(job));
  await collect(adapter.stream(options('unbound')));
  assert.equal(sent, 1); assert.equal(f.status().used, 0);
});

test('lock contention, damaged ledger and loss of ledger never fall back to sending', t => {
  const f = fixture(t); writeFileSync(f.file + '.lock', 'synthetic stale lock');
  assert.throws(() => reserveProviderRequest(f.ctx, options()), { code: 'UNO_BUDGET_LOCKED' });
  unlinkSync(f.file + '.lock'); writeFileSync(f.file, '{broken');
  assert.throws(() => reserveProviderRequest(f.ctx, options()), { code: 'UNO_BUDGET_STATE' });
  unlinkSync(f.file);
  assert.throws(() => reserveProviderRequest(f.ctx, options()), { code: 'UNO_BUDGET_STATE' });
});

test('unknown reservation is consumed after reload and replayed completion cannot change it', t => {
  const f = fixture(t); const reservation = reserveProviderRequest(f.ctx, options());
  assert.equal(getProviderBudget(f.root, f.jobId).used, 1);
  settleProviderRequest(reservation, { state: 'failed' });
  settleProviderRequest(reservation, { state: 'completed', usage: { inputTokens: 10 } });
  assert.equal(f.ledger().requests[0].state, 'failed'); assert.equal(f.status().used, 1);
});

test('not enough global remainder refuses a new package instead of starting unfundable author work', t => {
  const f = fixture(t, { limit: 6, reserve: 0 });
  for (let n = 0; n < 3; n++) reserveProviderRequest(f.ctx, options());
  assert.throws(() => f.bind('next-author', 'author', { packageId: 'batch-1', stageId: 'batch:1:role:author:repair:0', reviewReserve: 3 }), { code: 'UNO_REVIEW_RESERVE' });
  assert.equal(f.status().current.packageId, 'batch-0');
});

test('multiple processes share the same final request slots atomically', async t => {
  const f = fixture(t, { limit: 20, imported: 14, role: 'select', reserve: 0, stageLimit: 6 });
  const childSource = `import {reserveProviderRequest} from ${JSON.stringify(moduleUrl)};
    const ctx={get:()=>({get:()=>({header:{cwd:process.argv[1]}})})};
    try{reserveProviderRequest(ctx,{sessionId:'select',provider:'test',model:'test'});process.stdout.write('reserved');}
    catch(error){if(!['UNO_PROVIDER_BUDGET','UNO_STAGE_BUDGET','UNO_BUDGET_LOCKED'].includes(error.code))throw error;process.stdout.write(error.code);}`;
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, f.root], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return stdout;
  }));
  assert.ok(results.filter(x => x === 'reserved').length <= 6);
  while (f.status().remaining > 0) reserveProviderRequest(f.ctx, options('select'));
  assert.equal(f.status().used, 20); assert.equal(f.ledger().requests.length, 6);
  assert.deepEqual(f.ledger().requests.map(r => r.number), [15,16,17,18,19,20]);
});

test('OpenAI-compatible final wire budget blocks before transport and reservation',async t=>{
 const f=fixture(t);let sent=0;const adapter=new NexoModelAdapter(f.ctx,async()=>{sent++;return answer();});
 const req=options('author',{messages:projectUnoMessages([{role:'user',content:[{type:'text',text:'small'}]}]).messages});
 const measured=assertUnoRequestBudget(req);assertUnoRequestBudget(req,{limitBytes:measured.after_bytes});
 await assert.rejects(collect(adapter.stream(req)),{code:'UNO_CONTEXT_BUDGET'});
 assert.equal(sent,0);assert.equal(f.status().used,0);
});
