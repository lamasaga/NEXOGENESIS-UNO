/** DSH rc.6 compatibility seam for a non-destructive UNO request projection.
 * Do not rewrite llm/stream: its request is already frozen and adapter-bound.
 * Session events/surface stay authoritative and untouched; deriveMessages is a
 * deterministic view of those same events, including for native invariants.
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { projectUnoMessages, assertUnoRequestBudget } from './request-context.js';

const owners = new WeakMap();
const fail = message => new LlmError('[UNO_CONTEXT_ADAPTER] '+message, 'UNO_CONTEXT_ADAPTER');
const asFailure = error => error instanceof LlmError ? error
  : new LlmError(`[${error?.code ?? 'UNO_CONTEXT_ADAPTER'}] ${error?.message ?? String(error)}`,error?.code ?? 'UNO_CONTEXT_ADAPTER');

/** Installs only on agents whose scoped preset loaded this plugin. */
export function registerUnoRequestContext(ctx, {
  isGoverned = () => true,
  onMeasurement = () => {},
  project = projectUnoMessages,
  assertBudget = assertUnoRequestBudget,
} = {}) {
  const installed = new Set();
  let active = true;
  const ensure = agent => {
    if (!active) throw fail('上下文治理入口已卸载，未继续发送请求。');
    const session = agent?.session;
    let owner = owners.get(agent);
    if (owner) {
      if (owner.registration !== installed || agent.buildRequest !== owner.build || session?.deriveMessages !== owner.derive)
        throw fail('原生请求或消息投影入口被替换，未继续发送请求。');
      return;
    }
    // rc.6 signatures are deliberately pinned. A runtime upgrade must run the
    // native tests and adapt this seam instead of silently bypassing governance.
    if (!session || typeof session.deriveMessages !== 'function' || session.deriveMessages.length !== 0
        || typeof agent.buildRequest !== 'function' || agent.buildRequest.length !== 6)
      throw fail('当前原生运行时不支持已验证的消息投影契约。');
    const originalDerive = session.deriveMessages, originalBuild = agent.buildRequest;
    const ownDerive = Object.getOwnPropertyDescriptor(session,'deriveMessages');
    const ownBuild = Object.getOwnPropertyDescriptor(agent,'buildRequest');
    owner = { agent,session,originalDerive,originalBuild,ownDerive,ownBuild,registration:installed };
    owner.derive = function() {
      if (!active || session.deriveMessages !== owner.derive || agent.buildRequest !== owner.build)
        throw fail('原生上下文治理已失效，未生成未受控的请求。');
      try { return project(originalDerive.call(this)).messages; }
      catch (error) { throw asFailure(error); }
    };
    owner.build = async function(turn,step,tools,system,messages,signal) {
      if (!active || session.deriveMessages !== owner.derive || agent.buildRequest !== owner.build)
        throw fail('原生上下文治理已失效，未发送未受控的请求。');
      // Use the bound route/config/header machinery unmodified. The messages
      // were projected by session.deriveMessages immediately before this call.
      const built = await originalBuild.call(this,turn,step,tools,system,messages,signal);
      if (!built?.request || built.request.messages !== messages)
        throw fail('原生请求构建行为已变化，不能确认完整请求预算。');
      let stats;
      try { stats = assertBudget(built.request); }
      catch (error) {
        try { onMeasurement({sessionId:session.id,turn,step,accepted:false,code:error?.code,stats:error?.stats}); } catch {}
        throw asFailure(error);
      }
      try { onMeasurement({sessionId:session.id,turn,step,accepted:true,stats}); } catch {}
      return built;
    };
    Object.defineProperty(session,'deriveMessages',{configurable:true,writable:true,value:owner.derive});
    Object.defineProperty(agent,'buildRequest',{configurable:true,writable:true,value:owner.build});
    owners.set(agent,owner); installed.add(owner);
  };
  const unregister = ctx.on('agent/pre-step', (event,next) => {
    if (isGoverned(event.agent)) ensure(event.agent);
    return next();
  }, { prepend:true });
  return () => {
    if (!active) return;
    active=false; unregister?.();
    for (const owner of installed) {
      if (owner.agent.buildRequest === owner.build) {
        if(owner.ownBuild)Object.defineProperty(owner.agent,'buildRequest',owner.ownBuild);else delete owner.agent.buildRequest;
      }
      if (owner.session.deriveMessages === owner.derive) {
        if(owner.ownDerive)Object.defineProperty(owner.session,'deriveMessages',owner.ownDerive);else delete owner.session.deriveMessages;
      }
      owners.delete(owner.agent);
    }
    installed.clear();
  };
}
