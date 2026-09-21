import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rpcCall, RpcCallError } from '../packages/nexogenesis-web-host/lib/rpc.js';

const ok = value => Response.json({ type: 'server-response', result: { ok: true, value } });
function local(api, native, imported = () => {}) {
  api.sessions ??= {};
  api.sessions.list ??= async () => { throw new Error('unexpected mock list'); };
  return { get(name) {
    if (name === 'apiProxy') return api;
    if (name === 'loader') return { *entries() { yield {
      options: { name: '@deepseek-ai/dsh-host-apiproxy' },
      parent: { tree: { async import(name) { assert.equal(name, '@deepseek-ai/dsh-host-apiproxy'); imported(); return native; } } },
    }; } };
  } };
}

test('legacy embedded host retains one HTTP request and native envelope', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:32123/api/session.list');
    const body = JSON.parse(init.body);
    assert.equal(init.method, 'POST'); assert.equal(body.type, 'client-request');
    assert.equal(body.method, 'session.list'); assert.deepEqual(body.payload, {});
    assert.match(body.rpcId, /^[0-9a-f-]{36}$/);
    return ok({ items: [] });
  });
  assert.deepEqual(await rpcCall({ webServer: { port: 32123 } }, 'session.list'), { items: [] });
  assert.equal(calls, 1);
});

test('available apiProxy uses native carrier without sockets and caches by service identity', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('loopback network must not be used'));
  let imports = 0, dispatch = 0;
  const api = {}, ctx = local(api, { toFetchHandler(received) {
    assert.equal(received, api);
    return { async fetch(url, init) {
      dispatch++;
      assert.equal(new URL(url).pathname, '/api/session.create');
      assert.equal(JSON.parse(init.body).payload.cwd, '/sample');
      return ok({ sessionId: 'sample' });
    } };
  } }, () => imports++);
  await rpcCall(ctx, 'session.create', { cwd: '/sample' });
  await rpcCall(ctx, 'session.create', { cwd: '/sample' });
  assert.equal(imports, 1); assert.equal(dispatch, 2);
});

test('events-only apiProxy keeps legacy HTTP session RPC without importing a native carrier', async t => {
  let calls = 0;
  const partial = { events: { mux() {} }, respond() {} };
  const ctx = { webServer: { port: 32123 }, get(name) {
    if (name === 'apiProxy') return partial;
    if (name === 'loader') assert.fail('partial service must not resolve the native carrier');
  } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:32123/api/session.list');
    assert.equal(JSON.parse(init.body).method, 'session.list');
    return ok({ items: [] });
  });
  assert.deepEqual(await rpcCall(ctx, 'session.list', {}), { items: [] });
  assert.equal(calls, 1);
});

test('HTTP failures retain safe cause code and never retry create or prompt', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('secret token sk-private at https://credentials.invalid', {
      cause: Object.assign(new Error('another credential'), { code: 'UND_ERR_SOCKET' }),
    });
  });
  for (const method of ['session.create', 'session.prompt']) {
    await assert.rejects(rpcCall({ webServer: { port: 32123 } }, method, { content: 'private prompt' }), error => {
      assert.ok(error instanceof RpcCallError); assert.equal(error.method, method); assert.equal(error.code, 'transport');
      assert.equal(error.details.transport_code, 'UND_ERR_SOCKET');
      assert.match(error.message, new RegExp(method));
      assert.doesNotMatch(String(error) + JSON.stringify(error), /sk-private|credentials|private prompt|another credential/);
      return true;
    });
  }
  assert.equal(calls, 2);
});

test('in-process failure is not retried or replayed over HTTP', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('never fall back after local dispatch'));
  const ctx = local({}, { toFetchHandler() { return { async fetch() { calls++; throw Object.assign(new Error('sensitive'), { code: 'ERR_INVALID_STATE' }); } }; } });
  await assert.rejects(rpcCall(ctx, 'session.prompt', {}), error => error.details.transport === 'in-process' && error.details.transport_code === 'ERR_INVALID_STATE');
  assert.equal(calls, 1);
});

test('native module mismatch fails before dispatch without silent network fallback', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no HTTP fallback'));
  const ctx = local({}, {});
  await assert.rejects(rpcCall(ctx, 'session.create', {}), error => error.details.transport_code === 'UNO_RPC_CARRIER_UNAVAILABLE');
});

test('response body transport failure keeps method and cause code without retry', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { async json() { throw new TypeError('terminated', { cause: Object.assign(new Error('private endpoint'), { code: 'UND_ERR_SOCKET' }) }); } };
  });
  await assert.rejects(rpcCall({ webServer: { port: 32123 } }, 'session.prompt', {}), error =>
    error.method === 'session.prompt' && error.details.transport_code === 'UND_ERR_SOCKET' && !error.message.includes('private endpoint'));
  assert.equal(calls, 1);
});

test('native business error code and details remain intact', async () => {
  const business = { code: 'session-busy', message: 'session is busy', details: { sessionId: 's1' } };
  const ctx = local({}, { toFetchHandler() { return { async fetch() { return Response.json({ type: 'server-response', result: { ok: false, error: business } }); } }; } });
  await assert.rejects(rpcCall(ctx, 'session.rename', { sessionId: 's1', title: 'name' }), error => {
    assert.equal(error.code, business.code); assert.deepEqual(error.details, business.details); assert.equal(error.method, 'session.rename'); return true;
  });
});

test('non-JSON native handler response reports status without leaking its body', async () => {
  const ctx = local({}, { toFetchHandler() { return { async fetch() { return new Response('handler failure: secret', { status: 500 }); } }; } });
  await assert.rejects(rpcCall(ctx, 'session.create', {}), error => error.message.includes('in-process gateway replied 500') && !error.message.includes('secret'));
});

const nativeEntry = process.env.UNO_DSH_ENTRY;
const nativeTest = { skip: nativeEntry ? false : 'Set UNO_DSH_ENTRY to validate the installed native fetch carrier without model calls' };
async function installed() {
  const host = createRequire(resolve(nativeEntry));
  return import(pathToFileURL(host.resolve('@deepseek-ai/dsh-host-apiproxy')).href);
}

test('installed native carrier enforces schemas before business methods and strips unknown payload fields', nativeTest, async t => {
  const native = await installed();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('native carrier uses no external network'));
  const calls = [];
  const api = { sessions: { async create(request) {
    calls.push(request);
    return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: 'native-sample' } } };
  } } };
  const ctx = local(api, native);
  await assert.rejects(rpcCall(ctx, 'session.create', { cwd: '/sample', workspaceId: 'w1' }), error => error.code === 'bad-request');
  assert.equal(calls.length, 0);
  assert.deepEqual(await rpcCall(ctx, 'session.create', { cwd: '/sample', agentPreset: 'uno-compile', extra: 'ignored' }), { sessionId: 'native-sample' });
  assert.deepEqual(calls[0].payload, { cwd: '/sample', agentPreset: 'uno-compile' });
  assert.equal(calls.length, 1);
});

test('installed native carrier preserves structured business refusal and does not retry uncertain handler effects', nativeTest, async t => {
  const native = await installed(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no network'));
  const api = { sessions: {
    async rename(request) { return { rpcId: request.rpcId, result: { ok: false, error: { code: 'session-title-invalid', message: 'title invalid', details: { reason: 'empty' } } } }; },
    async create() { calls++; throw new Error('error after simulated side effect; credential omitted'); },
  } };
  const ctx = local(api, native);
  await assert.rejects(rpcCall(ctx, 'session.rename', { sessionId: 's1', title: '' }), error => error.code === 'session-title-invalid' && error.details.reason === 'empty');
  await assert.rejects(rpcCall(ctx, 'session.create', {}), error => error.details.status === 500 && !error.message.includes('credential'));
  assert.equal(calls, 1);
});

test('native fallback resolves from actual host entrypoint when no loader is mounted', nativeTest, async t => {
  const original = process.argv[1];
  process.argv[1] = nativeEntry;
  t.after(() => { process.argv[1] = original; });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no loopback socket'));
  const ctx = { apiProxy: { sessions: { async list(request) { return { rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }; } } } };
  assert.deepEqual(await rpcCall(ctx, 'session.list', {}), { items: [] });
});
