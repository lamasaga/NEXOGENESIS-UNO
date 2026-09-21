/** Meter the native Kimi Code transport without replacing its adapter or credentials.
 * DSH rc.6 does not expose a per-fetch hook. Its pi-ai Anthropic client obtains
 * global fetch when constructed. AsyncLocalStorage scopes this compatibility
 * bridge to one budget-bound native call; all other fetches pass through.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { getUnoRequestGovernance, assertUnoWireBudget } from '../../nexogenesis-tools/lib/uno/request-context.js';
import { captureWireInput } from './prompt-inspector.js';
import { ProviderBudgetError, captureProviderRequestContext, reserveProviderRequest, settleProviderRequest } from '../../nexogenesis-tools/lib/uno/request-budget.js';

const calls = new AsyncLocalStorage();
const transports = new WeakMap();
const registrations = new WeakMap();
export const NATIVE_KIMI_ROUTE = 'kimi-coding';
const failure = (message, code = 'UNO_BUDGET_TRANSPORT') => new LlmError(message.startsWith(`[${code}]`) ? message : `[${code}] ${message}`, code);
const budgetError = error => error instanceof ProviderBudgetError || String(error?.code ?? '').startsWith('UNO_CONTEXT_') ? failure(error.message, error.code) : error;
const outcome = reason => ({ stop:'completed', 'tool-calls':'completed', 'max-tokens':'truncated', error:'failed', aborted:'cancelled' })[reason] ?? 'incomplete';

function finishAttempt(entry, state, usage) {
  if (!entry || entry.finished) return;
  settleProviderRequest(entry.reservation, { state, usage });
  entry.finished = true;
}
function acquireTransport(target) {
  let transport = transports.get(target);
  if (transport) {
    if (target.fetch !== transport.fetch) throw failure('Kimi Code 请求计数入口已被替换，未启用有界任务。');
    transport.owners++;
    return transport;
  }
  if (typeof target.fetch !== 'function') throw failure('运行环境没有可计数的 Kimi Code 网络入口。');
  transport = { target, previous:target.fetch, owners:1, activeCalls:0 };
  transport.fetch = async function(input, init) {
    const call = calls.getStore();
    if (!call || call.transport !== transport) return transport.previous.call(this, input, init);
    let entry;
    try {
      if (call.fatal) throw call.fatal;
      if (!call.owner.active || call.closed) throw failure('Kimi Code 调用已结束，未发送迟到请求。', 'UNO_BUDGET_STALE_STAGE');
      call.options.signal?.throwIfAborted();
      const inheritedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      inheritedSignal?.throwIfAborted();
      call.controller.signal.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      // The subscription endpoint and native Anthropic wire format are retained.
      // Unexpected dispatches in a bound call are refused, never silently free.
      if (url.origin !== 'https://api.kimi.com' || url.pathname !== '/coding/v1/messages'
          || url.username || url.password || method !== 'POST') {
        throw failure('有界 Kimi Code 调用使用了未验证的网络端点，未发送请求。');
      }
      const signals = [inheritedSignal, call.options.signal, call.controller.signal].filter(Boolean);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      if (call.governed) {
        const body = typeof init?.body === 'string' ? init.body
          : init?.body === undefined && input instanceof Request ? await input.clone().text() : undefined;
        // Reading a Request body can await. Recheck owner/cancellation before
        // reserving or dispatching after an unload, pause or concurrent failure.
        if (call.fatal) throw call.fatal;
        if (!call.owner.active || call.closed) throw failure('Kimi Code 调用已结束，未发送迟到请求。', 'UNO_BUDGET_STALE_STAGE');
        signal.throwIfAborted();
        assertUnoWireBudget(call.options, body);
        // Diagnostic capture receives only the API body, never auth headers.
        try { captureWireInput(JSON.parse(body)); } catch {}
      }
      const reservation = reserveProviderRequest(call.ctx, call.options, call.binding);
      entry = { reservation, signal, finished:false };
      call.attempts.push(entry);
      // No await between reservation and dispatch: disk failure stops the request.
      const response = await transport.previous.call(this, input, { ...init, signal, redirect:'error' });
      if (!response.ok) finishAttempt(entry, 'failed');
      return response;
    } catch (error) {
      if (error instanceof ProviderBudgetError || /^UNO_(?:BUDGET|CONTEXT)/.test(String(error?.code ?? ''))) call.fatal = budgetError(error);
      finishAttempt(entry, entry?.signal.aborted || call.options.signal?.aborted || call.controller.signal.aborted || init?.signal?.aborted ? 'cancelled' : 'failed');
      throw budgetError(error);
    }
  };
  target.fetch = transport.fetch;
  transports.set(target, transport);
  return transport;
}
function restoreIdleTransport(transport) {
  if (transport.owners > 0 || transport.activeCalls > 0) return;
  if (transport.target.fetch === transport.fetch) transport.target.fetch = transport.previous;
  transports.delete(transport.target);
}
function releaseTransport(transport) {
  transport.owners--;
  restoreIdleTransport(transport);
}

/** The host checks this before creating/resuming a bounded native Kimi task. */
export function nativeKimiBudgetReady(ctx) {
  const owner = ctx && registrations.get(ctx);
  return Boolean(owner?.active && owner.transport.target.fetch === owner.transport.fetch);
}

/** Register once per host; the returned disposer removes the hook and fetch bridge. */
export function registerNativeKimiBudget(ctx, { transportTarget = globalThis } = {}) {
  if (registrations.get(ctx)?.active) throw failure('此宿主已安装 Kimi Code 请求计数入口。');
  const owner = { active:true, transport:acquireTransport(transportTarget), calls:new Set() };
  registrations.set(ctx, owner);
  let unregister;
  try {
    unregister = ctx.on('llm/stream', (options, next) => (async function* () {
      if (options.provider !== NATIVE_KIMI_ROUTE) { yield* next(); return; }
      let binding;
      try { binding = captureProviderRequestContext(ctx, options); }
      catch (error) { throw budgetError(error); }
      const governed = Boolean(getUnoRequestGovernance(options.messages));
      if (!binding && !governed) { yield* next(); return; } // Ordinary chat and ungoverned historical jobs.
      if (!nativeKimiBudgetReady(ctx)) throw failure('Kimi Code 请求计数入口不可用，未发送请求。');
      const call = { ctx, options, binding, governed, owner, transport:owner.transport, attempts:[], controller:new AbortController(), closed:false };
      owner.calls.add(call);
      // A native client may only capture fetch AFTER awaiting credentials. Keep
      // the bridge installed until that call has drained, even after unload.
      owner.transport.activeCalls++;
      let iterator, exhausted=false, state='incomplete', usage;
      try {
        options.signal?.throwIfAborted();
        iterator = calls.run(call, () => next()[Symbol.asyncIterator]());
        while (true) {
          const result = await calls.run(call, () => iterator.next());
          if (call.fatal) throw call.fatal; // Native SDK may turn transport errors into text.
          if (result.done) { exhausted=true; break; }
          const chunk = result.value;
          if (chunk.type === 'usage') usage=chunk.usage;
          if (chunk.type === 'finish') {
            state=outcome(chunk.reason?.kind);
            if (['completed','truncated'].includes(state) && !call.attempts.length)
              throw failure('Kimi Code 返回未经过已验证的网络计数入口，不能确认本次受预算执行。');
          }
          yield chunk;
        }
      } catch (error) {
        state=options.signal?.aborted || call.controller.signal.aborted ? 'cancelled' : 'failed';
        throw budgetError(error);
      } finally {
        call.closed=true;
        if (!exhausted) call.controller.abort();
        try { if (!exhausted && iterator?.return) await calls.run(call, () => iterator.return()); }
        finally {
          try {
            const pending=call.attempts.filter(entry=>!entry.finished);
            for (const entry of pending) finishAttempt(entry, options.signal?.aborted || !owner.active ? 'cancelled' : state,
              entry === call.attempts.at(-1) ? usage : undefined);
          } finally {
            owner.calls.delete(call);
            owner.transport.activeCalls--;
            restoreIdleTransport(owner.transport);
          }
        }
      }
    })());
  } catch (error) {
    owner.active=false; registrations.delete(ctx); releaseTransport(owner.transport); throw error;
  }
  return () => {
    if (!owner.active) return;
    owner.active=false;
    for (const call of owner.calls) call.controller.abort();
    unregister?.(); registrations.delete(ctx); releaseTransport(owner.transport);
  };
}

